import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { execFile, spawn } from 'node:child_process'
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  DarwinHeldKernelLockStrategy,
  KernelLockError,
  type KernelLockStrategy,
} from '@light-novel-audiobook/kernel-lock'

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
/** Detached spawn must establish its process group before an observer records that group. */
const HOLDER_GROUP_START_MS = 1_000

const delay = async (ms: number): Promise<void> =>
  await new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, ms)
  })

export type GpuOwner = 'composition' | 'gemma' | 'qwen3-tts'

export interface GpuLease {
  readonly owner: GpuOwner
  readonly lockFilePath: string
  /**
   * Persistently prevents normal acquisition when an owner cannot prove that its GPU runtime is
   * gone. Quarantine deliberately keeps the current kernel lease held for this process lifetime;
   * the durable marker continues blocking after the process exits and the kernel lock is released.
   */
  quarantine(reason: string): Promise<void>
  release(): Promise<void>
}

/** One cross-process contract used by every model composition that can own CUDA. */
export interface ExclusiveGpuLeaseCoordinator {
  acquire(owner: GpuOwner, signal?: AbortSignal): Promise<GpuLease>
}

export type GpuLeaseErrorCode = 'busy' | 'cancelled' | 'diagnostic' | 'quarantined' | 'unavailable'

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
  /** Provider override for contract tests; normal callers select from the current OS. */
  readonly kernelLockStrategy?: KernelLockStrategy
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
  /**
   * Lifecycle observer invoked after the detached holder process group exists and before acquisition
   * can settle. A rejected observer stops the holder and fails acquisition. Test infrastructure uses
   * this to durably register deliberately hostile fixture groups before an interruptible test runs.
   */
  readonly onHolderStarted?: (holderPgid: number) => Promise<void>
}

interface HolderExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly error?: unknown
}

type HolderHandshake = 'acquired' | 'exited' | 'unusable'

export interface ComputeApp {
  readonly pid: number | undefined
  readonly line: string
}

/** Liveness of a compute-apps row's PID, tri-stated so "cannot tell" can fail closed. */
export type ProcessLiveness = 'alive' | 'dead' | 'unknown'

/**
 * Maps a `/proc/<pid>/stat` read outcome to liveness. Provably dead means the process is gone
 * (ENOENT) or a zombie (`Z`/`X` - its address space, and with it any GPU allocation, is already
 * released). Every other read failure, and any content that cannot be parsed, is `unknown` -
 * never `dead` - because a false "dead" lets a second model onto the card, which is a guaranteed
 * OOM. Exported so tests can pin every errno without a host that can produce them.
 */
export function livenessFromProcStat(
  outcome:
    | { readonly ok: true; readonly stat: string }
    | { readonly ok: false; readonly code: string | undefined },
): ProcessLiveness {
  if (!outcome.ok) return outcome.code === 'ENOENT' ? 'dead' : 'unknown'
  const closeParen = outcome.stat.lastIndexOf(')')
  if (closeParen < 0) return 'unknown'
  const state = outcome.stat
    .slice(closeParen + 1)
    .trim()
    .split(/\s+/u)[0]
  if (state === undefined || state.length === 0) return 'unknown'
  return state === 'Z' || state === 'X' ? 'dead' : 'alive'
}

/**
 * Tri-states one pid against real `/proc`. The read boundary is a parameter (defaulting to the
 * real read) so the errno class is testable on hosts where non-ENOENT `/proc` failures cannot be
 * produced; the production caller never overrides it.
 */
export async function probeProcessLiveness(
  pid: number,
  readStat: (target: number) => Promise<string> = async (target) =>
    await readFile(`/proc/${target}/stat`, 'utf8'),
): Promise<ProcessLiveness> {
  try {
    return livenessFromProcStat({ ok: true, stat: await readStat(pid) })
  } catch (error) {
    return livenessFromProcStat({ ok: false, code: (error as NodeJS.ErrnoException).code })
  }
}

type ComputeAppVerdict = 'own' | 'foreign' | 'phantom'

/**
 * Decides what one compute-apps row means for the foreign-process guard (#68). Under WSL2/GPU-PV
 * the table can list PIDs that are already gone (`[Not Found], [N/A]`); a provably dead row is a
 * phantom and occupies nothing. An unreadable row is `unknown`, and unknown is foreign: the
 * asymmetry is deliberate, because a false "dead" puts two models co-resident on one card.
 * Exported with an injectable probe so the unknown branch is testable; production never overrides.
 */
