import type {
  Book,
  Chapter,
  DeliveryDirection,
  FallbackReason,
  Segment,
  SegmentKind,
} from '@light-novel-audiobook/domain'
import type { BookReadModel } from './book-read-model.js'
import { type ScriptSegmentFlag, scriptSegmentFlags } from './script-segment-flags.js'

/**
 * The read-only whole-script review (#96 step 6): the exact directed script the render gate hashes,
 * projected for a human to read before they confirm it.
 *
 * COPYRIGHT: `ScriptSegmentView.sourceText` — and the book title, chapter titles and speaker names
 * carried on these views — are story content. They cross this boundary for one reason: nobody can
 * approve a voice for a line they cannot read. They are rendered into the DOM and must never be
 * logged, written into job state, snapshots, warnings, diagnostics, or an error message.
 */

export interface ScriptSegmentView {
  readonly segmentId: string
  readonly order: number
  /** Story text — the line exactly as it will be spoken. DOM only; never log or persist it. */
  readonly sourceText: string
  readonly kind: SegmentKind
  readonly speakerId: string | null
  readonly speakerReason: string | null
  readonly confidence: number
  readonly voiceProfileId: string | null
  readonly usesFallback: boolean
  readonly fallbackReason: FallbackReason | null
  readonly delivery: DeliveryDirection
  readonly flags: readonly ScriptSegmentFlag[]
}

export interface ScriptChapterSummaryView {
  readonly chapterId: string
  readonly position: number
  /** Story content (a chapter title). DOM only. */
  readonly title: string
  readonly segmentCount: number
  readonly flaggedCount: number
}

/** The chapter-at-a-time index: counts for every chapter, text for none of them. */
export interface ScriptChapterListView {
  readonly jobId: string
  readonly bookId: string | null
  /** Story content (the book title). DOM only. */
  readonly bookTitle: string | null
  readonly chapterCount: number
  readonly totalSegments: number
  readonly flaggedSegments: number
  readonly chapters: readonly ScriptChapterSummaryView[]
}

/** One chapter's full directed script. Fetched on demand; never part of job-state polling. */
export interface ScriptChapterView {
  readonly jobId: string
  readonly chapterId: string
  readonly position: number
  readonly totalChapters: number
  /** Story content (a chapter title). DOM only. */
  readonly title: string
  readonly segmentCount: number
  readonly flaggedCount: number
  readonly segments: readonly ScriptSegmentView[]
}

export const buildScriptSegmentView = (segment: Segment): ScriptSegmentView => ({
  segmentId: segment.id,
  order: segment.order,
  sourceText: segment.sourceText,
  kind: segment.kind,
  speakerId: segment.speakerId,
  speakerReason: segment.speakerReason,
  confidence: segment.confidence,
  voiceProfileId: segment.voiceAssignment?.voiceProfileId ?? null,
  usesFallback: segment.voiceAssignment?.usesFallback === true,
  fallbackReason: segment.voiceAssignment?.fallbackReason ?? null,
  delivery: segment.delivery,
  flags: scriptSegmentFlags(segment),
})

/**
 * The index answers from the display projection (#100), whose per-chapter counts were precomputed
 * when the book last changed — so reading where the suspicious lines are never recounts the book.
 */
export const buildScriptChapterListView = (
  jobId: string,
  book: BookReadModel | undefined,
): ScriptChapterListView => {
  const chapters = (book?.chapters ?? []).map((chapter) => ({
    chapterId: chapter.chapterId,
    position: chapter.position,
    title: chapter.title,
    segmentCount: chapter.segmentCount,
    flaggedCount: chapter.flaggedSegments,
  }))
  return {
    jobId,
    bookId: book?.bookId ?? null,
    bookTitle: book?.title ?? null,
    chapterCount: chapters.length,
    totalSegments: chapters.reduce((total, chapter) => total + chapter.segmentCount, 0),
    flaggedSegments: chapters.reduce((total, chapter) => total + chapter.flaggedCount, 0),
    chapters,
  }
}

export const buildScriptChapterView = (
  jobId: string,
  book: Book,
  chapter: Chapter,
): ScriptChapterView => {
  const segments = chapter.segments.map(buildScriptSegmentView)
  return {
    jobId,
    chapterId: chapter.id,
    position: chapter.position,
    totalChapters: book.chapters.length,
    title: chapter.title,
    segmentCount: segments.length,
    flaggedCount: segments.filter((segment) => segment.flags.length > 0).length,
    segments,
  }
}
