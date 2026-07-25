import { lstat, realpath, statfs } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

function containsPath(parent: string, candidate: string): boolean {
  const difference = relative(parent, candidate)
  return (
    difference === '' ||
    (!difference.startsWith(`..${sep}`) && difference !== '..' && !isAbsolute(difference))
  )
}

function overlaps(left: string, right: string): boolean {
  return containsPath(left, right) || containsPath(right, left)
}

export async function rejectSymlinkComponents(path: string): Promise<void> {
  const absolute = resolve(path)
  const root = parse(absolute).root
  const parts = absolute.slice(root.length).split(sep).filter(Boolean)
  let current = root
  for (const part of parts) {
    current = join(current, part)
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error('External brain path contains a symbolic-link component')
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

export function defaultTtsProtectedRoots(): readonly string[] {
  const dataRoot = process.env.XDG_DATA_HOME ?? resolve(homedir(), '.local/share')
  const applicationRoot = resolve(dataRoot, 'light-novel-audiobook')
  return [
    process.env.LIGHT_NOVEL_AUDIOBOOK_TTS_RUNTIME_ROOT ?? resolve(applicationRoot, 'runtimes/tts'),
    process.env.LIGHT_NOVEL_AUDIOBOOK_TTS_MODEL_ROOT ?? resolve(applicationRoot, 'models/tts'),
    process.env.LIGHT_NOVEL_AUDIOBOOK_TTS_WORKSPACE_ROOT ??
      resolve(applicationRoot, 'workspaces/spikes/issue-7'),
  ]
}

export interface ExternalBrainProof {
  readonly canonicalized: true
  readonly ext4: true
  readonly outsideRepository: true
  readonly outsideGitDirectory: true
  readonly outsideTtsRoots: true
  readonly overlapCheckedBothDirections: true
  readonly symlinkComponentsRejected: true
  readonly pathClasses: readonly string[]
}

export async function validateExternalBrainPaths(options: {
  runtimeRoot: string
  repositoryRoot: string
  gitDirectory: string
  candidates: readonly { path: string; pathClass: string }[]
  ttsRoots?: readonly string[]
}): Promise<{ root: string; proof: ExternalBrainProof }> {
  const lexicalRoot = resolve(options.runtimeRoot)
  await rejectSymlinkComponents(lexicalRoot)
  const root = await realpath(lexicalRoot)
  const repository = await realpath(options.repositoryRoot)
  const gitDirectory = await realpath(options.gitDirectory)
  if (overlaps(root, repository)) throw new Error('External brain runtime overlaps Git repository')
  if (overlaps(root, gitDirectory)) throw new Error('External brain runtime overlaps Git directory')

  for (const protectedRoot of options.ttsRoots ?? defaultTtsProtectedRoots()) {
    const lexicalProtected = resolve(protectedRoot)
    await rejectSymlinkComponents(lexicalProtected)
    let canonicalProtected = lexicalProtected
    try {
      canonicalProtected = await realpath(lexicalProtected)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (overlaps(root, canonicalProtected)) {
      throw new Error('External brain runtime overlaps protected TTS storage')
    }
  }
  if ((await statfs(root)).type !== 0xef53) throw new Error('External brain runtime must use ext4')

  const pathClasses = new Set<string>(['runtime'])
  for (const candidate of options.candidates) {
    const absolute = resolve(candidate.path)
    if (!containsPath(root, absolute)) throw new Error('External brain candidate escapes runtime')
    await rejectSymlinkComponents(absolute)
    try {
      const canonical = await realpath(absolute)
      if (!containsPath(root, canonical))
        throw new Error('External brain candidate resolves outside runtime')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    pathClasses.add(candidate.pathClass)
  }
  return {
    root,
    proof: {
      canonicalized: true,
      ext4: true,
      outsideRepository: true,
      outsideGitDirectory: true,
      outsideTtsRoots: true,
      overlapCheckedBothDirections: true,
      symlinkComponentsRejected: true,
      pathClasses: [...pathClasses].sort(),
    },
  }
}
