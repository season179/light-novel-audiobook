import type {
  AudiobookJobSnapshot,
  AudiobookJobStage,
  AudiobookJobState,
  AudiobookOutput,
  FallbackReason,
} from '@light-novel-audiobook/domain'
import type { BookReadModel } from './book-read-model.js'

/**
 * The one shape every page reads. It is built from the persisted job snapshot, which is why a
 * browser refresh mid-generation shows the real current state instead of losing progress.
 */
export interface JobWarningView {
  readonly segmentId: string
  readonly chapterLabel: string
  readonly speakerId: string | null
  readonly voiceProfileId: string
  readonly reason: FallbackReason
  readonly message: string
}

export interface ChapterAudioView {
  readonly chapterId: string
  readonly chapterLabel: string
  readonly title: string | null
  readonly position: number
  readonly fileName: string
  readonly audioUrl: string
}

export interface AudiobookOutputView {
  readonly version: number
  readonly versionLabel: string
  readonly m4bFileName: string
  readonly downloadUrl: string
  readonly chapters: readonly ChapterAudioView[]
}

export type PipelineStageStatus = 'completed' | 'current' | 'upcoming'

export interface PipelineStageView {
  readonly stage: Exclude<AudiobookJobStage, 'completed'>
  readonly label: string
  readonly status: PipelineStageStatus
  readonly summary: string | null
}

/**
 * The two resting situations inside `awaiting_review` (issue #96). The job state stays
 * `awaiting_review` for both — this distinction is derived at read time, never stored, because a
 * stored copy goes stale the moment an approval changes.
 */
export type ReviewStatus =
  /** At least one blocking decision is missing or no longer valid. */
  | 'needs_decisions'
  /** Nothing is blocking; the script is waiting on the user's go-ahead. */
  | 'ready_to_confirm'

/** The review surface of an `awaiting_review` job: which situation it is in, and what blocks it. */
export interface JobReviewView {
  readonly status: ReviewStatus
  /** Fallback subjects without a live approval. Each one blocks rendering. */
  readonly blockers: number
  /** Every fallback subject in the directed script, decided or not. Zero is a good state. */
  readonly total: number
}

/** The one field of a live review record the projection reads. */
export interface ReviewQueueEntry {
  readonly decision: 'approved' | 'pending' | 'excluded'
}

export interface JobStateView {
  readonly jobId: string
  readonly state: AudiobookJobState
  readonly stage: AudiobookJobStage
  readonly stageLabel: string
  readonly bookId: string | null
  readonly bookTitle: string | null
  readonly currentChapterId: string | null
  readonly currentChapterLabel: string | null
  readonly currentChapterTitle: string | null
  readonly completedChapters: number
  readonly totalChapters: number
  readonly completedPassages: number
  readonly totalPassages: number
  readonly directionPercentComplete: number | null
  readonly completedSegments: number
  readonly totalSegments: number
  readonly percentComplete: number | null
  readonly pipelineStages: readonly PipelineStageView[]
  readonly latestMessage: string
  readonly error: string | null
  readonly failureDiagnosticPath: string | null
  readonly active: boolean
  readonly finished: boolean
  readonly review: JobReviewView | null
  readonly warnings: readonly JobWarningView[]
  readonly output: AudiobookOutputView | null
}

export const STAGE_LABELS: Readonly<Record<AudiobookJobStage, string>> = {
  extracting: 'Reading the EPUB',
  directing: 'Directing chapters',
  rendering: 'Rendering speech',
  assembling: 'Assembling the audiobook',
  completed: 'Completed',
}

export const PIPELINE_STAGES = ['extracting', 'directing', 'rendering', 'assembling'] as const

/**
 * Which of the two `awaiting_review` situations a job is in, and how many lines block it.
 *
 * Derived from the live review records (`ReviewFallbackApprovals.list`), never from the job's
 * stored message or the snapshot: a job whose approvals changed after its snapshot was written
 * must show the answer the records give now. `null` outside `awaiting_review`, where there is no
 * review surface at all. An empty queue is a good state — nothing is blocking — not a missing one.
 */
export const deriveJobReview = (
  state: AudiobookJobState,
  items: readonly ReviewQueueEntry[],
): JobReviewView | null => {
  if (state !== 'awaiting_review') return null
  const blockers = items.filter((item) => item.decision !== 'approved').length
  return {
    status: blockers === 0 ? 'ready_to_confirm' : 'needs_decisions',
    blockers,
    total: items.length,
  }
}

const buildPipelineStages = (
  snapshot: AudiobookJobSnapshot,
  book: BookReadModel | undefined,
  output: AudiobookOutputView | null,
): readonly PipelineStageView[] => {
  const currentIndex =
    snapshot.stage === 'completed'
      ? PIPELINE_STAGES.length
      : PIPELINE_STAGES.indexOf(snapshot.stage)
  const direction = snapshot.progress.direction
  return PIPELINE_STAGES.map((stage, index) => {
    const status: PipelineStageStatus =
      index < currentIndex ? 'completed' : index === currentIndex ? 'current' : 'upcoming'
    let summary: string | null = null
    if (stage === 'extracting' && status === 'completed') {
      const chapters = direction?.totalChapters ?? book?.chapters.length
      const passages = direction?.totalPassages ?? book?.totalPassages
      if (chapters !== undefined && passages !== undefined) {
        summary = `${chapters} chapters and ${passages} passages extracted`
      }
    }
    if (
      stage === 'directing' &&
      (status === 'completed' || snapshot.state === 'awaiting_review') &&
      book?.totalSegments !== undefined &&
      book.fallbackSegments !== undefined
    ) {
      summary = `${book.totalSegments} segments directed; ${book.fallbackSegments} needed a fallback voice`
    }
    if (stage === 'rendering' && status === 'completed' && snapshot.progress.totalSegments > 0) {
      summary = `${snapshot.progress.totalSegments} segment audio files ready`
    }
    if (stage === 'assembling' && status === 'completed' && output !== null) {
      summary = `Output ${output.versionLabel} assembled`
    }
    return {
      stage,
      label: STAGE_LABELS[stage],
      status,
      summary,
    }
  })
}

