import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  createDirectionApprovalRecord,
  createDirectionScriptSha256,
  type JobRepository,
  ReviewDirection,
  resolveReviewerIdentity,
} from '@light-novel-audiobook/application'
import {
  AudiobookJob,
  Book,
  Chapter,
  ExactSourceCoverage,
  SourcePassage,
  StableIds,
} from '@light-novel-audiobook/domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteDirectionApprovalRepository } from '../src/direction-approvals.js'
import { migrateSchema, SCHEMA_VERSION } from '../src/schema.js'

const SENTINEL = 'INVENTED_SENTINEL_96_DIRECTION_LEDGER'

const directedBook = (sourceText = SENTINEL): Book => {
  const sourceSha256 = '3'.repeat(64)
  const bookId = StableIds.book(sourceSha256)
  const chapterId = StableIds.chapter(bookId, 1)
  const passage = new SourcePassage({
    id: StableIds.passage(chapterId, 1),
    chapterId,
    sourceText,
  })
  const chapter = new Chapter({
    id: chapterId,
    bookId,
    position: 1,
    title: 'fixture-chapter',
    sourcePassages: [passage],
  })
  const segments = ExactSourceCoverage.createSegments(chapter, [
    {
      sourcePassageId: passage.id,
      sourceText,
      kind: 'narration',
      speakerId: null,
      confidence: 1,
      delivery: { emotion: 'neutral', pace: 'normal', volume: 'normal', pauseAfterMs: 0 },
    },
  ])
  segments[0]?.assignVoice({
    voiceProfileId: 'voice-narrator',
    usesFallback: false,
    fallbackReason: null,
  })
  chapter.submitForReview(segments)
  chapter.approve()
  return new Book({
    id: bookId,
    title: 'fixture-book',
    author: null,
    coverPath: null,
    source: { epubPath: join(tmpdir(), 'invented-fixture.epub'), sha256: sourceSha256 },
    chapters: [chapter],
  })
}

const awaitingReviewJob = (book: Book): AudiobookJob => {
  const job = new AudiobookJob('job-direction-fixture')
  job.bindCommand('a'.repeat(64))
  job.start()
  job.attachBook(book.id)
  job.beginDirection(1, 1)
  job.recordDirectionProgress(book.chapters[0]?.id ?? 'missing', 1, 1, 'Direction complete')
  job.awaitReview()
  return job
}

const approval = (scriptSha256: string, decidedAt = '2026-08-01T12:34:56.000Z') =>
  createDirectionApprovalRecord({
    jobId: 'job-direction-fixture',
    bookId: StableIds.book('3'.repeat(64)),
    scriptSha256,
    decidedBy: 'Reviewer 01',
    decidedAt,
  })

