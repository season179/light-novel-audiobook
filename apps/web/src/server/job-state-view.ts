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
  readonly completedSegments: number
  readonly totalSegments: number
  readonly percentComplete: number | null
  readonly latestMessage: string
  readonly error: string | null
  readonly active: boolean
  readonly finished: boolean
  readonly warnings: readonly JobWarningView[]
  readonly output: AudiobookOutputView | null
}

const STAGE_LABELS: Readonly<Record<AudiobookJobStage, string>> = {
  extracting: 'Reading the EPUB',
  directing: 'Directing chapters',
  rendering: 'Rendering speech',
  assembling: 'Assembling the audiobook',
  completed: 'Completed',
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
    completedSegments: progress.completedSegments,
    totalSegments: progress.totalSegments,
    percentComplete:
      progress.totalSegments === 0
        ? null
        : Math.round((progress.completedSegments / progress.totalSegments) * 100),
    latestMessage: progress.latestMessage,
    error: snapshot.error,
    active: snapshot.state === 'running' || snapshot.state === 'pending',
    finished: snapshot.state === 'completed',
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
