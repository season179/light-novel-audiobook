import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type {
  DirectionApprovalQuery,
  DirectionApprovalRepository,
  JobRepository,
  PersistedDirectionApproval,
} from '@light-novel-audiobook/application'
import { AudiobookJob, type Book, type Segment } from '@light-novel-audiobook/domain'
import { describe, expect, it } from 'vitest'
import {
  createDirectionApprovalRecord,
  createDirectionScriptSha256,
  ReviewDirection,
  resolveReviewerIdentity,
} from '../src/index.js'
import { createDirectionFixtureBook } from './support/direction-fixture.js'

const run = promisify(execFile)

const cloneWith = <T extends object>(value: T, changes: Record<string, unknown>): T => {
  const clone = Object.create(Object.getPrototypeOf(value)) as T
  return Object.assign(clone, value, changes)
}

const changeFirstSegment = (
  book: Book,
  changes: Record<string, unknown> | ((segment: Segment) => Record<string, unknown>),
): Book => {
  const chapter = book.chapters[0]
  const segment = chapter?.segments[0]
  if (chapter === undefined || segment === undefined) throw new Error('fixture is incomplete')
  const replacement = cloneWith(segment, typeof changes === 'function' ? changes(segment) : changes)
  const changedChapter = cloneWith(chapter, {
    directedSegments: Object.freeze([replacement, ...chapter.segments.slice(1)]),
  })
  return cloneWith(book, { chapters: Object.freeze([changedChapter, ...book.chapters.slice(1)]) })
}

class MemoryDirectionApprovals implements DirectionApprovalRepository {
  readonly records: PersistedDirectionApproval[] = []

  async findDirectionApproval(
    query: DirectionApprovalQuery,
  ): Promise<PersistedDirectionApproval | undefined> {
    return this.records.find(
      (record) =>
        record.jobId === query.jobId &&
        record.bookId === query.bookId &&
        record.scriptSha256 === query.scriptSha256,
    )
  }

  async saveDirectionApproval(approval: PersistedDirectionApproval): Promise<void> {
    this.records.push(approval)
  }
}

const awaitingReviewJob = (book: Book): AudiobookJob => {
  const job = new AudiobookJob('job-direction-fixture')
  job.bindCommand('a'.repeat(64))
  job.start()
  job.attachBook(book.id)
  job.beginDirection(book.chapters.length, book.chapters.length)
  job.recordDirectionProgress(
    book.chapters.at(-1)?.id ?? 'missing',
    book.chapters.length,
    book.chapters.length,
    'Fixture direction complete',
  )
  job.awaitReview()
  return job
}

const actor = resolveReviewerIdentity({ LNA_REVIEWER: 'Reviewer 01' }, () => undefined)

