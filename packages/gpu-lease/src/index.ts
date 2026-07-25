import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { execFile, spawn } from 'node:child_process'
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const HOLDER_SOURCE = `
const token = process.argv[1]
process.stdout.write(token + '\\n')
process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
`
/** Comfortably above an idle WSL2/GPU-PV baseline (~231 MiB) and far below any loaded model. */
const DEFAULT_RESIDENT_GPU_MEMORY_THRESHOLD_MIB = 1_024
const MAX_PROCESS_ANCESTRY_DEPTH = 64
/** How often release re-checks that the holder process group has no live member left. */
const HOLDER_GROUP_POLL_MS = 20
/** Bounded wait for `flock`'s own diagnostics once it has exited, so failures stay explainable. */
const HOLDER_STDERR_FLUSH_MS = 200

const delay = async (ms: number): Promise<void> =>
  await new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, ms)
  })

export type GpuOwner = 'composition' | 'gemma' | 'qwen3-tts'

export interface GpuLease {
  readonly owner: GpuOwner
  readonly lockFilePath: string
  release(): Promise<void>
}

/** One cross-process contract used by every model composition that can own CUDA. */
export interface ExclusiveGpuLeaseCoordinator {
  acquire(owner: GpuOwner, signal?: AbortSignal): Promise<GpuLease>
}

export type GpuLeaseErrorCode = 'busy' | 'cancelled' | 'diagnostic' | 'unavailable'

export class GpuLeaseError extends Error {
  override readonly name = 'GpuLeaseError'
  readonly code: GpuLeaseErrorCode

  constructor(code: GpuLeaseErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
  }
}

export interface FileGpuLeaseCoordinatorConfig {
  /** Required stable file path shared by Gemma, Qwen, and the final composition root. */
  readonly lockFilePath: string
  readonly flockExecutable?: string
  readonly nvidiaSmiExecutable?: string
  /** Diagnostic fail-closed check for uncoordinated pre-existing GPU users; flock is the guarantee. */
  readonly inspectExistingComputeProcesses?: boolean
  /**
   * Total-residency ceiling, in MiB, used when the compute-app table attributes nothing to this
   * process tree. WSL2/GPU-PV reports a real PID but `[Not Found]`/`[N/A]` for the name and
   * per-process memory, so total used memory is the only remaining residency signal there.
   */
  readonly residentGpuMemoryThresholdMiB?: number
  readonly releaseGraceMs?: number
}

interface HolderExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly error?: unknown
}

type HolderHandshake = 'acquired' | 'exited' | 'unusable'

interface ComputeApp {
  readonly pid: number | undefined
  readonly line: string
}

/** Reads the parent PID from `/proc/<pid>/stat`, tolerating spaces and parens in the comm field. */
async function parentProcessId(pid: number): Promise<number | undefined> {
  let raw: string
  try {
    raw = await readFile(`/proc/${pid}/stat`, 'utf8')
  } catch {
    return undefined
  }
  const fields = raw
    .slice(raw.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/u)
  const parent = Number(fields[1])
  return Number.isSafeInteger(parent) && parent >= 0 ? parent : undefined
}

/**
 * A process group with any live member still owns the locked descriptor, so `ESRCH` - and only
 * `ESRCH` - proves the holder subtree is gone.
 */
