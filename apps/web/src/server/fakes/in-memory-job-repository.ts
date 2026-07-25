import { createHash } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  CompletedSegmentAudio,
  JobRepository,
  OutputReservation,
  ReusableSegmentQuery,
} from '@light-novel-audiobook/application'
import {
  AudiobookJob,
  type AudiobookJobSnapshot,
  Book,
  Chapter,
  type DeliveryDirection,
  DomainError,
  OutputVersion,
  Segment,
  type SegmentKind,
  SourcePassage,
  type VoiceAssignment,
} from '@light-novel-audiobook/domain'
import type { LocalWorkspace } from '../workspace.js'

const MAX_OUTPUT_VERSIONS = 999

const outputBaseName = (title: string): string => {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z\d]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return slug.length === 0 ? 'audiobook' : slug
}

const chapterNumber = (chapterId: string): string => {
  const match = /-ch(\d{4})$/.exec(chapterId)
  return match?.[1] ?? '0000'
}

const segmentKey = (segmentId: string, inputIdentity: string): string =>
  `${segmentId}::${inputIdentity}`

/**
 * FAKE repository. It stores jobs as `AudiobookJob` snapshots rather than object references, so the
 * whole flow behaves like the persisted contract issue #27 will implement in SQLite: job state is
 * always read back from stored data, which is what makes a page refresh safe. Segment reuse is
 * verified against real bytes on disk, and numbered reservations never name an existing file.
 */
export class InMemoryJobRepository implements JobRepository {
  private readonly workspace: LocalWorkspace
  private readonly jobSnapshots = new Map<string, AudiobookJobSnapshot>()
  private readonly completedSegments = new Map<string, CompletedSegmentAudio>()
  private readonly reservedPaths = new Set<string>()
  private readonly latestVersionByBook = new Map<string, number>()
  private readonly approvedScripts = new Map<string, StoredBook>()

  constructor(workspace: LocalWorkspace) {
    this.workspace = workspace
  }

  async findJob(jobId: string): Promise<AudiobookJob | undefined> {
    const snapshot = this.jobSnapshots.get(jobId)
    return snapshot === undefined ? undefined : AudiobookJob.reconstitute(snapshot)
  }

  async saveJob(job: AudiobookJob): Promise<void> {
    this.jobSnapshots.set(job.id, job.snapshot())
  }

  /**
   * Stores the approved script as **serialized rows**, not as the `Book` object it was handed.
   *
   * Issue #45 made rendering a separate stage that reads the script back, so a forwarding stub would
   * let the fake flow reach `RenderAudiobook` while proving nothing about losslessness — and would
   * also hand back chapters still marked `rendered`, which cannot begin rendering again. Serializing
   * means only the fields SQLite persists survive, exactly as the real adapter behaves.
   */
  async saveBook(book: Book): Promise<void> {
    this.approvedScripts.set(book.id, serializeBook(book))
  }

  async findBook(bookId: string): Promise<Book | undefined> {
    const stored = this.approvedScripts.get(bookId)
    return stored === undefined ? undefined : deserializeBook(stored)
  }

  async findReusableSegment(
    query: ReusableSegmentQuery,
  ): Promise<CompletedSegmentAudio | undefined> {
    const key = segmentKey(query.segmentId, query.inputIdentity)
    const candidate = this.completedSegments.get(key)
    if (candidate === undefined) return undefined
    try {
      const bytes = await readFile(candidate.wavPath)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      if (bytes.byteLength !== candidate.byteLength || sha256 !== candidate.sha256) {
        this.completedSegments.delete(key)
        return undefined
      }
      return candidate
    } catch {
      this.completedSegments.delete(key)
      return undefined
    }
  }

  async saveCompletedSegment(segment: CompletedSegmentAudio): Promise<void> {
    this.completedSegments.set(segmentKey(segment.segmentId, segment.inputIdentity), segment)
  }

