import type {
  CompletedSegmentAudio,
  JobRepository,
  OutputReservation,
  ReusableSegmentQuery,
} from '@light-novel-audiobook/application'
import type { AudiobookJob, AudiobookOutput, Book } from '@light-novel-audiobook/domain'

export interface ChapterReadModel {
  readonly chapterId: string
  readonly position: number
  readonly title: string
}

export interface BookReadModel {
  readonly bookId: string
  readonly title: string
  readonly author: string | null
  readonly chapters: readonly ChapterReadModel[]
  /** Precomputed when the book changes, so 700ms job polling never recounts a whole book. */
  readonly totalPassages?: number
  /** Counts from persisted approved chapters; failed direction never trusts an in-window counter. */
  readonly approvedChapters?: number
  readonly approvedPassages?: number
  readonly totalSegments?: number
  readonly fallbackSegments?: number
}

/**
 * Display-only projection of the books the application layer writes.
 *
 * `JobRepository` is intentionally write-only for books, so the web layer cannot read a saved book
 * back to label the UI. Rather than change the port, this projection records what the pages need as
 * the use case saves. Anything missing here degrades to a stable label derived from the chapter ID,
 * so the UI stays correct when the projection is cold.
 */
export class BookReadModelStore {
  private readonly byBookId = new Map<string, BookReadModel>()

  record(book: Book): void {
    let totalPassages = 0
    let approvedChapters = 0
    let approvedPassages = 0
    let totalSegments = 0
    let fallbackSegments = 0
    for (const chapter of book.chapters) {
      totalPassages += chapter.sourcePassages.length
      if (chapter.state === 'approved') {
        approvedChapters += 1
        approvedPassages += chapter.sourcePassages.length
      }
      totalSegments += chapter.segments.length
      fallbackSegments += chapter.segments.filter(
        (segment) => segment.voiceAssignment?.usesFallback === true,
      ).length
    }
    this.byBookId.set(book.id, {
      bookId: book.id,
      title: book.title,
      author: book.author,
      totalPassages,
      approvedChapters,
      approvedPassages,
      totalSegments,
      fallbackSegments,
      chapters: book.chapters.map((chapter) => ({
        chapterId: chapter.id,
        position: chapter.position,
        title: chapter.title,
      })),
    })
  }

  find(bookId: string | null): BookReadModel | undefined {
    return bookId === null ? undefined : this.byBookId.get(bookId)
  }
}

/** Wraps any `JobRepository` (fake or real) and keeps the display projection current. */
export class ProjectingJobRepository implements JobRepository {
  private readonly inner: JobRepository
  private readonly books: BookReadModelStore

  constructor(inner: JobRepository, books: BookReadModelStore) {
    this.inner = inner
    this.books = books
  }

  findJob(jobId: string): Promise<AudiobookJob | undefined> {
    return this.inner.findJob(jobId)
  }

  saveJob(job: AudiobookJob): Promise<void> {
    return this.inner.saveJob(job)
  }

  saveFailureDiagnostic(jobId: string, error: unknown): Promise<string | undefined> {
    return this.inner.saveFailureDiagnostic(jobId, error)
  }

  saveCompletedJob(job: AudiobookJob, output: AudiobookOutput): Promise<void> {
    return this.inner.saveCompletedJob(job, output)
  }

  findCompletedOutput(jobId: string): Promise<AudiobookOutput | undefined> {
    return this.inner.findCompletedOutput(jobId)
  }

  async saveBook(book: Book): Promise<void> {
    await this.inner.saveBook(book)
    this.books.record(book)
  }

  /** Also refreshes the projection: a job resumed from persistence never called `saveBook`. */
  async findBook(bookId: string): Promise<Book | undefined> {
    const book = await this.inner.findBook(bookId)
    if (book !== undefined) this.books.record(book)
    return book
  }

  findReusableSegment(query: ReusableSegmentQuery): Promise<CompletedSegmentAudio | undefined> {
    return this.inner.findReusableSegment(query)
  }

  saveCompletedSegment(segment: CompletedSegmentAudio): Promise<void> {
    return this.inner.saveCompletedSegment(segment)
  }

  reserveNextOutput(book: Book): Promise<OutputReservation> {
    return this.inner.reserveNextOutput(book)
  }
}
