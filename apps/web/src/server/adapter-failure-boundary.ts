import type {
  AssembleAudiobookRequest,
  AudioAssembler,
  CompletedSegmentAudio,
  DirectChapterOptions,
  DirectedChapter,
  DirectorModel,
  EpubExtractionRequest,
  EpubExtractor,
  JobRepository,
  OutputReservation,
  ReusableSegmentQuery,
  SpeechEngine,
  SpeechRenderRequest,
} from '@light-novel-audiobook/application'
import type { AudiobookJob, AudiobookOutput, Book, Chapter } from '@light-novel-audiobook/domain'
import { toPublicFailureMessage } from './errors.js'

/**
 * Sanitizes adapter failures at the composition boundary.
 *
 * `GenerateAudiobook` persists the message of whatever an adapter threw into the job, and job state
 * is read straight back by the browser — so a raw `MODEL_KEY_FAILURE at /home/user/private/model.gguf`
 * would be displayed verbatim. Wrapping every adapter means the raw cause is logged server-side and
 * only an authored message can ever be stored. `WebApiError` and `DomainError` pass through intact,
 * because those are ours and their messages are the actionable ones.
 */
const sanitize = async <T>(context: string, operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation()
  } catch (error) {
    const message = toPublicFailureMessage(error, context)
    if (error instanceof Error && error.message === message) throw error
    throw new Error(message, { cause: error })
  }
}

class SanitizedEpubExtractor implements EpubExtractor {
  readonly identity: string
  private readonly inner: EpubExtractor

  constructor(inner: EpubExtractor) {
    this.inner = inner
    this.identity = inner.identity
  }

  extract(request: EpubExtractionRequest): Promise<Book> {
    return sanitize('epubExtractor.extract', () => this.inner.extract(request))
  }
}

class SanitizedDirectorModel implements DirectorModel {
  readonly identity: string
  private readonly inner: DirectorModel

  constructor(inner: DirectorModel) {
    this.inner = inner
    this.identity = inner.identity
  }

  directChapter(
    book: Book,
    chapter: Chapter,
    options?: DirectChapterOptions,
  ): Promise<DirectedChapter> {
    return sanitize('directorModel.directChapter', () =>
      this.inner.directChapter(book, chapter, options),
    )
  }

  release(): Promise<void> {
    return sanitize('directorModel.release', () => this.inner.release())
  }
}

class SanitizedSpeechEngine implements SpeechEngine {
  readonly identity: string
  private readonly inner: SpeechEngine

  constructor(inner: SpeechEngine) {
    this.inner = inner
    this.identity = inner.identity
  }

  beginBatch(): Promise<void> {
    return sanitize('speechEngine.beginBatch', () => this.inner.beginBatch())
  }

  render(request: SpeechRenderRequest): Promise<CompletedSegmentAudio> {
    return sanitize('speechEngine.render', () => this.inner.render(request))
  }

  endBatch(): Promise<void> {
    return sanitize('speechEngine.endBatch', () => this.inner.endBatch())
  }
}

class SanitizedAudioAssembler implements AudioAssembler {
  readonly identity: string
  private readonly inner: AudioAssembler

  constructor(inner: AudioAssembler) {
    this.inner = inner
    this.identity = inner.identity
  }

  assemble(request: AssembleAudiobookRequest): Promise<AudiobookOutput> {
    return sanitize('audioAssembler.assemble', () => this.inner.assemble(request))
  }
}

class SanitizedJobRepository implements JobRepository {
  private readonly inner: JobRepository

  constructor(inner: JobRepository) {
    this.inner = inner
  }

  findJob(jobId: string): Promise<AudiobookJob | undefined> {
    return sanitize('jobs.findJob', () => this.inner.findJob(jobId))
  }

  saveJob(job: AudiobookJob): Promise<void> {
    return sanitize('jobs.saveJob', () => this.inner.saveJob(job))
  }

  saveBook(book: Book): Promise<void> {
    return sanitize('jobs.saveBook', () => this.inner.saveBook(book))
  }

  findReusableSegment(query: ReusableSegmentQuery): Promise<CompletedSegmentAudio | undefined> {
    return sanitize('jobs.findReusableSegment', () => this.inner.findReusableSegment(query))
  }

  saveCompletedSegment(segment: CompletedSegmentAudio): Promise<void> {
    return sanitize('jobs.saveCompletedSegment', () => this.inner.saveCompletedSegment(segment))
  }

  reserveNextOutput(book: Book): Promise<OutputReservation> {
    return sanitize('jobs.reserveNextOutput', () => this.inner.reserveNextOutput(book))
  }
}

export const withSanitizedFailures = {
  epubExtractor: (inner: EpubExtractor): EpubExtractor => new SanitizedEpubExtractor(inner),
  directorModel: (inner: DirectorModel): DirectorModel => new SanitizedDirectorModel(inner),
  speechEngine: (inner: SpeechEngine): SpeechEngine => new SanitizedSpeechEngine(inner),
  audioAssembler: (inner: AudioAssembler): AudioAssembler => new SanitizedAudioAssembler(inner),
  jobs: (inner: JobRepository): JobRepository => new SanitizedJobRepository(inner),
}
