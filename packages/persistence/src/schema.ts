/** Versioned SQLite schema and migration SQL for the persistence package. */

import type { DatabaseSync } from 'node:sqlite'

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
  -- PRIMARY KEY(book_id, version) is what makes a reservation unique, enforced by the schema.
  CREATE TABLE output_reservations (
    book_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    m4b_path TEXT NOT NULL,
    chapter_paths_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(book_id, version)
  );

  CREATE TABLE jobs (
    id TEXT PRIMARY KEY NOT NULL,
    snapshot_json TEXT NOT NULL
  );
`,
)

/** Execute migrations up to SCHEMA_VERSION on the given database. */
export function migrateSchema(db: DatabaseSync): void {
  // Create migrations tracking table if missing
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)`)

  const existing = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {
    v: number | null
  } | null

  const current = existing?.v ?? 0
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
}
