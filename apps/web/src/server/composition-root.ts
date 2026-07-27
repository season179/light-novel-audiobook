import {
  ApprovalCatalogAccess,
  type AudioAssembler,
  CompletedOutputAuthority,
  DirectAudiobook,
  type DirectChapterOptions,
  type DirectionApprovalRepository,
  type DirectorModel,
  type EpubExtractor,
  type FallbackApprovalRepository,
  type JobRepository,
  RenderAudiobook,
  ReviewDirection,
  ReviewFallbackApprovals,
  type SpeechEngineFactory,
} from '@light-novel-audiobook/application'
import type { VoiceCast } from '@light-novel-audiobook/domain'
import { SlicingEpubExtractor } from '@light-novel-audiobook/pipeline-driver'
import { withSanitizedFailures } from './adapter-failure-boundary.js'
import { AudiobookWebApi } from './audiobook-web-api.js'
import { BookReadModelStore, ProjectingJobRepository } from './book-read-model.js'
import { resolveEnvironmentCompositionOptions } from './environment-composition.js'
import { EpubUploadStore } from './epub-upload-store.js'
import { FakeAudioAssembler } from './fakes/fake-audio-assembler.js'
import { FAKE_DIRECTOR_IDENTITY, FakeDirectorModel } from './fakes/fake-director-model.js'
import { FakeEpubExtractor } from './fakes/fake-epub-extractor.js'
import { createFakeSpeechEngineFactory } from './fakes/fake-speech-engine.js'
import { InMemoryDirectionApprovalRepository } from './fakes/in-memory-direction-approvals.js'
import { InMemoryFallbackApprovalRepository } from './fakes/in-memory-fallback-approvals.js'
import { InMemoryJobRepository } from './fakes/in-memory-job-repository.js'
import { GenerationRunner } from './generation-runner.js'
import { sliceLimitsForJobId } from './job-identity.js'
import { createM1VoiceCast, loadPinnedQwenConfig, pinnedVoiceMaterial } from './m1-voice-cast.js'
import { type ReviewerIdentity, resolveReviewerIdentity } from './reviewer-identity.js'
import { createWorkspace, type LocalWorkspace } from './workspace.js'

/**
 * The single place where concrete adapters meet the application ports.
 *
 * Adapters are supplied as **factories, called once per generation run**, not as instances. This is
 * not a style choice: `DirectAudiobook` always releases the director when direction finishes, and
 * a real director's release is terminal, so a retained director would serve the first book and fail
 * every book after it. A factory may still return a long-lived shared instance where the adapter
 * genuinely supports repeated use — see the per-field notes.
 *
 * Issue #21 wires the real EPUB extractor (#28), Gemma director (#30), Qwen speech engine (#31),
 * FFmpeg assembler (#32), and SQLite job repository (#27) behind `LNA_WEB_TRANSPORTS=real` (see
 * `environment-composition.ts`); the fakes below remain the default. No page, component, server
 * function, or route changes.
 */
