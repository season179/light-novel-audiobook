/**
 * The review context: how a book-level pre-approval becomes per-segment records, when a record stops
 * standing, and what the review read model exposes.
 *
 * All story text below is invented for this fixture.
 */
import {
  AudiobookJob,
  Book,
  Chapter,
  DomainError,
  ExactSourceCoverage,
  type SegmentKind,
  SourcePassage,
  StableIds,
  VoiceCast,
  VoiceProfile,
} from '@light-novel-audiobook/domain'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  collectFallbackSubjects,
  FALLBACK_APPROVAL_POLICIES,
  FALLBACK_EXCERPT_MAX_LENGTH,
  type FallbackApprovalRepository,
  fallbackApprovalExcerpt,
  hashSourceText,
  type JobRepository,
  type PersistedFallbackApproval,
  ReviewFallbackApprovals,
} from '../src/index.js'

const SOURCE_HASH = '9a'.repeat(32)
const BOOK_ID = StableIds.book(SOURCE_HASH)
const CHAPTER_ID = StableIds.chapter(BOOK_ID, 1)
const PASSAGE_ID = StableIds.passage(CHAPTER_ID, 1)
const DECIDED_AT = new Date('2026-07-25T10:00:00.000Z')
const LATER = new Date('2026-07-25T15:45:00.000Z')

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

class StubJobRepository implements JobRepository {
  book: Book | undefined
  readonly jobs = new Map<string, AudiobookJob>()
  savedJobs: string[] = []

  async findJob(jobId: string): Promise<AudiobookJob | undefined> {
    return this.jobs.get(jobId)
  }

