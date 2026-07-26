import type {
  AudiobookJob,
  AudiobookOutput,
  Book,
  Chapter,
  DirectedSegment,
  OutputVersion,
  Segment,
  VoiceProfile,
} from '@light-novel-audiobook/domain'
import type { PersistedCastApproval } from './cast-approval.js'
import type {
  BookFallbackGrant,
  FallbackApprovalCatalog,
  FallbackRevocation,
  PersistedFallbackApproval,
} from './fallback-approval.js'

export interface EpubExtractionRequest {
  readonly epubPath: string
}

/** Implemented by issue #28. identity binds extractor version, policy, and settings. */
export interface EpubExtractor {
  readonly identity: string
  extract(request: EpubExtractionRequest): Promise<Book>
}

export interface DirectedChapter {
  readonly chapterId: string
  readonly segments: readonly DirectedSegment[]
}

export interface DirectChapterOptions {
  /** Cancellation for the whole chapter direction, including every underlying model request. */
  readonly signal?: AbortSignal
  /**
   * Whole-chapter deadline in milliseconds, covering every underlying request the adapter needs
   * (for example every passage window) plus retries. Adapters own their per-request timeout as a
   * constructor setting; this option bounds the chapter operation the port actually exposes.
   */
  readonly timeoutMs?: number
}

/** Implemented by issue #30. identity binds model, prompt/schema, and direction settings. */
export interface DirectorModel {
  readonly identity: string
  directChapter(
    book: Book,
    chapter: Chapter,
    options?: DirectChapterOptions,
  ): Promise<DirectedChapter>
  release(): Promise<void>
}

/**
 * Builds the director **only when direction is actually going to run**.
 *
 * `GemmaDirectorModel.release()` is terminal and the model owns a GPU allocation, so a director
 * constructed for a run that turns out to be a render-only resume — an already-directed job
 * continuing after review — is never used and never released. It leaks, and Qwen then starts
 * rendering while that unnecessary model is still resident on a 16 GB card.
 *
 * `identity` is required separately because `createGenerationCommandIdentity` needs it before any
 * direction happens. That is sound because director identity is a pure function of configuration
 * (`gemmaDirectorIdentityMaterial`), so a composition root can compute it without a live model.
 * `DirectAudiobook` asserts the created director agrees.
 */
export interface DirectorModelFactory {
  readonly identity: string
  create(): DirectorModel | Promise<DirectorModel>
}

export interface SpeechRenderRequest {
  readonly segment: Segment
  readonly voice: VoiceProfile
  readonly inputIdentity: string
}

export interface CompletedSegmentAudio {
  readonly segmentId: string
  readonly inputIdentity: string
  readonly wavPath: string
  readonly sha256: string
  readonly byteLength: number
}

/**
 * Implemented by issue #31. identity must include model revision and render parameters.
 * One begin/end pair surrounds all missing segments so a local model can remain loaded.
 */
export interface SpeechEngine {
  readonly identity: string
  beginBatch(): Promise<void>
  render(request: SpeechRenderRequest): Promise<CompletedSegmentAudio>
  endBatch(): Promise<void>
}

export interface SpeechEngineContext {
  readonly bookId: string
  /**
   * The persisted human decisions authorizing fallback use in this book, one per approved segment.
   * `QwenApplicationSpeechEngine` refuses any fallback segment absent from this catalog, so it must
   * be complete before the engine is built.
   */
  readonly fallbackApprovals: readonly PersistedFallbackApproval[]
}

/**
 * Builds the speech engine for one book, **after** its approval catalog is known.
 *
 * A plain `SpeechEngine` dependency cannot work: the catalog is per book and only exists once
 * direction has found every unresolved speaker, so an engine constructed alongside the extractor
 * and director would always carry an empty catalog and fail on the first fallback segment.
 *
 * `identity` is required separately because `createGenerationCommandIdentity` needs it *before*
 * direction, while `create` cannot be called until after it. That is sound only because the engine
 * identity excludes the catalog by design (issue #31): approvals bind per segment, into that
 * segment's `RenderInputIdentity`, so a growing catalog must not move the global identity and
 * stale a running job. `RenderAudiobook` asserts the built engine agrees, so an adapter that
 * violated this would fail loudly instead of silently re-rendering the book on every approval.
 */
export interface SpeechEngineFactory {
  readonly identity: string
  create(context: SpeechEngineContext): SpeechEngine | Promise<SpeechEngine>
}

/**
 * The review context's own port, deliberately separate from `JobRepository`: approvals are written
 * and revoked by a human between direction and rendering, on their own lifecycle, and folding them
 * into the job repository would let a job save overwrite a decision.
 *
 * Every mutating method must **increment the book's catalog revision in the same transaction as the
 * row it writes**. `readCatalog` must return the records and that revision from one consistent read.
 * Together those two rules are what let a render claim a catalog and refuse to commit if a human
 * decision moved underneath it — reading records and revision separately would leave exactly the
 * race this exists to close.
 */
