import type { ChildProcess } from 'node:child_process'
import type { Mode, PathLike } from 'node:fs'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { OwnedLlamaLifecycle as SharedOwnedLlamaLifecycle } from '@light-novel-audiobook/gemma-director'
import { FileGpuLeaseCoordinator, type GpuLease } from '@light-novel-audiobook/gpu-lease'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OwnedLlamaLifecycle as DriverReExportedLifecycle } from '../src/index.js'

const spawnProbe = vi.hoisted(() => {
  let onSpawn: ((child: ChildProcess) => void) | undefined
  let count = 0
  const pids: number[] = []
  return {
    arm(callback?: (child: ChildProcess) => void): void {
      onSpawn = callback
      count = 0
      pids.length = 0
    },
    reset(): void {
      onSpawn = undefined
      count = 0
      pids.length = 0
    },
    record(child: ChildProcess): void {
      count += 1
      if (child.pid !== undefined) pids.push(child.pid)
      onSpawn?.(child)
    },
    count: (): number => count,
    pids: (): readonly number[] => [...pids],
  }
})

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (...args: unknown[]): ChildProcess => {
      const child = Reflect.apply(actual.spawn, undefined, args) as ChildProcess
      spawnProbe.record(child)
      return child
    },
  }
})

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
    reset(): void {
      openBarrier?.()
      armedPath = undefined
      announceReached = undefined
      openBarrier = undefined
      opened = undefined
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

interface LifecycleOptions {
  readonly binaryPath: string
  readonly args: readonly string[]
  readonly apiKey: string
  readonly keyPath: string
  readonly origin: string
  readonly port: number
  readonly startupTimeoutMs: number
  readonly terminateTimeoutMs?: number
  readonly killTimeoutMs?: number
  readonly portFreeTimeoutMs?: number
  readonly startupSettleTimeoutMs?: number
}

interface LifecycleSubject {
  readonly processId: number | undefined
  readonly running: boolean
  readonly cleanupComplete: boolean
  start(): Promise<void>
  release(): Promise<void>
}

type LifecycleFactory = (options: LifecycleOptions) => LifecycleSubject

const STUB = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/stub-llama-server.mjs',
)
const API_KEY = 'shared-lifecycle-contract-key'
const roots: string[] = []
const lifecycles: LifecycleSubject[] = []
const leases: GpuLease[] = []
const servers: Server[] = []

const delay = async (ms: number): Promise<void> =>
  await new Promise<void>((resolve) => setTimeout(resolve, ms))

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  if (address === null || typeof address === 'string') throw new Error('probe has no TCP address')
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error === undefined ? resolve() : reject(error))),
  )
  return address.port
}

async function portIsFree(port: number): Promise<boolean> {
  const probe = createServer()
  return await new Promise<boolean>((resolve) => {
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => {
      probe.close((error) => resolve(error === undefined))
    })
  })
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!(await condition())) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${description}`)
    await delay(10)
  }
}

/**
 * Bounds a wait on an event the implementation is expected to produce, and fails naming the event if
 * it never arrives — so a test that synchronises on an observation cannot instead hang to the suite
 * timeout. Bounded with a duration timer rather than a deadline, so it reads no clock.
 */
async function awaited(
  event: Promise<void>,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      event,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function scratch(label: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `lifecycle-contract-${label}-`))
  roots.push(root)
  return root
}

interface BuiltSubject {
  readonly lifecycle: LifecycleSubject
  readonly root: string
  readonly keyPath: string
  readonly port: number
  readonly options: LifecycleOptions
}

async function buildSubject(
  factory: LifecycleFactory,
  label: string,
  options: {
    readonly extraArgs?: readonly string[]
    readonly startupSettleTimeoutMs?: number
    readonly portFreeTimeoutMs?: number
  } = {},
): Promise<BuiltSubject> {
  const root = await scratch(label)
  const port = await freePort()
  const keyPath = path.join(root, 'api-key')
  const lifecycleOptions: LifecycleOptions = {
    binaryPath: process.execPath,
    args: [STUB, String(port), 'http://127.0.0.1:9/unreachable', ...(options.extraArgs ?? [])],
    apiKey: API_KEY,
    keyPath,
    origin: `http://127.0.0.1:${port}`,
    port,
    startupTimeoutMs: 10_000,
    terminateTimeoutMs: 1_000,
    killTimeoutMs: 2_000,
    portFreeTimeoutMs: options.portFreeTimeoutMs ?? 2_000,
    startupSettleTimeoutMs: options.startupSettleTimeoutMs ?? 2_000,
  }
  const lifecycle = factory(lifecycleOptions)
  lifecycles.push(lifecycle)
  return { lifecycle, root, keyPath, port, options: lifecycleOptions }
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )
}

