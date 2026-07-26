import type {
  AssembleAudiobookRequest,
  AudioAssembler,
  BookFallbackGrant,
  CompletedSegmentAudio,
  DirectChapterOptions,
  DirectedChapter,
  DirectorModel,
  DirectorModelFactory,
  EpubExtractionRequest,
  EpubExtractor,
  FallbackApprovalCatalog,
  FallbackApprovalRepository,
  FallbackRevocation,
  JobRepository,
  OutputReservation,
  PersistedFallbackApproval,
  ReusableSegmentQuery,
  SpeechEngine,
  SpeechEngineContext,
  SpeechEngineFactory,
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

  findBook(bookId: string): Promise<Book | undefined> {
    return sanitize('jobs.findBook', () => this.inner.findBook(bookId))
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

/**
 * The review ledger is reached from server functions the browser calls directly, so a raw adapter
 * message must not survive here either.
 */
class SanitizedFallbackApprovalRepository implements FallbackApprovalRepository {
  private readonly inner: FallbackApprovalRepository

  constructor(inner: FallbackApprovalRepository) {
    this.inner = inner
  }

  readCatalog(bookId: string): Promise<FallbackApprovalCatalog> {
    return sanitize('approvals.readCatalog', () => this.inner.readCatalog(bookId))
  }

  save(record: PersistedFallbackApproval): Promise<void> {
    return sanitize('approvals.save', () => this.inner.save(record))
  }

  revoke(bookId: string, segmentId: string, revocation: FallbackRevocation): Promise<boolean> {
    return sanitize('approvals.revoke', () => this.inner.revoke(bookId, segmentId, revocation))
  }

  saveBookGrant(grant: BookFallbackGrant): Promise<void> {
    return sanitize('approvals.saveBookGrant', () => this.inner.saveBookGrant(grant))
  }

  revokeBookGrant(bookId: string): Promise<boolean> {
    return sanitize('approvals.revokeBookGrant', () => this.inner.revokeBookGrant(bookId))
  }
}

/**
 * Wraps a *factory*, not only the adapter it returns.
 *
 * Construction is now deferred until the stage that needs it, so a factory that throws — a missing
 * model file, a refused GPU lease — throws inside the run rather than at composition time. Without
 * this the raw message would reach job state, which the browser reads back directly.
 */
class SanitizedDirectorModelFactory implements DirectorModelFactory {
  readonly identity: string
  private readonly inner: DirectorModelFactory

  constructor(inner: DirectorModelFactory) {
    this.inner = inner
    this.identity = inner.identity
  }

  create(): Promise<DirectorModel> {
    return sanitize(
      'directorModelFactory.create',
      async () => new SanitizedDirectorModel(await this.inner.create()),
    )
  }
}

class SanitizedSpeechEngineFactory implements SpeechEngineFactory {
  readonly identity: string
  private readonly inner: SpeechEngineFactory

  constructor(inner: SpeechEngineFactory) {
    this.inner = inner
    this.identity = inner.identity
  }

  create(context: SpeechEngineContext): Promise<SpeechEngine> {
    return sanitize(
      'speechEngineFactory.create',
      async () => new SanitizedSpeechEngine(await this.inner.create(context)),
    )
  }
}

export const withSanitizedFailures = {
  epubExtractor: (inner: EpubExtractor): EpubExtractor => new SanitizedEpubExtractor(inner),
  directorModel: (inner: DirectorModel): DirectorModel => new SanitizedDirectorModel(inner),
  speechEngine: (inner: SpeechEngine): SpeechEngine => new SanitizedSpeechEngine(inner),
  audioAssembler: (inner: AudioAssembler): AudioAssembler => new SanitizedAudioAssembler(inner),
  directorModelFactory: (inner: DirectorModelFactory): DirectorModelFactory =>
    new SanitizedDirectorModelFactory(inner),
  speechEngineFactory: (inner: SpeechEngineFactory): SpeechEngineFactory =>
    new SanitizedSpeechEngineFactory(inner),
  jobs: (inner: JobRepository): JobRepository => new SanitizedJobRepository(inner),
  approvals: (inner: FallbackApprovalRepository): FallbackApprovalRepository =>
    new SanitizedFallbackApprovalRepository(inner),
}
