import { mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
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
  type Chapter,
  DomainError,
  OutputVersion,
} from '@light-novel-audiobook/domain'
import type { WorkspaceLayout } from './workspace.js'
import { hashText, outputBaseName, sha256OfFile, toSafeAbsolute } from './workspace.js'

/** JobRepository implementation backed by SQLite + filesystem. */
export class SqliteJobRepository implements JobRepository {
  constructor(
    private readonly layout: WorkspaceLayout,
    private readonly db: DatabaseSync,
  ) {}

  async findJob(jobId: string): Promise<AudiobookJob | undefined> {
    if (!jobId || jobId.length === 0) {
      throw new DomainError('Job ID is required')
    }

    const row = this.db.prepare('SELECT snapshot_json FROM jobs WHERE id = ?').get(jobId) as
      | { snapshot_json?: string }
      | undefined

    if (!row?.snapshot_json) return undefined

    // A crash mid-write can truncate the snapshot. findJob is called before the use case has a
    // job to record a failure on, so a raw SyntaxError would leave the job permanently
    // unopenable with no explanation; surface it as a domain failure instead.
    let snapshot: AudiobookJobSnapshot
    try {
      snapshot = JSON.parse(row.snapshot_json) as AudiobookJobSnapshot
    } catch {
      throw new DomainError(`Audiobook job ${jobId} has an unreadable snapshot`)
    }
    return AudiobookJob.reconstitute(snapshot)
  }