export interface AudiobookAdapterFactories {
  /**
   * MUST return a director that has not been released. `GemmaDirectorModel.release()` memoises its
   * shutdown and every later `directChapter()` throws, so this has to construct per run.
   *
   * #21: wrap the real adapter so the command identity binds WHAT it is, not WHERE it ran —
   * `withDirectorContentIdentity(model, createDirectorContentIdentity(options))` (issue #54). The
   * adapter's self-reported identity hashes in its baseUrl and GPU lease lock path, so an
   * unwrapped real director wedges every resumable job on a port or lock-file move.
   */
  readonly createDirectorModel?: (() => DirectorModel | Promise<DirectorModel>) | undefined
  /**
   * The director's identity, derived from configuration rather than from a live model.
   *
   * Required alongside a custom `createDirectorModel`, because the generation command identity binds
   * it before direction runs while the model must not be constructed until direction actually
   * happens. `#21` passes `createDirectorContentIdentity(settings)` — the content identity, NOT the
   * adapter's self-reported `createGemmaDirectorIdentity(settings)`. The raw hash folds in the
   * baseUrl and the GPU lease lock path, so a port or lock-file move would wedge every resumable
   * job (issue #54). It would not even run once: `createDirectorModel` is wrapped in the content
   * identity, and `DirectAudiobook` releases any constructed director whose identity disagrees
   * with the factory's advertised value, then fails the run. The two must be the same string.
   */
  readonly directorIdentity?: string | undefined
  /** Stateless in practice; a shared instance is fine. */
  readonly createEpubExtractor?: (() => EpubExtractor | Promise<EpubExtractor>) | undefined
  /**
   * Builds the speech engine per book, **after** that book's persisted fallback approvals are read
   * back: the engine refuses a fallback segment absent from its catalog, so it cannot be constructed
   * alongside the extractor and director. MAY close over a shared engine instance — `endBatch()` is
   * not terminal for the real Qwen adapter, and docs/PLAN.md wants the TTS model to stay loaded.
   *
   * `#21` supplies `createQwenSpeechEngineFactory(await QwenTtsSpeechEngine.create({ … }))`.
   */
  readonly speechEngineFactory?: SpeechEngineFactory | undefined
  /**
   * The review ledger: the persisted human decisions authorizing the fallback voice. Shared for the
   * whole process, like `jobs`. `#21` supplies `new SqliteFallbackApprovalRepository(db)`.
   */
  readonly approvals?: FallbackApprovalRepository | undefined
  /** Separate whole-script confirmation history; a job save must never overwrite it. */
  readonly directionApprovals?: DirectionApprovalRepository | undefined
  /** Stateless in practice; a shared instance is fine. */
  readonly createAudioAssembler?: (() => AudioAssembler | Promise<AudioAssembler>) | undefined
  /**
   * Shared for the whole process: this is the persistence boundary, not a per-run resource.
   * `#21` supplies `new SqliteJobRepository(layout, db)` on the workspace's `layoutFor(root)`
   * layout, the same database the pipeline driver writes, so a job from either side is visible
   * to the other.
   */
  readonly jobs?: JobRepository | undefined
  readonly voices?: VoiceCast | undefined
  /**
   * Who this server records as the human behind a fallback-voice decision.
   *
   * Omitted, it is resolved from `LNA_REVIEWER` or the operating-system account — never invented, and
   * never read from a request body. `resolveReviewerIdentity` throws if neither is available, so the
   * gap is visible at startup instead of being papered over with a constant.
   */
  readonly reviewer?: ReviewerIdentity | undefined
}

export interface AudiobookWebApiOptions extends AudiobookAdapterFactories {
  readonly workspaceRoot?: string | undefined
  readonly workspace?: LocalWorkspace | undefined
  /** Overrides the pinned Qwen production configuration the default cast is derived from. */
  readonly qwenConfigPath?: string | undefined
  /** Operational cancellation/deadline controls forwarded to every director call. */
  readonly directorOptions?: DirectChapterOptions | undefined
}