  async reserveNextOutput(book: Book): Promise<OutputReservation> {
    const directory = join(this.workspace.outputsDir, book.id)
    await mkdir(directory, { recursive: true })
    const baseName = outputBaseName(book.title)
    let candidate = (this.latestVersionByBook.get(book.id) ?? 0) + 1

    while (candidate <= MAX_OUTPUT_VERSIONS) {
      const version = new OutputVersion(candidate)
      const m4bPath = join(directory, version.fileName(baseName, 'm4b'))
      const chapters = book.chapters.map((chapter) => ({
        chapterId: chapter.id,
        path: join(directory, `${baseName}-${version.label}-ch${chapterNumber(chapter.id)}.wav`),
      }))
      const paths = [m4bPath, ...chapters.map((chapter) => chapter.path)]
      const taken = await Promise.all(paths.map((path) => this.isTaken(path)))

      if (!taken.includes(true)) {
        for (const path of paths) this.reservedPaths.add(path)
        this.latestVersionByBook.set(book.id, candidate)
        return { bookId: book.id, version, m4bPath, chapters }
      }
      candidate += 1
    }
    throw new DomainError('No numbered output version is available for this book')
  }

  private async isTaken(path: string): Promise<boolean> {
    if (this.reservedPaths.has(path)) return true
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  }
}

/** The exact fields `SqliteJobRepository` persists for an approved script, and nothing more. */
interface StoredBook {
  readonly id: string
  readonly title: string
  readonly author: string | null
  readonly coverPath: string | null
  readonly epubPath: string
  readonly sha256: string
  readonly chapters: readonly {
    readonly id: string
    readonly position: number
    readonly title: string
    readonly passages: readonly { readonly id: string; readonly sourceText: string }[]
    readonly segments: readonly {
      readonly id: string
      readonly sourcePassageId: string
      readonly sourceText: string
      readonly kind: SegmentKind
      readonly speakerId: string | null
      readonly confidence: number
      readonly delivery: DeliveryDirection
      readonly assignment: VoiceAssignment | null
    }[]
  }[]
}

const serializeBook = (book: Book): StoredBook => ({
  id: book.id,
  title: book.title,
  author: book.author,
  coverPath: book.coverPath,
  epubPath: book.source.epubPath,
  sha256: book.source.sha256,
  chapters: book.chapters.map((chapter) => ({
    id: chapter.id,
    position: chapter.position,
    title: chapter.title,
    passages: chapter.sourcePassages.map((passage) => ({
      id: passage.id,
      sourceText: passage.sourceText,
    })),
    segments: chapter.segments.map((segment) => ({
      id: segment.id,
      sourcePassageId: segment.sourcePassageId,
      sourceText: segment.sourceText,
      kind: segment.kind,
      speakerId: segment.speakerId,
      confidence: segment.confidence,
      delivery: { ...segment.delivery },
      assignment: segment.voiceAssignment === null ? null : { ...segment.voiceAssignment },
    })),
  })),
})

/**
 * Rebuilds through the domain constructors, as the SQLite adapter does, so the round trip re-proves
 * chapter membership, contiguous segment order and that every segment carries a voice before the
 * chapter is approved. Chapter render state is deliberately not restored.
 */
const deserializeBook = (stored: StoredBook): Book =>
  new Book({
    id: stored.id,
    title: stored.title,
    author: stored.author,
    coverPath: stored.coverPath,
    source: { epubPath: stored.epubPath, sha256: stored.sha256 },
    chapters: stored.chapters.map((storedChapter) => {
      const chapter = new Chapter({
        id: storedChapter.id,
        bookId: stored.id,
        position: storedChapter.position,
        title: storedChapter.title,
        sourcePassages: storedChapter.passages.map(
          (passage) =>
            new SourcePassage({
              id: passage.id,
              chapterId: storedChapter.id,
              sourceText: passage.sourceText,
            }),
        ),
      })
      if (storedChapter.segments.length === 0) return chapter
      chapter.submitForReview(
        storedChapter.segments.map((storedSegment, index) => {
          const segment = new Segment({
            id: storedSegment.id,
            chapterId: storedChapter.id,
            sourcePassageId: storedSegment.sourcePassageId,
            order: index + 1,
            sourceText: storedSegment.sourceText,
            kind: storedSegment.kind,
            speakerId: storedSegment.speakerId,
            confidence: storedSegment.confidence,
            delivery: storedSegment.delivery,
          })
          if (storedSegment.assignment !== null) segment.assignVoice(storedSegment.assignment)
          return segment
        }),
      )
      chapter.approve()
      return chapter
    }),
  })