  async saveJob(job: AudiobookJob): Promise<void> {
    if (!job.id) throw new DomainError('Job ID is required')

    const snapshot = job.snapshot()
    const json = JSON.stringify(snapshot)

    withTransaction(this.db, () => {
      this.db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id)
      this.db.prepare('INSERT INTO jobs (id, snapshot_json) VALUES (?, ?)').run(job.id, json)
    })
  }

  async saveBook(book: Book): Promise<void> {
    withTransaction(this.db, () => {
      // Upsert, never INSERT OR REPLACE. REPLACE deletes the conflicting row before
      // re-inserting it, and SQLite runs ON DELETE CASCADE actions for a REPLACE-driven
      // delete -- which is how this wiped the artifact and reservation ledgers. The use case
      // calls saveBook six times per run, interleaved with saveCompletedSegment and
      // reserveNextOutput, so saveBook must only ever touch book metadata.
      this.db
        .prepare(
          `INSERT INTO books (id, title, author, cover_path, epub_path, epub_sha256)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             author = excluded.author,
             cover_path = excluded.cover_path,
             epub_path = excluded.epub_path,
             epub_sha256 = excluded.epub_sha256`,
        )
        .run(
          book.id,
          book.title,
          book.author ?? null,
          book.coverPath ?? null,
          book.source.epubPath,
          book.source.sha256,
        )

      for (const chapter of book.chapters) {
        this.db
          .prepare(
            `INSERT INTO chapters (id, book_id, position, title)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               book_id = excluded.book_id,
               position = excluded.position,
               title = excluded.title`,
          )
          .run(chapter.id, book.id, chapter.position, chapter.title)

        this.saveChapterSegments(chapter)
      }

      // Delete only the chapters that are no longer part of the book. Their segments follow
      // through the chapters cascade, which stays: that cluster is written together.
      const chapterIds = book.chapters.map((chapter) => chapter.id)
      if (chapterIds.length === 0) {
        this.db.prepare('DELETE FROM chapters WHERE book_id = ?').run(book.id)
      } else {
        const placeholders = chapterIds.map(() => '?').join(', ')
        this.db
          .prepare(`DELETE FROM chapters WHERE book_id = ? AND id NOT IN (${placeholders})`)
          .run(book.id, ...chapterIds)
      }
    })
  }

  /**
   * Persist one chapter's segment rows, writing nothing when they already match. saveBook runs
   * once per chapter during direction plus twice per chapter during rendering, so on a
   * 400-chapter book an unconditional rewrite costs millions of row writes per run for data
   * nothing in this package reads.
   */
  private saveChapterSegments(chapter: Chapter): void {
    const desired = chapter.segments.map((segment, index) => ({
      id: segment.id,
      position: index + 1,
      sourcePassageId: segment.sourcePassageId,
      sourceTextSha256: hashText(segment.sourceText),
      kind: segment.kind,
      speakerId: segment.speakerId ?? null,
      confidence: segment.confidence,
      delivery: JSON.stringify(segment.delivery),
    }))

    const existing = this.db
      .prepare(
        `SELECT id, position, source_passage_id, source_text_sha256, kind, speaker_id, confidence, delivery
           FROM segments WHERE chapter_id = ? ORDER BY position`,
      )
      .all(chapter.id) as unknown as SegmentRow[]

    if (
      existing.length === desired.length &&
      desired.every((want, index) => segmentRowMatches(want, existing[index]))
    ) {
      return
    }

    // Replace this chapter's rows wholesale rather than upserting row by row. Segment ids encode
    // a position within their *passage* while segments.position is chapter-wide, so re-directing
    // a chapter can move a surviving segment id onto a position another surviving id still holds.
    // UNIQUE(chapter_id, position) is checked per statement and cannot be deferred, so a
    // row-by-row upsert would fail on that reshuffle. Safe now that artifacts no longer
    // reference segments, and it only runs for a chapter that actually changed.
    this.db.prepare('DELETE FROM segments WHERE chapter_id = ?').run(chapter.id)

    const insert = this.db.prepare(
      `INSERT INTO segments
        (id, chapter_id, position, source_passage_id, source_text_sha256, kind, speaker_id, confidence, delivery)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const want of desired) {
      insert.run(
        want.id,
        chapter.id,
        want.position,
        want.sourcePassageId,
        want.sourceTextSha256,
        want.kind,
        want.speakerId,
        want.confidence,
        want.delivery,
      )
    }
  }

  async findReusableSegment(
    query: ReusableSegmentQuery,
  ): Promise<CompletedSegmentAudio | undefined> {
    const { segmentId, inputIdentity } = query

    const row = this.db
      .prepare(
        'SELECT wav_path, sha256, byte_length FROM artifacts WHERE segment_id = ? AND input_identity = ?',
      )
      .get(segmentId, inputIdentity) as
      | { wav_path: string; sha256: string; byte_length: number }
      | undefined

    if (!row) return undefined

    // Must validate on-disk: exists, size matches, SHA-256 matches
    const validated = validateArtifact(row.wav_path, row.sha256, row.byte_length)
    if (!validated) return undefined

    return Object.freeze({
      segmentId,
      inputIdentity,
      wavPath: validated.wavPath,
      sha256: validated.sha256,
      byteLength: validated.byteLength,
    })
  }

  async saveCompletedSegment(segment: CompletedSegmentAudio): Promise<void> {
    const now = new Date().toISOString()
    withTransaction(this.db, () => {
      // Remove any prior artifact for this segment+identity to allow replacement after failure
      this.db
        .prepare('DELETE FROM artifacts WHERE segment_id = ? AND input_identity = ?')
        .run(segment.segmentId, segment.inputIdentity)

      this.db
        .prepare(
          'INSERT INTO artifacts (segment_id, input_identity, wav_path, sha256, byte_length, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          segment.segmentId,
          segment.inputIdentity,
          segment.wavPath,
          segment.sha256,
          segment.byteLength,
          now,
        )
    })
  }

  async reserveNextOutput(book: Book): Promise<OutputReservation> {
    const baseName = outputBaseName(book.title)

    const chapterOutputs = book.chapters.map((ch) => {
      const dir = join(this.layout.chapterDir, `ch-${ch.id}`)
      const stem = `${baseName}-ch${String(ch.position).padStart(3, '0')}`
      return { chapterId: ch.id, dir, stem }
    })

    // Start from the highest version already claimed for this book.
    const existing = this.db
      .prepare('SELECT MAX(version) AS v FROM output_reservations WHERE book_id = ?')
      .get(book.id) as { v: number | null } | undefined

    // Existing chapter files are read once: nothing writes into these directories until the
    // reservation has been claimed, so the listings cannot go stale inside this loop.
    const chapterEntries = new Map(
      chapterOutputs.map((ch) => [ch.dir, listExistingFiles(ch.dir)] as const),
    )

    let candidate = (existing?.v ?? 0) + 1
    let busyRetries = 0

    while (true) {
      const label = versionLabel(candidate)
      const m4bPath = join(this.layout.outputDir, `${baseName}-${label}.m4b`)
      const chapterPaths = chapterOutputs.map((ch) => ({
        chapterId: ch.chapterId,
        path: join(ch.dir, `${ch.stem}-${label}`),
      }))

      assertReservablePaths(this.layout.root, [m4bPath, ...chapterPaths.map((cp) => cp.path)])

      // Belt-and-braces now that the reservation row is the durable claim: never name a path
      // that already holds a file, however that file got there (restored database, deleted
      // database, output copied in by hand).
      const takenOnDisk =
        fileExists(m4bPath) ||
        chapterOutputs.some((ch) =>
          hasVersionedOutput(chapterEntries.get(ch.dir) ?? [], `${ch.stem}-${label}`),
        )
      if (takenOnDisk) {
        candidate += 1
        continue
      }

      // One transaction per attempt, not one around the whole loop: a rolled back attempt
      // releases its read snapshot, so a retry after SQLITE_BUSY sees the other process's
      // committed rows instead of spinning on a stale snapshot forever.
      const chapterPathsJson = JSON.stringify(
        chapterPaths.map((cp) => ({ chapterId: cp.chapterId, path: cp.path })),
      )
      const outcome = withTransaction(this.db, (): 'claimed' | 'taken' | 'busy' => {
        const dbConflict = this.db
          .prepare('SELECT 1 FROM output_reservations WHERE book_id = ? AND version = ?')
          .get(book.id, candidate)
        if (dbConflict) return 'taken'

        try {
          this.db
            .prepare(
              'INSERT INTO output_reservations (book_id, version, m4b_path, chapter_paths_json) VALUES (?, ?, ?, ?)',
            )
            .run(book.id, candidate, m4bPath, chapterPathsJson)
        } catch (error) {
          // PRIMARY KEY(book_id, version) is what actually guarantees uniqueness, so losing
          // this race is an ordinary outcome: take the next version instead of failing the run.
          const failure = classifySqliteFailure(error)
          if (failure === 'constraint') return 'taken'
          if (failure === 'busy') return 'busy'
          throw error
        }
        return 'claimed'
      })

      if (outcome === 'taken') {
        candidate += 1
        continue
      }
      if (outcome === 'busy') {
        busyRetries += 1
        if (busyRetries > BUSY_RETRY_LIMIT) {
          throw new DomainError(
            `Could not reserve an output version for book ${book.id}; the workspace database stayed locked`,
          )
        }
        continue
      }

      // After the claim commits, so a failed commit cannot leave directories behind.
      mkdirSync(dirname(m4bPath), { recursive: true })
      for (const ch of chapterOutputs) {
        mkdirSync(ch.dir, { recursive: true })
      }

      return {
        bookId: book.id,
        version: new OutputVersion(candidate),
        m4bPath,
        chapters: chapterPaths.map((cp) => ({
          chapterId: cp.chapterId,
          path: cp.path,
        })),
      }
    }
  }
}

// ============================================================
// Private helpers
// ============================================================

/** How many times a claim may lose a lock race before the run gives up. */
const BUSY_RETRY_LIMIT = 5

/** Primary SQLite result codes. node:sqlite reports the *extended* code on `errcode`. */
const SQLITE_BUSY = 5
const SQLITE_LOCKED = 6
const SQLITE_CONSTRAINT = 19

/** Open transaction depth per connection, so a nested call nests instead of failing. */
const transactionDepth = new WeakMap<DatabaseSync, number>()

/**
 * Run `work` inside a SQLite transaction. node:sqlite's DatabaseSync exposes no
 * `transaction()` helper, so BEGIN/COMMIT/ROLLBACK are issued explicitly here. A nested call
 * uses a savepoint: `BEGIN` inside a transaction is an error, and rolling the outer transaction
 * back on the inner unit's behalf would silently discard work the caller still owns.
 */
function withTransaction<T>(db: DatabaseSync, work: () => T): T {
  const depth = transactionDepth.get(db) ?? 0
  const savepoint = depth > 0 ? `lna_sp_${depth}` : null

  // BEGIN IMMEDIATE, not a deferred BEGIN: every unit of work here writes, and several read
  // before writing. A deferred transaction takes a read snapshot first, so once another process
  // commits, the write fails with SQLITE_BUSY_SNAPSHOT -- which busy_timeout does NOT wait out.
  // Taking the write lock up front is what makes busy_timeout actually apply.
  //
  // The opening statement stays outside the try. If it fails there is no transaction or
  // savepoint belonging to *this* call, and issuing ROLLBACK would destroy the caller's.
  db.exec(savepoint === null ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`)
  transactionDepth.set(db, depth + 1)
  try {
    const result = work()
    // Inside the try, so a failed commit/release still unwinds below.
    db.exec(savepoint === null ? 'COMMIT' : `RELEASE ${savepoint}`)
    transactionDepth.set(db, depth)
    return result
  } catch (error) {
    transactionDepth.set(db, depth)
    try {
      if (savepoint === null) {
        db.exec('ROLLBACK')
      } else {
        // ROLLBACK TO rewinds but leaves the savepoint active; RELEASE pops it.
        db.exec(`ROLLBACK TO ${savepoint}`)
        db.exec(`RELEASE ${savepoint}`)
      }
    } catch {
      // Preserve the causative error; a failed rollback should not mask it.
    }
    throw error
  }
}