function isProcessGroupAlive(groupId: number): boolean {
  try {
    process.kill(-groupId, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Fail-closed: only a PID provably inside this process tree is treated as our own. */
async function isOwnProcessTree(pid: number): Promise<boolean> {
  if (pid === process.pid) return true
  let current = pid
  for (let depth = 0; depth < MAX_PROCESS_ANCESTRY_DEPTH; depth += 1) {
    const parent = await parentProcessId(current)
    if (parent === undefined) return false
    if (parent === process.pid) return true
    if (parent <= 1) return false
    current = parent
  }
  return false
}

export class FileGpuLeaseCoordinator implements ExclusiveGpuLeaseCoordinator {
  readonly #lockFilePath: string
  readonly #flockExecutable: string
  readonly #nvidiaSmiExecutable: string
  readonly #inspectExistingComputeProcesses: boolean
  readonly #residentGpuMemoryThresholdMiB: number
  readonly #releaseGraceMs: number

  constructor(config: FileGpuLeaseCoordinatorConfig) {
    if (config.lockFilePath.length === 0)
      throw new GpuLeaseError('unavailable', 'GPU lock file path is required')
    this.#lockFilePath = resolve(config.lockFilePath)
    this.#flockExecutable = config.flockExecutable ?? 'flock'
    this.#nvidiaSmiExecutable = config.nvidiaSmiExecutable ?? 'nvidia-smi'
    this.#inspectExistingComputeProcesses = config.inspectExistingComputeProcesses ?? true
    this.#residentGpuMemoryThresholdMiB =
      config.residentGpuMemoryThresholdMiB ?? DEFAULT_RESIDENT_GPU_MEMORY_THRESHOLD_MIB
    this.#releaseGraceMs = config.releaseGraceMs ?? 5_000
    if (
      !Number.isSafeInteger(this.#residentGpuMemoryThresholdMiB) ||
      this.#residentGpuMemoryThresholdMiB < 1
    ) {
      throw new GpuLeaseError('unavailable', 'GPU residency threshold must be a positive integer')
    }
    if (!Number.isSafeInteger(this.#releaseGraceMs) || this.#releaseGraceMs < 100) {
      throw new GpuLeaseError('unavailable', 'GPU lease release grace must be at least 100 ms')
    }
  }

  async acquire(owner: GpuOwner, signal?: AbortSignal): Promise<GpuLease> {
    if (signal?.aborted) throw new GpuLeaseError('cancelled', 'GPU lease acquisition was cancelled')
    await mkdir(dirname(this.#lockFilePath), { recursive: true, mode: 0o700 })
    const file = await open(this.#lockFilePath, 'a', 0o600)
    await file.close()

    const token = `${owner}-${process.pid}-${crypto.randomUUID()}`
    const child = spawn(
      this.#flockExecutable,
      [
        '--exclusive',
        '--nonblock',
        '--conflict-exit-code',
        '75',
        this.#lockFilePath,
        process.execPath,
        '-e',
        HOLDER_SOURCE,
        token,
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'] as const,
        windowsHide: true,
        // The holder is a two-process subtree (`flock` -> nested Node) and the nested process is the
        // one holding the locked descriptor. Its own process group is the only handle that can
        // terminate it, so the holder must be a group leader from the start.
        detached: true,
      },
    )
    // A detached holder must never be the only reason a caller's event loop stays alive; release
    // re-refs the handle so it can still observe exit.
    child.unref()
    // Node destroys this pipe as soon as the direct child exits, so the unconditional EOF in
    // release can surface an asynchronous stream error that is not a release failure.
    child.stdin.on('error', () => {})
    // 'exit' rather than 'close': 'close' also waits for the stdio the nested holder inherited, so
    // a surviving descendant could otherwise stall release forever.
    const exit = new Promise<HolderExit>((resolveExit) => {
      let settled = false
      const settle = (result: HolderExit): void => {
        if (settled) return
        settled = true
        resolveExit(result)
      }
      child.once('error', (error) => settle({ code: null, signal: null, error }))
      child.once('exit', (code, exitSignal) => settle({ code, signal: exitSignal }))
    })
    let stderr = ''
    const stderrFlushed = new Promise<void>((resolveFlushed) => {
      child.stderr.once('end', () => resolveFlushed())
      child.stderr.once('close', () => resolveFlushed())
      child.stderr.once('error', () => resolveFlushed())
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4_000)
    })

    const cancel = (): void => {
      this.#signalHolderSubtree(child, 'SIGTERM')
    }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      const handshake = await this.#waitForToken(child, exit, token)
      if (handshake === 'unusable') {
        throw new GpuLeaseError(
          'unavailable',
          'GPU lease holder produced an unusable handshake and was stopped',
        )
      }
      if (handshake === 'exited') {
        const result = await exit
        if (signal?.aborted)
          throw new GpuLeaseError('cancelled', 'GPU lease acquisition was cancelled')
        if (result.code === 75) {
          throw new GpuLeaseError('busy', `GPU lease is already held: ${this.#lockFilePath}`)
        }
        // Settling on 'exit' can outrun flock's own stderr, so give the diagnostic a bounded wait.
        await this.#settleWithin(stderrFlushed, HOLDER_STDERR_FLUSH_MS)
        throw new GpuLeaseError(
          'unavailable',
          `GPU lease holder failed to start: ${stderr.trim() || result.error || `exit ${result.code}`}`,
        )
      }
      if (signal?.aborted) {
        throw new GpuLeaseError('cancelled', 'GPU lease acquisition was cancelled')
      }
      if (this.#inspectExistingComputeProcesses) await this.#diagnoseExistingCompute(signal)

      let released = false
      return {
        owner,
        lockFilePath: this.#lockFilePath,
        release: async () => {
          if (released) return
          released = true
          await this.#stopHolder(child, exit)
        },
      }
    } catch (error) {
      // The holder subtree can still hold the kernel lock on every failure path - including a
      // handshake that never arrived - and stopping it must never replace the original cause.
      await this.#stopHolderQuietly(child, exit)
      if (error instanceof GpuLeaseError) throw error
      if (signal?.aborted)
        throw new GpuLeaseError('cancelled', 'GPU lease acquisition was cancelled', {
          cause: error,
        })
      throw new GpuLeaseError('unavailable', 'Could not acquire the cross-process GPU lease', {
        cause: error,
      })
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
  }

  async #waitForToken(
    child: ChildProcessWithoutNullStreams,
    exit: Promise<HolderExit>,
    token: string,
  ): Promise<HolderHandshake> {
    child.stdout.setEncoding('utf8')
    return await new Promise<HolderHandshake>((resolveReady) => {
      let settled = false
      let output = ''
      const finish = (value: HolderHandshake): void => {
        if (settled) return
        settled = true
        resolveReady(value)
      }
      child.stdout.on('data', (chunk: string) => {
        output += chunk
        if (output.split(/\r?\n/u).includes(token)) finish('acquired')
        if (output.length > 4_000) finish('unusable')
      })
      void exit.then(() => finish('exited'))
    })
  }

  async #diagnoseExistingCompute(signal?: AbortSignal): Promise<void> {
    const computeApps = this.#parseComputeApps(
      await this.#queryNvidiaSmi(
        ['--query-compute-apps=pid,process_name,used_gpu_memory', '--format=csv,noheader,nounits'],
        signal,
      ),
    )
    const foreign: string[] = []
    let ownProcesses = 0
    for (const app of computeApps) {
      // Names and per-process memory are unreliable under GPU-PV; only the PID is trustworthy.
      if (app.pid !== undefined && (await isOwnProcessTree(app.pid))) ownProcesses += 1
      else foreign.push(app.line)
    }
    if (foreign.length > 0) {
      throw new GpuLeaseError(
        'diagnostic',
        `Uncoordinated GPU compute process detected after lease acquisition: ${foreign.join('; ')}`,
      )
    }
    // Our own runtime legitimately occupies VRAM, so total residency only decides the rest.
    if (ownProcesses > 0) return
    const used = this.#parseMemoryUsedMiB(
      await this.#queryNvidiaSmi(
        ['--query-gpu=memory.used', '--format=csv,noheader,nounits'],
        signal,
      ),
    )
    if (used !== undefined && used > this.#residentGpuMemoryThresholdMiB) {
      throw new GpuLeaseError(
        'diagnostic',
        `Unattributed GPU residency of ${used} MiB exceeds the ${this.#residentGpuMemoryThresholdMiB} MiB threshold after lease acquisition`,
      )
    }
  }

  async #queryNvidiaSmi(args: readonly string[], signal?: AbortSignal): Promise<string> {
    try {
      const { stdout } = await execFileAsync(this.#nvidiaSmiExecutable, [...args], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
        signal,
      })
      return stdout
    } catch (error) {
      if (signal?.aborted)
        throw new GpuLeaseError('cancelled', 'GPU diagnostic was cancelled', { cause: error })
      throw new GpuLeaseError('diagnostic', 'Could not inspect existing GPU compute processes', {
        cause: error,
      })
    }
  }

  #parseComputeApps(stdout: string): ComputeApp[] {
    return stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const pid = Number(line.split(',')[0]?.trim())
        return {
          pid: Number.isSafeInteger(pid) && pid > 0 ? pid : undefined,
          line,
        }
      })
  }

  /** `[N/A]`, `[Not Found]`, and other non-numeric readings are absent data, never zero. */
  #parseMemoryUsedMiB(stdout: string): number | undefined {
    const values = stdout
      .split(/\r?\n/u)
      .map((line) => Number(line.trim()))
      .filter((value) => Number.isFinite(value))
    return values.length === 0 ? undefined : Math.max(...values)
  }

  async #stopHolderQuietly(
    child: ChildProcessWithoutNullStreams,
    exit: Promise<HolderExit>,
  ): Promise<void> {
    try {
      await this.#stopHolder(child, exit)
    } catch {
      // The caller is already reporting a more informative failure.
    }
  }

  /**
   * Release is a subtree problem: `flock` is only the direct child and the nested Node process is
   * what holds the locked descriptor. Every path here therefore ends with the whole process group
   * proven gone, or with a thrown error - never with an unbounded wait.
   */
  async #stopHolder(
    child: ChildProcessWithoutNullStreams,
    exit: Promise<HolderExit>,
  ): Promise<void> {
    // The holder was unref'd at spawn; release has to be able to observe its exit.
    child.ref()
    this.#endHolderStdin(child)
    let result = await this.#awaitSubtreeExit(child, exit, this.#releaseGraceMs)
    let escalated = false
    if (result === undefined) {
      escalated = true
      this.#signalHolderSubtree(child, 'SIGKILL')
      result = await this.#awaitSubtreeExit(child, exit, this.#releaseGraceMs)
    }
    if (result === undefined)
      throw new GpuLeaseError(
        'unavailable',
        `GPU lease holder subtree survived SIGKILL and may still hold ${this.#lockFilePath}`,
      )
    if (result.error !== undefined)
      throw new GpuLeaseError('unavailable', 'GPU lease holder process failed', {
        cause: result.error,
      })
    // Only our own escalation means graceful release failed; a holder killed from outside that then
    // freed the lock on EOF is a completed release, not a failure.
    if (escalated)
      throw new GpuLeaseError('unavailable', 'GPU lease holder required SIGKILL during release')
  }

  /**
   * Unconditional EOF: the nested holder releases on stdin EOF whatever the direct child's exit
   * state is, so this must never be gated on `exitCode`/`signalCode`.
   */
  #endHolderStdin(child: ChildProcessWithoutNullStreams): void {
    if (child.stdin.destroyed || child.stdin.writableEnded) return
    try {
      child.stdin.end()
    } catch {
      // An already-closed holder pipe is not a release failure.
    }
  }

  /**
   * Signals the direct child and the holder process group. The direct kill covers the window before
   * the detached child has called `setsid`; the group kill covers the nested holder afterwards.
   */
  #signalHolderSubtree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    try {
      child.kill(signal)
    } catch {
      // Already gone.
    }
    if (child.pid === undefined) return
    try {
      process.kill(-child.pid, signal)
    } catch {
      // ESRCH is success: the group has no member left to signal.
    }
  }

  /** Resolves only when the direct child has exited *and* its process group is empty. */
  async #awaitSubtreeExit(
    child: ChildProcessWithoutNullStreams,
    exit: Promise<HolderExit>,
    timeoutMs: number,
  ): Promise<HolderExit | undefined> {
    const deadline = Date.now() + timeoutMs
    const result = await this.#settleWithin(exit, timeoutMs)
    if (result === undefined) return undefined
    const groupId = child.pid
    if (groupId === undefined) return result
    for (;;) {
      if (!isProcessGroupAlive(groupId)) return result
      if (Date.now() >= deadline) return undefined
      await delay(HOLDER_GROUP_POLL_MS)
    }
  }

  /** Resolves `undefined` on timeout; the timer stays ref'd so release cannot be cut short. */
  async #settleWithin<T>(settling: Promise<T>, timeoutMs: number): Promise<T | undefined> {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        settling,
        new Promise<undefined>((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout(undefined), timeoutMs)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
}
