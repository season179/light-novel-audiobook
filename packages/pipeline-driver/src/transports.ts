import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  type DirectorRuntimeLifecycle,
  GemmaDirectorEndpoint,
  llamaRuntimePaths,
  llamaServerArgs,
  OwnedLlamaLifecycle,
} from '@light-novel-audiobook/gemma-director'
import {
  type ExclusiveGpuLeaseCoordinator,
  FileGpuLeaseCoordinator,
  type GpuLease,
  type GpuOwner,
} from '@light-novel-audiobook/gpu-lease'

/**
 * Everything about a run that is a *transport* rather than an adapter: where the director's HTTP
 * endpoint is, which Python worker the speech engine spawns, and who arbitrates the GPU.
 *
 * All five adapters are real in both modes. Only these three seams change, which is what lets the
 * same composition root be CI-safe by default and load real models on demand.
 */
export interface DirectorRuntimeTransport {
  /** Per-runtime secret paired with the lifecycle that writes it to llama.cpp's key file. */
  readonly apiKey: string
  /** Single-use by contract: release is terminal and this instance must never be reset. */
  readonly lifecycle: DirectorRuntimeLifecycle
}

export interface PipelineTransports {
  readonly mode: 'fake' | 'real'
  readonly director: {
    readonly baseUrl: string
    /**
     * Constructs one fresh, single-use runtime for each director model. Long-lived web processes call
     * this once per generation; the CLI calls it at most once in its single run.
     */
    createRuntime(): DirectorRuntimeTransport
  }
  readonly speech: {
    readonly pythonExecutable: string
    readonly workerScriptPath: string
    readonly runtimeManifestPath: string
    /**
     * Directory holding the pinned Qwen model snapshot. The transport owns this because it is a
     * property of the runtime, not of the workspace: the real Python worker resolves this exact path,
     * validates its files against `config/qwen3-tts-custom-voice.lock.json` and then calls
     * `from_pretrained` on it, so a fresh workspace subdirectory can never be correct.
     */
    readonly modelSnapshotPath: string
    readonly processEnvironment: Readonly<Record<string, string>>
  }
  readonly gpu: {
    readonly coordinator: ExclusiveGpuLeaseCoordinator
    readonly lockFilePath: string
  }
  /**
   * Ordered record of GPU/runtime events. **Diagnostic only** — these are strings this module chose to
   * push, so they show the order the driver *called* things, and nothing about VRAM. In real mode the
   * list carries the director's start and exit and no Qwen lease acquisition at all, because the speech
   * engine holds the real cross-process lease directly. Evidence that a model unloaded has to come from
   * observed process state; `test/lifecycle-release-race.test.ts` and `test/real-lifecycle-ordering.test.ts`
   * are where that is checked.
   */
  readonly lifecycleEvents: readonly string[]
  close(): Promise<void>
}

export interface TransportPaths {
  /** Scratch directory for anything a transport has to materialise. */
  readonly runtimeDirectory: string
  readonly repositoryRoot: string
}

const FAKE_RUNTIME_MANIFEST = {
  schemaVersion: 1,
  immutable: true,
  pythonVersion: '3.12.13',
  uvLockSha256: '6a7d989924871b408ed0e6eea86ce21ff399033e1272c5fa19bf9a5e38c3bbd9',
  packages: [
    { name: 'qwen-tts', version: '0.1.1' },
    { name: 'torch', version: '2.9.1' },
    { name: 'torchaudio', version: '2.9.1' },
  ],
} as const

/**
 * In-process GPU arbitration for fake mode. Records acquire/release so a run can show the order the
 * lease changed hands.
 *
 * Be precise about what that proves: these are recorded strings, and in fake mode nothing is ever
 * resident, so an ordered event log here is evidence about the *use case's* call order and nothing
 * more. It is not evidence that a model unloaded. That claim needs observed process state, which is
 * what `test/real-lifecycle-ordering.test.ts` checks against a real owned process.
 */
class RecordingGpuCoordinator implements ExclusiveGpuLeaseCoordinator {
  #held: GpuOwner | undefined

  constructor(
    private readonly events: string[],
    readonly lockFilePath: string,
  ) {}