/** Map a node:sqlite failure onto the two outcomes a claim can legitimately retry. */
function classifySqliteFailure(error: unknown): 'busy' | 'constraint' | null {
  if (typeof error !== 'object' || error === null) return null
  const { errcode } = error as { errcode?: unknown }
  if (typeof errcode !== 'number') return null
  switch (errcode & 0xff) {
    case SQLITE_BUSY:
    case SQLITE_LOCKED:
      return 'busy'
    case SQLITE_CONSTRAINT:
      return 'constraint'
    default:
      return null
  }
}

/**
 * Every reserved path must be absolute, already canonical, and inside the workspace. The
 * assembler (#32) resolves the paths it is handed, so a relative or merely non-canonical path is
 * silently rewritten rather than rejected: the book encodes to a different location, and
 * GenerateAudiobook then rejects the output on an exact path compare -- after hours of
 * rendering, leaving files that wedge every retry. Fail here, before anything is rendered.
 */
function assertReservablePaths(root: string, paths: readonly string[]): void {
  for (const path of paths) {
    if (!isAbsolute(path) || resolve(path) !== path) {
      throw new DomainError(`Reserved output path must be absolute and canonical: ${path}`)
    }
    // Also catches a chapter id whose separators or `..` segments join() already collapsed.
    if (!path.startsWith(`${root}${sep}`)) {
      throw new DomainError(`Reserved output path must stay inside the workspace: ${path}`)
    }
  }
}

