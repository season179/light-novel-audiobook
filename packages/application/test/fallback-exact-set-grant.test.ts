/**
 * Exact-set book grants (issue #96 step 4): the human selects the N of M pending segments they
 * accept, and one decision covers exactly that set — the rest keep blocking. The service resolves
 * the selection against the queue as it is at decision time and rejects anything no longer on
 * offer, never silently ignoring or silently approving a segment.
 *
 * All story text below is invented for this fixture.
 */
import {
  AudiobookJob,
  type AudiobookOutput,
  Book,
  Chapter,
  ExactSourceCoverage,
  type SegmentKind,
  SourcePassage,
  StableIds,
  VoiceCast,
  VoiceProfile,
} from '@light-novel-audiobook/domain'
import { beforeEach, describe, expect, it } from 'vitest'
import { type JobRepository, ReviewFallbackApprovals } from '../src/index.js'
import { InMemoryFallbackApprovalRepository } from './support/in-memory-fallback-approvals.js'

const SOURCE_HASH = '9a'.repeat(32)
const BOOK_ID = StableIds.book(SOURCE_HASH)
const CHAPTER_ID = StableIds.chapter(BOOK_ID, 1)
const PASSAGE_ID = StableIds.passage(CHAPTER_ID, 1)
const DECIDED_AT = new Date('2026-07-25T10:00:00.000Z')
const REVIEWER = 'local-reviewer'

const voice = (
  id: string,
  role: 'narrator' | 'character' | 'fallback',
  speakerId: string | null,
): VoiceProfile =>
  new VoiceProfile({
    id,
    displayName: id,
    role,
    speakerId,
    syntheticSpeaker: role === 'narrator' ? 'Aiden' : 'Ryan',
    instruction: `${id} restrained delivery`,
    seed: 9205,
    revision: 1,
  })

const cast = new VoiceCast(
  voice('cast-narrator', 'narrator', null),
  voice('cast-fallback', 'fallback', null),
  [voice('cast-alice', 'character', 'alice')],
)

interface Line {
  readonly text: string
  readonly kind: SegmentKind
  readonly speakerId: string | null
}

const DEFAULT_LINES: readonly Line[] = [
  { text: 'The keeper had left the door open. ', kind: 'narration', speakerId: null },
  { text: '“You are late,” ', kind: 'dialogue', speakerId: 'alice' },
  { text: '“Nobody counted the hours.” ', kind: 'dialogue', speakerId: null },
  { text: '“Then start counting.”', kind: 'dialogue', speakerId: 'mira' },
]

const bookOf = (lines: readonly Line[] = DEFAULT_LINES): Book => {
  const chapter = new Chapter({
    id: CHAPTER_ID,
    bookId: BOOK_ID,
    position: 1,
    title: 'An Open Door',
    sourcePassages: [
      new SourcePassage({
        id: PASSAGE_ID,
        chapterId: CHAPTER_ID,
        sourceText: lines.map((line) => line.text).join(''),
      }),
    ],
  })
  const segments = ExactSourceCoverage.createSegments(
    chapter,
    lines.map((line) => ({
      sourcePassageId: PASSAGE_ID,
      sourceText: line.text,
      kind: line.kind,
      speakerId: line.speakerId,
      confidence: 0.9,
      delivery: {
        emotion: 'calm',
        pace: 'normal' as const,
        volume: 'normal' as const,
        pauseAfterMs: 200,
      },
    })),
  )
  for (const segment of segments) segment.assignVoice(cast.resolve(segment).assignment)
  chapter.submitForReview(segments)
  chapter.approve()
  return new Book({
    id: BOOK_ID,
    title: 'Review Fixture',
    author: null,
    coverPath: null,
    source: { epubPath: '/uploads/review.epub', sha256: SOURCE_HASH },
    chapters: [chapter],
  })
}

const UNRESOLVED_SEGMENT = StableIds.segment(PASSAGE_ID, 3)
const MIRA_SEGMENT = StableIds.segment(PASSAGE_ID, 4)
const NARRATION_SEGMENT = StableIds.segment(PASSAGE_ID, 1)

