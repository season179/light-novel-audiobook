import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  type DirectorRuntimeLifecycle,
  GemmaDirectorEndpoint,
} from '@light-novel-audiobook/gemma-director'
import {
  type ExclusiveGpuLeaseCoordinator,
  FileGpuLeaseCoordinator,
  type GpuLease,
  type GpuOwner,
} from '@light-novel-audiobook/gpu-lease'
import { llamaRuntimePaths, llamaServerArgs, OwnedLlamaLifecycle } from './llama-lifecycle.js'

/**
 * Everything about a run that is a *transport* rather than an adapter: where the director's HTTP
 * endpoint is, which Python worker the speech engine spawns, and who arbitrates the GPU.
 *
 * All five adapters are real in both modes. Only these three seams change, which is what lets the
 * same composition root be CI-safe by default and load real models on demand.
 */
export interface PipelineTransports {
  readonly mode: 'fake' | 'real'
  readonly director: {
    readonly baseUrl: string
    readonly apiKey: string
    readonly lifecycle: DirectorRuntimeLifecycle
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
  /** Ordered record of GPU/runtime events, so a run can prove Gemma released before Qwen leased. */
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
 * In-process GPU arbitration for fake mode. Records acquire/release so a run can assert the ordering
 * the audit verified: the director must have released before the speech engine leases, or the two
 * models would be co-resident in VRAM.
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
      release: async () => {
        this.#held = undefined
        this.events.push(`lease:release:${owner}`)
      },
    }
  }
}

/** Records the director runtime's load/unload without ever putting weights anywhere. */
class RecordingLifecycle implements DirectorRuntimeLifecycle {
  constructor(private readonly events: string[]) {}
  async start(): Promise<void> {
    this.events.push('director:start')
  }
  async release(): Promise<void> {
    this.events.push('director:release')
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
      apiKey: 'pipeline-driver-fake-key',
      lifecycle: new RecordingLifecycle(events),
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
  /** Shared with the director so the two models can never be co-resident. */
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

  // Generated per run and passed by file, never on argv, so it cannot leak through the process table.
  const apiKey = randomBytes(32).toString('base64url')
  const keyPath = path.join(config.llamaRuntimeRoot, `.pipeline-driver-key-${process.pid}`)
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

  return {
    mode: 'real',
    director: {
      baseUrl: endpoint.baseUrl,
      apiKey,
      lifecycle: {
        start: async () => {
          await owned.start()
          // Recorded after the process is serving, so the event cannot precede GPU residency.
          events.push(`director:start:pid=${owned.processId ?? 'unknown'}`)
        },
        release: async () => {
          await owned.release()
          // Recorded only after the process has exited and its port is free.
          events.push('director:release:process-exited')
        },
      },
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
    // Safety net: a failure between start() and release() must not leave a model resident.
    close: async () => {
      await owned.release()
    },
  }
}