/**
 * File names directly inside `dir`, or an empty list when it does not exist yet. Directories and
 * dot-entries are skipped: #32 creates `.lna-assembly-*` staging directories beside a reserved
 * output and a SIGKILL can leave one behind, and a leftover must never read as a finished output.
 */
function listExistingFiles(dir: string): readonly string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/**
 * Whether a file already exists named `<versionedStem>.<ext>` for this exact version. The
 * assembler picks the chapter master's container, so matching a single hard-coded extension here
 * would embed a cross-package assumption this package cannot verify. The version suffix is
 * required and the extension must be alphanumeric, so no other version and no staging leftover
 * can match.
 */
function hasVersionedOutput(entries: readonly string[], versionedStem: string): boolean {
  if (!/-v\d{3,}$/.test(versionedStem)) return false
  return entries.some((name) => {
    if (!name.startsWith(`${versionedStem}.`)) return false
    return /^[A-Za-z0-9]+$/.test(name.slice(versionedStem.length + 1))
  })
}

interface SegmentRow {
  readonly id: string
  readonly position: number
  readonly source_passage_id: string
  readonly source_text_sha256: string
  readonly kind: string
  readonly speaker_id: string | null
  readonly confidence: number
  readonly delivery: string
}

interface DesiredSegmentRow {
  readonly id: string
  readonly position: number
  readonly sourcePassageId: string
  readonly sourceTextSha256: string
  readonly kind: string
  readonly speakerId: string | null
  readonly confidence: number
  readonly delivery: string
}

function segmentRowMatches(want: DesiredSegmentRow, row: SegmentRow | undefined): boolean {
  return (
    row !== undefined &&
    row.id === want.id &&
    row.position === want.position &&
    row.source_passage_id === want.sourcePassageId &&
    row.source_text_sha256 === want.sourceTextSha256 &&
    row.kind === want.kind &&
    row.speaker_id === want.speakerId &&
    row.confidence === want.confidence &&
    row.delivery === want.delivery
  )
}

function versionLabel(v: number): string {
  return `v${String(v).padStart(3, '0')}`
}

function fileExists(path: string): boolean {
  try {
    const s = statSync(path)
    return s.isFile()
  } catch {
    return false
  }
}

function validateArtifact(
  wavPath: string,
  expectedSha256: string,
  expectedByteLength: number,
): { wavPath: string; sha256: string; byteLength: number } | null {
  try {
    const stat = statSync(wavPath)
    if (!stat.isFile()) return null
    if (stat.size !== expectedByteLength) return null

    const actual = sha256OfFile(wavPath)
    if (actual !== expectedSha256.toLowerCase()) return null

    const abs = toSafeAbsolute(wavPath)
    return { wavPath: abs, sha256: actual, byteLength: stat.size }
  } catch {
    return null
  }
}