class StubJobRepository implements JobRepository {
  book: Book | undefined
  readonly jobs = new Map<string, AudiobookJob>()
  readonly completedOutputs = new Map<string, AudiobookOutput>()

  async findJob(jobId: string): Promise<AudiobookJob | undefined> {
    return this.jobs.get(jobId)
  }

  async saveJob(job: AudiobookJob): Promise<void> {
    this.jobs.set(job.id, job)
    if (job.state !== 'completed') this.completedOutputs.delete(job.id)
  }

  async saveFailureDiagnostic(): Promise<undefined> {
    return undefined
  }

  async saveCompletedJob(job: AudiobookJob, output: AudiobookOutput): Promise<void> {
    this.jobs.set(job.id, job)
    this.completedOutputs.set(job.id, output)
  }

  async findCompletedOutput(jobId: string): Promise<AudiobookOutput | undefined> {
    return this.completedOutputs.get(jobId)
  }

  async saveBook(): Promise<void> {}

  async findBook(bookId: string): Promise<Book | undefined> {
    return this.book?.id === bookId ? this.book : undefined
  }

  async findReusableSegment(): Promise<undefined> {
    return undefined
  }

  async saveCompletedSegment(): Promise<void> {}

  async reserveNextOutput(): Promise<never> {
    throw new Error('not used')
  }
}

interface Harness {
  readonly jobs: StubJobRepository
  readonly approvals: InMemoryFallbackApprovalRepository
  readonly review: ReviewFallbackApprovals
}

const harness = (): Harness => {
  const jobs = new StubJobRepository()
  const approvals = new InMemoryFallbackApprovalRepository()
  return {
    jobs,
    approvals,
    review: new ReviewFallbackApprovals({ jobs, approvals, now: () => DECIDED_AT }),
  }
}

const directedJob = (jobs: StubJobRepository, book: Book, jobId = 'job-review'): AudiobookJob => {
  const job = new AudiobookJob(jobId)
  job.bindCommand('a'.repeat(64))
  job.start()
  job.attachBook(book.id)
  const totalPassages = book.chapters.reduce(
    (total, chapter) => total + chapter.sourcePassages.length,
    0,
  )
  job.beginDirection(book.chapters.length, totalPassages)
  job.recordDirectionProgress(
    book.chapters.at(-1)?.id ?? 'chapter-fixture',
    book.chapters.length,
    totalPassages,
    `Directed chapter ${book.chapters.length} of ${book.chapters.length}`,
  )
  job.awaitReview()
  jobs.jobs.set(jobId, job)
  jobs.book = book
  return job
}

