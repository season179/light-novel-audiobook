/** Versioned SQLite schema and migration SQL for the persistence package. */

import type { DatabaseSync } from 'node:sqlite'
import { withTransaction } from './transaction.js'

export const SCHEMA_VERSION = 1 satisfies number

const migrations = new Map<number, string>()

migrations.set(
  1,
  `
  CREATE TABLE books (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    author TEXT,
    cover_path TEXT,
    epub_path TEXT NOT NULL,
    epub_sha256 TEXT NOT NULL
  );

  CREATE TABLE chapters (
    id TEXT PRIMARY KEY NOT NULL,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    title TEXT NOT NULL,
    UNIQUE(book_id, position)
  );

  CREATE TABLE segments (
    id TEXT PRIMARY KEY NOT NULL,
    chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    source_passage_id TEXT NOT NULL,
    source_text_sha256 TEXT NOT NULL,
    kind TEXT NOT NULL,
    speaker_id TEXT,
    confidence REAL NOT NULL,
    delivery TEXT NOT NULL,
    UNIQUE(chapter_id, position)
  );

  -- Deliberately no foreign key to segments. This is the reuse ledger: rows are
  -- content-addressed by (segment_id, input_identity) and revalidated against the bytes on
  -- disk before use, so referential integrity to a table nothing reads buys nothing -- while
  -- a cascade from books/chapters/segments would delete completed audio on every saveBook.
  CREATE TABLE artifacts (
    segment_id TEXT NOT NULL,
    input_identity TEXT NOT NULL,
    wav_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(segment_id, input_identity)
  );

  -- Append-only claim ledger, so also deliberately without a foreign key to books:
  -- re-saving book metadata must never be able to delete a claim on an output version.
  --
  -- Two schema-enforced constraints, and both are load-bearing:
  --   PRIMARY KEY(book_id, version) -- one book never gets the same version twice.
  --   UNIQUE(m4b_path)              -- no two books ever get the same output file. The M4B name
  --                                    derives only from the normalized title, so two different
  --                                    books sharing a title would otherwise both be handed
  --                                    <title>-v001.m4b, and the filesystem guard cannot catch
  --                                    it because a reservation deliberately precedes file
  --                                    creation. The second book takes v002 as its first output.
  CREATE TABLE output_reservations (
    book_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    m4b_path TEXT NOT NULL,
    chapter_paths_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(book_id, version),
    UNIQUE(m4b_path)
  );

  CREATE TABLE jobs (
    id TEXT PRIMARY KEY NOT NULL,
    snapshot_json TEXT NOT NULL
  );
`,
)

/**
 * Execute migrations up to SCHEMA_VERSION on the given database.
 *
 * The tracking table, the current-version read, every migration body and its version stamp all
 * run inside ONE transaction. Without it, two processes opening a fresh workspace both read
 * version 0 and the loser dies with `table books already exists` -- and PLAN.md has the web app
 * and a separate worker both starting against one workspace. The transaction also means a crash
 * part-way through a migration cannot leave a half-applied, unstamped schema behind.
 *
 * The caller must have set `busy_timeout` first, so the loser of the race waits rather than
 * failing; `withTransaction` opens with BEGIN IMMEDIATE, which is what lets that timeout apply.
 */
export function migrateSchema(db: DatabaseSync): void {
  // Read-only fast path. An already-migrated workspace is the overwhelmingly common case, and it
  // must not take the write lock: otherwise merely *opening* a workspace fails whenever another
  // process is mid-write for longer than busy_timeout.
  if (schemaVersionOf(db) === SCHEMA_VERSION) return

  withTransaction(db, () => {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)')

    // Re-read inside the transaction. The fast path above is advisory only -- another process may
    // have migrated in the meantime, and this is the read that the write is serialized against.
    const current = schemaVersionOf(db)
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${current} exceeds supported version ${SCHEMA_VERSION}`,
      )
    }

    for (let v = current + 1; v <= SCHEMA_VERSION; v += 1) {
      const sql = migrations.get(v)
      if (!sql) {
        throw new Error(`Missing migration for version ${v}`)
      }
      db.exec(sql)
      db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(v)
    }
  })
}

/** Applied schema version, or 0 when the tracking table does not exist yet. */
function schemaVersionOf(db: DatabaseSync): number {
  try {
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {
      v: number | null
    } | null
    return row?.v ?? 0
  } catch {
    // No schema_migrations table: an untouched database.
    return 0
  }
}
