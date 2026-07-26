/** Versioned SQLite schema and migration SQL for the persistence package. */

import type { DatabaseSync } from 'node:sqlite'
import { withTransaction } from './transaction.js'

export const SCHEMA_VERSION = 2 satisfies number

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

migrations.set(
  2,
  `
  -- Issue #45. Rendering moved into its own stage that runs after human review, so it can no
  -- longer be handed an in-memory Book: it has to read the approved script back. Version 1 stored
  -- only source_text_sha256 and no voice assignment, from which no Segment can be reconstructed
  -- and no render input identity can be reproduced.
  --
  -- Storing source_text puts story text in the workspace database. That is a deliberate decision
  -- (recorded in the #45 report): audiobook.db matches the gitignored '*.db' rule, and source text
  -- must never be logged or committed. It is the same text the WAVs beside it already encode.
  --
  -- Segments and passages are dropped and recreated rather than altered. They are derived data
  -- re-created by direction, a version 1 row cannot supply a NOT NULL source_text, and the
  -- artifacts and output_reservations ledgers are keyed independently of them so nothing durable
  -- is lost. A book directed under version 1 is re-directed once.
  DROP TABLE segments;

  CREATE TABLE source_passages (
    id TEXT PRIMARY KEY NOT NULL,
    chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    source_text TEXT NOT NULL,
    UNIQUE(chapter_id, position)
  );

  CREATE TABLE segments (
    id TEXT PRIMARY KEY NOT NULL,
    chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    source_passage_id TEXT NOT NULL,
    source_text TEXT NOT NULL,
    kind TEXT NOT NULL,
    speaker_id TEXT,
    confidence REAL NOT NULL,
    delivery TEXT NOT NULL,
    voice_profile_id TEXT,
    uses_fallback INTEGER NOT NULL DEFAULT 0,
    fallback_reason TEXT,
    UNIQUE(chapter_id, position)
  );

  -- The review context's ledger, one live row per approved unresolved-speaker segment.
  --
  -- Deliberately without a foreign key to segments, for the same reason artifacts has none: a
  -- re-direction replaces a chapter's segment rows wholesale, and a cascade would silently delete
  -- human decisions as a side effect of saving a book. Reconciliation removes decisions that no
  -- longer describe their segment, explicitly and countably.
  --
  -- Revocation DELETEs. A revoked approval must be indistinguishable from one that never existed,
  -- because that is what makes the segment unrenderable and its cached audio unreachable; a
  -- 'revoked' flag would leave a row that a future query could mistake for a live decision.
  CREATE TABLE fallback_approvals (
    book_id TEXT NOT NULL,
    segment_id TEXT NOT NULL,
    speaker_id TEXT,
    fallback_reason TEXT NOT NULL,
    voice_profile_id TEXT NOT NULL,
    source_text_sha256 TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    -- Required. A record with a time but no actor is not evidence of a human decision, which is
    -- how issue #45's first round shipped a renamed auto-approval.
    decided_by TEXT NOT NULL,
    -- The book-wide grant this record was derived from, or NULL when the human decided this one
    -- segment individually.
    grant_id TEXT,
    approval_id TEXT NOT NULL,
    approval_sha256 TEXT NOT NULL,
    PRIMARY KEY(book_id, segment_id)
  );

  -- Segments the human explicitly refused to authorize.
  --
  -- Recorded rather than merely deleted, because a book-wide grant would otherwise re-create the
  -- approval on the next reconciliation and silently undo the revocation. An exclusion outranks any
  -- grant and is cleared only by approving that segment again. A *system* invalidation -- a decision
  -- that no longer describes its segment -- deliberately writes no exclusion, or a re-directed line
  -- would be blocked forever instead of simply re-decided.
  CREATE TABLE fallback_approval_exclusions (
    book_id TEXT NOT NULL,
    segment_id TEXT NOT NULL,
    decided_by TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    PRIMARY KEY(book_id, segment_id)
  );

  -- One human decision authorizing the fallback voice for every unresolved speaker in one book.
  -- The M1 answer to a 2,328-passage book that must not stop for a click per line; it still
  -- produces one per-segment approval row each, so revoking one speaker touches only that speaker.
  CREATE TABLE fallback_book_grants (
    book_id TEXT PRIMARY KEY NOT NULL,
    decided_by TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    grant_id TEXT NOT NULL,
    grant_sha256 TEXT NOT NULL
  );

  -- Monotonic per-book counter, incremented in the SAME transaction as every approval, exclusion and
  -- grant mutation. A render reads it together with the records it renders under and re-checks it
  -- before publishing anything, so a decision that lands mid-render cannot let that render complete
  -- under a withdrawn approval.
  CREATE TABLE fallback_catalog_revisions (
    book_id TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL
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
