import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
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
import { classifySqliteFailure, withTransaction } from './transaction.js'
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

    await withBusyRetryingTransaction(
      this.db,
      () => {
        this.db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id)
        this.db.prepare('INSERT INTO jobs (id, snapshot_json) VALUES (?, ?)').run(job.id, json)
      },
      `Could not save audiobook job ${job.id}; the workspace database stayed locked`,
    )
  }

  async saveBook(book: Book): Promise<void> {
    await withBusyRetryingTransaction(
      this.db,
      () => {
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
      },
      `Could not save book ${book.id}; the workspace database stayed locked`,
    )
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
    await withBusyRetryingTransaction(
      this.db,
      () => {
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
      },
      `Could not save completed segment ${segment.segmentId}; the workspace database stayed locked`,
    )
  }

  async reserveNextOutput(book: Book): Promise<OutputReservation> {
    const baseName = outputBaseName(book.title)

    const chapterOutputs = book.chapters.map((ch) => {
      // Validated before the id is ever used to build a path. A NUL, a separator or a control
      // character used to pass the lexical assertion, get committed, and only then be rejected
      // by mkdirSync -- consuming a version on every retry and wedging the book permanently.
      assertSafePathComponent(ch.id, `Chapter id for book ${book.id}`)
      const dir = join(this.layout.chapterDir, `ch-${ch.id}`)
      const stem = `${baseName}-ch${String(ch.position).padStart(3, '0')}`
      return { chapterId: ch.id, dir, stem }
    })

    // Prove the directories that will be written to are real directories inside the workspace,
    // creating them if needed. Lexical containment is not enough: layoutFor canonicalizes only
    // the root, so a symlink at any directory *below* it passes a string prefix check and would
    // redirect the assembler's writes outside the workspace. Directories left behind by a lost
    // claim are harmless.
    const realRoot = realpathSync(this.layout.root)
    ensureContainedDirectory(realRoot, this.layout.outputDir)
    for (const ch of chapterOutputs) {
      ensureContainedDirectory(realRoot, ch.dir)
    }

    // Start from the highest version already claimed for this book.
    const existing = this.db
      .prepare('SELECT MAX(version) AS v FROM output_reservations WHERE book_id = ?')
      .get(book.id) as { v: number | null } | undefined

    let candidate = (existing?.v ?? 0) + 1

    while (true) {
      const label = versionLabel(candidate)
      const m4bPath = join(this.layout.outputDir, `${baseName}-${label}.m4b`)
      const chapterPaths = chapterOutputs.map((ch) => ({
        chapterId: ch.chapterId,
        // The M1 assembler's fixed settings always emit FLAC chapter masters, just as the final
        // container is always M4B. If a second assembler with another chapter container appears,
        // this extension must become an explicit concern of the AudioAssembler port.
        path: join(ch.dir, `${ch.stem}-${label}.flac`),
      }))

      assertReservablePaths(realRoot, [m4bPath, ...chapterPaths.map((cp) => cp.path)])

      // Belt-and-braces now that the reservation row is the durable claim: never name a path
      // that already holds anything, however it got there (restored database, deleted database,
      // output copied in by hand).
      const takenOnDisk =
        pathOccupied(m4bPath) || chapterPaths.some((chapter) => pathOccupied(chapter.path))
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

      const outcome = await withBusyRetryingTransaction(
        this.db,
        (): 'claimed' | 'taken' => {
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
            // PRIMARY KEY(book_id, version) and UNIQUE(m4b_path) are what actually guarantee
            // distinctness, so losing either race is an ordinary outcome: take the next version
            // instead of failing the run. UNIQUE(m4b_path) is how a second book sharing a title
            // gets pushed off v001.
            if (classifySqliteFailure(error) === 'constraint') return 'taken'
            throw error
          }
          return 'claimed'
        },
        `Could not reserve an output version for book ${book.id}; the workspace database stayed locked`,
      )

      if (outcome === 'taken') {
        candidate += 1
        continue
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

/** Total time a repository transaction may spend losing lock races before the run gives up. */
const TRANSACTION_BUSY_DEADLINE_MS = 30_000

/**
 * Retry the whole transaction after a busy failure, so a failed BEGIN IMMEDIATE or COMMIT is
 * included and every attempt starts with a fresh transaction. SQLite's busy_timeout performs the
 * primary wait; this deadline bounds repeated losses, while backoff prevents a retry spin.
 */
async function withBusyRetryingTransaction<T>(
  db: DatabaseSync,
  work: () => T,
  lockedMessage: string,
): Promise<T> {
  const deadline = Date.now() + TRANSACTION_BUSY_DEADLINE_MS
  let busyAttempts = 0

  while (true) {
    try {
      return withTransaction(db, work)
    } catch (error) {
      if (classifySqliteFailure(error) !== 'busy') throw error

      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) throw new DomainError(lockedMessage)

      await delay(Math.min(backoffMs(busyAttempts), remainingMs))
      busyAttempts += 1
    }
  }
}

/** NUL and the C0 controls, DEL and the C1 controls, and both path separators. */
function isUnsafePathCharacter(character: string): boolean {
  if (character === '/' || character === '\\') return true
  const code = character.codePointAt(0) ?? 0
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/** Escalating waits between lock retries. A tight retry loop with no delay is not a retry. */
function backoffMs(attempt: number): number {
  return Math.min(25 * 2 ** attempt, 500)
}

/**
 * A value that will become one path component must not be able to reshape the path or produce a
 * path the operating system rejects. A NUL is the dangerous case: it satisfies every lexical
 * check, SQLite stores it happily, and only `mkdirSync` refuses it -- which used to happen after
 * the reservation had committed, so every retry consumed another version and failed identically.
 */
function assertSafePathComponent(value: string, label: string): void {
  if (value.length === 0) {
    throw new DomainError(`${label} must not be empty`)
  }
  if ([...value].some(isUnsafePathCharacter)) {
    // JSON.stringify so a control character is shown escaped rather than embedded in the message.
    throw new DomainError(
      `${label} must not contain path separators or control characters: ${JSON.stringify(value)}`,
    )
  }
}

/**
 * Every reserved path must be absolute, already canonical, and inside the workspace. The
 * assembler (#32) resolves the paths it is handed, so a relative or merely non-canonical path is
 * silently rewritten rather than rejected: the book encodes to a different location, and
 * GenerateAudiobook then rejects the output on an exact path compare -- after hours of
 * rendering, leaving files that wedge every retry. Fail here, before anything is rendered.
 *
 * This is the lexical half only. `ensureContainedDirectory` proves the physical half, because
 * `resolve()` does not follow symlinks and this check cannot see one.
 */
function assertReservablePaths(realRoot: string, paths: readonly string[]): void {
  for (const path of paths) {
    if (!isAbsolute(path) || resolve(path) !== path) {
      throw new DomainError(`Reserved output path must be absolute and canonical: ${path}`)
    }
    if (!path.startsWith(`${realRoot}${sep}`)) {
      throw new DomainError(`Reserved output path must stay inside the workspace: ${path}`)
    }
  }
}

/**
 * Prove that `directory` is a real directory inside `realRoot`, creating it if missing, and that
 * no component along the way is a symlink. `layoutFor` canonicalizes only the root, so a symlink
 * at `chapters/ch-<id>` or at `output` itself satisfies a lexical prefix check while pointing
 * anywhere on the filesystem -- and the assembler would then write there.
 *
 * Walks one component at a time and never uses `recursive: true`, because a recursive mkdir
 * happily traverses a symlink instead of reporting it.
 */
function ensureContainedDirectory(realRoot: string, directory: string): void {
  const relativePath = relative(realRoot, directory)
  if (relativePath.length === 0) return
  if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new DomainError(`Reserved output directory must stay inside the workspace: ${directory}`)
  }

  let current = realRoot
  for (const part of relativePath.split(sep)) {
    current = join(current, part)
    let entry = lstatSync(current, { throwIfNoEntry: false })
    if (entry === undefined) {
      try {
        mkdirSync(current)
      } catch (error) {
        // Another process may have created it between the lstat and the mkdir.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      entry = lstatSync(current, { throwIfNoEntry: false })
    }
    if (entry === undefined || entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new DomainError(
        `Reserved output directory must be a real directory inside the workspace: ${current}`,
      )
    }
  }

  // With no symlink component, the canonical path must equal the lexical one. Belt-and-braces
  // against anything the component walk above could have missed.
  if (realpathSync(directory) !== directory) {
    throw new DomainError(
      `Reserved output directory resolves outside its own path: ${directory} -> ${realpathSync(directory)}`,
    )
  }
}

/**
 * Whether anything at all occupies this exact path. Uses `lstat`, so a directory, or a symlink
 * even a dangling one, counts: the assembler cannot create its output over any of them, and a
 * reservation that names one is a version consumed for nothing.
 */
function pathOccupied(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined
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
