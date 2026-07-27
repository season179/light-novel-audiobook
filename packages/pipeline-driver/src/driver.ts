import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  characterSharesFallbackMaterial,
  DirectAudiobook,
  RenderAudiobook,
  ReviewDirection,
  type ReviewerIdentity,
  withDirectorContentIdentity,
} from '@light-novel-audiobook/application'
import { FfmpegAudioAssembler } from '@light-novel-audiobook/audio-assembly'
import { DomainError } from '@light-novel-audiobook/domain'
import { DomainEpubExtractor } from '@light-novel-audiobook/epub-ingestion'
import {
  createGemmaDirectorContentIdentity,
  type DirectorProgressEvent,
  type DirectorRequestReceipt,
  GemmaDirectorModel,
} from '@light-novel-audiobook/gemma-director'
import {
  layoutFor,
  migrateSchema,
  openWorkspace,
  SqliteCastApprovalRepository,
  SqliteDirectionApprovalRepository,
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
  readonly confidenceThreshold?: number
  readonly ffmpegDirectory?: string
  /** Direction progress, which #21 needs to surface and a run needs in order to be diagnosable. */
  readonly onDirectorProgress?: (event: DirectorProgressEvent) => void
  /** Content-free HTTP receipts for local provenance evidence; never receives model prose. */
  readonly onDirectorRequestReceipt?:
    | ((receipt: DirectorRequestReceipt) => void | Promise<void>)
    | undefined
  /**
   * Fake-only roster override for review-gate acceptance. It lets the fake director name a speaker
   * deliberately absent from the render cast, producing a real `missing_speaker_voice` decision.
   * Real transports reject it; production direction always receives exactly the approved cast.
   */
  readonly fakeDirectorSpeakers?:
    | readonly { readonly id: string; readonly aliases: readonly string[] }[]
    | undefined
}