describe('SQLite direction approval ledger', () => {
  let root: string
  let db: DatabaseSync

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lna-direction-approval-'))
    db = new DatabaseSync(join(root, 'audiobook.db'))
    migrateSchema(db)
  })

  afterEach(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('keeps historical decisions and returns the latest exact match', async () => {
    const repository = new SqliteDirectionApprovalRepository(db)
    const hash = createDirectionScriptSha256(directedBook())
    const first = approval(hash)
    const second = approval(hash, '2026-08-02T12:34:56.000Z')

    await repository.saveDirectionApproval(first)
    await repository.saveDirectionApproval(second)

    expect(db.prepare('SELECT COUNT(*) AS count FROM direction_approvals').get()).toEqual({
      count: 2,
    })
    expect(
      await repository.findDirectionApproval({
        jobId: second.jobId,
        bookId: second.bookId,
        scriptSha256: hash,
      }),
    ).toEqual(second)
  })

  it('finds nothing for a changed script hash', async () => {
    const repository = new SqliteDirectionApprovalRepository(db)
    const original = approval(createDirectionScriptSha256(directedBook()))
    await repository.saveDirectionApproval(original)

    expect(
      await repository.findDirectionApproval({
        jobId: original.jobId,
        bookId: original.bookId,
        scriptSha256: createDirectionScriptSha256(directedBook(`${SENTINEL}-changed`)),
      }),
    ).toBeUndefined()
  })

  it('persists the script hash but no source story text', async () => {
    const book = directedBook()
    const job = awaitingReviewJob(book)
    const scriptSha256 = createDirectionScriptSha256(book)
    const repository = new SqliteDirectionApprovalRepository(db)
    const review = new ReviewDirection({
      jobs: {
        findJob: async () => job,
        findBook: async () => book,
      } as unknown as JobRepository,
      approvals: repository,
      now: () => new Date('2026-08-01T12:34:56.000Z'),
    })
    await review.confirm({
      jobId: job.id,
      decidedBy: resolveReviewerIdentity({ LNA_REVIEWER: 'Reviewer 01' }, () => undefined),
    })

    const row = db.prepare('SELECT * FROM direction_approvals').get() as Record<string, unknown>
    const serialized = JSON.stringify(row)
    expect(serialized).not.toContain(SENTINEL)
    expect(serialized).toContain(scriptSha256)
    expect(row).toEqual(
      expect.objectContaining({
        script_sha256: scriptSha256,
        decided_by: 'Reviewer 01',
      }),
    )
  })

  it('is not overwritten by an ordinary job save', async () => {
    const repository = new SqliteDirectionApprovalRepository(db)
    const record = approval(createDirectionScriptSha256(directedBook()))
    await repository.saveDirectionApproval(record)
    db.prepare('INSERT INTO jobs (id, snapshot_json) VALUES (?, ?)').run(record.jobId, '{}')
    db.prepare('UPDATE jobs SET snapshot_json = ? WHERE id = ?').run('{"saved":true}', record.jobId)

    expect(await repository.findDirectionApproval(record)).toEqual(record)
  })
})

describe('schema 5 to schema 6 migration', () => {
  it('uses the registered version-5 path and preserves existing book and job rows', () => {
    const root = mkdtempSync(join(tmpdir(), 'lna-schema-5-forward-'))
    const db = new DatabaseSync(join(root, 'audiobook.db'))
    try {
      migrateSchema(db, 5)
      expect(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({
        version: 5,
      })
      db.prepare(
        `INSERT INTO books (id, title, author, cover_path, epub_path, epub_sha256)
         VALUES (?, ?, NULL, NULL, ?, ?)`,
      ).run('book-existing', 'fixture-book', join(root, 'fixture.epub'), '4'.repeat(64))
      db.prepare('INSERT INTO jobs (id, snapshot_json) VALUES (?, ?)').run(
        'job-existing',
        JSON.stringify({ schemaVersion: 4, fixture: true }),
      )
      db.prepare(
        `INSERT INTO completed_outputs (job_id, version, m4b_path, chapters_json)
         VALUES (?, ?, ?, ?)`,
      ).run('job-existing', 1, join(root, 'existing.m4b'), '[]')

      migrateSchema(db)

      expect(SCHEMA_VERSION).toBe(6)
      expect(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({
        version: 6,
      })
      expect(db.prepare('SELECT id, epub_sha256 FROM books').get()).toEqual({
        id: 'book-existing',
        epub_sha256: '4'.repeat(64),
      })
      expect(db.prepare('SELECT id, snapshot_json FROM jobs').get()).toEqual({
        id: 'job-existing',
        snapshot_json: JSON.stringify({ schemaVersion: 4, fixture: true }),
      })
      expect(db.prepare('SELECT job_id, version FROM completed_outputs').get()).toEqual({
        job_id: 'job-existing',
        version: 1,
      })
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get('direction_approvals'),
      ).toEqual({ name: 'direction_approvals' })
      expect(db.prepare('SELECT COUNT(*) AS count FROM direction_approvals').get()).toEqual({
        count: 0,
      })
    } finally {
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
