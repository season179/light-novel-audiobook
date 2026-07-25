import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DirectorRuntimeLifecycle } from '@light-novel-audiobook/gemma-director'
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
  await mkdir(paths.runtimeDirectory, { recursive: true })
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
  /** llama.cpp OpenAI-compatible base URL, e.g. `http://127.0.0.1:8080/v1`. */
  readonly directorBaseUrl: string
  readonly directorApiKey: string
  /** `uv`-managed interpreter for the pinned Qwen runtime. */
  readonly pythonExecutable: string
  readonly workerScriptPath: string
  readonly runtimeManifestPath: string
  /** Shared with the director so the two models can never be co-resident. */
  readonly gpuLockFilePath: string
}

/**
 * Real transports: a running llama.cpp server, the pinned Python worker, and the real kernel-held GPU
 * lease from `packages/gpu-lease`.
 *
 * The director lifecycle is intentionally a no-op that only records. `DirectorRuntimeLifecycle` is
 * meant to load and unload the runtime, and this driver does not own the llama.cpp process — the
 * launcher does. Starting or stopping someone else's server from here would be the wrong boundary, so
 * the contract is: bring the server up before running, and the GPU lease still serialises Gemma
 * against Qwen because both use the same lock file.
 *
 * Not executed yet: `loadWorkerRuntimeIdentity` currently throws for everyone (issue #59), so the
 * speech engine cannot start in real mode. Nothing here works around that, deliberately — the moment
 * #59 lands this path should work unchanged.
 */
export function createRealTransports(config: RealTransportConfig): PipelineTransports {
  const events: string[] = []
  return {
    mode: 'real',
    director: {
      baseUrl: config.directorBaseUrl,
      apiKey: config.directorApiKey,
      lifecycle: {
        start: async () => {
          events.push('director:start')
        },
        release: async () => {
          events.push('director:release')
        },
      },
    },
    speech: {
      pythonExecutable: config.pythonExecutable,
      workerScriptPath: config.workerScriptPath,
      runtimeManifestPath: config.runtimeManifestPath,
      processEnvironment: {},
    },
    gpu: {
      coordinator: new FileGpuLeaseCoordinator({ lockFilePath: config.gpuLockFilePath }),
      lockFilePath: config.gpuLockFilePath,
    },
    lifecycleEvents: events,
    close: async () => undefined,
  }
}