  async acquire(owner: GpuOwner): Promise<GpuLease> {
    if (this.#held !== undefined) {
      throw new Error(`GPU already leased to ${this.#held} while ${owner} asked for it`)
    }
    this.#held = owner
    this.events.push(`lease:acquire:${owner}`)
    return {
      owner,
      lockFilePath: this.lockFilePath,
      quarantine: async (reason) => {
        this.events.push(`lease:quarantine:${owner}:${reason}`)
      },
      release: async () => {
        this.#held = undefined
        this.events.push(`lease:release:${owner}`)
      },
    }
  }
}

/** Records the director runtime's load/unload without ever putting weights anywhere. */
class RecordingLifecycle implements DirectorRuntimeLifecycle {
  #startPromise: Promise<void> | undefined
  #releasePromise: Promise<void> | undefined
  #releasing = false

  constructor(private readonly events: string[]) {}

  start(): Promise<void> {
    this.#startPromise ??= (async () => {
      if (this.#releasing) throw new Error('Fake director runtime cannot start after release')
      this.events.push('director:start')
    })()
    return this.#startPromise
  }

  release(): Promise<void> {
    this.#releasing = true
    this.#releasePromise ??= (async () => {
      this.events.push('director:release')
    })()
    return this.#releasePromise
  }
}

/**
 * CI-safe transports: the request-echoing director endpoint is started by the caller and passed in,
 * the speech engine spawns the committed fake Python worker under the real Node executable, and the
 * GPU is arbitrated in process. No model weights, no GPU, no network beyond loopback.
 */
export async function createFakeTransports(
  paths: TransportPaths,
  directorBaseUrl: string,
): Promise<PipelineTransports> {
  const events: string[] = []
  const runtimeManifestPath = path.join(paths.runtimeDirectory, 'runtime-manifest.json')
  const workerScriptPath = path.join(paths.runtimeDirectory, 'fake-qwen-process.mjs')
  // The fake worker loads no weights, so its snapshot directory is genuinely scratch — but it must
  // exist, because the engine realpaths it. Real mode resolves the pinned snapshot instead.
  const modelSnapshotPath = path.join(paths.runtimeDirectory, 'tts-snapshot')
  await mkdir(paths.runtimeDirectory, { recursive: true })
  await mkdir(modelSnapshotPath, { recursive: true, mode: 0o700 })
  await writeFile(runtimeManifestPath, `${JSON.stringify(FAKE_RUNTIME_MANIFEST)}\n`)
  await copyFile(
    path.join(paths.repositoryRoot, 'packages/qwen-tts/test/fixtures/fake-qwen-process.mjs'),
    workerScriptPath,
  )

  return {
    mode: 'fake',
    director: {
      baseUrl: directorBaseUrl,
      createRuntime: () => ({
        apiKey: 'pipeline-driver-fake-key',
        lifecycle: new RecordingLifecycle(events),
      }),
    },
    speech: {
      pythonExecutable: process.execPath,
      workerScriptPath,
      runtimeManifestPath,
      modelSnapshotPath,
      processEnvironment: { FAKE_QWEN_MODE: 'normal' },
    },
    gpu: {
      coordinator: new RecordingGpuCoordinator(
        events,
        path.join(paths.runtimeDirectory, 'exclusive.lock'),
      ),
      lockFilePath: path.join(paths.runtimeDirectory, 'exclusive.lock'),
    },
    lifecycleEvents: events,
    close: async () => undefined,
  }
}

export interface RealTransportConfig {
  /** Loopback `/v1` URL the owned llama.cpp server binds to, e.g. `http://127.0.0.1:8080/v1`. */
  readonly directorBaseUrl: string
  /** Built brain runtime: `<root>/llama.cpp/build/bin/llama-server` and `<root>/models/<gguf>`. */
  readonly llamaRuntimeRoot: string
  /** `uv`-managed interpreter for the pinned Qwen runtime. */
  readonly pythonExecutable: string
  readonly workerScriptPath: string
  readonly runtimeManifestPath: string
  /** Pinned Qwen snapshot directory. See {@link resolveDefaultModelSnapshotPath}. */
  readonly modelSnapshotPath: string
  /**
   * Shared with the director, so the two models cannot hold the GPU at the same time. Note that the
   * lock alone does not prevent co-residency: it only transfers the *right* to load. What keeps Gemma
   * out of VRAM once the lease moves on is `OwnedLlamaLifecycle` reaping the server before release.
   */
  readonly gpuLockFilePath: string
  readonly startupTimeoutMs?: number
}

