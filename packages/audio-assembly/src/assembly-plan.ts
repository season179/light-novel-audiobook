import type {
  AssembleAudiobookRequest,
  OutputReservation,
} from '@light-novel-audiobook/application'
import type { Book, OutputVersion, Segment } from '@light-novel-audiobook/domain'
import { safeFileArgument } from './argument-safety.js'
import { AssemblyOrderError, AudioAssemblyError } from './errors.js'
import { manifestFileNameFor } from './output-naming.js'
import type { AssemblySettings } from './settings.js'

export interface PlannedSegment {
  readonly segmentId: string
  readonly order: number
  readonly wavPath: string
  readonly sha256: string
  /** Silence appended after this segment. The chapter's final segment carries the chapter tail. */
  readonly padMs: number
}

export interface PlannedChapter {
  readonly chapterId: string
  readonly position: number
  readonly title: string
  readonly outputPath: string
  readonly segments: readonly PlannedSegment[]
  /** Ordered batches of segments; each batch is one FFmpeg invocation. */
  readonly passes: readonly (readonly PlannedSegment[])[]
}

export interface AssemblyPlan {
  readonly bookId: string
  readonly title: string
  readonly author: string | null
  readonly coverPath: string | null
  readonly sourceSha256: string
  readonly version: OutputVersion
  readonly m4bPath: string
  readonly manifestPath: string
  readonly chapters: readonly PlannedChapter[]
}

/**
 * The pause after a segment: the director's own `pauseAfterMs` when it asked for one, otherwise the
 * configured default, always clamped into the configured bounds.
 */
export const resolveSegmentPauseMs = (segment: Segment, settings: AssemblySettings): number => {
  const requested =
    segment.delivery.pauseAfterMs > 0
      ? segment.delivery.pauseAfterMs
      : settings.defaultSegmentPauseMs
  return Math.min(Math.max(requested, settings.minSegmentPauseMs), settings.maxSegmentPauseMs)
}

const batch = <T>(items: readonly T[], size: number): readonly (readonly T[])[] => {
  const batches: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size))
  }
  return batches
}

const assertReservationShape = (book: Book, reservation: OutputReservation): void => {
  if (reservation.bookId !== book.id) {
    throw new AssemblyOrderError(
      `Reservation is for book ${reservation.bookId} but assembly received ${book.id}`,
    )
  }
  if (reservation.chapters.length !== book.chapters.length) {
    throw new AssemblyOrderError(
      `Reservation lists ${reservation.chapters.length} chapters but the book has ${book.chapters.length}`,
    )
  }
  if (!/\.m4b$/iu.test(reservation.m4bPath)) {
    throw new AudioAssemblyError(`Reserved audiobook path must end in .m4b: ${reservation.m4bPath}`)
  }
}

/**
 * Turns a request into a fully validated plan. Every ordering rule is checked here, before a single
 * byte is encoded, because a silently reordered chapter or segment ruins the audiobook without
 * failing anything downstream.
 */
export const planAssembly = (
  request: AssembleAudiobookRequest,
  settings: AssemblySettings,
): AssemblyPlan => {
  const { book, reservation } = request
  assertReservationShape(book, reservation)

  if (request.chapters.length !== book.chapters.length) {
    throw new AssemblyOrderError(
      `Assembly received ${request.chapters.length} chapters but the book has ${book.chapters.length}`,
    )
  }

  const seenSegmentIds = new Set<string>()
  const chapters: PlannedChapter[] = []

  for (const [index, entry] of request.chapters.entries()) {
    const bookChapter = book.chapters[index]
    const reserved = reservation.chapters[index]
    if (bookChapter === undefined || reserved === undefined) {
      throw new AssemblyOrderError(`Missing chapter at position ${index + 1}`)
    }
    if (entry.chapter.id !== bookChapter.id || entry.chapter.position !== index + 1) {
      throw new AssemblyOrderError(
        `Chapter at position ${index + 1} is ${entry.chapter.id} but the book expects ${bookChapter.id}`,
      )
    }
    if (reserved.chapterId !== bookChapter.id) {
      throw new AssemblyOrderError(
        `Reserved chapter ${index + 1} is ${reserved.chapterId} but the book expects ${bookChapter.id}`,
      )
    }
    if (!/\.flac$/iu.test(reserved.path)) {
      throw new AudioAssemblyError(
        `Reserved chapter master path must end in .flac: ${reserved.path}`,
      )
    }
    if (entry.segments.length === 0) {
      throw new AssemblyOrderError(`Chapter ${bookChapter.id} has no rendered segments`)
    }

    const segments: PlannedSegment[] = []
    for (const [segmentIndex, item] of entry.segments.entries()) {
      const { segment, audio } = item
      if (segment.chapterId !== bookChapter.id) {
        throw new AssemblyOrderError(
          `Segment ${segment.id} belongs to chapter ${segment.chapterId}, not ${bookChapter.id}`,
        )
      }
      if (segment.order !== segmentIndex + 1) {
        throw new AssemblyOrderError(
          `Segment ${segment.id} is at index ${segmentIndex + 1} but declares order ${segment.order}`,
        )
      }
      if (audio.segmentId !== segment.id) {
        throw new AssemblyOrderError(
          `Rendered audio ${audio.segmentId} was supplied for segment ${segment.id}`,
        )
      }
      if (seenSegmentIds.has(segment.id)) {
        throw new AssemblyOrderError(`Segment ${segment.id} appears more than once in the assembly`)
      }
      seenSegmentIds.add(segment.id)

      const isChapterEnd = segmentIndex === entry.segments.length - 1
      segments.push({
        segmentId: segment.id,
        order: segment.order,
        wavPath: safeFileArgument('Segment audio', audio.wavPath),
        sha256: audio.sha256.toLowerCase(),
        padMs: isChapterEnd
          ? settings.chapterTailPauseMs
          : resolveSegmentPauseMs(segment, settings),
      })
    }

    chapters.push({
      chapterId: bookChapter.id,
      position: bookChapter.position,
      title: bookChapter.title,
      outputPath: safeFileArgument('Reserved chapter master', reserved.path),
      segments,
      passes: batch(segments, settings.maxInputsPerPass),
    })
  }

  const m4bPath = safeFileArgument('Reserved audiobook', reservation.m4bPath)
  const outputPaths = [m4bPath, ...chapters.map((chapter) => chapter.outputPath)]
  if (new Set(outputPaths).size !== outputPaths.length) {
    throw new AudioAssemblyError('Reserved output paths must be pairwise distinct')
  }

  return {
    bookId: book.id,
    title: book.title,
    author: book.author,
    coverPath: book.coverPath === null ? null : safeFileArgument('Cover art', book.coverPath),
    sourceSha256: book.source.sha256,
    version: reservation.version,
    m4bPath,
    manifestPath: manifestFileNameFor(m4bPath),
    chapters,
  }
}
