/**
 * The concurrent half of the `OwnedLlamaLifecycle` contract: `release()` must not resolve while a
 * `start()` is still in flight, and no spawn may follow a release.
 *
 * Why this file exists separately from `llama-lifecycle.test.ts`: every test there awaits a settled
 * `start()` before releasing, so all of them pass against the older implementation that snapshotted
 * `#child` once and returned. The bug lived entirely in the unsettled window — startup parked in a
 * pre-spawn filesystem await, `#child` still undefined, release seeing nothing to reap, declaring the
 * runtime gone and letting the lease move to Qwen while a 16 GB llama.cpp load was one statement away.
 *
 * The measurements here are the inverse of the ones that found the defect: 40 raced trials counting how
 * often release returned before startup settled (was 40/40, must be 0), and real-flock acquisitions that
 * ask the kernel — not a recorded string — whether a director process exists at the instant Qwen would
 * begin loading weights.
 */
import type { Mode, PathLike } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { OwnedLlamaLifecycle } from '@light-novel-audiobook/gemma-director'
import {
  type ExclusiveGpuLeaseCoordinator,
  FileGpuLeaseCoordinator,
  type GpuLease,
  type GpuOwner,
} from '@light-novel-audiobook/gpu-lease'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NarrationEchoDirectorServer } from '../src/fake-director-server.js'

/**
 * A barrier at the exact window the reviewer identified. `#startOnce()` writes the API-key file and
 * then `chmod`s it before spawning, so parking `chmod` leaves startup with the key file really on disk,
 * really unsettled, and one synchronous statement from `spawn` — reproducible instead of timing luck.
 *
 * It gates one armed path only, so every other `node:fs/promises` caller in this file's module graph —
 * including the real GPU lease coordinator — is untouched.
 */
const chmodGate = vi.hoisted(() => {
  let armedPath: string | undefined
  let announceReached: (() => void) | undefined
  let openBarrier: (() => void) | undefined
  let opened: Promise<void> | undefined
  return {
    arm(keyPath: string): { readonly reached: Promise<void>; readonly open: () => void } {
      armedPath = keyPath
      const reached = new Promise<void>((resolve) => {
        announceReached = resolve
      })
      opened = new Promise<void>((resolve) => {
        openBarrier = resolve
      })
      return { reached, open: () => openBarrier?.() }
    },
    /** Always call this in cleanup: a still-armed gate would wedge the afterEach release. */
    disarm(): void {
      openBarrier?.()
      armedPath = undefined
      opened = undefined
      announceReached = undefined
      openBarrier = undefined
    },
    async waitIfArmed(candidate: string): Promise<void> {
      if (armedPath === undefined || candidate !== armedPath) return
      announceReached?.()
      await opened
    },
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    chmod: async (target: PathLike, mode: Mode): Promise<void> => {
      await chmodGate.waitIfArmed(String(target))
      await actual.chmod(target, mode)
    },
  }
})

const STUB = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/stub-llama-server.mjs',
)
const RACE_TRIALS = 40

const directories: string[] = []
const servers: NarrationEchoDirectorServer[] = []
const lifecycles: OwnedLlamaLifecycle[] = []
const leases: GpuLease[] = []

afterEach(async () => {
  chmodGate.disarm()
  for (const lease of leases.splice(0)) await lease.release().catch(() => undefined)
  for (const lifecycle of lifecycles.splice(0)) await lifecycle.release().catch(() => undefined)
  for (const server of servers.splice(0)) await server.stop()
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function scratch(label: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), `release-race-${label}-`))
  directories.push(directory)
  return directory
}

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

async function portIsFree(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => {
      probe.close((error) => resolve(error === undefined))
    })
  })
}