async function assertDirectory(candidate: string, what: string): Promise<void> {
  const stats = await stat(candidate).catch(() => undefined)
  if (stats === undefined || !stats.isDirectory()) {
    throw new Error(`${what} is not a directory: ${candidate}`)
  }
}

async function assertExecutable(candidate: string, what: string): Promise<void> {
  const stats = await stat(candidate).catch(() => undefined)
  if (stats === undefined || !stats.isFile() || (stats.mode & 0o111) === 0) {
    throw new Error(`${what} is not an executable file: ${candidate}`)
  }
}

/**
 * The pinned Qwen snapshot location, derived from the lock rather than restated: the extension script
 * installs it at `<data root>/models/tts/qwen3-tts-custom-voice/<model.revision>/snapshot`, and the
 * revision is whatever `config/qwen3-tts-custom-voice.lock.json` pins. Deriving it means a lock bump
 * moves this default automatically instead of silently pointing at a stale revision.
 */
export async function resolveDefaultModelSnapshotPath(repositoryRoot: string): Promise<string> {
  const lockPath = path.join(repositoryRoot, 'config/qwen3-tts-custom-voice.lock.json')
  const lock = JSON.parse(await readFile(lockPath, 'utf8')) as { model?: { revision?: unknown } }
  const revision = lock.model?.revision
  if (typeof revision !== 'string' || !/^[a-f0-9]{40}$/.test(revision)) {
    throw new Error(`Pinned Qwen lock has no usable model revision: ${lockPath}`)
  }
  const dataRoot =
    process.env.QWEN3_TTS_DATA_ROOT ??
    path.join(
      process.env.XDG_DATA_HOME ?? path.join(homedir(), '.local/share'),
      'light-novel-audiobook',
    )
  return path.join(dataRoot, 'models/tts/qwen3-tts-custom-voice', revision, 'snapshot')
}

/**
 * Real transports: an *owned* llama.cpp server, the pinned Python worker against the pinned model
 * snapshot, and the real kernel-held GPU lease from `packages/gpu-lease`.
 *
 * The director lifecycle owns the llama.cpp process on purpose, and this is the load-bearing detail of
 * real mode. `GemmaDirectorModel` calls `start()` only while it holds the exclusive lease and
 * `release()` before dropping it, so spawning and reaping the server at those two points is what makes
 * VRAM residency inseparable from the lease. Sharing one lock file is *not* sufficient on its own: if
 * the server outlives `release()`, the lease passes to Qwen while Gemma is still resident and both
 * models sit in VRAM together. `OwnedLlamaLifecycle.release()` therefore waits for actual process exit
 * and a free port before returning.
 */
