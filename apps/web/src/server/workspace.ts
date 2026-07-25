import { existsSync } from 'node:fs'
import { type FileHandle, lstat, mkdir, open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { WebApiError } from './errors.js'

/**
 * Every uploaded EPUB, rendered WAV, and exported audiobook lives in this external local workspace.
 * It is deliberately outside the repository tree so book text and generated audio can never be
 * committed.
 */
export const WORKSPACE_ENV_VAR = 'AUDIOBOOK_WORKSPACE_DIR'

const DEFAULT_WORKSPACE_SEGMENTS = ['.local', 'share', 'light-novel-audiobook', 'workspace']

const findRepositoryRoot = (from: string): string | undefined => {
  let current = resolve(from)
  for (;;) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current
    const parent = parse(current).dir
    if (parent === current) return undefined
    current = parent
  }
}

const isInside = (parent: string, candidate: string): boolean =>
  candidate === parent || candidate.startsWith(`${parent}${sep}`)

const canonicalize = async (path: string): Promise<string | undefined> => {
  try {
    return await realpath(path)
  } catch {
    return undefined
  }
}

export const resolveWorkspaceRoot = (configured?: string | undefined): string => {
  const requested = configured ?? process.env[WORKSPACE_ENV_VAR]
  const root =
    requested === undefined || requested.trim().length === 0
      ? join(homedir(), ...DEFAULT_WORKSPACE_SEGMENTS)
      : resolve(requested)

  if (!isAbsolute(root)) {
    throw new WebApiError('internal', `${WORKSPACE_ENV_VAR} must be an absolute path`)
  }
  const repositoryRoot = findRepositoryRoot(process.cwd())
  if (repositoryRoot !== undefined && isInside(repositoryRoot, root)) {
    throw new WebApiError(
      'internal',
      `${WORKSPACE_ENV_VAR} must point outside the repository so EPUBs and audio stay out of Git`,
    )
  }
  return root
}

/** A validated, already-open file inside the workspace. The caller owns closing the handle. */
export interface ContainedFile {
  readonly handle: FileHandle
  readonly path: string
  readonly byteLength: number
}

/**
 * Filesystem layout for the local workspace, plus the path guard for anything the browser reaches.
 *
 * Containment is decided on canonical paths, never lexical ones: `resolve()` alone would accept a
 * path that sits under the root but is a symlink to somewhere else, and the browser would then be
 * served a file from outside the workspace.
 */
export class LocalWorkspace {
  readonly root: string
  readonly uploadsDir: string
  readonly segmentsDir: string
  readonly outputsDir: string
  private canonicalRoot: string | undefined
  private prepared = false

  constructor(root: string) {
    this.root = root
    this.uploadsDir = join(root, 'uploads')
    this.segmentsDir = join(root, 'segments')
    this.outputsDir = join(root, 'outputs')
  }

  async prepare(): Promise<void> {
    if (this.prepared) return
    for (const directory of [this.uploadsDir, this.segmentsDir, this.outputsDir]) {
      await mkdir(directory, { recursive: true })
    }
    const canonical = await canonicalize(this.root)
    if (canonical === undefined) {
      throw new WebApiError('internal', 'The local workspace directory could not be resolved')
    }
    // A root that is lexically outside the repository can still be a symlink into it.
    const repositoryRoot = findRepositoryRoot(process.cwd())
    const canonicalRepository =
      repositoryRoot === undefined ? undefined : await canonicalize(repositoryRoot)
    if (canonicalRepository !== undefined && isInside(canonicalRepository, canonical)) {
      throw new WebApiError(
        'internal',
        `${WORKSPACE_ENV_VAR} resolves inside the repository, so EPUBs and audio would land in Git`,
      )
    }
    this.canonicalRoot = canonical
    this.prepared = true
  }

  /** Cheap lexical pre-check. Necessary but never sufficient — see `openContainedFile`. */
  contains(candidate: string): boolean {
    return isAbsolute(candidate) && isInside(this.root, resolve(candidate))
  }

  assertContains(candidate: string): string {
    if (!this.contains(candidate) || candidate.includes('\0')) {
      throw new WebApiError('output_unavailable', 'Requested file is outside the local workspace')
    }
    return resolve(candidate)
  }

  /**
   * Opens a workspace file for serving. Rejects lexical escapes, symlinked files, symlinked parent
   * directories, and anything whose canonical path leaves the workspace. Validation is done against
   * the opened handle, so the file cannot be swapped between the check and the read.
   */
  async openContainedFile(candidate: string): Promise<ContainedFile> {
    const lexical = this.assertContains(candidate)
    const canonicalRoot = this.requireCanonicalRoot()
    await this.assertNoSymlinkedComponent(lexical)

    const canonical = await canonicalize(lexical)
    if (canonical === undefined) {
      throw new WebApiError(
        'output_unavailable',
        'The generated file is missing from the workspace.',
      )
    }
    if (!isInside(canonicalRoot, canonical)) {
      throw new WebApiError('output_unavailable', 'Requested file is outside the local workspace')
    }

    const handle = await this.openFile(canonical)
    try {
      const stats = await handle.stat()
      if (!stats.isFile()) {
        throw new WebApiError('output_unavailable', 'Requested workspace path is not a file')
      }
      return { handle, path: canonical, byteLength: stats.size }
    } catch (error) {
      await handle.close()
      throw error
    }
  }

  private async openFile(path: string): Promise<FileHandle> {
    try {
      return await open(path, 'r')
    } catch {
      throw new WebApiError(
        'output_unavailable',
        'The generated file is missing from the workspace.',
      )
    }
  }

  /**
   * Walks every path component below the configured root and refuses symlinks. The root itself may
   * legitimately be reached through a symlink (`/tmp` on some systems), which is why the walk starts
   * below it and containment is separately proven on canonical paths.
   */
  private async assertNoSymlinkedComponent(path: string): Promise<void> {
    const suffix = relative(this.root, path)
    if (suffix.length === 0) return
    let current = this.root
    for (const segment of suffix.split(sep)) {
      if (segment.length === 0 || segment === '.') continue
      current = join(current, segment)
      let entry: Awaited<ReturnType<typeof lstat>>
      try {
        entry = await lstat(current)
      } catch {
        throw new WebApiError(
          'output_unavailable',
          'The generated file is missing from the workspace.',
        )
      }
      if (entry.isSymbolicLink()) {
        throw new WebApiError(
          'output_unavailable',
          'Requested workspace path passes through a symbolic link',
        )
      }
    }
  }

  private requireCanonicalRoot(): string {
    if (this.canonicalRoot === undefined) {
      throw new WebApiError('internal', 'The local workspace has not been prepared')
    }
    return this.canonicalRoot
  }
}

export const createWorkspace = async (
  configuredRoot?: string | undefined,
): Promise<LocalWorkspace> => {
  const workspace = new LocalWorkspace(resolveWorkspaceRoot(configuredRoot))
  await workspace.prepare()
  return workspace
}
