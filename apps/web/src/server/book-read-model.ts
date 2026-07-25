import type {
  CompletedSegmentAudio,
  JobRepository,
  OutputReservation,
  ReusableSegmentQuery,
} from '@light-novel-audiobook/application'
import type { AudiobookJob, Book } from '@light-novel-audiobook/domain'

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
    this.byBookId.set(book.id, {
      bookId: book.id,
      title: book.title,
      author: book.author,
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

  async saveBook(book: Book): Promise<void> {
    await this.inner.saveBook(book)
    this.books.record(book)
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