export const createAudiobookWebApi = async (
  options: AudiobookWebApiOptions = {},
): Promise<AudiobookWebApi> => {
  const workspace = options.workspace ?? (await createWorkspace(options.workspaceRoot))
  // The pinned Qwen configuration is the source of truth for which voices are approved, so the
  // default cast is derived from it and the default fake engine is held to the same profiles.
  const pinnedConfig = await loadPinnedQwenConfig(options.qwenConfigPath)
  const voices = options.voices ?? createM1VoiceCast(pinnedConfig)
  const books = new BookReadModelStore()
  // Sanitized before projection: a raw adapter message must not reach job state, which the browser
  // reads back directly.
  const jobs = new ProjectingJobRepository(
    withSanitizedFailures.jobs(options.jobs ?? new InMemoryJobRepository(workspace)),
    books,
  )

  const createEpubExtractor = options.createEpubExtractor ?? (() => new FakeEpubExtractor())
  const createDirectorModel = options.createDirectorModel ?? (() => new FakeDirectorModel())
  const createAudioAssembler = options.createAudioAssembler ?? (() => new FakeAudioAssembler())
  // Never constructs a director. The command identity has to bind the director's identity before any
  // direction happens, but building the model here would defeat the point of the factory twice over:
  // a render-only review resume must construct nothing, and a failing factory must surface as a run
  // failure the browser can read rather than as a composition failure. Director identity is a pure
  // function of configuration — `FAKE_DIRECTOR_IDENTITY` here, `createGemmaDirectorIdentity(settings)`
  // at #21.
  const directorIdentity = options.directorIdentity ?? FAKE_DIRECTOR_IDENTITY
  const speechEngineFactory =
    options.speechEngineFactory ??
    createFakeSpeechEngineFactory(workspace, {
      fallbackVoiceProfileId: voices.fallback.id,
      pinnedVoiceProfiles: pinnedVoiceMaterial(pinnedConfig),
    })
  const approvals = withSanitizedFailures.approvals(
    options.approvals ?? new InMemoryFallbackApprovalRepository(),
  )
  const directionApprovals = options.directionApprovals ?? new InMemoryDirectionApprovalRepository()
  // One coordinator per process and catalog. Completed-output consumers hold it only through their
  // final catalog check and, for files, descriptor acquisition; review mutations hold it through the
  // catalog commit. Streams themselves never hold it.
  const catalogAccess = new ApprovalCatalogAccess()
  const completedOutputs = new CompletedOutputAuthority(approvals, jobs, catalogAccess)

  // Stage A and Stage B have separate factories. In particular, the upload path cannot even obtain
  // a `RenderAudiobook`, so a zero-warning script has no route to speech without another user action.
  const runner = new GenerationRunner({
    createDirection: async (command) => {
      const [epubExtractor, audioAssembler] = await Promise.all([
        createEpubExtractor(),
        createAudioAssembler(),
      ])
      // Slice bounds live in the job ID and are folded into extractor identity.
      const limits = sliceLimitsForJobId(command.jobId)
      const boundedExtractor =
        Object.keys(limits).length === 0
          ? epubExtractor
          : new SlicingEpubExtractor(epubExtractor, limits)
      return new DirectAudiobook({
        epubExtractor: withSanitizedFailures.epubExtractor(boundedExtractor),
        directorModelFactory: withSanitizedFailures.directorModelFactory({
          identity: directorIdentity,
          create: createDirectorModel,
        }),
        speechEngineFactory: withSanitizedFailures.speechEngineFactory(speechEngineFactory),
        audioAssembler: withSanitizedFailures.audioAssembler(audioAssembler),
        jobs,
      })
    },
    createRendering: async () =>
      new RenderAudiobook({
        speechEngineFactory: withSanitizedFailures.speechEngineFactory(speechEngineFactory),
        audioAssembler: withSanitizedFailures.audioAssembler(await createAudioAssembler()),
        jobs,
        approvals,
        directionApprovals,
        completedOutputs,
      }),
  })

  return new AudiobookWebApi({
    workspace,
    uploads: new EpubUploadStore(workspace),
    jobs,
    books,
    runner,
    voices,
    review: new ReviewFallbackApprovals({ jobs, approvals, catalogAccess }),
    directionReview: new ReviewDirection({ jobs, approvals: directionApprovals }),
    completedOutputs,
    reviewer: options.reviewer ?? resolveReviewerIdentity(),
    ...(options.directorOptions === undefined ? {} : { directorOptions: options.directorOptions }),
  })
}

let instance: Promise<AudiobookWebApi> | undefined

/**
 * Lazily built once per server process; never at import time, so builds stay side-effect free.
 *
 * The adapter set comes from explicit environment configuration (`LNA_WEB_TRANSPORTS`, resolved in
 * `environment-composition.ts`): **fakes are the default**, and the real EPUB/Gemma/Qwen/FFmpeg/
 * SQLite adapters exist only when that variable says `real` (#21). Explicit options passed to
 * `createAudiobookWebApi` — every test — are untouched by this.
 */
export const getAudiobookWebApi = (): Promise<AudiobookWebApi> => {
  instance ??= resolveEnvironmentCompositionOptions().then((options) =>
    createAudiobookWebApi(options),
  )
  return instance
}