describe('grantBookFallback with an explicit selected set (issue #96 step 4)', () => {
  let app: Harness

  beforeEach(() => {
    app = harness()
  })

  it('authorizes exactly the selected N of M and leaves the rest blocking', async () => {
    const book = bookOf()
    directedJob(app.jobs, book)

    const result = await app.review.grantBookFallback({
      jobId: 'job-review',
      decidedBy: REVIEWER,
      segmentIds: [UNRESOLVED_SEGMENT],
    })

    // Exactly one record, for exactly the selected segment — the grant hashes that exact set.
    expect(result.created.map((record) => record.segmentId)).toEqual([UNRESOLVED_SEGMENT])
    expect(result.created).toHaveLength(1)
    expect(result.grant?.subjects.map((subject) => subject.segmentId)).toEqual([UNRESOLVED_SEGMENT])
    expect(result.grant?.decidedBy).toBe(REVIEWER)
    // The unselected segment is still pending afterwards: it blocks until it is decided itself.
    expect(result.pending.map((item) => [item.segmentId, item.decision])).toEqual([
      [MIRA_SEGMENT, 'pending'],
    ])

    const listed = await app.review.list('job-review')
    expect(listed.map((item) => [item.segmentId, item.decision])).toEqual([
      [UNRESOLVED_SEGMENT, 'approved'],
      [MIRA_SEGMENT, 'pending'],
    ])
    expect(listed.find((item) => item.segmentId === UNRESOLVED_SEGMENT)?.approvalId).not.toBeNull()
  })

  it('covers every pending subject when no selection is given — approve-all is unchanged', async () => {
    const book = bookOf()
    directedJob(app.jobs, book)

    const result = await app.review.grantBookFallback({ jobId: 'job-review', decidedBy: REVIEWER })

    expect(result.created.map((record) => record.segmentId)).toEqual([
      UNRESOLVED_SEGMENT,
      MIRA_SEGMENT,
    ])
    expect(result.pending).toEqual([])
    expect(result.grant?.subjects).toHaveLength(2)
  })

  it('rejects a selected ID that is not in the current queue, approving nothing', async () => {
    const book = bookOf()
    directedJob(app.jobs, book)

    // A narration segment never falls back, and a fabricated ID never existed: neither is on
    // offer, and a grant must not silently ignore them.
    for (const segmentIds of [
      [UNRESOLVED_SEGMENT, NARRATION_SEGMENT],
      [`${BOOK_ID}-ch0001-p000001-s0099`],
    ]) {
      await expect(
        app.review.grantBookFallback({ jobId: 'job-review', decidedBy: REVIEWER, segmentIds }),
      ).rejects.toThrow('not awaiting a decision in the current review queue')
    }

    expect(app.approvals.approvals.size).toBe(0)
    expect((await app.approvals.readCatalog(BOOK_ID)).grant).toBeUndefined()
    const listed = await app.review.list('job-review')
    expect(listed.every((item) => item.decision === 'pending')).toBe(true)
  })

  it('rejects the whole request when one selected segment was decided since the queue was read', async () => {
    const book = bookOf()
    directedJob(app.jobs, book)
    // The queue the human read had both segments pending. Between display and submission, one was
    // approved individually — the selection is now stale.
    await app.review.approve({ jobId: 'job-review', segmentId: MIRA_SEGMENT, decidedBy: REVIEWER })

    await expect(
      app.review.grantBookFallback({
        jobId: 'job-review',
        decidedBy: REVIEWER,
        segmentIds: [UNRESOLVED_SEGMENT, MIRA_SEGMENT],
      }),
    ).rejects.toThrow('not awaiting a decision in the current review queue')

    // Nothing was partially granted: the still-pending segment remains pending, and no grant was
    // recorded. The human re-reads the queue and decides over what is actually on offer.
    expect((await app.approvals.readCatalog(BOOK_ID)).grant).toBeUndefined()
    const listed = await app.review.list('job-review')
    expect(listed.map((item) => [item.segmentId, item.decision])).toEqual([
      [UNRESOLVED_SEGMENT, 'pending'],
      [MIRA_SEGMENT, 'approved'],
    ])
    expect(app.approvals.approvals.size).toBe(1)
  })

  it('rejects a selection naming a segment the human withdrew — a grant never undoes a withdrawal', async () => {
    const book = bookOf()
    directedJob(app.jobs, book)
    await app.review.approve({ jobId: 'job-review', segmentId: MIRA_SEGMENT, decidedBy: REVIEWER })
    await app.review.revoke({ jobId: 'job-review', segmentId: MIRA_SEGMENT, decidedBy: REVIEWER })

    await expect(
      app.review.grantBookFallback({
        jobId: 'job-review',
        decidedBy: REVIEWER,
        segmentIds: [UNRESOLVED_SEGMENT, MIRA_SEGMENT],
      }),
    ).rejects.toThrow('not awaiting a decision in the current review queue')

    expect((await app.approvals.readCatalog(BOOK_ID)).grant).toBeUndefined()
    const listed = await app.review.list('job-review')
    expect(listed.map((item) => [item.segmentId, item.decision])).toEqual([
      [UNRESOLVED_SEGMENT, 'pending'],
      [MIRA_SEGMENT, 'excluded'],
    ])
  })

  it('rejects a selection whose segment stopped falling back after the queue was read', async () => {
    const book = bookOf()
    directedJob(app.jobs, book)
    const displayed = await app.review.list('job-review')
    expect(displayed.filter((item) => item.decision === 'pending')).toHaveLength(2)

    // The script changed under the open page: mira joined the cast, so that segment resolved and
    // is no longer a fallback subject. Approving it now would authorize a line nobody reviewed.
    const withMira = new VoiceCast(
      voice('cast-narrator', 'narrator', null),
      voice('cast-fallback', 'fallback', null),
      [voice('cast-alice', 'character', 'alice'), voice('cast-mira', 'character', 'mira')],
    )
    const chapter = new Chapter({
      id: CHAPTER_ID,
      bookId: BOOK_ID,
      position: 1,
      title: 'An Open Door',
      sourcePassages: [
        new SourcePassage({
          id: PASSAGE_ID,
          chapterId: CHAPTER_ID,
          sourceText: DEFAULT_LINES.map((line) => line.text).join(''),
        }),
      ],
    })
    const segments = ExactSourceCoverage.createSegments(
      chapter,
      DEFAULT_LINES.map((line) => ({
        sourcePassageId: PASSAGE_ID,
        sourceText: line.text,
        kind: line.kind,
        speakerId: line.speakerId,
        confidence: 0.9,
        delivery: {
          emotion: 'calm',
          pace: 'normal' as const,
          volume: 'normal' as const,
          pauseAfterMs: 200,
        },
      })),
    )
    for (const segment of segments) segment.assignVoice(withMira.resolve(segment).assignment)
    chapter.submitForReview(segments)
    chapter.approve()
    app.jobs.book = new Book({
      id: BOOK_ID,
      title: 'Review Fixture',
      author: null,
      coverPath: null,
      source: { epubPath: '/uploads/review.epub', sha256: SOURCE_HASH },
      chapters: [chapter],
    })

    await expect(
      app.review.grantBookFallback({
        jobId: 'job-review',
        decidedBy: REVIEWER,
        segmentIds: displayed
          .filter((item) => item.decision === 'pending')
          .map((item) => item.segmentId),
      }),
    ).rejects.toThrow('not awaiting a decision in the current review queue')

    expect((await app.approvals.readCatalog(BOOK_ID)).grant).toBeUndefined()
    expect(app.approvals.approvals.size).toBe(0)
  })

  it('rejects an empty or duplicated selection without deciding anything', async () => {
    directedJob(app.jobs, bookOf())

    await expect(
      app.review.grantBookFallback({ jobId: 'job-review', decidedBy: REVIEWER, segmentIds: [] }),
    ).rejects.toThrow('requires at least one segment')
    await expect(
      app.review.grantBookFallback({
        jobId: 'job-review',
        decidedBy: REVIEWER,
        segmentIds: [UNRESOLVED_SEGMENT, UNRESOLVED_SEGMENT],
      }),
    ).rejects.toThrow('cannot contain the same segment twice')

    expect((await app.approvals.readCatalog(BOOK_ID)).grant).toBeUndefined()
    expect(app.approvals.approvals.size).toBe(0)
  })

  it('binds the grant to the exact subject tuples on offer, not to the IDs alone', async () => {
    const book = bookOf()
    directedJob(app.jobs, book)

    const result = await app.review.grantBookFallback({
      jobId: 'job-review',
      decidedBy: REVIEWER,
      segmentIds: [MIRA_SEGMENT],
    })

    // The recorded subject carries speaker, reason, voice and the digest of the exact line, so a
    // later re-direction leaves a grant that no longer describes what would be spoken.
    const subject = result.grant?.subjects[0]
    expect(subject).toMatchObject({
      segmentId: MIRA_SEGMENT,
      speakerId: 'mira',
      fallbackReason: 'missing_speaker_voice',
      voiceProfileId: 'cast-fallback',
    })
    expect(subject?.sourceTextSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(result.created[0]?.grantId).toBe(result.grant?.grantId)
  })
})
