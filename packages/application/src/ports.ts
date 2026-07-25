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
  saveBook(book: Book): Promise<void>
  findReusableSegment(query: ReusableSegmentQuery): Promise<CompletedSegmentAudio | undefined>
  saveCompletedSegment(segment: CompletedSegmentAudio): Promise<void>
  reserveNextOutput(book: Book): Promise<OutputReservation>
}
