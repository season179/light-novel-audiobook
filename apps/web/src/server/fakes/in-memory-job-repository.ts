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
  type Book,
  DomainError,
  OutputVersion,
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

  async saveBook(_book: Book): Promise<void> {
    // Books are write-only across this port; the web read model projects what the UI needs.
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