describe('whole directed-script identity', () => {
  it('is byte-identical across repeated calls and independent Node processes', async () => {
    const expected = createDirectionScriptSha256(createDirectionFixtureBook())
    expect(createDirectionScriptSha256(createDirectionFixtureBook())).toBe(expected)

    const child = join(dirname(fileURLToPath(import.meta.url)), 'direction-identity-child.ts')
    const invoke = () => run(process.execPath, ['--import', 'tsx', child])
    const [first, second] = await Promise.all([invoke(), invoke()])
    expect(first.stderr).toBe('')
    expect(second.stderr).toBe('')
    expect(first.stdout).toBe(expected)
    expect(second.stdout).toBe(expected)
  })

  it.each([
    ['segment ID', (segment: Segment) => ({ id: `${segment.id}-changed` })],
    ['source-text hash', () => ({ sourceText: 'Invented changed fixture text.' })],
    ['kind', () => ({ kind: 'thought' })],
    ['speaker', () => ({ speakerId: 'speaker-02' })],
    ['confidence', () => ({ confidence: 0.76 })],
    [
      'delivery emotion',
      (segment: Segment) => ({ delivery: { ...segment.delivery, emotion: 'urgent' } }),
    ],
    ['delivery pace', (segment: Segment) => ({ delivery: { ...segment.delivery, pace: 'fast' } })],
    [
      'delivery volume',
      (segment: Segment) => ({ delivery: { ...segment.delivery, volume: 'loud' } }),
    ],
    [
      'delivery pause',
      (segment: Segment) => ({ delivery: { ...segment.delivery, pauseAfterMs: 126 } }),
    ],
    [
      'voice profile',
      (segment: Segment) => ({
        assignment: { ...segment.voiceAssignment, voiceProfileId: 'voice-02' },
      }),
    ],
    [
      'voice fallback flag',
      (segment: Segment) => ({ assignment: { ...segment.voiceAssignment, usesFallback: true } }),
    ],
    [
      'voice fallback reason',
      (segment: Segment) => ({
        assignment: { ...segment.voiceAssignment, fallbackReason: 'missing_speaker_voice' },
      }),
    ],
  ] as const)('changes when the covered %s changes', (_label, change) => {
    const original = createDirectionFixtureBook()
    expect(createDirectionScriptSha256(changeFirstSegment(original, change))).not.toBe(
      createDirectionScriptSha256(original),
    )
  })

  it('changes when a chapter ID changes', () => {
    const original = createDirectionFixtureBook()
    const chapter = original.chapters[0]
    if (chapter === undefined) throw new Error('fixture is incomplete')
    const changedChapter = cloneWith(chapter, { id: `${chapter.id}-changed` })
    const changed = cloneWith(original, {
      chapters: Object.freeze([changedChapter, ...original.chapters.slice(1)]),
    })
    expect(createDirectionScriptSha256(changed)).not.toBe(createDirectionScriptSha256(original))
  })

  it('changes when segment order changes', () => {
    const original = createDirectionFixtureBook()
    const chapter = original.chapters[0]
    if (chapter === undefined) throw new Error('fixture is incomplete')
    const changedChapter = cloneWith(chapter, {
      directedSegments: Object.freeze([...chapter.segments].reverse()),
    })
    const reordered = cloneWith(original, {
      chapters: Object.freeze([changedChapter, ...original.chapters.slice(1)]),
    })
    expect(createDirectionScriptSha256(reordered)).not.toBe(createDirectionScriptSha256(original))
  })

  it('changes when chapter order changes', () => {
    const original = createDirectionFixtureBook()
    const reordered = cloneWith(original, {
      chapters: Object.freeze([...original.chapters].reverse()),
    })
    expect(createDirectionScriptSha256(reordered)).not.toBe(createDirectionScriptSha256(original))
  })
})

describe('whole-script confirmation operation', () => {
  it('records the resolved reviewer and exact persisted script', async () => {
    const book = createDirectionFixtureBook()
    const job = awaitingReviewJob(book)
    const approvals = new MemoryDirectionApprovals()
    const review = new ReviewDirection({
      jobs: {
        findJob: async () => job,
        findBook: async () => book,
      } as unknown as JobRepository,
      approvals,
      now: () => new Date('2026-08-01T12:34:56.000Z'),
    })

    const confirmed = await review.confirm({ jobId: job.id, decidedBy: actor })

    expect(confirmed).toEqual({
      approvalId: expect.stringMatching(/^direction-[a-f\d]{64}$/),
      jobId: job.id,
      bookId: book.id,
      scriptSha256: createDirectionScriptSha256(book),
      decidedBy: actor,
      decidedAt: '2026-08-01T12:34:56.000Z',
    })
    expect(await review.findCurrent(job.id)).toEqual(confirmed)
  })

  it('finds no approval after the persisted script changes', async () => {
    const original = createDirectionFixtureBook()
    const job = awaitingReviewJob(original)
    const approvals = new MemoryDirectionApprovals()
    let current = original
    const review = new ReviewDirection({
      jobs: {
        findJob: async () => job,
        findBook: async () => current,
      } as unknown as JobRepository,
      approvals,
      now: () => new Date('2026-08-01T12:34:56.000Z'),
    })
    await review.confirm({ jobId: job.id, decidedBy: actor })

    current = changeFirstSegment(original, { confidence: 0.76 })

    expect(await review.findCurrent(job.id)).toBeUndefined()
    expect(approvals.records).toHaveLength(1)
  })

  it('rejects malformed decision evidence before persistence', () => {
    expect(() =>
      createDirectionApprovalRecord({
        jobId: 'job-01',
        bookId: 'book-01',
        scriptSha256: 'a'.repeat(64),
        decidedBy: 'Reviewer 01',
        decidedAt: '2026-08-01T12:34:56Z',
      }),
    ).toThrow(/canonical ISO 8601/)
  })
})
