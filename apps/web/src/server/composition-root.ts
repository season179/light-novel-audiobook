import {
  type AudioAssembler,
  type DirectChapterOptions,
  type DirectorModel,
  type EpubExtractor,
  GenerateAudiobook,
  type JobRepository,
  type SpeechEngine,
} from '@light-novel-audiobook/application'
import type { VoiceCast } from '@light-novel-audiobook/domain'
import { withSanitizedFailures } from './adapter-failure-boundary.js'
import { AudiobookWebApi } from './audiobook-web-api.js'
import { BookReadModelStore, ProjectingJobRepository } from './book-read-model.js'
import { EpubUploadStore } from './epub-upload-store.js'
import { FakeAudioAssembler } from './fakes/fake-audio-assembler.js'
import { FakeDirectorModel } from './fakes/fake-director-model.js'
import { FakeEpubExtractor } from './fakes/fake-epub-extractor.js'
import { FakeSpeechEngine } from './fakes/fake-speech-engine.js'
import { InMemoryJobRepository } from './fakes/in-memory-job-repository.js'
import { GenerationRunner } from './generation-runner.js'
import { createM1VoiceCast, loadPinnedQwenConfig, pinnedVoiceMaterial } from './m1-voice-cast.js'
import { createWorkspace, type LocalWorkspace } from './workspace.js'

/**
 * The single place where concrete adapters meet the application ports.
 *
 * Adapters are supplied as **factories, called once per generation run**, not as instances. This is
 * not a style choice: `GenerateAudiobook` always releases the director when direction finishes, and
 * a real director's release is terminal, so a retained director would serve the first book and fail
 * every book after it. A factory may still return a long-lived shared instance where the adapter
 * genuinely supports repeated use — see the per-field notes.
 *
 * Issue #21 replaces the fake factories with the real EPUB extractor (#28), Gemma director (#30),
 * Qwen speech engine (#31), FFmpeg assembler (#32), and SQLite job repository (#27). No page,
 * component, server function, or route changes.
 */
export interface AudiobookAdapterFactories {
  /**
   * MUST return a director that has not been released. `GemmaDirectorModel.release()` memoises its
   * shutdown and every later `directChapter()` throws, so this has to construct per run.
   */
  readonly createDirectorModel?: (() => DirectorModel | Promise<DirectorModel>) | undefined
  /** Stateless in practice; a shared instance is fine. */
  readonly createEpubExtractor?: (() => EpubExtractor | Promise<EpubExtractor>) | undefined
  /**
   * MAY return a shared instance: `endBatch()` is not terminal for the real Qwen adapter, which
   * clears its batch and accepts a later `beginBatch()`, and docs/PLAN.md wants the TTS model to
   * stay loaded across requests. Exactly one begin/end pair happens per run either way.
   */
  readonly createSpeechEngine?: (() => SpeechEngine | Promise<SpeechEngine>) | undefined
  /** Stateless in practice; a shared instance is fine. */
  readonly createAudioAssembler?: (() => AudioAssembler | Promise<AudioAssembler>) | undefined
  /** Shared for the whole process: this is the persistence boundary, not a per-run resource. */
  readonly jobs?: JobRepository | undefined
  readonly voices?: VoiceCast | undefined
}

export interface AudiobookWebApiOptions extends AudiobookAdapterFactories {
  readonly workspaceRoot?: string | undefined
  readonly workspace?: LocalWorkspace | undefined
  /** Overrides the pinned Qwen production configuration the default cast is derived from. */
  readonly qwenConfigPath?: string | undefined
  /**
   * Operational direction options forwarded to every generation command: cancellation and the
   * whole-chapter deadline. Operational only; never part of the job's command identity.
   */
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
  const createSpeechEngine =
    options.createSpeechEngine ??
    (() =>
      new FakeSpeechEngine(workspace, {
        fallbackVoiceProfileId: voices.fallback.id,
        pinnedVoiceProfiles: pinnedVoiceMaterial(pinnedConfig),
        // M1 STAND-IN, and the one place to change when the approval workflow lands. The fake — like
        // the real Qwen adapter — refuses fallback speech without a per-segment human approval, and
        // this app has no approval action yet, so it mints an identity-bound record per segment and
        // reports them on `autoApprovedFallbacks`. Real Qwen accepts no such policy: #21 must supply
        // persisted `fallbackApprovals` or every book with an unresolved speaker will fail.
        unreviewedFallbackPolicy: 'auto-approve',
      }))

  // One use case per run, with adapters that have not been released or batched yet.
  const runner = new GenerationRunner(async () => {
    const [epubExtractor, directorModel, speechEngine, audioAssembler] = await Promise.all([
      createEpubExtractor(),
      createDirectorModel(),
      createSpeechEngine(),
      createAudioAssembler(),
    ])
    return new GenerateAudiobook({
      epubExtractor: withSanitizedFailures.epubExtractor(epubExtractor),
      directorModel: withSanitizedFailures.directorModel(directorModel),
      speechEngine: withSanitizedFailures.speechEngine(speechEngine),
      audioAssembler: withSanitizedFailures.audioAssembler(audioAssembler),
      jobs,
    })
  })

  return new AudiobookWebApi({
    workspace,
    uploads: new EpubUploadStore(workspace),
    jobs,
    books,
    runner,
    voices,
    ...(options.directorOptions === undefined ? {} : { directorOptions: options.directorOptions }),
  })
}

let instance: Promise<AudiobookWebApi> | undefined

/** Lazily built once per server process; never at import time, so builds stay side-effect free. */
export const getAudiobookWebApi = (): Promise<AudiobookWebApi> => {
  instance ??= createAudiobookWebApi()
  return instance
}
