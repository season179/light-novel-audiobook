import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  AssembleAudiobookRequest,
  AudioAssembler,
  CompletedSegmentAudio,
  JobRepository,
  OutputReservation,
  ReusableSegmentQuery,
} from '@light-novel-audiobook/application'
import {
  type AudiobookJob,
  type AudiobookOutput,
  type Book,
  type ChapterAudioOutput,
  OutputVersion,
} from '@light-novel-audiobook/domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { audioFileResponse } from '../src/server/audio-file-response.js'
import type { AudiobookWebApi } from '../src/server/audiobook-web-api.js'
import { createAudiobookWebApi } from '../src/server/composition-root.js'
import { InMemoryJobRepository } from '../src/server/fakes/in-memory-job-repository.js'
import { createWorkspace, type LocalWorkspace } from '../src/server/workspace.js'
import { createStubEpubBytes } from './support/stub-epub.js'
import { waitForJobState } from './support/test-harness.js'

/**
 * The merged FFmpeg assembler (#32) writes `<title>-vNNN.m4b` plus `<title>-vNNN-chNNNN.flac`. This
 * proves **this app's routes and content typing** serve those extensions with no change, so #21 can
 * wire the real assembler behind them.
 *
 * #43 has since aligned the real pair: SQLite persistence reserves `<stem>-vNNN.flac` chapter masters
 * and the planner requires `.flac`. This test still uses local doubles rather than those packages, so
 * `apps/web` does not take a dependency on persistence or FFmpeg assembly to prove its own routing;
 * pinning the real pair against each other belongs with #43/#21. The doubles are local because the
 * shipped `FakeAudioAssembler` refuses a reservation it cannot honour, which is the behaviour that
 * stops a fake from hiding that class of mismatch.
 */
class FlacReservingRepository implements JobRepository {
  private readonly inner: InMemoryJobRepository
  private readonly outputsDir: string

  constructor(workspace: LocalWorkspace) {
    this.inner = new InMemoryJobRepository(workspace)
    this.outputsDir = workspace.outputsDir
  }

  findBook(bookId: string): Promise<Book | undefined> {
    return this.inner.findBook(bookId)
  }

  findJob(jobId: string): Promise<AudiobookJob | undefined> {
    return this.inner.findJob(jobId)
  }

  saveJob(job: AudiobookJob): Promise<void> {
    return this.inner.saveJob(job)
  }

  saveFailureDiagnostic(jobId: string, error: unknown): Promise<string | undefined> {
    return this.inner.saveFailureDiagnostic(jobId, error)
  }

  saveCompletedJob(job: AudiobookJob, output: AudiobookOutput): Promise<void> {
    return this.inner.saveCompletedJob(job, output)
  }

  findCompletedOutput(jobId: string): Promise<AudiobookOutput | undefined> {
    return this.inner.findCompletedOutput(jobId)
  }

  saveBook(book: Book): Promise<void> {
    return this.inner.saveBook(book)
  }

  findReusableSegment(query: ReusableSegmentQuery): Promise<CompletedSegmentAudio | undefined> {
    return this.inner.findReusableSegment(query)
  }

  saveCompletedSegment(segment: CompletedSegmentAudio): Promise<void> {
    return this.inner.saveCompletedSegment(segment)
  }

  /** Mirrors the naming docs/PLAN.md specifies and #32 implements. */
  async reserveNextOutput(book: Book): Promise<OutputReservation> {
    const version = new OutputVersion(1)
    const directory = join(this.outputsDir, book.id)
    return {
      bookId: book.id,
      version,
      m4bPath: join(directory, `real-title-${version.label}.m4b`),
      chapters: book.chapters.map((chapter, index) => ({
        chapterId: chapter.id,
        path: join(
          directory,
          `real-title-${version.label}-ch${String(index + 1).padStart(4, '0')}.flac`,
        ),
      })),
    }
  }
}

/** Writes placeholder bytes wherever the reservation points, including `.flac`. */
class FlacWritingAssembler implements AudioAssembler {
  readonly identity = 'test-double-flac-assembler/1'

  async assemble(request: AssembleAudiobookRequest): Promise<AudiobookOutput> {
    const { reservation } = request
    const chapters: ChapterAudioOutput[] = []
    for (const [index, entry] of request.chapters.entries()) {
      const reserved = reservation.chapters[index]
      if (reserved === undefined) throw new Error(`missing reservation at ${index}`)
      const clips = await Promise.all(
        entry.segments.map((segment) => readFile(segment.audio.wavPath)),
      )
      await mkdir(dirname(reserved.path), { recursive: true })
      await writeFile(reserved.path, Buffer.concat(clips))
      chapters.push({ chapterId: reserved.chapterId, path: reserved.path })
    }
    await mkdir(dirname(reservation.m4bPath), { recursive: true })
    await writeFile(reservation.m4bPath, Buffer.from('placeholder audiobook'))
    return { version: reservation.version, m4bPath: reservation.m4bPath, chapters }
  }
}

let workspace: LocalWorkspace
let root: string
let api: AudiobookWebApi

describe('serving the real assembler’s output extensions', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lna-flac-'))
    workspace = await createWorkspace(root)
    api = await createAudiobookWebApi({
      workspace,
      jobs: new FlacReservingRepository(workspace),
      createAudioAssembler: () => new FlacWritingAssembler(),
    })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('labels FLAC chapter masters and the M4B with playable content types', async () => {
    const upload = await api.uploadEpub({
      fileName: 'real-title.epub',
      bytes: createStubEpubBytes(),
    })
    const started = await api.startGeneration({ uploadId: upload.uploadId })
    const completed = await waitForJobState(api, started.jobId, (job) => job.finished)

    const chapters = completed.output?.chapters ?? []
    expect(chapters).toHaveLength(3)
    expect(chapters.map((chapter) => chapter.fileName)).toEqual([
      'real-title-v001-ch0001.flac',
      'real-title-v001-ch0002.flac',
      'real-title-v001-ch0003.flac',
    ])
    expect(completed.output?.m4bFileName).toBe('real-title-v001.m4b')

    const chapterFile = await api.openChapterAudioFile({
      jobId: started.jobId,
      chapterId: chapters[0]?.chapterId ?? '',
    })
    try {
      expect(chapterFile.descriptor.contentType).toBe('audio/flac')
      expect(chapterFile.descriptor.attachment).toBe(false)
      const response = audioFileResponse(chapterFile)
      expect(response.headers.get('Content-Type')).toBe('audio/flac')
      expect(response.headers.get('Content-Disposition')).toContain(
        'inline; filename="real-title-v001-ch0001.flac"',
      )
      expect((await response.arrayBuffer()).byteLength).toBe(chapterFile.descriptor.byteLength)
    } finally {
      await chapterFile.close()
    }

    const audiobookFile = await api.openAudiobookFile({ jobId: started.jobId })
    try {
      expect(audiobookFile.descriptor.contentType).toBe('audio/mp4')
      expect(audiobookFile.descriptor.attachment).toBe(true)
    } finally {
      await audiobookFile.close()
    }
  })
})