export interface CastApprovalRepository {
  /** Active human-approved cast for these exact EPUB bytes, if one exists. */
  findCastApproval(epubSha256: string): Promise<PersistedCastApproval | undefined>
  /** Replaces the active decision while preserving its content-addressed approval identity. */
  saveCastApproval(approval: PersistedCastApproval): Promise<void>
}

export interface FallbackApprovalRepository {
  /** One atomically consistent read: live approvals, exclusions, the book-wide grant, revision. */
  readCatalog(bookId: string): Promise<FallbackApprovalCatalog>
  save(record: PersistedFallbackApproval): Promise<void>
  /**
   * Removes a live approval. `'human-withdrawal'` must also record a durable exclusion, so a
   * book-wide grant cannot silently re-create the approval on the next reconciliation;
   * `'no-longer-describes-segment'` is a system invalidation and must not.
   *
   * Returns true when a live approval existed and was removed.
   */
  revoke(bookId: string, segmentId: string, revocation: FallbackRevocation): Promise<boolean>
  saveBookGrant(grant: BookFallbackGrant): Promise<void>
  /** True when a grant existed and was withdrawn. Recorded exclusions and approvals are untouched. */
  revokeBookGrant(bookId: string): Promise<boolean>
}

export interface OutputReservation {
  readonly bookId: string
  readonly version: OutputVersion
  readonly m4bPath: string
  readonly chapters: readonly {
    readonly chapterId: string
    readonly path: string
  }[]
}

export interface AssemblySegment {
  readonly segment: Segment
  readonly audio: CompletedSegmentAudio
}

export interface AssemblyChapter {
  readonly chapter: Chapter
  readonly segments: readonly AssemblySegment[]
}

export interface AssembleAudiobookRequest {
  readonly book: Book
  readonly chapters: readonly AssemblyChapter[]
  readonly reservation: OutputReservation
}

/** Implemented by issue #32. identity binds encoding, pause, and assembly settings. */
export interface AudioAssembler {
  readonly identity: string
  assemble(request: AssembleAudiobookRequest): Promise<AudiobookOutput>
}

export interface ReusableSegmentQuery {
  readonly segmentId: string
  readonly inputIdentity: string
}

/**
 * Implemented by issue #27. Persist jobs through AudiobookJob.snapshot()/reconstitute(), not
 * process-local object references. Completed output is deliberately stored separately from the
 * public aggregate and may be fetched only through the narrow persistence operation below. A
 * reusable result may be returned only after the adapter proves
 * the absolute path exists and its current bytes match sha256 and byteLength. Reservations must be
 * atomic, pairwise-distinct, and must never name an existing file.
 */
export interface JobRepository {
  findJob(jobId: string): Promise<AudiobookJob | undefined>
  saveJob(job: AudiobookJob): Promise<void>
  /** Atomically persists the terminal job state and its separately held output. */
  saveCompletedJob(job: AudiobookJob, output: AudiobookOutput): Promise<void>
  /**
   * Persistence-only raw output read. Application consumers must use `CompletedOutputAuthority`,
   * which calls this under the live approval-catalog section. Direct use bypasses authorization.
   */
  findCompletedOutput(jobId: string): Promise<AudiobookOutput | undefined>
  /**
   * Persists the approved script **losslessly**, including every segment's exact `sourceText` and
   * its `voiceAssignment`. `findBook` has to reproduce a book that hashes to the same
   * `createRenderInputIdentity` values, and a stored digest cannot do that. Storing source text is
   * a deliberate decision recorded in the #45 report: the workspace database is gitignored
   * (`*.db`), and source text must never be logged or committed.
   */
  saveBook(book: Book): Promise<void>
  /**
   * Reads the approved script back for a render stage that did not direct it. Returns chapters in
   * spine order with their source passages and directed, voice-assigned segments; `undefined` when
   * the book was never saved.
   *
   * Deferred during #25 and load-bearing for #45: rendering happens in a separate invocation from
   * direction, after review, so it cannot rely on an in-memory `Book`. Chapter *render* state is
   * not part of the script and is not restored — what is persisted is the approved script, and
   * render progress lives in the job and the artifact ledger.
   */
  findBook(bookId: string): Promise<Book | undefined>
  findReusableSegment(query: ReusableSegmentQuery): Promise<CompletedSegmentAudio | undefined>
  saveCompletedSegment(segment: CompletedSegmentAudio): Promise<void>
  reserveNextOutput(book: Book): Promise<OutputReservation>
}
