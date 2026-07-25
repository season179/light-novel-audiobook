import { mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

    const snapshot: AudiobookJobSnapshot = JSON.parse(row.snapshot_json)
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
      this.db
        .prepare(
          `INSERT OR REPLACE INTO books (id, title, author, cover_path, epub_path, epub_sha256)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          book.id,
          book.title,
          book.author ?? null,
          book.coverPath ?? null,
          book.source.epubPath,
          book.source.sha256,
        )

      // Remove old chapters+segments and re-insert (simpler and safer for now)
      this.db.prepare('DELETE FROM chapters WHERE book_id = ?').run(book.id)

      for (const chapter of book.chapters) {
        this.db
          .prepare('INSERT INTO chapters (id, book_id, position, title) VALUES (?, ?, ?, ?)')
          .run(chapter.id, book.id, chapter.position, chapter.title)

        for (const [idx, seg] of chapter.segments.entries()) {
          this.db
            .prepare(
              `INSERT OR REPLACE INTO segments
                (id, chapter_id, position, source_passage_id, source_text_sha256, kind, speaker_id, confidence, delivery)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              seg.id,
              chapter.id,
              idx + 1,
              seg.sourcePassageId,
              hashText(seg.sourceText),
              seg.kind,
              seg.speakerId ?? null,
              seg.confidence,
              JSON.stringify(seg.delivery),
            )
        }
      }
    })
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

    // Scan DB for the highest existing version, then verify filesystem
    const existing = this.db
      .prepare('SELECT MAX(version) AS v FROM output_reservations WHERE book_id = ?')
      .get(book.id) as { v: number | null } | undefined

    let candidate = (existing?.v ?? 0) + 1

    return withTransaction(this.db, () => {
      while (true) {
        const label = versionLabel(candidate)
        const m4bPath = join(this.layout.outputDir, `${baseName}-${label}.m4b`)

        const chapterPaths = chapterOutputs.map((ch) => ({
          chapterId: ch.chapterId,
          path: join(ch.dir, `${ch.stem}-${label}`),
        }))

        // Check DB uniqueness + filesystem freedom
        const dbConflict = this.db
          .prepare('SELECT 1 FROM output_reservations WHERE book_id = ? AND version = ?')
          .get(book.id, candidate)

        if (dbConflict) {
          candidate += 1
          continue
        }

        if (fileExists(m4bPath)) {
          candidate += 1
          continue
        }

        const fsConflict = chapterPaths.some((cp) => fileExists(`${cp.path}.flac`))
        if (fsConflict) {
          candidate += 1
          continue
        }

        // Claim atomically inside transaction
        const chapterPathsJson = JSON.stringify(
          chapterPaths.map((cp) => ({ chapterId: cp.chapterId, path: cp.path })),
        )

        this.db
          .prepare(
            'INSERT INTO output_reservations (book_id, version, m4b_path, chapter_paths_json) VALUES (?, ?, ?, ?)',
          )
          .run(book.id, candidate, m4bPath, chapterPathsJson)

        // Ensure output directories exist
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
    })
  }
}

// ============================================================
// Private helpers
// ============================================================

/**
 * Run `work` inside a SQLite transaction. node:sqlite's DatabaseSync exposes no
 * `transaction()` helper, so BEGIN/COMMIT/ROLLBACK are issued explicitly here.
 */
function withTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // Preserve the causative error; a failed rollback should not mask it.
    }
    throw error
  }
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