afterEach(async () => {
  chmodGate.reset()
  spawnProbe.reset()
  for (const lease of leases.splice(0)) await lease.release().catch(() => undefined)
  for (const lifecycle of lifecycles.splice(0)) {
    await lifecycle.release().catch(() => undefined)
    const pid = lifecycle.processId
    if (pid !== undefined && processAlive(pid)) {
      process.kill(pid, 'SIGKILL')
      await waitUntil(() => !processAlive(pid), `mutant child ${pid} to exit`).catch(
        () => undefined,
      )
    }
  }
  for (const server of servers.splice(0)) await closeServer(server).catch(() => undefined)
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/**
 * There is exactly **one** `OwnedLlamaLifecycle`, so the eight properties below run against it once.
 *
 * Until issue/lifecycle-dedup this file looped over two independently written copies — one in
 * gemma-director, one in pipeline-driver — because #53 was believed to have consolidated them and had
 * not. That loop is gone rather than kept over a single element: a loop labelled `consumers` reads as
 * though it still compares two things, and a suite that quietly became half a test is worse than a
 * smaller honest one.
 *
 * What replaces the comparison is test `0.` below **together with**
 * `lifecycle-single-owner.test.ts`. Test `0.` alone is not enough, and the review of
 * issue/lifecycle-dedup proved it: restoring the local copy while leaving `src/index.ts` re-exporting
 * the shared class and pointing only `src/transports.ts` at the local one passes all nine tests here.
 * The guard on the class real runs actually construct lives in that other file; keep them together.
 */
const consumer = {
  name: 'the one OwnedLlamaLifecycle both consumers use',
  factory: (options: LifecycleOptions): LifecycleSubject => new SharedOwnedLlamaLifecycle(options),
}

describe('DirectorRuntimeLifecycle contract: single implementation', () => {
  /**
   * Half of the guard that replaces the old two-copy loop: pipeline-driver's **public export** is
   * gemma-director's class rather than a redefinition.
   *
   * What it does *not* prove is that `createRealTransports` constructs that export — the production
   * binding is a separate direct import in `src/transports.ts`, and a reintroduced copy wired only
   * there passes this assertion. `lifecycle-single-owner.test.ts` covers that, by observing the
   * construction real mode performs and by counting class definitions.
   *
   * It is an identity check, not a behavioural one, and that is deliberate: two *different* objects
   * cannot be proved equivalent by any assertion cheap enough to keep, which is precisely why the
   * duplication had to be deleted rather than tested around.
   */
  it('0. is a single class, re-exported rather than redefined by pipeline-driver', () => {
    expect(DriverReExportedLifecycle).toBe(SharedOwnedLlamaLifecycle)
  })
})

describe(`DirectorRuntimeLifecycle contract: ${consumer.name}`, () => {
  it('1. sets releasing synchronously before the first await', async () => {
    const built = await buildSubject(consumer.factory, 'sync-release')
    let keyPathReads = 0
    const guardedOptions = {
      ...built.options,
      get keyPath(): string {
        keyPathReads += 1
        return built.keyPath
      },
    }
    const lifecycle = consumer.factory(guardedOptions)
    lifecycles.push(lifecycle)

    const released = lifecycle.release()
    const started = lifecycle.start()
    // `start()` itself runs synchronously to its first await. A delayed releasing assignment lets it
    // read keyPath and begin the write before release has closed the gate.
    expect(keyPathReads).toBe(0)
    await expect(started).rejects.toThrow(/release had already begun/)
    await expect(released).resolves.toBeUndefined()
    expect(lifecycle.cleanupComplete).toBe(true)
  })

  it('2. reaps a current child before waiting for startup settlement', async () => {
    const built = await buildSubject(consumer.factory, 'reap-before-wait', {
      extraArgs: ['--health-unready-ms=120000'],
      startupSettleTimeoutMs: 1_500,
    })
    const coordinator = new FileGpuLeaseCoordinator({
      lockFilePath: path.join(built.root, 'exclusive.lock'),
      inspectExistingComputeProcesses: false,
    })
    const gemmaLease = await coordinator.acquire('gemma')
    leases.push(gemmaLease)
    const started = built.lifecycle.start()
    await waitUntil(() => built.lifecycle.processId !== undefined, 'the child to spawn')
    const pid = built.lifecycle.processId
    if (pid === undefined) throw new Error('spawned lifecycle has no process ID')
    expect(processAlive(pid)).toBe(true)

    const released = built.lifecycle.release()
    await expect(started).rejects.toThrow(/exited during model load/)
    await expect(released).resolves.toBeUndefined()
    expect(processAlive(pid)).toBe(false)
    await gemmaLease.release()

    const qwenLease = await coordinator.acquire('qwen3-tts')
    leases.push(qwenLease)
    expect(processAlive(pid)).toBe(false)
    expect(await portIsFree(built.port)).toBe(true)
  })

  it('3. awaits startup settlement and counts a failed start as settled', async () => {
    const built = await buildSubject(consumer.factory, 'await-start')
    const barrier = chmodGate.arm(built.keyPath)
    const started = built.lifecycle.start()
    await barrier.reached

    let releaseSettled = false
    const released = built.lifecycle.release().finally(() => {
      releaseSettled = true
    })
    await delay(100)
    expect(releaseSettled).toBe(false)

    barrier.open()
    await expect(started).rejects.toThrow(/release had already begun/)
    await expect(released).resolves.toBeUndefined()
    expect(built.lifecycle.cleanupComplete).toBe(true)
  })

  it('4. reaps again after a start that spawned during the first reap snapshot', async () => {
    const built = await buildSubject(consumer.factory, 'second-reap', {
      portFreeTimeoutMs: 300,
    })
    let releaseFromSpawn: Promise<void> | undefined
    spawnProbe.arm(() => {
      releaseFromSpawn ??= built.lifecycle.release()
      void releaseFromSpawn.catch(() => undefined)
    })

    await expect(built.lifecycle.start()).resolves.toBeUndefined()
    expect(releaseFromSpawn).toBeDefined()
    await expect(releaseFromSpawn).resolves.toBeUndefined()
    const pid = spawnProbe.pids()[0]
    if (pid === undefined) throw new Error('spawn probe observed no child PID')
    expect(processAlive(pid)).toBe(false)
    expect(await portIsFree(built.port)).toBe(true)
    expect(built.lifecycle.cleanupComplete).toBe(true)
  })

  it('5. removes the key, requires a free port, then marks cleanup complete', async () => {
    const built = await buildSubject(consumer.factory, 'cleanup-order')
    await writeFile(built.keyPath, `${API_KEY}\n`, { mode: 0o600 })
    const blocker = createServer()
    servers.push(blocker)
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject)
      blocker.listen(built.port, '127.0.0.1', resolve)
    })

    let releaseSettled = false
    const released = built.lifecycle.release().finally(() => {
      releaseSettled = true
    })
    await waitUntil(
      async () =>
        await stat(built.keyPath).then(
          () => false,
          (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
        ),
      'the API key to be removed',
    )
    expect(releaseSettled).toBe(false)
    expect(built.lifecycle.cleanupComplete).toBe(false)
    expect(await portIsFree(built.port)).toBe(false)

    await closeServer(blocker)
    await expect(released).resolves.toBeUndefined()
    expect(await portIsFree(built.port)).toBe(true)
    expect(built.lifecycle.cleanupComplete).toBe(true)
  })

  it('6. performs the final releasing check and spawn in one synchronous step', async () => {
    const built = await buildSubject(consumer.factory, 'check-adjacent', {
      extraArgs: ['--health-unready-ms=120000'],
    })
    let lifecycle: LifecycleSubject | undefined
    let releaseStarted = false
    let released: Promise<void> | undefined
    let spawnSawRelease = false
    const queuedReleaseOperand = {
      toString(): string {
        queueMicrotask(() => {
          releaseStarted = true
          released ??= (lifecycle as LifecycleSubject).release()
          void released.catch(() => undefined)
        })
        return STUB
      },
    }
    const options = {
      ...built.options,
      args: [
        queuedReleaseOperand,
        String(built.port),
        'http://127.0.0.1:9/unreachable',
        '--health-unready-ms=120000',
      ] as unknown as readonly string[],
    }
    lifecycle = consumer.factory(options)
    lifecycles.push(lifecycle)
    // Resolved from inside the recorded spawn, so the assertion below can only run once a spawn has
    // actually been observed. Asserting `spawnSawRelease` without this synchronisation would pass
    // vacuously whenever it ran before the first spawn.
    let firstSpawnObserved: (() => void) | undefined
    const firstSpawn = new Promise<void>((resolve) => {
      firstSpawnObserved = resolve
    })
    spawnProbe.arm(() => {
      spawnSawRelease = releaseStarted
      firstSpawnObserved?.()
    })

    const started = lifecycle.start()
    // Attached before the first await so a rejection that arrives while we wait is never unhandled.
    void started.catch(() => undefined)

    // Ordered so the failure names the defect. An `await` inserted between the final releasing check
    // and the spawn lets the queued release land first; the downstream symptom is a child spawned
    // after release began, never reaped, so startup times out ~10 s later. Awaiting `started` first
    // reported that timeout and masked the ordering violation that caused it.
    await awaited(
      firstSpawn,
      'the lifecycle never spawned a child, so nothing observed the ordering',
    )
    expect(
      spawnSawRelease,
      'release began before spawn: the final releasing check and the spawn were separated by an await',
    ).toBe(false)

    await expect(started).rejects.toThrow(/exited during model load/)
    await expect(released).resolves.toBeUndefined()
    expect(spawnProbe.count()).toBe(1)
    expect(lifecycle.cleanupComplete).toBe(true)
  })

  it('7. reads and coerces every spawn operand before the final releasing check', async () => {
    const cases: readonly {
      readonly label: string
      readonly options: (base: LifecycleOptions, beginRelease: () => void) => LifecycleOptions
    }[] = [
      {
        label: 'binaryPath getter',
        options: (base, beginRelease) => ({
          ...base,
          get binaryPath(): string {
            beginRelease()
            return process.execPath
          },
        }),
      },
      {
        label: 'args getter',
        options: (base, beginRelease) => ({
          ...base,
          get args(): readonly string[] {
            beginRelease()
            return base.args
          },
        }),
      },
      {
        label: 'args iterator',
        options: (base, beginRelease) => ({
          ...base,
          args: {
            *[Symbol.iterator](): Iterator<string> {
              beginRelease()
              yield* base.args
            },
          } as readonly string[],
        }),
      },
      {
        label: 'argument coercion',
        options: (base, beginRelease) => ({
          ...base,
          args: [
            {
              toString(): string {
                beginRelease()
                return STUB
              },
            },
            ...base.args.slice(1),
          ] as unknown as readonly string[],
        }),
      },
    ]

    for (const testCase of cases) {
      const built = await buildSubject(consumer.factory, `operand-${testCase.label}`)
      let lifecycle: LifecycleSubject | undefined
      let released: Promise<void> | undefined
      let hookCalls = 0
      const beginRelease = (): void => {
        hookCalls += 1
        released ??= (lifecycle as LifecycleSubject).release()
        void released.catch(() => undefined)
      }
      lifecycle = consumer.factory(testCase.options(built.options, beginRelease))
      lifecycles.push(lifecycle)
      spawnProbe.arm()

      await expect(lifecycle.start(), testCase.label).rejects.toThrow(/release had already begun/)
      await expect(released, testCase.label).resolves.toBeUndefined()
      expect(hookCalls, testCase.label).toBe(1)
      expect(spawnProbe.count(), testCase.label).toBe(0)
      expect(lifecycle.cleanupComplete, testCase.label).toBe(true)
    }
  })

  it('8. bounds startup settlement and leaves cleanup incomplete on expiry', async () => {
    const built = await buildSubject(consumer.factory, 'settle-bound', {
      startupSettleTimeoutMs: 75,
    })
    const barrier = chmodGate.arm(built.keyPath)
    const started = built.lifecycle.start()
    void started.catch(() => undefined)
    await barrier.reached

    const releaseStartedAt = performance.now()
    await expect(built.lifecycle.release()).rejects.toThrow(/had not settled 75ms/)
    expect(performance.now() - releaseStartedAt).toBeLessThan(2_000)
    expect(built.lifecycle.cleanupComplete).toBe(false)

    barrier.open()
    await expect(started).rejects.toThrow()
    expect(built.lifecycle.processId).toBeUndefined()
  })
})
