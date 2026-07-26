import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { GenerateAudiobook } from '@light-novel-audiobook/application'
import { FfmpegAudioAssembler } from '@light-novel-audiobook/audio-assembly'
import { DomainEpubExtractor } from '@light-novel-audiobook/epub-ingestion'
import type { DirectorProgressEvent } from '@light-novel-audiobook/gemma-director'
import { GemmaDirectorModel } from '@light-novel-audiobook/gemma-director'
import {
  layoutFor,
  migrateSchema,
  openWorkspace,
  SqliteFallbackApprovalRepository,
  SqliteJobRepository,
} from '@light-novel-audiobook/persistence'
import {
  createQwenSpeechEngineFactory,
  loadProductionConfig,
  QwenTtsSpeechEngine,
} from '@light-novel-audiobook/qwen-tts'
import { type SliceLimits, type SliceReport, SlicingEpubExtractor } from './slice.js'
import type { PipelineTransports } from './transports.js'
import { deriveVoiceCast } from './voice-cast.js'

export interface RunPipelineOptions {
  readonly jobId: string
  readonly epubPath: string
  /** Workspace root for the SQLite database, segment WAVs and exports. Never inside the repository. */
  readonly workspaceRoot: string
  readonly repositoryRoot: string
  readonly transports: PipelineTransports
  readonly limits?: SliceLimits
  /** Character speaker IDs to cast against the pinned character profiles. Empty for narration-only. */
  readonly characterSpeakerIds?: readonly string[]
  readonly confidenceThreshold?: number
  readonly ffmpegDirectory?: string
  /** Direction progress, which #21 needs to surface and a run needs in order to be diagnosable. */
  readonly onDirectorProgress?: (event: DirectorProgressEvent) => void
}

export interface RunPipelineReport {
  readonly mode: 'fake' | 'real'
  readonly jobId: string
  readonly bookId: string
  readonly jobState: string
  readonly jobStage: string
  readonly slice: SliceReport | undefined
  readonly generatedSegments: number
  readonly reusedSegments: number
  readonly outputVersion: number
  readonly m4bPath: string
  readonly m4bBytes: number
  readonly m4bSha256: string
  readonly chapterOutputs: readonly {
    readonly chapterId: string
    readonly path: string
    readonly bytes: number
  }[]
  readonly fallbackWarnings: number
  readonly lifecycleEvents: readonly string[]
  readonly identities: {
    readonly extractor: string
    readonly director: string
    readonly speechEngine: string
    readonly assembler: string
  }
  readonly durationsMs: {
    readonly total: number
  }
}

/**
 * The composition root: all five real adapters, the real `GenerateAudiobook`, one bounded run.
 *
 * Two constraints from the pre-flight audit are honoured here and must stay honoured.
 *
 * 1. **The director is constructed inside this function, per run.** `directBook` always calls
 *    `release()`, which is terminal, so a `GemmaDirectorModel` held as a singleton directs exactly one
 *    book per process — and an in-process retry of the *first* book fails at its first `directChapter`.
 *    Every other adapter is safely reused: Qwen re-arms per batch, the assembler and repository are
 *    stateless per call.
 * 2. **The cast is derived from the pinned Qwen config**, never restated. See `voice-cast.ts`.
 */
