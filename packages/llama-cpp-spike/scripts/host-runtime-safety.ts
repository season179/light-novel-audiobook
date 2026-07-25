import { type ChildProcess, execFile as execFileCallback, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { lstat, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

export interface ExternalRuntimeProof {
  readonly canonicalized: true
  readonly ext4: true
  readonly outsideWorktree: true
  readonly outsideRepository: true
  readonly outsideGitDirectory: true
  readonly overlapCheckedBothDirections: true
  readonly symlinkComponentsRejected: true
  readonly validatedPathClasses: ReadonlyArray<string>
}

interface ExternalRuntimeOptions {
  readonly runtimeRootInput: string
  readonly worktreeRoot: string
  readonly repositoryRoot: string
  readonly gitDirectory: string
  readonly paths: ReadonlyArray<{ readonly path: string; readonly pathClass: string }>
}

export interface ValidatedExternalRuntime {
  readonly root: string
  readonly proof: ExternalRuntimeProof
}

function containsPath(parent: string, candidate: string): boolean {
  const difference = relative(parent, candidate)
  return (
    difference === '' ||
    (!difference.startsWith(`..${sep}`) && difference !== '..' && !isAbsolute(difference))
  )
}

function pathsOverlap(left: string, right: string): boolean {
  return containsPath(left, right) || containsPath(right, left)
}

async function rejectSymlinkComponents(path: string): Promise<void> {
  const absolute = resolve(path)
  const root = parse(absolute).root
  const segments = absolute.slice(root.length).split(sep).filter(Boolean)
  let current = root
  for (const segment of segments) {
    current = join(current, segment)
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`External runtime path contains a symbolic-link component`)
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

export async function validateExternalRuntime(
  options: ExternalRuntimeOptions,
): Promise<ValidatedExternalRuntime> {
  const lexicalRoot = resolve(options.runtimeRootInput)
  await rejectSymlinkComponents(lexicalRoot)
  const canonicalRoot = await realpath(lexicalRoot)
  const canonicalWorktree = await realpath(options.worktreeRoot)
  const canonicalRepository = await realpath(options.repositoryRoot)
  const canonicalGitDirectory = await realpath(options.gitDirectory)

  if (pathsOverlap(canonicalRoot, canonicalWorktree)) {
    throw new Error('External runtime root overlaps the Git worktree')
  }
  if (pathsOverlap(canonicalRoot, canonicalRepository)) {
    throw new Error('External runtime root overlaps the Git repository')
  }
  if (pathsOverlap(canonicalRoot, canonicalGitDirectory)) {
    throw new Error('External runtime root overlaps the Git directory')
  }

  const { stdout: filesystemOutput } = await execFile('findmnt', [
    '-n',
    '-o',
    'FSTYPE',
    '-T',
    canonicalRoot,
  ])
  if (filesystemOutput.trim() !== 'ext4') {
    throw new Error('External runtime root must use ext4')
  }

  const validatedPathClasses = new Set<string>(['runtime'])
  for (const candidate of options.paths) {
    const absoluteCandidate = resolve(candidate.path)
    if (!containsPath(canonicalRoot, absoluteCandidate)) {
      throw new Error(`External ${candidate.pathClass} path escapes the runtime root`)
    }
    await rejectSymlinkComponents(absoluteCandidate)
    try {
      const canonicalCandidate = await realpath(absoluteCandidate)
      if (!containsPath(canonicalRoot, canonicalCandidate)) {
        throw new Error(`External ${candidate.pathClass} path resolves outside the runtime root`)
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    validatedPathClasses.add(candidate.pathClass)
  }

  return {
    root: canonicalRoot,
    proof: {
      canonicalized: true,
      ext4: true,
      outsideWorktree: true,
      outsideRepository: true,
      outsideGitDirectory: true,
      overlapCheckedBothDirections: true,
      symlinkComponentsRejected: true,
      validatedPathClasses: [...validatedPathClasses].sort(),
    },
  }
}

export async function validateExternalPath(runtimeRoot: string, candidate: string): Promise<void> {
  const canonicalRoot = await realpath(runtimeRoot)
  const absoluteCandidate = resolve(candidate)
  if (!containsPath(canonicalRoot, absoluteCandidate)) {
    throw new Error('Owned temporary path escapes the external runtime root')
  }
  await rejectSymlinkComponents(absoluteCandidate)
  try {
    const canonicalCandidate = await realpath(absoluteCandidate)
    if (!containsPath(canonicalRoot, canonicalCandidate)) {
      throw new Error('Owned temporary path resolves outside the external runtime root')
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childHasExited(child)) return true
  return await new Promise<boolean>((resolvePromise) => {
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      resolvePromise(value)
    }
    const onExit = (): void => finish(true)
    const timer = setTimeout(() => finish(childHasExited(child)), timeoutMs)
    child.once('exit', onExit)
    if (childHasExited(child)) finish(true)
  })
}

async function stopOwnedProcess(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || childHasExited(child)) return
  child.kill('SIGTERM')
  if (await waitForChildExit(child, 5_000)) return
  if (!childHasExited(child)) child.kill('SIGKILL')
  if (!(await waitForChildExit(child, 5_000))) {
    throw new Error('Owned llama.cpp child did not exit after SIGKILL')
  }
}

export interface OwnedServerContext {
  readonly apiKey: string
  readonly apiKeyFile: string
  readonly child: ChildProcess
  readonly throwIfChildError: () => void
}

interface OwnedServerOptions<T> {
  readonly runtimeRoot: string
  readonly spawnChild: (apiKeyFile: string) => ChildProcess
  readonly run: (context: OwnedServerContext) => Promise<T>
}

/** Owns the key and process from creation through cleanup, including spawn failures. */
export async function withOwnedServer<T>(options: OwnedServerOptions<T>): Promise<{
  readonly result: T
  readonly removedApiKeyFile: string
}> {
  let apiKeyFile: string | undefined
  let child: ChildProcess | undefined
  let childError: Error | undefined
  let onChildError: ((error: Error) => void) | undefined
  try {
    const apiKey = randomBytes(32).toString('base64url')
    apiKeyFile = resolve(
      options.runtimeRoot,
      `.run-api-key-${process.pid}-${randomBytes(6).toString('hex')}`,
    )
    await validateExternalPath(options.runtimeRoot, apiKeyFile)
    await writeFile(apiKeyFile, `${apiKey}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    const keyMode = (await stat(apiKeyFile)).mode & 0o777
    if (keyMode !== 0o600) throw new Error('Per-run API-key file permissions are not 0600')

    child = options.spawnChild(apiKeyFile)
    onChildError = (error: Error): void => {
      childError = error
    }
    child.on('error', onChildError)
    child.stdout?.resume()
    child.stderr?.resume()
    await new Promise<void>((resolvePromise, reject) => {
      const onSpawn = (): void => {
        child?.removeListener('error', onStartError)
        resolvePromise()
      }
      const onStartError = (error: Error): void => {
        child?.removeListener('spawn', onSpawn)
        reject(new Error('Owned llama.cpp child failed to start', { cause: error }))
      }
      child?.once('spawn', onSpawn)
      child?.once('error', onStartError)
    })

    const ownedChild = child
    const throwIfChildError = (): void => {
      if (childError)
        throw new Error('Owned llama.cpp child emitted an error', { cause: childError })
      if (childHasExited(ownedChild)) {
        throw new Error(
          `Owned llama.cpp child exited during the run (exit=${String(ownedChild.exitCode)}, signal=${String(ownedChild.signalCode)})`,
        )
      }
    }
    const result = await options.run({ apiKey, apiKeyFile, child: ownedChild, throwIfChildError })
    return { result, removedApiKeyFile: apiKeyFile }
  } finally {
    try {
      if (child) await stopOwnedProcess(child)
    } finally {
      if (child && onChildError) child.removeListener('error', onChildError)
      child?.stdin?.destroy()
      child?.stdout?.destroy()
      child?.stderr?.destroy()
      if (apiKeyFile) await rm(apiKeyFile, { force: true })
    }
  }
}

export function spawnPipedChild(binary: string, args: ReadonlyArray<string>): ChildProcess {
  return spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
}
