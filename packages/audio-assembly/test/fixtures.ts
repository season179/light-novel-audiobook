import type {
  AssembleAudiobookRequest,
  AssemblyChapter,
  CompletedSegmentAudio,
  OutputReservation,
} from '@light-novel-audiobook/application'
import {
  Book,
  Chapter,
  type DeliveryDirection,
  OutputVersion,
  Segment,
  SourcePassage,
  StableIds,
} from '@light-novel-audiobook/domain'
import { audiobookFileName, chapterAudioFileName } from '../src/output-naming.js'

export const HOSTILE_TITLE = 'The "Book"; #1 = a\\path/name\tと日本語 ★'
export const HOSTILE_AUTHOR = 'A. Author; = #ghost\\writer'
export const HOSTILE_CHAPTER_TITLE = 'Ch=1; #wait\\stop -y --metadata'

export const sourceSha256 = 'a3'.repeat(32)
export const bookId = StableIds.book(sourceSha256)

const delivery = (pauseAfterMs: number): DeliveryDirection => ({
  emotion: 'neutral',
  pace: 'normal',
  volume: 'normal',
  pauseAfterMs,
})

export interface ChapterSpec {
  readonly title: string
  /** One entry per segment: the pause the director asked for. */
  readonly pauses: readonly number[]
}

export interface BookSpec {
  readonly title?: string
  readonly author?: string | null
  readonly coverPath?: string | null
  readonly chapters: readonly ChapterSpec[]
}

export interface FixtureBook {
  readonly book: Book
  readonly segmentIds: readonly (readonly string[])[]
}

export const makeBook = (spec: BookSpec): FixtureBook => {
  const segmentIds: string[][] = []
  const chapters = spec.chapters.map((chapterSpec, chapterIndex) => {
    const position = chapterIndex + 1
    const chapterId = StableIds.chapter(bookId, position)
    const passageId = StableIds.passage(chapterId, 1)
    const chapter = new Chapter({
      id: chapterId,
      bookId,
      position,
      title: chapterSpec.title,
      sourcePassages: [
        new SourcePassage({
          id: passageId,
          chapterId,
          sourceText: chapterSpec.pauses.map((_, index) => `Segment ${index + 1}.`).join(''),
        }),
      ],
    })
    const segments = chapterSpec.pauses.map(
      (pauseAfterMs, segmentIndex) =>
        new Segment({
          id: StableIds.segment(passageId, segmentIndex + 1),
          chapterId,
          sourcePassageId: passageId,
          order: segmentIndex + 1,
          sourceText: `Segment ${segmentIndex + 1}.`,
          kind: 'narration',
          speakerId: null,
          confidence: 1,
          delivery: delivery(pauseAfterMs),
        }),
    )
    chapter.submitForReview(segments)
    segmentIds.push(segments.map((segment) => segment.id))
    return chapter
  })

  const book = new Book({
    id: bookId,
    title: spec.title ?? HOSTILE_TITLE,
    author: spec.author === undefined ? HOSTILE_AUTHOR : spec.author,
    coverPath: spec.coverPath === undefined ? null : spec.coverPath,
    source: { epubPath: '/workspace/uploads/story.epub', sha256: sourceSha256 },
    chapters,
  })
  return { book, segmentIds }
}

const audioFor = (segmentId: string, wavPath: string): CompletedSegmentAudio => ({
  segmentId,
  inputIdentity: 'f'.repeat(64),
  wavPath,
  sha256: 'e'.repeat(64),
  byteLength: 1024,
})

export interface RequestSpec {
  readonly book: Book
  readonly outputDirectory: string
  readonly wavDirectory: string
  readonly version?: number
}

/** Builds a reservation the way issue #27's repository is contracted to: numbered and pre-ordered. */
export const makeReservation = (spec: RequestSpec): OutputReservation => {
  const version = new OutputVersion(spec.version ?? 1)
  return {
    bookId: spec.book.id,
    version,
    m4bPath: `${spec.outputDirectory}/${audiobookFileName(spec.book.title, version)}`,
    chapters: spec.book.chapters.map((chapter) => ({
      chapterId: chapter.id,
      path: `${spec.outputDirectory}/${chapterAudioFileName(
        spec.book.title,
        version,
        chapter.position,
        spec.book.chapters.length,
      )}`,
    })),
  }
}

export const makeRequest = (spec: RequestSpec): AssembleAudiobookRequest => {
  const chapters: AssemblyChapter[] = spec.book.chapters.map((chapter) => ({
    chapter,
    segments: chapter.segments.map((segment) => ({
      segment,
      audio: audioFor(segment.id, `${spec.wavDirectory}/${segment.id}.wav`),
    })),
  }))
  return { book: spec.book, chapters, reservation: makeReservation(spec) }
}
