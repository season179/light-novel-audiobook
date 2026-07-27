import { createHash } from 'node:crypto'
import type { EpubExtractionRequest, EpubExtractor } from '@light-novel-audiobook/application'
import { Book, Chapter, SourcePassage, StableIds } from '@light-novel-audiobook/domain'

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
 * The one canonical statement of a slice's bounds: fixed order, defaults omitted, invalid bounds
 * rejected. `null` means the limits spell the unbounded prefix — no bound stated, or only
 * `firstChapter: 1`, which *is* the unbounded prefix — so an unbounded run and a bounded one can
 * never share a descriptor, and two spellings of one window always share one.
 *
 * This is the single rule every identity derivation uses: `SlicingEpubExtractor` binds it into the
 * extractor identity here in the driver, and the web API binds the same string into its job IDs
 * (`apps/web/src/server/job-identity.ts`). Nothing else may re-decide which bounds count.
 */
export const canonicalSliceDescriptor = (limits: SliceLimits): string | null => {
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
  const bounds = [
    ['firstChapter', limits.firstChapter === 1 ? undefined : limits.firstChapter],
    ['maxChapters', limits.maxChapters],
    ['maxPassagesPerChapter', limits.maxPassagesPerChapter],
  ]
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${String(name)}=${String(value)}`)
  return bounds.length === 0 ? null : bounds.join(',')
}

/**
 * Wraps the real extractor and narrows the `Book` it returns.
 *
 * `DirectAudiobookCommand` has no slice option and the use case calls `extract()` itself, so
 * bounding a run has to happen here, at the composition root. Deliberately a decorator rather than a
 * change to `DomainEpubExtractor`: the real extractor still ingests the entire publication — all 21
 * spine documents and 2,328 passages of the real book — so real-scale extraction, fidelity checks and
 * workspace commit are genuinely exercised, and only what direction and rendering see is reduced.
 *
 * The window stays internally consistent: `Book` requires `chapter.position === index + 1`, so a window
 * that does not start at chapter 1 is **renumbered** to 1..N. The visible consequence is that exported
 * filenames and M4B track numbers are window-relative — selecting chapter 3 alone produces `-ch001-`,
 * because it is the first chapter of that excerpt. `SourcePassage` carries no position invariant, and
 * `ExactSourceCoverage` runs over the sliced book, so "every passage represented exactly once" still
 * means that for the slice.
 *
 * `identity` binds the slice bounds. `DirectAudiobook` folds the extractor identity into the command
 * identity, and a completed job returns its stored output without re-extracting — so an unbound slice
 * would let a second run with different bounds silently reuse the first run's audio. On a
 * 2,328-passage book that is the difference between three paragraphs and an unintended full render.
 * With the bounds bound in, changing them changes the command identity, and the same job ID is
 * rejected as stale instead of quietly resurfacing the old result.
 *
 * A window that actually removes or renumbers anything also gets its own **IDs throughout**: the book
 * ID is derived from the parent book ID plus the same canonical descriptor `identity` binds, and every
 * chapter and passage ID is rebuilt under it — `StableIds.chapter(windowId, originalPosition)`, so the
 * suffix still names the original chapter (the web UI derives its "Chapter 3" label from that suffix)
 * while the prefix names the window. This is load-bearing, not cosmetic: the approved-script rows,
 * chapter and segment rows, the fallback approval catalog and output versioning are all keyed from
 * these IDs, and the parent book ID derives from the EPUB's sha256 alone. Without windowed IDs every
 * slice of one upload would share those rows — a chapter-3 run pausing for review and a chapter-1 run
 * then directing would replace each other's persisted script, and the paused job would resume into
 * the other window's chapters. With them, two windows of one upload can no more collide than two
 * different books.
 *
 * An unbounded slice reports the inner identity verbatim and returns the inner book untouched, so
 * wrapping without limits stays indistinguishable from not wrapping at all.
 */
export class SlicingEpubExtractor implements EpubExtractor {
  readonly identity: string
  #report: SliceReport | undefined

  constructor(
    private readonly inner: EpubExtractor,
    private readonly limits: SliceLimits,
  ) {
    // `canonicalSliceDescriptor` validates the bounds; its throw is the guard against a bound that is
    // silently wrong (`firstChapter: 0` would start the window at index -1, the *end* of the book).
    this.identity = SlicingEpubExtractor.#identityFor(inner.identity, limits)
  }

  /**
   * Canonical, fixed order, with defaults omitted. Omitting the default matters: `firstChapter: 1` *is*
   * the unbounded prefix, so it must not read as a different slice from not passing it at all, or two
   * spellings of one window would produce two job identities.
   */
  static #identityFor(innerIdentity: string, limits: SliceLimits): string {
    const descriptor = canonicalSliceDescriptor(limits)
    if (descriptor === null) return innerIdentity
    return `${innerIdentity}+slice(${descriptor})`
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
    // The window's own ID namespace (see the class doc). The canonical descriptor cannot be null
    // here in a way that matters: when it is null nothing was bounded away, `sliced` comes out
    // false below, and the original book — original IDs included — is returned untouched.
    const descriptor = canonicalSliceDescriptor(this.limits)
    const windowedBookId =
      descriptor === null
        ? book.id
        : `book-${createHash('sha256').update(`${book.id}+slice(${descriptor})`, 'utf8').digest('hex').slice(0, 24)}`
    const chapters = keptChapters.map((chapter, windowIndex) => {
      // The suffix keeps naming the original chapter, so labels and filenames still read
      // "chapter 3"; the prefix names the window, so per-window storage can never collide.
      const windowedChapterId = StableIds.chapter(windowedBookId, chapter.position)
      return new Chapter({
        id: windowedChapterId,
        bookId: windowedBookId,
        // Window-relative, because `Book` requires positions to be exactly `index + 1`.
        position: windowIndex + 1,
        title: chapter.title,
        sourcePassages: chapter.sourcePassages
          .slice(0, this.limits.maxPassagesPerChapter ?? chapter.sourcePassages.length)
          .map(
            (passage, passageIndex) =>
              new SourcePassage({
                id: StableIds.passage(windowedChapterId, passageIndex + 1),
                chapterId: windowedChapterId,
                sourceText: passage.sourceText,
              }),
          ),
      })
    })

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
      id: windowedBookId,
      title: book.title,
      author: book.author,
      coverPath: book.coverPath,
      source: book.source,
      chapters,
    })
  }
}