export async function createRealTransports(
  config: RealTransportConfig,
): Promise<PipelineTransports> {
  const events: string[] = []
  const endpoint = new GemmaDirectorEndpoint(config.directorBaseUrl)
  const { binaryPath, modelPath } = llamaRuntimePaths(config.llamaRuntimeRoot)

  await assertExecutable(binaryPath, 'Owned llama-server binary')
  await assertDirectory(config.modelSnapshotPath, 'Pinned Qwen model snapshot')
  const modelStats = await stat(modelPath).catch(() => undefined)
  if (modelStats === undefined || !modelStats.isFile()) {
    throw new Error(`Pinned Gemma model file is missing: ${modelPath}`)
  }

  // A transport may live for the whole web process, but every owned lifecycle remains single-use.
  // Track the currently unreleased instances so one set of process guards can reap any of them
  // without accumulating signal listeners after many generations.
  const ownedLifecycles = new Set<OwnedLlamaLifecycle>()
  let runtimeSequence = 0
  let closePromise: Promise<void> | undefined
  let closed = false

  const releaseAll = async (): Promise<void> => {
    const results = await Promise.allSettled(
      [...ownedLifecycles].map(async (owned) => {
        await owned.release()
        ownedLifecycles.delete(owned)
      }),
    )
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason)
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more owned director runtimes failed to release')
    }
  }

  // Last-ditch orphan guard. The lifecycle's own paths cover success and failure, and a terminal
  // Ctrl-C reaches the server through the process group; but a SIGTERM aimed at this process
  // alone, or an unhandled rejection, kills the host without touching children whose stdio is
  // 'ignore'. One process-level guard covers every per-run lifecycle. The 'exit' hook cannot run
  // under SIGKILL; that residual needs a parent-death signal llama-server does not have.
  const killOrphanedServers = () => {
    for (const owned of ownedLifecycles) {
      const pid = owned.processId
      if (!owned.running || pid === undefined) continue
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
  }
  const signalHandlers = new Map<NodeJS.Signals, () => void>()
  process.once('exit', killOrphanedServers)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const handler = () => {
      const relay = () => {
        // Only re-raise when no other listener remains: a host with its own shutdown must not be
        // killed mid-cleanup by this guard.
        if (process.listenerCount(signal) === 0) process.kill(process.pid, signal)
      }
      void releaseAll().then(relay, relay)
    }
    signalHandlers.set(signal, handler)
    process.once(signal, handler)
  }

  const detachProcessGuards = (): void => {
    process.removeListener('exit', killOrphanedServers)
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler)
  }

  const createRuntime = (): DirectorRuntimeTransport => {
    if (closed) throw new Error('Real director transports have been closed')
    runtimeSequence += 1
    // Generated per runtime and passed by file, never on argv, so it cannot leak through the process
    // table. A sequence makes queued instances non-colliding even though the GPU lease serializes
    // their eventual starts.
    const apiKey = randomBytes(32).toString('base64url')
    const keyPath = path.join(
      config.llamaRuntimeRoot,
      `.pipeline-driver-key-${process.pid}-${runtimeSequence}`,
    )
    const owned = new OwnedLlamaLifecycle({
      binaryPath,
      args: llamaServerArgs({
        modelPath,
        host: endpoint.host,
        port: endpoint.port,
        keyPath,
      }),
      apiKey,
      keyPath,
      origin: endpoint.origin,
      port: endpoint.port,
      startupTimeoutMs: config.startupTimeoutMs ?? 600_000,
    })
    ownedLifecycles.add(owned)
    let startPromise: Promise<void> | undefined
    let releasePromise: Promise<void> | undefined

    return {
      apiKey,
      lifecycle: {
        start: () => {
          startPromise ??= owned.start().then(() => {
            // Recorded after the process is serving, so the event cannot precede GPU residency.
            events.push(`director:start:pid=${owned.processId ?? 'unknown'}`)
          })
          return startPromise
        },
        release: () => {
          releasePromise ??= owned.release().then(() => {
            ownedLifecycles.delete(owned)
            // Recorded only after the process has exited and its port is free.
            events.push('director:release:process-exited')
          })
          return releasePromise
        },
      },
    }
  }

  return {
    mode: 'real',
    director: {
      baseUrl: endpoint.baseUrl,
      createRuntime,
    },
    speech: {
      pythonExecutable: config.pythonExecutable,
      workerScriptPath: config.workerScriptPath,
      runtimeManifestPath: config.runtimeManifestPath,
      modelSnapshotPath: config.modelSnapshotPath,
      processEnvironment: {},
    },
    gpu: {
      coordinator: new FileGpuLeaseCoordinator({ lockFilePath: config.gpuLockFilePath }),
      lockFilePath: config.gpuLockFilePath,
    },
    lifecycleEvents: events,
    // Safety net: a failure between runtime construction, start, and model release must not leave a
    // child resident. The CLI calls this after its one run; a long-lived web host relies on each
    // model's release plus the process guards above.
    close: () => {
      closed = true
      closePromise ??= releaseAll().then(() => {
        detachProcessGuards()
      })
      return closePromise
    },
  }
}