export interface RunPipelineReport {
  readonly operation: 'direction' | 'confirmed-render'
  readonly mode: 'fake' | 'real'
  readonly jobId: string
  readonly bookId: string
  readonly jobState: string
  readonly jobStage: string
  readonly slice: SliceReport | undefined
  readonly generatedSegments: number
  readonly reusedSegments: number
  readonly outputVersion: number | null
  readonly m4bPath: string | null
  readonly m4bBytes: number | null
  readonly m4bSha256: string | null
  readonly chapterOutputs: readonly {
    readonly chapterId: string
    readonly path: string
    readonly bytes: number
  }[]
  readonly fallbackWarnings: number
  readonly cast: {
    readonly approvalId: string | null
    readonly characterCount: number
    readonly distinctMaterialCount: number
    readonly sharedMaterialGroupCount: number
    readonly characterSharesFallbackMaterial: boolean
  }
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
 * The composition root for explicit Stage A direction. It always reports success at review and
 * never requires or produces an M4B.
 *
 * Two constraints from the pre-flight audit are honoured here and must stay honoured.
 *
 * 1. **The director factory constructs lazily, per direction stage.** `directBook` always calls
 *    `release()`, which is terminal, while a render-stage resume must not construct or call Gemma.
 *    Every other adapter is safely reused: Qwen re-arms per batch, the assembler and repository are
 *    stateless per call.
 * 2. **The cast is derived from the pinned Qwen config**, never restated. See `voice-cast.ts`.
 */
export async function runPipeline(options: RunPipelineOptions): Promise<RunPipelineReport> {
  return executePipeline(options, 'direction')
}

/** Explicit Stage B operation: confirm the exact persisted script, then render it. */
export async function runConfirmedRender(
  options: RunPipelineOptions,
  reviewer: ReviewerIdentity,
): Promise<RunPipelineReport> {
  return executePipeline(options, 'confirmed-render', reviewer)
}

async function executePipeline(
  options: RunPipelineOptions,
  operation: 'direction' | 'confirmed-render',
  reviewer?: ReviewerIdentity,
): Promise<RunPipelineReport> {
  // Monotonic on purpose: Date.now() runs backward on some hosts, and a negative total in the
  // report is how that surfaces.
  const startedAt = performance.now()
  const { transports } = options
  if (options.fakeDirectorSpeakers !== undefined && transports.mode !== 'fake') {
    throw new Error('A fake director speaker override cannot be used with real transports')
  }

  const epubBytes = new Uint8Array(await readFile(options.epubPath))
  const epubSha256 = createHash('sha256').update(epubBytes).digest('hex')

  // --- persistence: real SQLite in a real workspace
  const layout = layoutFor(options.workspaceRoot)
  const database = openWorkspace(layout)
  migrateSchema(database)
  const jobs = new SqliteJobRepository(layout, database)
  const approvals = new SqliteFallbackApprovalRepository(database)
  const directionApprovals = new SqliteDirectionApprovalRepository(database)
  const castApprovals = new SqliteCastApprovalRepository(database)
  const castApproval = await castApprovals.findCastApproval(epubSha256)

  // --- extraction: the real extractor, bounded by a decorator at this boundary only
  const slicedExtractor = new SlicingEpubExtractor(
    new DomainEpubExtractor({
      workspaceRoot: options.workspaceRoot,
      repositoryRoot: options.repositoryRoot,
    }),
    options.limits ?? {},
  )
  const extractor = {
    identity: slicedExtractor.identity,
    extract: async (request: { readonly epubPath: string }) => {
      const book = await slicedExtractor.extract(request)
      if (castApproval !== undefined && castApproval.bookId !== book.id) {
        throw new DomainError('The approved cast belongs to a different extracted book identity')
      }
      return book
    },
  }

  // --- cast: derived from the config the engine validates against
  const production = await loadProductionConfig(
    path.join(options.repositoryRoot, 'config/qwen3-tts-production.json'),
  )
  const { cast, castSpeakers, narratorProfileId, fallbackProfileId, sharedMaterialGroups } =
    deriveVoiceCast(production.value, castApproval?.assignments ?? [])

  // --- director: constructed only if a draft chapter actually needs direction. Its command
  // identity binds content settings, not the movable loopback port or GPU lock path.
  const directorIdentity = createGemmaDirectorContentIdentity({
    baseUrl: transports.director.baseUrl,
    confidenceThreshold: options.confidenceThreshold ?? 0.5,
    gpuLeaseLockFilePath: transports.gpu.lockFilePath,
  })
  const directorModelFactory = {
    identity: directorIdentity,
    create: async () => {
      // The CLI is single-run, so this factory is called at most once. It still consumes the same
      // per-model runtime seam as the long-lived web composition, preserving one lifecycle owner and
      // all transport-level signal/orphan guards without retaining a resettable runtime.
      const runtime = transports.director.createRuntime()
      try {
        return withDirectorContentIdentity(
          new GemmaDirectorModel({
            baseUrl: transports.director.baseUrl,
            apiKey: runtime.apiKey,
            confidenceThreshold: options.confidenceThreshold ?? 0.5,
            contextProvider: {
              // Production uses the cast itself as context, so every named speaker is renderable.
              // Fake review-gate acceptance may deliberately inject an uncast context speaker to
              // exercise `missing_speaker_voice`. Narrator/fallback role IDs remain excluded.
              forChapter: async () => ({
                speakers: options.fakeDirectorSpeakers ?? castSpeakers,
                narratorSpeakerId: narratorProfileId,
                fallbackSpeakerId: fallbackProfileId,
              }),
            },
            progressStore: {
              append: async (event) => {
                options.onDirectorProgress?.(event)
              },
            },
            onRequestReceipt: options.onDirectorRequestReceipt,
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
    },
  }

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

  try {
    let result: {
      readonly job: Awaited<ReturnType<DirectAudiobook['execute']>>['job']
      readonly generatedSegments: number
      readonly reusedSegments: number
      readonly output?: Awaited<ReturnType<RenderAudiobook['execute']>>['output']
    }
    if (operation === 'direction') {
      const direction = new DirectAudiobook({
        epubExtractor: extractor,
        directorModelFactory,
        speechEngineFactory,
        audioAssembler,
        jobs,
      })
      const directed = await direction.execute({
        jobId: options.jobId,
        epubPath: options.epubPath,
        epubSha256,
        voices: cast,
      })
      result = { job: directed.job, generatedSegments: 0, reusedSegments: 0 }
    } else {
      if (reviewer === undefined) throw new DomainError('Confirmed render requires a reviewer')
      await new ReviewDirection({ jobs, approvals: directionApprovals }).confirm({
        jobId: options.jobId,
        decidedBy: reviewer,
      })
      result = await new RenderAudiobook({
        speechEngineFactory,
        audioAssembler,
        jobs,
        approvals,
        directionApprovals,
      }).execute({ jobId: options.jobId, voices: cast })
    }

    const chapterOutputs =
      result.output === undefined
        ? []
        : await Promise.all(
            result.output.chapters.map(async (chapter) => ({
              chapterId: chapter.chapterId,
              path: chapter.path,
              bytes: (await readFile(chapter.path)).byteLength,
            })),
          )
    const m4b = result.output === undefined ? undefined : await readFile(result.output.m4bPath)

    return {
      operation,
      mode: transports.mode,
      jobId: options.jobId,
      bookId: result.job.bookId ?? '',
      jobState: result.job.state,
      jobStage: result.job.stage,
      slice: slicedExtractor.report,
      generatedSegments: result.generatedSegments,
      reusedSegments: result.reusedSegments,
      outputVersion: result.output?.version.value ?? null,
      m4bPath: result.output?.m4bPath ?? null,
      m4bBytes: m4b?.byteLength ?? null,
      m4bSha256: m4b === undefined ? null : createHash('sha256').update(m4b).digest('hex'),
      chapterOutputs,
      fallbackWarnings: result.job.warnings.length,
      cast: {
        approvalId: castApproval?.approvalId ?? null,
        characterCount: castApproval?.assignments.length ?? 0,
        distinctMaterialCount: new Set(
          castApproval?.assignments.map((item) => item.materialProfileId) ?? [],
        ).size,
        sharedMaterialGroupCount: sharedMaterialGroups.length,
        characterSharesFallbackMaterial: characterSharesFallbackMaterial(
          production.value.fallbackVoiceProfileId,
          castApproval?.assignments ?? [],
        ),
      },
      lifecycleEvents: [...transports.lifecycleEvents],
      identities: {
        extractor: extractor.identity,
        director: directorIdentity,
        speechEngine: speechEngineFactory.identity,
        assembler: audioAssembler.identity,
      },
      durationsMs: { total: Math.round(performance.now() - startedAt) },
    }
  } finally {
    database.close()
    await transports.close()
  }
}