export async function runPipeline(options: RunPipelineOptions): Promise<RunPipelineReport> {
  const startedAt = Date.now()
  const { transports } = options

  const epubBytes = new Uint8Array(await readFile(options.epubPath))
  const epubSha256 = createHash('sha256').update(epubBytes).digest('hex')

  // --- persistence: real SQLite in a real workspace
  const layout = layoutFor(options.workspaceRoot)
  const database = openWorkspace(layout)
  migrateSchema(database)
  const jobs = new SqliteJobRepository(layout, database)
  const approvals = new SqliteFallbackApprovalRepository(database)

  // --- extraction: the real extractor, bounded by a decorator at this boundary only
  const extractor = new SlicingEpubExtractor(
    new DomainEpubExtractor({
      workspaceRoot: options.workspaceRoot,
      repositoryRoot: options.repositoryRoot,
    }),
    options.limits ?? {},
  )

  // --- cast: derived from the config the engine validates against
  const production = await loadProductionConfig(
    path.join(options.repositoryRoot, 'config/qwen3-tts-production.json'),
  )
  const { cast, castSpeakerIds, narratorProfileId, fallbackProfileId } = deriveVoiceCast(
    production.value,
    options.characterSpeakerIds ?? [],
  )

  // --- director: fresh per run, because release() is terminal
  const director = new GemmaDirectorModel({
    baseUrl: transports.director.baseUrl,
    apiKey: transports.director.apiKey,
    confidenceThreshold: options.confidenceThreshold ?? 0.5,
    contextProvider: {
      // The story bible does not exist yet, so the cast itself is the context: the director may only
      // attribute dialogue to a speaker this run can actually render.
      // The roster is character speakers only: the director rejects a request whose roster contains
      // the narrator or fallback ID, since those are roles rather than characters.
      forChapter: async () => ({
        speakers: castSpeakerIds.map((id) => ({ id, aliases: [] })),
        narratorSpeakerId: narratorProfileId,
        fallbackSpeakerId: fallbackProfileId,
      }),
    },
    progressStore: {
      append: async (event) => {
        options.onDirectorProgress?.(event)
      },
    },
    lifecycle: transports.director.lifecycle,
    gpuLeaseCoordinator: transports.gpu.coordinator,
    gpuLeaseLockFilePath: transports.gpu.lockFilePath,
  })

  // --- speech: real engine over the selected transport.
  // The snapshot path comes from the transport, never from the workspace: it is where the pinned model
  // weights actually live, and the real Python worker validates that directory against the model lock
  // before `from_pretrained`. A fresh workspace subdirectory would be an empty directory, so real mode
  // would fail at model load. The output directory *is* workspace-shaped, so this owns only that.
  const speechOutputDirectory = path.join(options.workspaceRoot, 'segments')
  await mkdir(speechOutputDirectory, { recursive: true, mode: 0o700 })
  const engine = await QwenTtsSpeechEngine.create({
    pythonExecutable: transports.speech.pythonExecutable,
    workerScriptPath: transports.speech.workerScriptPath,
    productionConfigPath: path.join(options.repositoryRoot, 'config/qwen3-tts-production.json'),
    modelLockPath: path.join(options.repositoryRoot, 'config/qwen3-tts-custom-voice.lock.json'),
    runtimeManifestPath: transports.speech.runtimeManifestPath,
    uvLockPath: path.join(options.repositoryRoot, 'scripts/qwen3-tts-runtime/uv.lock'),
    snapshotPath: transports.speech.modelSnapshotPath,
    outputDirectory: speechOutputDirectory,
    repositoryRoot: options.repositoryRoot,
    gpuGate: transports.gpu.coordinator,
    processEnvironment: transports.speech.processEnvironment,
  })
  const speechEngineFactory = createQwenSpeechEngineFactory(engine)

  // --- assembly: the pinned ffmpeg toolchain, version-checked
  const audioAssembler = await FfmpegAudioAssembler.create(
    options.ffmpegDirectory === undefined ? {} : { toolchainDirectory: options.ffmpegDirectory },
  )

  const useCase = new GenerateAudiobook({
    epubExtractor: extractor,
    directorModelFactory: { identity: director.identity, create: () => director },
    speechEngineFactory,
    audioAssembler,
    jobs,
    approvals,
  })

  try {
    const result = await useCase.execute({
      jobId: options.jobId,
      epubPath: options.epubPath,
      epubSha256,
      voices: cast,
    })

    const chapterOutputs = await Promise.all(
      result.output.chapters.map(async (chapter) => ({
        chapterId: chapter.chapterId,
        path: chapter.path,
        bytes: (await readFile(chapter.path)).byteLength,
      })),
    )
    const m4b = await readFile(result.output.m4bPath)

    return {
      mode: transports.mode,
      jobId: options.jobId,
      bookId: result.job.bookId ?? '',
      jobState: result.job.state,
      jobStage: result.job.stage,
      slice: extractor.report,
      generatedSegments: result.generatedSegments,
      reusedSegments: result.reusedSegments,
      outputVersion: result.output.version.value,
      m4bPath: result.output.m4bPath,
      m4bBytes: m4b.byteLength,
      m4bSha256: createHash('sha256').update(m4b).digest('hex'),
      chapterOutputs,
      fallbackWarnings: result.job.warnings.length,
      lifecycleEvents: [...transports.lifecycleEvents],
      identities: {
        extractor: extractor.identity,
        director: director.identity,
        speechEngine: speechEngineFactory.identity,
        assembler: audioAssembler.identity,
      },
      durationsMs: { total: Date.now() - startedAt },
    }
  } finally {
    database.close()
    await transports.close()
  }
}
