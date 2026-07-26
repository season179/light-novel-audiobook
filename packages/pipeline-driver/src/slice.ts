import type { EpubExtractionRequest, EpubExtractor } from '@light-novel-audiobook/application'
import { Book, Chapter } from '@light-novel-audiobook/domain'

export interface SliceLimits {
  /**
   * 1-based domain chapter position the window starts at. Default 1, which is the prefix behaviour.
   *
   * This exists because `maxChapters` alone can only express "the first N chapters". Choosing a good
   * excerpt needs *selection*: the best first-run candidate on the real book is chapter 3, and asking
   * for it with `maxChapters: 3` would render chapters 1 and 2 as well.
   */
  readonly firstChapter?: number
  /** Keep at most this many chapters, counting from `firstChapter`. */
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
  /** Domain chapter positions the window kept, so a run report names the real chapters. */
  readonly selectedChapterPositions: readonly number[]
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
 * The window stays internally consistent: `Book` requires `chapter.position === index + 1`, so a window
 * that does not start at chapter 1 is **renumbered** to 1..N while every chapter keeps its original
 * `id`. That split is deliberate. The ID is what identity, the database rows and all passage IDs are
 * built from, so a chapter-3 run stays distinguishable from a chapter-1 run everywhere it matters; the
 * position is only the chapter's place *within this render*. The visible consequence is that exported
 * filenames and M4B track numbers are window-relative — selecting chapter 3 alone produces `-ch001-`,
 * because it is the first chapter of that excerpt. The web UI derives its label from the ID instead, so
 * it still reads "Chapter 3". `SourcePassage` carries no position invariant, and `ExactSourceCoverage`
 * runs over the sliced book, so "every passage represented exactly once" still means that for the slice.
 *
 * `identity` binds the slice bounds. `GenerateAudiobook` folds the extractor identity into the command
 * identity, and a completed job returns its stored output without re-extracting — so an unbound slice
 * would let a second run with different bounds silently reuse the first run's audio. On a
 * 2,328-passage book that is the difference between three paragraphs and an unintended full render.
 * With the bounds bound in, changing them changes the command identity, and the same job ID is
 * rejected as stale instead of quietly resurfacing the old result.
 *
 * An unbounded slice reports the inner identity verbatim, so wrapping without limits stays
 * indistinguishable from not wrapping at all.
 */
export class SlicingEpubExtractor implements EpubExtractor {
  readonly identity: string
  #report: SliceReport | undefined

  constructor(
    private readonly inner: EpubExtractor,
    private readonly limits: SliceLimits,
  ) {
    // A bound that is silently wrong is worse than one that is rejected: `firstChapter: 0` would make
    // the window start at index -1 and slice from the *end* of the book.
    for (const [name, value] of [
      ['firstChapter', limits.firstChapter],
      ['maxChapters', limits.maxChapters],
      ['maxPassagesPerChapter', limits.maxPassagesPerChapter],
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
        throw new Error(`Slice bound ${name} must be a positive integer, got ${String(value)}`)
      }
    }
    this.identity = SlicingEpubExtractor.#identityFor(inner.identity, limits)
  }

  /**
   * Canonical, fixed order, with defaults omitted. Omitting the default matters: `firstChapter: 1` *is*
   * the unbounded prefix, so it must not read as a different slice from not passing it at all, or two
   * spellings of one window would produce two job identities.
   */
  static #identityFor(innerIdentity: string, limits: SliceLimits): string {
    const bounds = [
      ['firstChapter', limits.firstChapter === 1 ? undefined : limits.firstChapter],
      ['maxChapters', limits.maxChapters],
      ['maxPassagesPerChapter', limits.maxPassagesPerChapter],
    ]
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => `${String(name)}=${String(value)}`)
    if (bounds.length === 0) return innerIdentity
    return `${innerIdentity}+slice(${bounds.join(',')})`
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

    const startIndex = (this.limits.firstChapter ?? 1) - 1
    if (startIndex >= book.chapters.length) {
      // Fail loudly. Silently producing an empty window would fail much later, inside the domain's
      // "a book requires at least one chapter", with nothing pointing at the bound that caused it.
      throw new Error(
        `Slice bound firstChapter=${startIndex + 1} is past the end of a ${book.chapters.length}-chapter book`,
      )
    }
    const keptChapters = book.chapters.slice(
      startIndex,
      startIndex + (this.limits.maxChapters ?? book.chapters.length),
    )
    const selectedChapterPositions = keptChapters.map((chapter) => chapter.position)
    const chapters = keptChapters.map(
      (chapter, windowIndex) =>
        new Chapter({
          id: chapter.id,
          bookId: chapter.bookId,
          // Window-relative, because `Book` requires positions to be exactly `index + 1`. The original
          // chapter is still identified by `chapter.id`, which is what carries into identity and IDs.
          position: windowIndex + 1,
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
      selectedChapterPositions,
      // An offset window is always a slice even when it kept every chapter it could, because its
      // chapters have been renumbered and the original `book` no longer describes it.
      sliced:
        startIndex > 0 ||
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
