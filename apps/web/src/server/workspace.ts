import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, parse, resolve, sep } from 'node:path'
import { WebApiError } from './errors.js'

/**
 * Every uploaded EPUB, rendered WAV, and exported audiobook lives in this external local
 * workspace. It is deliberately outside the repository tree so book text and generated audio can
 * never be committed.
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

/** Filesystem layout for the local workspace, with a path guard for anything the browser reaches. */
export class LocalWorkspace {
  readonly root: string
  readonly uploadsDir: string
  readonly segmentsDir: string
  readonly outputsDir: string
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
    this.prepared = true
  }

  contains(candidate: string): boolean {
    return isAbsolute(candidate) && isInside(this.root, resolve(candidate))
  }

  /** Refuses any path that escaped the workspace, whatever produced it. */
  assertContains(candidate: string): string {
    if (!this.contains(candidate) || candidate.includes('\0')) {
      throw new WebApiError('output_unavailable', 'Requested file is outside the local workspace')
    }
    return resolve(candidate)
  }
}

export const createWorkspace = async (
  configuredRoot?: string | undefined,
): Promise<LocalWorkspace> => {
  const workspace = new LocalWorkspace(resolveWorkspaceRoot(configuredRoot))
  await workspace.prepare()
  return workspace
}