export async function classifyComputeApp(
  app: ComputeApp,
  probeLiveness: (pid: number) => Promise<ProcessLiveness> = probeProcessLiveness,
): Promise<ComputeAppVerdict> {
  if (app.pid === undefined) return 'foreign'
  const liveness = await probeLiveness(app.pid)
  if (liveness === 'dead') return 'phantom'
  if (liveness === 'alive' && (await isOwnProcessTree(app.pid))) return 'own'
  return 'foreign'
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
 * Only a real, positive pid may ever be negated: `process.kill(-0, …)` signals *our own* process
 * group, and `process.kill(-1, …)` signals every process we are allowed to signal. Neither is a
 * holder subtree, so validity - not just definedness - has to be established first.
 */
function isSignallableProcessId(pid: number | undefined): pid is number {
  return pid !== undefined && Number.isSafeInteger(pid) && pid > 1
}

/**
 * A process group with any live member still owns the locked descriptor, so `ESRCH` - and only
 * `ESRCH` - proves the holder subtree is gone. Fail closed: an id we must not signal is an id whose
 * group we cannot prove empty.
 */
function isProcessGroupAlive(groupId: number | undefined): boolean {
  if (!isSignallableProcessId(groupId)) return true
  try {
    process.kill(-groupId, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Stops a detached holder from being the only thing keeping the caller's event loop alive.
 *
 * **The placement of the call matters more than the call.** It must run only after the handshake has
 * settled and nothing is awaiting a holder event any more. Called at spawn instead, it removes the
 * last thing that can wake the loop while `acquire()` is still waiting for `'exit'` - the stdio
 * pipes all close when the direct child exits - so a contended acquire drains the loop and the
 * process exits 0 with `acquire()` never settling: no error, no log, no failed job. Measured with the
 * call hoisted to spawn: 1 silent exit in 25 contended acquisitions under load, and a test that fails
 * deterministically. With the call here: 30/30 contended acquisitions settled.
 * `#stopHolder` re-refs the handle for the same reason, so release never waits on a detached holder.
 */
function detachHolderFromEventLoop(child: ChildProcessWithoutNullStreams): void {
  child.unref()
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    ;(stream as { unref?: () => void }).unref?.()
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
  readonly #quarantineFilePath: string
  readonly #flockExecutable: string
  readonly #kernelLockStrategy: KernelLockStrategy | undefined
  readonly #nvidiaSmiExecutable: string
  readonly #inspectExistingComputeProcesses: boolean
  readonly #residentGpuMemoryThresholdMiB: number
  readonly #releaseGraceMs: number
  readonly #onHolderStarted: ((holderPgid: number) => Promise<void>) | undefined

  constructor(config: FileGpuLeaseCoordinatorConfig) {
    if (config.lockFilePath.length === 0)
      throw new GpuLeaseError('unavailable', 'GPU lock file path is required')
    this.#lockFilePath = resolve(config.lockFilePath)
    this.#quarantineFilePath = `${this.#lockFilePath}.quarantined`
    this.#flockExecutable = config.flockExecutable ?? 'flock'
    this.#kernelLockStrategy =
      config.kernelLockStrategy ??
      (process.platform === 'darwin' && config.flockExecutable === undefined
        ? new DarwinHeldKernelLockStrategy({
            ...(config.releaseGraceMs === undefined
              ? {}
              : { releaseGraceMs: config.releaseGraceMs }),
          })
        : undefined)
    this.#nvidiaSmiExecutable = config.nvidiaSmiExecutable ?? 'nvidia-smi'
    if (config.flockExecutable !== undefined && config.onHolderStarted === undefined) {
      // A custom flock executable exists only so tests can run hostile or stubborn holders:
      // holders that outlive every polite stop. Without the holder-start observer there is no
      // point at which such a holder can be durably registered, so an interrupt would strand it
      // unregistered and unreapable (#67). Fail closed at construction instead.
      throw new GpuLeaseError(
        'unavailable',
        'A custom flock executable requires onHolderStarted so the holder can be registered',
      )
    }
    this.#inspectExistingComputeProcesses =
      config.inspectExistingComputeProcesses ?? process.platform === 'linux'
    this.#residentGpuMemoryThresholdMiB =
      config.residentGpuMemoryThresholdMiB ?? DEFAULT_RESIDENT_GPU_MEMORY_THRESHOLD_MIB
    this.#releaseGraceMs = config.releaseGraceMs ?? 5_000
    this.#onHolderStarted = config.onHolderStarted
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
    if (this.#kernelLockStrategy !== undefined) {
      return await this.#acquireThroughKernelLock(owner, signal)
    }
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
      if (this.#onHolderStarted !== undefined) {
        const holderPgid = await this.#waitForHolderProcessGroup(child)
        if (holderPgid !== undefined) await this.#onHolderStarted(holderPgid)
      }
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
      // Check only after the kernel lock is ours. A previous owner can create the durable marker and
      // then lose its holder while this acquire is starting; a pre-lock check would miss that race.
      await this.#assertNotQuarantined()
      if (this.#inspectExistingComputeProcesses) await this.#diagnoseExistingCompute(signal)

      // Only here, once nothing is awaiting a holder event any more. See the function's comment: the
      // placement of this call is load-bearing and must stay after the handshake.
      detachHolderFromEventLoop(child)
      let released = false
      let quarantined = false
      return {
        owner,
        lockFilePath: this.#lockFilePath,
        quarantine: async (reason: string) => {
          if (released) {
            throw new GpuLeaseError('unavailable', 'A released GPU lease cannot be quarantined')
          }
          if (quarantined) return
          await this.#writeQuarantine(owner, reason)
          quarantined = true
        },
        release: async () => {
          // Quarantine is intentionally not a normal release. Keep the holder alive until this
          // process exits; the marker below keeps future processes blocked after EOF frees flock.
          if (released || quarantined) return
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

  async #acquireThroughKernelLock(owner: GpuOwner, signal?: AbortSignal): Promise<GpuLease> {
    let held: Awaited<ReturnType<KernelLockStrategy['acquire']>> | undefined
    try {
      held = await this.#kernelLockStrategy?.acquire({
        lockFilePath: this.#lockFilePath,
        acquisition: { kind: 'nonblocking' },
        conflictExitCode: 75,
        ...(signal === undefined ? {} : { signal }),
      })
      if (held === undefined)
        throw new GpuLeaseError('unavailable', 'GPU kernel-lock strategy is unavailable')
      await this.#assertNotQuarantined()
      if (this.#inspectExistingComputeProcesses) await this.#diagnoseExistingCompute(signal)
      let released = false
      let quarantined = false
      return {
        owner,
        lockFilePath: this.#lockFilePath,
        quarantine: async (reason: string) => {
          if (released)
            throw new GpuLeaseError('unavailable', 'A released GPU lease cannot be quarantined')
          if (quarantined) return
          await this.#writeQuarantine(owner, reason)
          quarantined = true
        },
        release: async () => {
          if (released || quarantined) return
          released = true
          try {
            await held?.release()
          } catch (error) {
            throw new GpuLeaseError('unavailable', 'GPU kernel lease release failed', {
              cause: error,
            })
          }
        },
      }
    } catch (error) {
      await held?.release().catch(() => undefined)
      if (error instanceof GpuLeaseError) throw error
      if (error instanceof KernelLockError) {
        const code =
          error.code === 'busy' ? 'busy' : error.code === 'cancelled' ? 'cancelled' : 'unavailable'
        throw new GpuLeaseError(code, error.message, { cause: error })
      }
      throw new GpuLeaseError('unavailable', 'Could not acquire the cross-process GPU lease', {
        cause: error,
      })
    }
  }

  async #assertNotQuarantined(): Promise<void> {
    try {
      await readFile(this.#quarantineFilePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new GpuLeaseError('unavailable', 'Could not inspect the GPU quarantine marker', {
        cause: error,
      })
    }
    throw new GpuLeaseError(
      'quarantined',
      `GPU lease is quarantined after an unproven runtime cleanup: ${this.#quarantineFilePath}. Verify no model process, GPU residency, pending spawn, or occupied endpoint remains before explicitly removing this marker.`,
    )
  }

  async #writeQuarantine(owner: GpuOwner, reason: string): Promise<void> {
    const explanation = reason.trim()
    if (explanation.length === 0) {
      throw new GpuLeaseError('unavailable', 'GPU lease quarantine requires a reason')
    }
    let marker: Awaited<ReturnType<typeof open>> | undefined
    try {
      marker = await open(this.#quarantineFilePath, 'wx', 0o600)
      await marker.writeFile(
        `${JSON.stringify({
          schema: 1,
          owner,
          processId: process.pid,
          quarantinedAt: new Date().toISOString(),
          reason: explanation,
        })}\n`,
        'utf8',
      )
      await marker.sync()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return
      throw new GpuLeaseError('unavailable', 'Could not persist the GPU quarantine marker', {
        cause: error,
      })
    } finally {
      await marker?.close()
    }
  }

  async #waitForHolderProcessGroup(
    child: ChildProcessWithoutNullStreams,
  ): Promise<number | undefined> {
    const pid = child.pid
    if (!isSignallableProcessId(pid)) {
      throw new GpuLeaseError('unavailable', 'GPU lease holder did not expose a safe process group')
    }
    const deadline = performance.now() + HOLDER_GROUP_START_MS
    for (;;) {
      try {
        process.kill(-pid, 0)
        return pid
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return pid
      }
      if (child.exitCode !== null) return undefined
      if (performance.now() >= deadline) {
        throw new GpuLeaseError('unavailable', 'GPU lease holder process group did not start')
      }
      await delay(1)
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
      // Every row is classified: a phantom (provably dead PID) is ignored, everything else
      // reaches the guard (#68).
      const verdict = await classifyComputeApp(app)
      if (verdict === 'phantom') continue
      if (verdict === 'own') ownProcesses += 1
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
    // The holder was detached from the loop once the lease was handed over; release awaits its exit,
    // so the handle has to keep the loop alive again for as long as that wait lasts. Node closes it
    // when the child is reaped, so this cannot outlive the release itself.
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
    const groupId = child.pid
    if (!isSignallableProcessId(groupId)) return
    try {
      process.kill(-groupId, signal)
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
    const deadline = performance.now() + timeoutMs
    const result = await this.#settleWithin(exit, timeoutMs)
    if (result === undefined) return undefined
    // An undefined pid means the spawn itself failed, so there is no subtree to outlive it. Any
    // other unusable pid is handled fail-closed inside `isProcessGroupAlive`.
    if (child.pid === undefined) return result
    for (;;) {
      if (!isProcessGroupAlive(child.pid)) return result
      if (performance.now() >= deadline) return undefined
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
