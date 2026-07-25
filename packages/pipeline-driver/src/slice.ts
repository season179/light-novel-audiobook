import type { EpubExtractionRequest, EpubExtractor } from '@light-novel-audiobook/application'
import { Book, Chapter } from '@light-novel-audiobook/domain'

export interface SliceLimits {
  /** Keep at most this many chapters, from the start. */
  readonly maxChapters?: number
  /** Keep at most this many source passages per chapter, from the start. */
  readonly maxPassagesPerChapter?: number
}

export interface SliceReport {
  readonly extractedChapters: number
  readonly extractedPassages: number
  readonly extractedCharacters: number
  readonly slicedChapters: number
  readonly slicedPassages: number
  readonly slicedCharacters: number
  readonly sliced: boolean
  /** Whether the real extraction produced a usable cover; #61 makes SVG covers fail export. */
  readonly coverPathPresent: boolean
}

/**
 * Wraps the real extractor and narrows the `Book` it returns.
 *
 * `GenerateAudiobookCommand` has no slice option and the use case calls `extract()` itself, so
 * bounding a run has to happen here, at the composition root. Deliberately a decorator rather than a
 * change to `DomainEpubExtractor`: the real extractor still ingests the entire publication — all 21
 * spine documents and 2,328 passages of the real book — so real-scale extraction, fidelity checks and
 * workspace commit are genuinely exercised, and only what direction and rendering see is reduced.
 *
 * A prefix stays internally consistent: chapter positions remain 1..N contiguous, `SourcePassage`
 * carries no position invariant, and `ExactSourceCoverage` then runs over the sliced book, so
 * "every passage represented exactly once" still means exactly that for the slice.
 *
 * `identity` is passed through unchanged on purpose. It identifies the extractor, and the extractor
 * is the real one; the slice is recorded in the run report instead, where it cannot be mistaken for a
 * property of the extraction itself.
 */
export class SlicingEpubExtractor implements EpubExtractor {
  readonly identity: string
  #report: SliceReport | undefined

  constructor(
    private readonly inner: EpubExtractor,
    private readonly limits: SliceLimits,
  ) {
    this.identity = inner.identity
  }

  /** Populated once `extract` has run; the numbers a run report should quote. */
  get report(): SliceReport | undefined {
    return this.#report
  }

  async extract(request: EpubExtractionRequest): Promise<Book> {
    const book = await this.inner.extract(request)
    const countPassages = (chapters: readonly Chapter[]): number =>
      chapters.reduce((total, chapter) => total + chapter.sourcePassages.length, 0)
    const countCharacters = (chapters: readonly Chapter[]): number =>
      chapters.reduce(
        (total, chapter) =>
          total +
          chapter.sourcePassages.reduce((inner, passage) => inner + passage.sourceText.length, 0),
        0,
      )

    const keptChapters = book.chapters.slice(0, this.limits.maxChapters ?? book.chapters.length)
    const chapters = keptChapters.map(
      (chapter) =>
        new Chapter({
          id: chapter.id,
          bookId: chapter.bookId,
          position: chapter.position,
          title: chapter.title,
          sourcePassages: chapter.sourcePassages.slice(
            0,
            this.limits.maxPassagesPerChapter ?? chapter.sourcePassages.length,
          ),
        }),
    )

    this.#report = {
      extractedChapters: book.chapters.length,
      extractedPassages: countPassages(book.chapters),
      extractedCharacters: countCharacters(book.chapters),
      slicedChapters: chapters.length,
      slicedPassages: countPassages(chapters),
      slicedCharacters: countCharacters(chapters),
      sliced:
        chapters.length !== book.chapters.length ||
        countPassages(chapters) !== countPassages(book.chapters),
      coverPathPresent: book.coverPath !== null,
    }

    if (!this.#report.sliced) return book
    return new Book({
      id: book.id,
      title: book.title,
      author: book.author,
      coverPath: book.coverPath,
      source: book.source,
      chapters,
    })
  }
}
