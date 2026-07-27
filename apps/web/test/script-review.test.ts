/**
 * The read-only directed-script review at the API boundary (#96 step 6).
 *
 * Two things are pinned here. First, the views are faithful: what the reader sees is the persisted
 * book the render gate hashes — exact text, exact attribution, exact voice — and a wrong answer is
 * a failed assertion, not a shrug. Second, the copyright boundary: the script text may reach these
 * views (they are rendered for the reader) and must reach nothing else — not job state, not the
 * persisted snapshot, not any log line. The sentinel test drives that with a unique string.
 *
 * All prose is invented fixture text written for these tests — never book content.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { EpubExtractionRequest, EpubExtractor } from '@light-novel-audiobook/application'
import { Book, Chapter, SourcePassage, StableIds } from '@light-novel-audiobook/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FIXTURE_CHAPTERS } from '../src/server/fakes/fixture-book.js'
import { createStubEpubBytes } from './support/stub-epub.js'
import { createTestHarness, type TestHarness } from './support/test-harness.js'

let harness: TestHarness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

/** Uploads the fixture EPUB and waits for the review stop, with no review decision made. */
const startAndStopForReview = async (
  marker: string,
  options: Parameters<typeof createTestHarness>[0] = {},
) => {
  harness = await createTestHarness(options)
  const upload = await harness.api.uploadEpub({
    fileName: `${marker}.epub`,
    bytes: createStubEpubBytes(marker),
  })
  const started = await harness.api.startGeneration({ uploadId: upload.uploadId })
  const deadline = performance.now() + 10_000
  while (performance.now() < deadline) {
    const job = await harness.api.getJobState({ jobId: started.jobId })
    if (job !== null && !job.active && job.state === 'awaiting_review') break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return { api: harness.api, jobId: started.jobId, app: harness }
}

describe('script review reads the persisted directed script (#96 step 6)', () => {
  it('indexes every chapter with counts and flags — and ships no story text in the index', async () => {
    const { api, jobId } = await startAndStopForReview('script-index')

    const index = await api.listScriptChapters({ jobId })

    expect(index.chapterCount).toBe(FIXTURE_CHAPTERS.length)
    expect(index.chapters.map((chapter) => chapter.position)).toEqual([1, 2, 3])
    expect(index.chapters.map((chapter) => chapter.title)).toEqual(
      FIXTURE_CHAPTERS.map((chapter) => chapter.title),
    )
    // Totals agree with the per-chapter counts, and the flagged lines are countable per chapter.
    expect(index.totalSegments).toBe(
      index.chapters.reduce((total, chapter) => total + chapter.segmentCount, 0),
    )
    expect(index.totalSegments).toBeGreaterThan(0)
    expect(index.flaggedSegments).toBe(
      index.chapters.reduce((total, chapter) => total + chapter.flaggedCount, 0),
    )
    // The fixture book has unresolved speakers, so at least one line is flagged somewhere.
    expect(index.flaggedSegments).toBeGreaterThan(0)
    // The index is counts and titles only: no line of the script crosses in it.
    const fixtureLine = FIXTURE_CHAPTERS[0]?.passages[0] ?? ''
    expect(fixtureLine.length).toBeGreaterThan(0)
    expect(JSON.stringify(index)).not.toContain(fixtureLine)
  })

  it('answers the index from the warm projection without reloading the book', async () => {
    const { api, jobId, app } = await startAndStopForReview('script-index-cheap')

    const first = await api.listScriptChapters({ jobId })
    expect(first.chapterCount).toBeGreaterThan(0)

    // With the projection warm, a second read must not touch persistence at all: break the
    // repository's book read and the answer must still come back complete and identical.
    const jobs = app.jobs
    const originalFindBook = jobs.findBook.bind(jobs)
    let bookReads = 0
    jobs.findBook = async (bookId: string) => {
      bookReads += 1
      return originalFindBook(bookId)
    }
    try {
      const second = await api.listScriptChapters({ jobId })
      expect(second).toEqual(first)
      expect(bookReads).toBe(0)
    } finally {
      jobs.findBook = originalFindBook
    }
  })

  it('returns one chapter exactly as persisted: text, kind, speaker, voice, delivery, confidence', async () => {
    const { api, jobId, app } = await startAndStopForReview('script-chapter')

    const job = await api.getJobState({ jobId })
    const bookId = job?.bookId
    if (bookId == null) throw new Error('job has no book')
    const persisted = await app.jobs.findBook(bookId)
    const chapter = persisted?.chapters[1]
    if (chapter === undefined) throw new Error('fixture has no second chapter')

    const view = await api.getScriptChapter({ jobId, chapterId: chapter.id })

    expect(view.position).toBe(2)
    expect(view.totalChapters).toBe(FIXTURE_CHAPTERS.length)
    expect(view.title).toBe(chapter.title)
    expect(view.segmentCount).toBe(chapter.segments.length)
    // Field-by-field against the persisted book — a swapped speaker or dropped delivery fails here.
    for (const [index, segment] of chapter.segments.entries()) {
      const shown = view.segments[index]
      if (shown === undefined) throw new Error(`segment ${index} missing from the view`)
      expect(shown.segmentId).toBe(segment.id)
      expect(shown.order).toBe(segment.order)
      expect(shown.sourceText).toBe(segment.sourceText)
      expect(shown.kind).toBe(segment.kind)
      expect(shown.speakerId).toBe(segment.speakerId)
      expect(shown.confidence).toBe(segment.confidence)
      expect(shown.delivery).toEqual(segment.delivery)
      expect(shown.voiceProfileId).toBe(segment.voiceAssignment?.voiceProfileId ?? null)
      expect(shown.usesFallback).toBe(segment.voiceAssignment?.usesFallback === true)
    }
    // And the exact concatenation reproduces the chapter's passages — nothing omitted or reordered.
    const spoken = view.segments.map((segment) => segment.sourceText).join('')
    const source = chapter.sourcePassages.map((passage) => passage.sourceText).join('')
    expect(spoken).toBe(source)
  })

  it('flags the unresolved-speaker fallback lines and leaves clean narration unflagged', async () => {
    const { api, jobId, app } = await startAndStopForReview('script-flags')

    const job = await api.getJobState({ jobId })
    const bookId = job?.bookId
    if (bookId == null) throw new Error('job has no book')
    const persisted = await app.jobs.findBook(bookId)
    if (persisted === undefined) throw new Error('book is not persisted')

    const views = await Promise.all(
      persisted.chapters.map((chapter) => api.getScriptChapter({ jobId, chapterId: chapter.id })),
    )
    const segments = views.flatMap((view) => view.segments)

    const flagged = segments.filter((segment) => segment.flags.length > 0)
    expect(flagged.length).toBeGreaterThan(0)
    expect(flagged.length).toBe(views.reduce((total, view) => total + view.flaggedCount, 0))
    for (const segment of flagged) {
      expect(segment.flags).toContain('fallback_voice')
      expect(segment.usesFallback).toBe(true)
    }
    // The fixture book has both fallback shapes: an unidentified speaker and a speaker with no
    // cast voice. Each is flagged in a way the UI can name.
    expect(flagged.some((segment) => segment.flags.includes('unresolved_speaker'))).toBe(true)
    expect(flagged.some((segment) => segment.flags.includes('missing_speaker_voice'))).toBe(true)
    // Clean narration with a cast voice and high confidence carries no flag.
    const clean = segments.filter(
      (segment) => segment.kind === 'narration' && segment.confidence >= 0.7,
    )
    expect(clean.length).toBeGreaterThan(0)
    for (const segment of clean) {
      expect(segment.flags).toEqual([])
    }
  })

  it('is read-only: nothing starts, nothing is decided, and unknown IDs are clean failures', async () => {
    const { api, jobId, app } = await startAndStopForReview('script-readonly')

    const before = await api.listFallbackReview({ jobId })
    const index = await api.listScriptChapters({ jobId })
    const chapterId = index.chapters[0]?.chapterId
    if (chapterId === undefined) throw new Error('index has no chapters')
    await api.getScriptChapter({ jobId, chapterId })

    // The job is still resting, nothing rendered, and no review decision appeared.
    const job = await api.getJobState({ jobId })
    expect(job?.state).toBe('awaiting_review')
    expect(app.speechEngine.rendered).toBe(0)
    const after = await api.listFallbackReview({ jobId })
    expect(after).toEqual(before)

    await expect(api.listScriptChapters({ jobId: 'job-does-not-exist' })).rejects.toThrow(
      /does not exist/,
    )
    await expect(api.getScriptChapter({ jobId, chapterId: 'ch-not-in-this-book' })).rejects.toThrow(
      /not part of this audiobook/,
    )
  })
})

describe('the copyright boundary of the script review (#96 step 6)', () => {
  /** A unique string that cannot appear anywhere unless this test's book put it there. */
  const SENTINEL = 'SENTINEL-9d4e2b the lamplighter owes the ferryman a kettle'

  /** The fixture extractor plus one invented narration passage carrying the sentinel. */
  class SentinelExtractor implements EpubExtractor {
    readonly identity = 'sentinel-epub-extractor/1'

    async extract(request: EpubExtractionRequest): Promise<Book> {
      const bytes = await readFile(request.epubPath)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const bookId = StableIds.book(sha256)
      const chapters = FIXTURE_CHAPTERS.map((fixture, index) => {
        const position = index + 1
        const chapterId = StableIds.chapter(bookId, position)
        const passages = position === 1 ? [...fixture.passages, SENTINEL] : [...fixture.passages]
        return new Chapter({
          id: chapterId,
          bookId,
          position,
          title: fixture.title,
          sourcePassages: passages.map(
            (sourceText, passageIndex) =>
              new SourcePassage({
                id: StableIds.passage(chapterId, passageIndex + 1),
                chapterId,
                sourceText,
              }),
          ),
        })
      })
      return new Book({
        id: bookId,
        title: 'Sentinel Fixture',
        author: 'Fixture Author',
        coverPath: null,
        source: { epubPath: request.epubPath, sha256 },
        chapters,
      })
    }
  }

  it('the sentinel reaches the script views only — never job state, the snapshot, or any log', async () => {
    const logged: string[] = []
    const spies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
    ]
    for (const spy of spies) {
      spy.mockImplementation((...args: unknown[]) => {
        logged.push(args.map((arg) => String(arg)).join(' '))
      })
    }

    try {
      const { api, jobId, app } = await startAndStopForReview('sentinel-book', {
        createEpubExtractor: () => new SentinelExtractor(),
      })

      const index = await api.listScriptChapters({ jobId })
      const first = index.chapters[0]
      if (first === undefined) throw new Error('index has no chapters')
      const chapter = await api.getScriptChapter({ jobId, chapterId: first.chapterId })

      // The one place the sentinel belongs: the chapter view the reader sees.
      expect(chapter.segments.some((segment) => segment.sourceText === SENTINEL)).toBe(true)
      expect(JSON.stringify(chapter)).toContain(SENTINEL)

      // Job state as the browser polls it — no story text, sentinel or otherwise.
      const state = await api.getJobState({ jobId })
      expect(JSON.stringify(state)).not.toContain(SENTINEL)
      // The chapter index is counts and titles, not text.
      expect(JSON.stringify(index)).not.toContain(SENTINEL)
      // The persisted job snapshot — what the render gate and every later read load.
      const persisted = await app.jobs.findJob(jobId)
      expect(JSON.stringify(persisted?.snapshot())).not.toContain(SENTINEL)
      // The fallback review queue does not carry this line either (it is plain narration, and
      // excerpts there are browser-only by design — asserted here to stay deliberate).
      const review = await api.listFallbackReview({ jobId })
      expect(JSON.stringify(review)).not.toContain(SENTINEL)
      // No log line captured the sentinel while all of the above ran.
      expect(logged.join('\n')).not.toContain(SENTINEL)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})
