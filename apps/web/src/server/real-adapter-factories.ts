import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { type DirectorModel, withDirectorContentIdentity } from '@light-novel-audiobook/application'
import { FfmpegAudioAssembler } from '@light-novel-audiobook/audio-assembly'
import { DomainEpubExtractor } from '@light-novel-audiobook/epub-ingestion'
import { GemmaDirectorModel } from '@light-novel-audiobook/gemma-director'
import {
  layoutFor,
  migrateSchema,
  openWorkspace,
  SqliteDirectionApprovalRepository,
  SqliteFallbackApprovalRepository,
  SqliteJobRepository,
} from '@light-novel-audiobook/persistence'
import type { PipelineTransports } from '@light-novel-audiobook/pipeline-driver'
import { createQwenSpeechEngineFactory, QwenTtsSpeechEngine } from '@light-novel-audiobook/qwen-tts'
import type { AudiobookAdapterFactories } from './composition-root.js'
import { createDirectorContentIdentity } from './director-content-identity.js'
import type { LocalWorkspace } from './workspace.js'

export interface DirectorFactoryBinding {
  readonly identity: string
  create(): DirectorModel | Promise<DirectorModel>
}

export interface RealAdapterFactoryOptions {
  /** The same workspace the persistence layout and the speech engine's segment output live in. */
  readonly workspace: LocalWorkspace
  readonly repositoryRoot: string
  /**
   * Qwen worker paths and GPU arbitration. Local Gemma mode passes the complete pipeline transport;
   * cloud mode deliberately passes only speech/GPU so no llama lifecycle can be reached.
   */
  readonly transports: Pick<PipelineTransports, 'speech' | 'gpu'> &
    Partial<Pick<PipelineTransports, 'director'>>
  /** Omitted preserves the historical local Gemma factory path byte-for-byte in behavior. */
  readonly director?: DirectorFactoryBinding | undefined
  /**
   * Speaker IDs the director may legitimately emit, i.e. the ones the cast can actually render. The
   * roster excludes narrator/fallback role IDs because Gemma rejects them as character speakers.
   */
  readonly characterSpeakerIds: readonly string[]
  readonly narratorProfileId: string
  readonly fallbackProfileId: string
  /** Cancels the owned Qwen worker when the web process begins a user-requested stop. */
  readonly shutdownSignal?: AbortSignal | undefined
  readonly confidenceThreshold?: number | undefined
}

export interface RealAdapterFactories {
  readonly factories: AudiobookAdapterFactories
  /**
   * Closes the SQLite handle. The composition root holds no other process-lifetime resource: the
   * transports are closed by their owner, and the per-run director lifecycle reaps the llama-server
   * it starts. A long-lived server normally lets the process exit do this; tests should call it.
   */
  close(): void
}

/**
 * The #21 wiring: one factory set per adapter field of `AudiobookAdapterFactories`, composed exactly
 * as `packages/pipeline-driver/src/driver.ts` composes them, over the transports the caller built.
 *
 * The load-bearing rules from the composition-root seam are honoured here, not re-decided:
 *
 * - The director is a **factory called once per generation run**, never a shared instance, and each
 *   model receives a fresh single-use runtime from the transport. Both `GemmaDirectorModel.release()`
 *   and `OwnedLlamaLifecycle.release()` are terminal; neither object may cross run boundaries.
 * - `directorIdentity` is derived from configuration — `createDirectorContentIdentity(settings)`,
 *   which pins `baseUrl` and the GPU lock path out of the hash (issue #54) — and the constructed
 *   director is wrapped in the same value, because `DirectAudiobook` asserts the two agree.
 * - The speech engine is the documented exception: one shared `QwenTtsSpeechEngine`, because
 *   `endBatch()` is not terminal for the real adapter and docs/PLAN.md wants the TTS model to stay
 *   loaded. The factory still builds per book, after that book's approvals are read back.
 * - `jobs` and `approvals` are the real SQLite persistence boundary, opened with
 *   `layoutFor`/`openWorkspace`/`migrateSchema` exactly as the driver does, so a job the driver
 *   wrote is visible here and a review decision made here is visible to the driver.
 */
