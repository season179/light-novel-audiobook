import { constants, existsSync, type Stats } from 'node:fs'
import { type FileHandle, lstat, mkdir, open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { WebApiError } from './errors.js'

/**
 * `O_NOFOLLOW` makes the open itself refuse a symlink in the final position, which is the swap a
 * check/open race exploits. It does not exist on every platform, so it is added only when present.
 */
const READ_NO_FOLLOW_FLAGS =
  constants.O_RDONLY | (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0)

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
   * Opens a workspace file for serving and proves that **the object it opened** is a regular file
   * inside the workspace.
   *
   * Order matters. Validating a pathname and then opening it is a check/open race: swapping the file
   * for a symlink in between makes `open()` follow the new target, and a measured attack leaked
   * outside files on 115 of 5,000 requests. So the file is opened first — with `O_NOFOLLOW`, so a
   * symlink in the final position fails outright — and containment is then decided from the open
   * descriptor itself via `/proc/self/fd/<fd>`, which names the inode actually held. Nothing after
   * the open can change what this handle refers to, and the same handle is what gets streamed.
   *
   * What this guarantees, precisely: the bytes served come from a regular file whose name resolves
   * inside the workspace, reached without following a link out of it. It does **not** guarantee the
   * *content* is what this app produced. A hardlink placed in the workspace, or a plain overwrite of
   * a reserved path, both present as ordinary in-workspace files — and both require write access to
   * the workspace, which already allows substituting the bytes directly. Refusing `nlink > 1` would
   * not change that and would reject legitimate exports, because the FFmpeg assembler places outputs
   * with `link()` and a failed `unlink()` of its staged copy leaves a real output at two links.
   * Content integrity needs a digest recorded when the output is produced and checked when it is
   * served; `AudiobookOutput` carries no hashes today, so that is a port-level change, not a check
   * this function can make. Callers must also only ever pass paths the job actually reserved.
   */
  async openContainedFile(candidate: string): Promise<ContainedFile> {
    const lexical = this.assertContains(candidate)
    const canonicalRoot = this.requireCanonicalRoot()

    const handle = await this.openFile(lexical)
    try {
      const stats = await handle.stat()
      if (!stats.isFile()) {
        throw new WebApiError('output_unavailable', 'Requested workspace path is not a file')
      }

      const canonical = await this.canonicalPathOfOpenFile(handle, lexical, stats)
      if (!isInside(canonicalRoot, canonical)) {
        throw new WebApiError('output_unavailable', 'Requested file is outside the local workspace')
      }
      // Policy check, and a clearer message: the workspace holds no symlinks of its own. Containment
      // is already proven above, so this cannot be raced into allowing anything.
      await this.assertNoSymlinkedComponent(lexical)

      return { handle, path: canonical, byteLength: stats.size }
    } catch (error) {
      await handle.close()
      throw error
    }
  }

  /**
   * The canonical path of an already-open descriptor. `/proc/self/fd/<fd>` is a kernel-maintained
   * link to the opened inode, so resolving it cannot be influenced by anything that happens to the
   * original pathname afterwards. Where `/proc` is unavailable, fall back to comparing the opened
   * inode against a fresh `lstat` of the pathname, which combined with `O_NOFOLLOW` still refuses a
   * swapped or symlinked target.
   */
  private async canonicalPathOfOpenFile(
    handle: FileHandle,
    lexical: string,
    stats: Stats,
  ): Promise<string> {
    const fromDescriptor = await canonicalize(`/proc/self/fd/${handle.fd}`)
    if (fromDescriptor !== undefined) {
      // A path the kernel reports as deleted must never be served: the name no longer exists, so
      // containment cannot be reasoned about, and the suffix would otherwise pass a prefix test.
      if (fromDescriptor.endsWith(' (deleted)')) {
        throw new WebApiError(
          'output_unavailable',
          'The generated file is missing from the workspace.',
        )
      }
      return fromDescriptor
    }

    let link: Stats
    try {
      link = await lstat(lexical)
    } catch {
      throw new WebApiError(
        'output_unavailable',
        'The generated file is missing from the workspace.',
      )
    }
    if (link.isSymbolicLink() || link.ino !== stats.ino || link.dev !== stats.dev) {
      throw new WebApiError('output_unavailable', 'Requested file is outside the local workspace')
    }
    const canonical = await canonicalize(lexical)
    if (canonical === undefined) {
      throw new WebApiError(
        'output_unavailable',
        'The generated file is missing from the workspace.',
      )
    }
    return canonical
  }

  private async openFile(path: string): Promise<FileHandle> {
    try {
      return await open(path, READ_NO_FOLLOW_FLAGS)
    } catch {
      // ELOOP (a symlink in the final position) is deliberately indistinguishable from a missing
      // file here: neither is something the browser may learn more about.
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