const FALLBACK_REASON_MESSAGES: Readonly<Record<FallbackReason, string>> = {
  unresolved_speaker:
    'No speaker could be identified, so the fallback dialogue voice was used. Review before you keep this audio.',
  missing_speaker_voice:
    'This speaker has no cast voice yet, so the fallback dialogue voice was used. Review before you keep this audio.',
}

/** Stable IDs carry chapter position, so a readable label never needs a book lookup. */
export const deriveChapterNumber = (chapterId: string): number | null => {
  const match = /-ch(\d{4})(?:-|$)/.exec(chapterId)
  if (match?.[1] === undefined) return null
  const position = Number(match[1])
  return Number.isSafeInteger(position) && position > 0 ? position : null
}

export const deriveChapterLabel = (chapterId: string): string => {
  const position = deriveChapterNumber(chapterId)
  return position === null ? 'Unknown chapter' : `Chapter ${position}`
}

export const chapterAudioUrl = (jobId: string, chapterId: string): string =>
  `/api/jobs/${encodeURIComponent(jobId)}/audio/${encodeURIComponent(chapterId)}`

export const audiobookDownloadUrl = (jobId: string): string =>
  `/api/jobs/${encodeURIComponent(jobId)}/download`

export const fileNameOf = (path: string): string => {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

export const buildJobStateView = (
  snapshot: AudiobookJobSnapshot,
  book: BookReadModel | undefined,
  authorizedOutput?: AudiobookOutput | undefined,
  reviewItems: readonly ReviewQueueEntry[] = [],
): JobStateView => {
  const { progress } = snapshot
  const chapterTitles = new Map(
    (book?.chapters ?? []).map((chapter) => [chapter.chapterId, chapter.title]),
  )

  const output =
    authorizedOutput === undefined
      ? null
      : {
          version: authorizedOutput.version.value,
          versionLabel: authorizedOutput.version.label,
          m4bFileName: fileNameOf(authorizedOutput.m4bPath),
          downloadUrl: audiobookDownloadUrl(snapshot.id),
          chapters: authorizedOutput.chapters.map((chapter, index) => ({
            chapterId: chapter.chapterId,
            chapterLabel: deriveChapterLabel(chapter.chapterId),
            title: chapterTitles.get(chapter.chapterId) ?? null,
            position: deriveChapterNumber(chapter.chapterId) ?? index + 1,
            fileName: fileNameOf(chapter.path),
            audioUrl: chapterAudioUrl(snapshot.id, chapter.chapterId),
          })),
        }

  return {
    jobId: snapshot.id,
    state: snapshot.state,
    stage: snapshot.stage,
    stageLabel: STAGE_LABELS[snapshot.stage],
    bookId: snapshot.bookId,
    bookTitle: book?.title ?? null,
    currentChapterId: progress.currentChapterId,
    currentChapterLabel:
      progress.currentChapterId === null ? null : deriveChapterLabel(progress.currentChapterId),
    currentChapterTitle:
      progress.currentChapterId === null
        ? null
        : (chapterTitles.get(progress.currentChapterId) ?? null),
    completedChapters: progress.direction?.completedChapters ?? 0,
    totalChapters: progress.direction?.totalChapters ?? 0,
    completedPassages: progress.direction?.completedPassages ?? 0,
    totalPassages: progress.direction?.totalPassages ?? 0,
    directionPercentComplete:
      progress.direction === null || progress.direction.totalPassages === 0
        ? null
        : Math.round(
            (progress.direction.completedPassages / progress.direction.totalPassages) * 100,
          ),
    completedSegments: progress.completedSegments,
    totalSegments: progress.totalSegments,
    percentComplete:
      progress.totalSegments === 0
        ? null
        : Math.round((progress.completedSegments / progress.totalSegments) * 100),
    pipelineStages: buildPipelineStages(snapshot, book, output),
    latestMessage: progress.latestMessage,
    error: snapshot.error,
    failureDiagnosticPath: snapshot.failureDiagnosticPath,
    active: snapshot.state === 'running' || snapshot.state === 'pending',
    finished: snapshot.state === 'completed',
    review: deriveJobReview(snapshot.state, reviewItems),
    warnings: snapshot.warnings.map((warning) => ({
      segmentId: warning.segmentId,
      chapterLabel: deriveChapterLabel(warning.segmentId),
      speakerId: warning.speakerId,
      voiceProfileId: warning.voiceProfileId,
      reason: warning.reason,
      message: warning.speakerReason ?? FALLBACK_REASON_MESSAGES[warning.reason],
    })),
    output,
  }
}