  async saveJob(job: AudiobookJob): Promise<void> {
    this.savedJobs.push(`${job.id}:${job.state}`)
    this.jobs.set(job.id, job)
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

class StubApprovalRepository implements FallbackApprovalRepository {
  readonly records = new Map<string, PersistedFallbackApproval>()
  revoked: string[] = []
  saved: string[] = []

  async listForBook(bookId: string): Promise<readonly PersistedFallbackApproval[]> {
    return [...this.records.values()]
      .filter((record) => record.bookId === bookId)
      .sort((left, right) => (left.segmentId < right.segmentId ? -1 : 1))
  }

  async save(record: PersistedFallbackApproval): Promise<void> {
    this.saved.push(record.segmentId)
    this.records.set(record.segmentId, record)
  }

  async revoke(_bookId: string, segmentId: string): Promise<boolean> {
    this.revoked.push(segmentId)
    return this.records.delete(segmentId)
  }
}

interface Harness {
  readonly jobs: StubJobRepository
  readonly approvals: StubApprovalRepository
  readonly review: ReviewFallbackApprovals
}

const harness = (now: () => Date = () => DECIDED_AT): Harness => {
  const jobs = new StubJobRepository()
  const approvals = new StubApprovalRepository()
  return { jobs, approvals, review: new ReviewFallbackApprovals({ jobs, approvals, now }) }
}

const directedJob = (jobs: StubJobRepository, book: Book, jobId = 'job-review'): AudiobookJob => {
  const job = new AudiobookJob(jobId)
  job.bindCommand('a'.repeat(64))
  job.start()
  job.attachBook(book.id)
  job.beginDirection()
  job.awaitReview()
  jobs.jobs.set(jobId, job)
  jobs.book = book
  return job
}

describe('ReviewFallbackApprovals (issue #45)', () => {
  let app: Harness

  beforeEach(() => {
    app = harness()
  })

  it('turns one book-level pre-approval into a record per unresolved-speaker segment', async () => {
    const book = bookOf()
    const result = await app.review.reconcile({ book, policy: 'pre-approve-book-fallback' })

    // Two fallback segments, two records, two distinct identities — never one blanket approval.
    expect(result.created.map((record) => record.segmentId)).toEqual([
      UNRESOLVED_SEGMENT,
      MIRA_SEGMENT,
    ])
    expect(result.pending).toEqual([])
    expect(new Set(result.created.map((record) => record.approvalSha256)).size).toBe(2)
    expect(result.created.map((record) => record.fallbackReason)).toEqual([
      'unresolved_speaker',
      'missing_speaker_voice',
    ])
    expect(result.created.map((record) => record.speakerId)).toEqual([null, 'mira'])
    expect(result.created.every((record) => record.voiceProfileId === 'cast-fallback')).toBe(true)
    expect(result.created.every((record) => record.decidedAt === DECIDED_AT.toISOString())).toBe(
      true,
    )
  })

  it('leaves an unchanged decision byte-for-byte alone on a second reconciliation', async () => {
    const book = bookOf()
    const first = await app.review.reconcile({ book, policy: 'pre-approve-book-fallback' })
    // A later clock proves idempotence is by content, not by luck: the second pass runs at a
    // different instant and must still not restale a segment, or every generation run would
    // re-render every fallback segment in the book.
    const second = await new ReviewFallbackApprovals({
      jobs: app.jobs,
      approvals: app.approvals,
      now: () => LATER,
    }).reconcile({ book: bookOf(), policy: 'pre-approve-book-fallback' })

    expect(second.created).toEqual([])
    expect(second.revoked).toEqual([])
    expect(second.unchanged.map((record) => record.approvalId)).toEqual(
      first.created.map((record) => record.approvalId),
    )
    expect(app.approvals.saved).toEqual([UNRESOLVED_SEGMENT, MIRA_SEGMENT])
  })

  it('revokes a decision whose approved line was re-directed under it', async () => {
    await app.review.reconcile({ book: bookOf(), policy: 'pre-approve-book-fallback' })
    const before = app.approvals.records.get(MIRA_SEGMENT)?.approvalId

    // Same speaker and same position, different words: PLAN.md:132 makes that an invalidation, and
    // the human approved a line, not a slot.
    const rewritten = await app.review.reconcile({
      book: bookOf([
        ...DEFAULT_LINES.slice(0, 3),
        { text: '“Then stop counting.”', kind: 'dialogue', speakerId: 'mira' },
      ]),
      policy: 'pre-approve-book-fallback',
    })

    expect(rewritten.revoked.map((record) => record.segmentId)).toEqual([MIRA_SEGMENT])
    expect(rewritten.created.map((record) => record.segmentId)).toEqual([MIRA_SEGMENT])
    expect(app.approvals.records.get(MIRA_SEGMENT)?.approvalId).not.toBe(before)
    // The other speaker's decision was untouched.
    expect(rewritten.unchanged.map((record) => record.segmentId)).toEqual([UNRESOLVED_SEGMENT])
  })

  it('revokes a decision whose segment no longer falls back at all', async () => {
    await app.review.reconcile({ book: bookOf(), policy: 'pre-approve-book-fallback' })
    // The cast gained a voice for mira, so that segment resolves and needs no human decision.
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
    const recast = new Book({
      id: BOOK_ID,
      title: 'Review Fixture',
      author: null,
      coverPath: null,
      source: { epubPath: '/uploads/review.epub', sha256: SOURCE_HASH },
      chapters: [chapter],
    })

    const result = await app.review.reconcile({ book: recast, policy: 'pre-approve-book-fallback' })
    expect(result.revoked.map((record) => record.segmentId)).toEqual([MIRA_SEGMENT])
    expect(result.approved.map((record) => record.segmentId)).toEqual([UNRESOLVED_SEGMENT])
    expect(collectFallbackSubjects(recast).map((subject) => subject.segment.id)).toEqual([
      UNRESOLVED_SEGMENT,
    ])
  })

  it('reports every unresolved speaker as pending under require-explicit-review and writes nothing', async () => {
    const result = await app.review.reconcile({
      book: bookOf(),
      policy: 'require-explicit-review',
    })
    expect(result.created).toEqual([])
    expect(result.approved).toEqual([])
    expect(app.approvals.saved).toEqual([])
    expect(result.pending.map((item) => item.segmentId)).toEqual([UNRESOLVED_SEGMENT, MIRA_SEGMENT])
    expect(result.pending.map((item) => item.sourceTextExcerpt)).toEqual([
      '“Nobody counted the hours.”',
      '“Then start counting.”',
    ])
    expect(result.pending.every((item) => item.chapterTitle === 'An Open Door')).toBe(true)
    expect(result.pending.every((item) => item.proposedVoiceProfileId === 'cast-fallback')).toBe(
      true,
    )
  })

  it('offers exactly two policies and rejects anything else', async () => {
    expect([...FALLBACK_APPROVAL_POLICIES]).toEqual([
      'pre-approve-book-fallback',
      'require-explicit-review',
    ])
    await expect(
      app.review.reconcile({
        book: bookOf(),
        // A caller reaching for an auto-approve escape hatch does not get one.
        policy: 'auto-approve' as unknown as 'require-explicit-review',
      }),
    ).rejects.toThrow('Unsupported fallback approval policy')
  })

  it('returns a completed job to review when one decision is revoked, and only then', async () => {
    const book = bookOf()
    const job = directedJob(app.jobs, book)
    await app.review.reconcile({ book, policy: 'pre-approve-book-fallback' })
    job.resumeApprovedRender()
    job.beginRendering(4)
    for (const segment of book.chapters[0]?.segments ?? []) job.recordSegmentCompleted(segment.id)
    job.beginAssembly()
    job.complete({
      version: { value: 1, label: 'v001', fileName: () => 'x' } as never,
      m4bPath: '/workspace/review-v001.m4b',
      chapters: [{ chapterId: CHAPTER_ID, path: '/workspace/ch1.flac' }],
    })
    expect(job.state).toBe('completed')

    expect(await app.review.revoke({ jobId: 'job-review', segmentId: MIRA_SEGMENT })).toBe(true)
    expect(job.state).toBe('awaiting_review')
    expect(job.output).toBeNull()
    // The reuse ledger is untouched: only the revoked segment's content address became unreachable.
    expect(app.approvals.records.has(UNRESOLVED_SEGMENT)).toBe(true)

    // A second revocation of the same segment changes nothing and does not reopen anything.
    const saves = app.jobs.savedJobs.length
    expect(await app.review.revoke({ jobId: 'job-review', segmentId: MIRA_SEGMENT })).toBe(false)
    expect(app.jobs.savedJobs).toHaveLength(saves)
  })

  it('re-approving a revoked segment records a new decision with a new identity', async () => {
    const book = bookOf()
    directedJob(app.jobs, book)
    await app.review.reconcile({ book, policy: 'pre-approve-book-fallback' })
    const original = app.approvals.records.get(MIRA_SEGMENT)?.approvalId
    await app.review.revoke({ jobId: 'job-review', segmentId: MIRA_SEGMENT })

    const later = new ReviewFallbackApprovals({
      jobs: app.jobs,
      approvals: app.approvals,
      now: () => LATER,
    })
    const record = await later.approve({ jobId: 'job-review', segmentId: MIRA_SEGMENT })
    expect(record.approvalId).not.toBe(original)
    expect(record.decidedAt).toBe(LATER.toISOString())
    expect(record.sourceTextSha256).toBe(hashSourceText('“Then start counting.”'))
  })

  it('refuses to decide a segment that does not need a fallback decision', async () => {
    const book = bookOf()
    directedJob(app.jobs, book)
    const narration = StableIds.segment(PASSAGE_ID, 1)
    await expect(app.review.approve({ jobId: 'job-review', segmentId: narration })).rejects.toThrow(
      'does not need a fallback approval',
    )
    await expect(
      app.review.revoke({ jobId: 'job-review', segmentId: 'not-a-segment' }),
    ).rejects.toThrow('does not need a fallback approval')
    await expect(app.review.list('job-missing')).rejects.toThrow(DomainError)
  })

  it('lists decided and undecided speakers together for the review UI', async () => {
    const book = bookOf()
    directedJob(app.jobs, book)
    await app.review.approve({ jobId: 'job-review', segmentId: MIRA_SEGMENT })

    const listed = await app.review.list('job-review')
    expect(listed.map((item) => [item.segmentId, item.decision])).toEqual([
      [UNRESOLVED_SEGMENT, 'pending'],
      [MIRA_SEGMENT, 'approved'],
    ])
    expect(listed[0]?.approvalId).toBeNull()
    expect(listed[1]?.approvalId).toBe(app.approvals.records.get(MIRA_SEGMENT)?.approvalId)
  })

  it('caps a review excerpt and collapses its whitespace', () => {
    expect(fallbackApprovalExcerpt('  “Two   words”\n next ')).toBe('“Two words” next')
    const long = fallbackApprovalExcerpt('x'.repeat(400))
    expect(long).toHaveLength(FALLBACK_EXCERPT_MAX_LENGTH)
    expect(long.endsWith('…')).toBe(true)
  })
})