export const createRealAdapterFactories = async (
  options: RealAdapterFactoryOptions,
): Promise<RealAdapterFactories> => {
  const { workspace, repositoryRoot, transports } = options
  const confidenceThreshold = options.confidenceThreshold ?? 0.5

  // --- persistence: the same SQLite workspace the pipeline driver writes. WAL (enabled by
  // openWorkspace) is what lets this process read while the driver holds the database open.
  const layout = layoutFor(workspace.root)
  const database = openWorkspace(layout)
  migrateSchema(database)
  const jobs = new SqliteJobRepository(layout, database)
  const approvals = new SqliteFallbackApprovalRepository(database)
  const directionApprovals = new SqliteDirectionApprovalRepository(database)

  // --- director: an explicit cloud binding never touches local lifecycle/GPU/port logic. With no
  // binding, preserve the historical local Gemma construction and content-identity behavior.
  let directorIdentity: string
  let createDirectorModel: () => DirectorModel | Promise<DirectorModel>
  if (options.director !== undefined) {
    // Cloud identity is already content-only: no endpoint, key, lifecycle, or lock path is hashed,
    // so it needs no Gemma-style environment-pinning wrapper.
    const cloudDirector = options.director
    directorIdentity = cloudDirector.identity
    createDirectorModel = () => cloudDirector.create()
  } else {
    const localDirector = transports.director
    if (localDirector === undefined) {
      throw new Error('Local Gemma adapter construction requires a director runtime transport')
    }
    const directorSettings = {
      baseUrl: localDirector.baseUrl,
      confidenceThreshold,
      gpuLeaseLockFilePath: transports.gpu.lockFilePath,
    }
    directorIdentity = createDirectorContentIdentity(directorSettings)
    createDirectorModel = async () => {
      const runtime = localDirector.createRuntime()
      try {
        return withDirectorContentIdentity(
          new GemmaDirectorModel({
            baseUrl: localDirector.baseUrl,
            apiKey: runtime.apiKey,
            confidenceThreshold,
            contextProvider: {
              forChapter: async () => ({
                speakers: options.characterSpeakerIds.map((id) => ({ id, aliases: [] })),
                narratorSpeakerId: options.narratorProfileId,
                fallbackSpeakerId: options.fallbackProfileId,
              }),
            },
            progressStore: { append: async () => undefined },
            lifecycle: runtime.lifecycle,
            gpuLeaseCoordinator: transports.gpu.coordinator,
            gpuLeaseLockFilePath: transports.gpu.lockFilePath,
          }),
          directorIdentity,
        )
      } catch (constructionFailure: unknown) {
        try {
          await runtime.lifecycle.release()
        } catch (releaseFailure: unknown) {
          throw new AggregateError(
            [constructionFailure, releaseFailure],
            'Director construction failed and its runtime could not be released',
          )
        }
        throw constructionFailure
      }
    }
  }

  // --- speech: the real engine over the selected transport, shared across runs. The snapshot path
  // comes from the transport, never from the workspace, exactly as in the driver.
  const speechOutputDirectory = path.join(workspace.root, 'segments')
  await mkdir(speechOutputDirectory, { recursive: true, mode: 0o700 })
  const engine = await QwenTtsSpeechEngine.create({
    pythonExecutable: transports.speech.pythonExecutable,
    workerScriptPath: transports.speech.workerScriptPath,
    productionConfigPath: path.join(repositoryRoot, 'config/qwen3-tts-production.json'),
    modelLockPath: path.join(repositoryRoot, 'config/qwen3-tts-custom-voice.lock.json'),
    runtimeManifestPath: transports.speech.runtimeManifestPath,
    uvLockPath: path.join(repositoryRoot, 'scripts/qwen3-tts-runtime/uv.lock'),
    snapshotPath: transports.speech.modelSnapshotPath,
    outputDirectory: speechOutputDirectory,
    repositoryRoot,
    gpuGate: transports.gpu.coordinator,
    processEnvironment: transports.speech.processEnvironment,
  })
  const speechEngineFactory = createQwenSpeechEngineFactory(
    engine,
    options.shutdownSignal === undefined ? {} : { signal: options.shutdownSignal },
  )

  // --- assembly: the pinned ffmpeg toolchain, version-checked. Stateless per call, so shared.
  const audioAssembler = await FfmpegAudioAssembler.create()

  return {
    factories: {
      createDirectorModel,
      directorIdentity,
      createEpubExtractor: () =>
        new DomainEpubExtractor({ workspaceRoot: workspace.root, repositoryRoot }),
      speechEngineFactory,
      approvals,
      directionApprovals,
      createAudioAssembler: () => audioAssembler,
      jobs,
    },
    close: () => {
      database.close()
    },
  }
}