/** A kernel probe, independent of the lifecycle's own bookkeeping. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    // EPERM means it exists but is not ours; that still counts as alive.
    return true
  }
}

const delay = async (ms: number): Promise<void> =>
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

/** Polls observable state rather than sleeping a guessed interval, and fails loudly if it never holds. */
async function waitUntil(
  condition: () => boolean,
  what: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting until ${what}`)
    await delay(10)
  }
}

interface RacedStart {
  readonly started: Promise<'resolved' | 'rejected'>
  settled: () => boolean
}

/**
 * Attaches settlement tracking synchronously, so `release()` can be called in the *same* tick as
 * `start()` without the tracking itself yielding. That same-tick call is what makes the pre-spawn case
 * deterministic: `#startOnce()` runs synchronously only as far as its first `await`, so a `release()`
 * issued before any microtask runs is guaranteed to arrive while startup is parked before the spawn.
 */
function trackStart(lifecycle: OwnedLlamaLifecycle): RacedStart {
  let settled = false
  const started = lifecycle.start().then(
    () => {
      settled = true
      return 'resolved' as const
    },
    () => {
      settled = true
      return 'rejected' as const
    },
  )
  return { started, settled: () => settled }
}

interface RaceSubject {
  readonly lifecycle: OwnedLlamaLifecycle
  readonly port: number
  readonly keyPath: string
  readonly runtimeRoot: string
}

async function subject(
  options: {
    readonly label?: string
    readonly extraArgs?: readonly string[]
    readonly startupSettleTimeoutMs?: number
    readonly runtimeRoot?: string
    readonly keyName?: string
    readonly port?: number
    /** Omit the proxy target when the trial can never reach a spawn, so 40 trials start 0 servers. */
    readonly upstream?: 'echo' | 'none'
  } = {},
): Promise<RaceSubject> {
  const runtimeRoot = options.runtimeRoot ?? (await scratch(options.label ?? 'runtime'))
  const port = options.port ?? (await freePort())
  const keyPath = path.join(runtimeRoot, options.keyName ?? 'api-key')
  let upstreamUrl = 'http://127.0.0.1:9/unreachable'
  if (options.upstream !== 'none') {
    const echo = new NarrationEchoDirectorServer()
    servers.push(echo)
    await echo.start()
    upstreamUrl = echo.baseUrl
  }
  const lifecycle = new OwnedLlamaLifecycle({
    binaryPath: process.execPath,
    args: [STUB, String(port), upstreamUrl, ...(options.extraArgs ?? [])],
    apiKey: 'release-race-key',
    keyPath,
    origin: `http://127.0.0.1:${port}`,
    port,
    startupTimeoutMs: 30_000,
    terminateTimeoutMs: 2_000,
    killTimeoutMs: 5_000,
    ...(options.startupSettleTimeoutMs === undefined
      ? {}
      : { startupSettleTimeoutMs: options.startupSettleTimeoutMs }),
  })
  lifecycles.push(lifecycle)
  return { lifecycle, port, keyPath, runtimeRoot }
}

/**
 * Wraps the real cross-process lease and, at the instant an owner acquires it, asks the kernel whether
 * the director's owned process still exists and whether its port is still held. That instant is the one
 * that matters: it is when the speech engine would start loading 16 GB of Qwen weights.
 */
class ProcessProbingCoordinator implements ExclusiveGpuLeaseCoordinator {
  readonly observations: {
    owner: GpuOwner
    directorProcess: 'alive' | 'gone' | 'never-spawned'
    directorPortFree: boolean
  }[] = []

  constructor(
    private readonly inner: ExclusiveGpuLeaseCoordinator,
    private readonly directorPid: () => number | undefined,
    private readonly directorPort: number,
  ) {}

  async acquire(owner: GpuOwner, signal?: AbortSignal): Promise<GpuLease> {
    const lease = await this.inner.acquire(owner, signal)
    leases.push(lease)
    const pid = this.directorPid()
    this.observations.push({
      owner,
      directorProcess:
        pid === undefined ? 'never-spawned' : processAlive(pid) ? 'alive' : ('gone' as const),
      directorPortFree: await portIsFree(this.directorPort),
    })
    return lease
  }
}

describe('OwnedLlamaLifecycle release racing an in-flight start', () => {
  it('never returns before a pre-spawn start has settled, and never lets a spawn follow', async () => {
    // The inverse of the probe that found this: 40 trials, same shape, opposite expectation.
    const runtimeRoot = await scratch('trials')
    const port = await freePort()
    let releasedBeforeStartSettled = 0
    let spawnedAfterRelease = 0
    let startsRejected = 0

    for (let trial = 0; trial < RACE_TRIALS; trial += 1) {
      const { lifecycle } = await subject({
        runtimeRoot,
        port,
        keyName: `api-key-${trial}`,
        upstream: 'none',
      })
      const start = trackStart(lifecycle)
      // Same tick as start(), so startup is parked in its first pre-spawn await.
      const released = lifecycle.release()
      expect(lifecycle.processId).toBeUndefined()

      await released
      if (!start.settled()) releasedBeforeStartSettled += 1
      if ((await start.started) === 'rejected') startsRejected += 1
      // Give an abandoned start every chance to spawn late before concluding it cannot.
      await delay(20)
      if (lifecycle.processId !== undefined) spawnedAfterRelease += 1
    }

    expect({
      trials: RACE_TRIALS,
      releasedBeforeStartSettled,
      spawnedAfterRelease,
      startsRejected,
    }).toEqual({
      trials: RACE_TRIALS,
      releasedBeforeStartSettled: 0,
      spawnedAfterRelease: 0,
      // A start abandoned by release must fail, not quietly report a runtime that was never started.
      startsRejected: RACE_TRIALS,
    })
  }, 120_000)

  it('holds release open at the barrier between the key write and the spawn', async () => {
    const { lifecycle, port, keyPath } = await subject({ label: 'barrier', upstream: 'none' })
    const barrier = chmodGate.arm(keyPath)

    const start = trackStart(lifecycle)
    await barrier.reached
    // Startup is now genuinely mid-flight: the key file exists, no child does, and the next statement
    // after the barrier is the spawn.
    expect((await stat(keyPath)).isFile()).toBe(true)
    expect(lifecycle.processId).toBeUndefined()
    expect(start.settled()).toBe(false)

    const released = lifecycle.release().then(() => 'released' as const)
    // The old implementation resolved here. It must not: startup is one statement from spawning.
    expect(await Promise.race([released, delay(250).then(() => 'still-waiting' as const)])).toBe(
      'still-waiting',
    )
    expect(start.settled()).toBe(false)

    barrier.open()
    expect(await released).toBe('released')

    expect(start.settled()).toBe(true)
    expect(await start.started).toBe('rejected')
    // Release began, so the spawn was prohibited rather than merely lost a race.
    expect(lifecycle.processId).toBeUndefined()
    expect(lifecycle.running).toBe(false)
    expect(lifecycle.cleanupComplete).toBe(true)
    expect(await portIsFree(port)).toBe(true)
    // Awaiting settlement also fixes the key file leak: the write completed before release removed it.
    await expect(stat(keyPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)

  it('reaps a child spawned by an in-flight start before release resolves', async () => {
    // Startup is past spawn and still polling /health, exactly as it is while llama.cpp loads weights.
    const { lifecycle, port } = await subject({
      label: 'loading',
      extraArgs: ['--health-unready-ms=120000'],
    })
    const start = trackStart(lifecycle)
    await waitUntil(() => lifecycle.processId !== undefined, 'the owned process is spawned')
    const pid = lifecycle.processId
    if (pid === undefined) throw new Error('owned lifecycle reported no process ID after spawn')
    expect(processAlive(pid)).toBe(true)
    expect(start.settled()).toBe(false)

    await lifecycle.release()

    // Both halves of the contract: startup is over, and the process it created is gone.
    expect(start.settled()).toBe(true)
    expect(await start.started).toBe('rejected')
    expect(processAlive(pid)).toBe(false)
    expect(lifecycle.running).toBe(false)
    expect(lifecycle.cleanupComplete).toBe(true)
    expect(await portIsFree(port)).toBe(true)
  }, 60_000)

  it('rejects a spawn whose own operands re-entered release, before any child exists', async () => {
    // The last window: `spawn`'s operands are read *after* the check unless they are snapshotted first,
    // and `OwnedLlamaLifecycleOptions` is an interface, so they may legally be accessors. A getter that
    // calls release() is synchronous caller code running between the check and the spawn. Against the
    // unsnapshotted version this spawned a live child after release had begun.
    const runtimeRoot = await scratch('reentrant')
    const port = await freePort()
    const keyPath = path.join(runtimeRoot, 'api-key')
    let lifecycle: OwnedLlamaLifecycle | undefined
    let binaryPathReads = 0
    let releaseFromOperand: Promise<void> | undefined

    const reentrant = {
      // Legal against the declared `readonly binaryPath: string`.
      get binaryPath(): string {
        binaryPathReads += 1
        releaseFromOperand ??= (lifecycle as OwnedLlamaLifecycle).release()
        // Swallowed here only so the probe itself cannot fail on an unhandled rejection; the test
        // asserts on `releaseFromOperand` below.
        void releaseFromOperand.catch(() => undefined)
        return process.execPath
      },
      args: [STUB, String(port), 'http://127.0.0.1:9/unreachable'],
      apiKey: 'reentrant-operand-key',
      keyPath,
      origin: `http://127.0.0.1:${port}`,
      port,
      startupTimeoutMs: 30_000,
      terminateTimeoutMs: 2_000,
      killTimeoutMs: 5_000,
      startupSettleTimeoutMs: 5_000,
    }
    lifecycle = new OwnedLlamaLifecycle(reentrant)
    lifecycles.push(lifecycle)

    await expect(lifecycle.start()).rejects.toThrow(/abandoned because release had already begun/)

    // The operand really did run — otherwise this test would pass for the wrong reason.
    expect(binaryPathReads).toBe(1)
    expect(releaseFromOperand).toBeDefined()
    // No child was ever created, so there is nothing that could still be holding VRAM.
    expect(lifecycle.processId).toBeUndefined()
    expect(lifecycle.running).toBe(false)

    // And the release that the operand began still completes its contract.
    await expect(releaseFromOperand).resolves.toBeUndefined()
    expect(lifecycle.cleanupComplete).toBe(true)
    expect(await portIsFree(port)).toBe(true)
    await expect(stat(keyPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)

  it('rejects a spawn whose args iterator re-entered release', async () => {
    // Same window, reached through the other operand: `args` is an iterable, so spreading it can run
    // caller code too. Snapshotting has to cover the iteration, not just the property read.
    const runtimeRoot = await scratch('reentrant-args')
    const port = await freePort()
    const keyPath = path.join(runtimeRoot, 'api-key')
    let lifecycle: OwnedLlamaLifecycle | undefined
    let iterated = false
    let releaseFromOperand: Promise<void> | undefined

    const args: Iterable<string> = {
      *[Symbol.iterator](): Iterator<string> {
        iterated = true
        releaseFromOperand ??= (lifecycle as OwnedLlamaLifecycle).release()
        void releaseFromOperand.catch(() => undefined)
        yield STUB
        yield String(port)
        yield 'http://127.0.0.1:9/unreachable'
      },
    }
    lifecycle = new OwnedLlamaLifecycle({
      binaryPath: process.execPath,
      args: args as readonly string[],
      apiKey: 'reentrant-args-key',
      keyPath,
      origin: `http://127.0.0.1:${port}`,
      port,
      startupTimeoutMs: 30_000,
      terminateTimeoutMs: 2_000,
      killTimeoutMs: 5_000,
      startupSettleTimeoutMs: 5_000,
    })
    lifecycles.push(lifecycle)

    await expect(lifecycle.start()).rejects.toThrow(/abandoned because release had already begun/)

    expect(iterated).toBe(true)
    expect(lifecycle.processId).toBeUndefined()
    await expect(releaseFromOperand).resolves.toBeUndefined()
    expect(lifecycle.cleanupComplete).toBe(true)
    expect(await portIsFree(port)).toBe(true)
  }, 60_000)

  it('fails loudly instead of hanging or reporting success when startup is wedged', async () => {
    // A bounded wait is only progress if expiry cannot be mistaken for a released runtime.
    const { lifecycle, keyPath } = await subject({
      label: 'wedged',
      startupSettleTimeoutMs: 250,
      upstream: 'none',
    })
    const barrier = chmodGate.arm(keyPath)
    const start = trackStart(lifecycle)
    await barrier.reached

    await expect(lifecycle.release()).rejects.toThrow(/had not settled 250ms after release began/)
    expect(lifecycle.cleanupComplete).toBe(false)
    expect(lifecycle.processId).toBeUndefined()

    // And the expired wait still closed the state: the wedge clearing cannot produce a late spawn.
    barrier.open()
    expect(await start.started).toBe('rejected')
    expect(lifecycle.processId).toBeUndefined()
  }, 60_000)
})

describe('a raced release leaves nothing for the real Qwen lease to load beside', () => {
  it('has no director process at the instant the real flock reaches the speech engine', async () => {
    // The composition GenerateAudiobook performs, with the pre-spawn race dropped into the middle of it.
    const { lifecycle, port, runtimeRoot } = await subject({
      label: 'flock-prespawn',
      upstream: 'none',
    })
    const coordinator = new ProcessProbingCoordinator(
      new FileGpuLeaseCoordinator({
        lockFilePath: path.join(runtimeRoot, 'exclusive.lock'),
        // The kernel flock stays real — it is the guarantee, and it is what this test needs. Only the
        // separate nvidia-smi diagnostic for *foreign* GPU users is off, because it is orthogonal to
        // the ordering claim and it reads a table that lists dead PIDs under WSL2/GPU-PV: one such
        // stale entry failed this file's first run while the ordering assertions were all correct.
        inspectExistingComputeProcesses: false,
      }),
      () => lifecycle.processId,
      port,
    )

    // Gemma's real cross-process lease first, then the runtime — the only ordering the lease makes
    // meaningful, and the ordering GemmaDirectorModel.ensureRuntimeReady enforces.
    const gemmaLease = await coordinator.acquire('gemma')
    const start = trackStart(lifecycle)
    const released = lifecycle.release()

    await released
    expect(start.settled()).toBe(true)
    await gemmaLease.release()

    // Qwen's turn. Acquisition here is a real kernel flock, not a flag.
    await coordinator.acquire('qwen3-tts')

    expect(coordinator.observations.map((observation) => observation.owner)).toEqual([
      'gemma',
      'qwen3-tts',
    ])
    const speech = coordinator.observations.find((observation) => observation.owner === 'qwen3-tts')
    // THE ASSERTIONS THIS TEST EXISTS FOR, both observed rather than recorded: the abandoned start
    // produced no director process at all, and the port it would have bound is unheld.
    expect(speech?.directorProcess).toBe('never-spawned')
    expect(speech?.directorPortFree).toBe(true)
  }, 120_000)

  it('has reaped a loading director process before the real flock reaches the speech engine', async () => {
    // The same composition, but release races a startup that has already spawned, so there is a real
    // PID for the kernel to be asked about at the Qwen instant.
    const { lifecycle, port, runtimeRoot } = await subject({
      label: 'flock-loading',
      extraArgs: ['--health-unready-ms=120000'],
    })
    const coordinator = new ProcessProbingCoordinator(
      new FileGpuLeaseCoordinator({
        lockFilePath: path.join(runtimeRoot, 'exclusive.lock'),
        // The kernel flock stays real — it is the guarantee, and it is what this test needs. Only the
        // separate nvidia-smi diagnostic for *foreign* GPU users is off, because it is orthogonal to
        // the ordering claim and it reads a table that lists dead PIDs under WSL2/GPU-PV: one such
        // stale entry failed this file's first run while the ordering assertions were all correct.
        inspectExistingComputeProcesses: false,
      }),
      () => lifecycle.processId,
      port,
    )

    const gemmaLease = await coordinator.acquire('gemma')
    const start = trackStart(lifecycle)
    await waitUntil(() => lifecycle.processId !== undefined, 'the owned process is spawned')
    const pid = lifecycle.processId
    if (pid === undefined) throw new Error('owned lifecycle reported no process ID after spawn')

    await lifecycle.release()
    expect(start.settled()).toBe(true)
    await gemmaLease.release()

    await coordinator.acquire('qwen3-tts')

    const speech = coordinator.observations.find((observation) => observation.owner === 'qwen3-tts')
    expect(speech?.directorProcess).toBe('gone')
    expect(speech?.directorPortFree).toBe(true)
    expect(processAlive(pid)).toBe(false)
  }, 120_000)
})
