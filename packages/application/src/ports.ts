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
import type { PersistedFallbackApproval } from './fallback-approval.js'

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

/** Implemented by issue #30. identity binds model, prompt/schema, and direction settings. */
export interface DirectorModel {
  readonly identity: string
  directChapter(book: Book, chapter: Chapter): Promise<DirectedChapter>
  release(): Promise<void>
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
 * `listForBook` returns only live decisions. Revocation removes the row: a revoked approval must be
 * indistinguishable from one that was never granted, because that is what makes the segment
 * unrenderable and its cached audio unreachable.
 */
export interface FallbackApprovalRepository {
  listForBook(bookId: string): Promise<readonly PersistedFallbackApproval[]>
  save(record: PersistedFallbackApproval): Promise<void>
  /** True when a live decision existed and was removed. */
  revoke(bookId: string, segmentId: string): Promise<boolean>
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
 * process-local object references. A reusable result may be returned only after the adapter proves
 * the absolute path exists and its current bytes match sha256 and byteLength. Reservations must be
 * atomic, pairwise-distinct, and must never name an existing file.
 */
export interface JobRepository {
  findJob(jobId: string): Promise<AudiobookJob | undefined>
  saveJob(job: AudiobookJob): Promise<void>
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
