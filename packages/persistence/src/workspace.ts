import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrateSchema } from './schema.js'

export interface WorkspaceLayout {
  readonly root: string
  readonly dbPath: string
  readonly epubsDir: string
  readonly wavDir: string
  readonly chapterDir: string
  readonly outputDir: string
}

export function layoutFor(root: string): WorkspaceLayout {
  const abs = toSafeAbsolute(root)
  return Object.freeze({
    root: abs,
    dbPath: join(abs, 'audiobook.db'),
    epubsDir: join(abs, 'epubs'),
    wavDir: join(abs, 'wav'),
    chapterDir: join(abs, 'chapters'),
    outputDir: join(abs, 'output'),
  })
}

/** Resolve to an absolute, symlink-normalized path. */
export function toSafeAbsolute(path: string): string {
  const abs = resolve(path)
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}

/** Ensure workspace directories exist and return an opened database. */
export function openWorkspace(layout: WorkspaceLayout): DatabaseSync {
  mkdirSync(layout.root, { recursive: true })
  mkdirSync(layout.epubsDir, { recursive: true })
  mkdirSync(layout.wavDir, { recursive: true })
  mkdirSync(layout.chapterDir, { recursive: true })
  mkdirSync(layout.outputDir, { recursive: true })

  const db = new DatabaseSync(layout.dbPath)
  try {
    // busy_timeout FIRST: switching the journal mode needs an exclusive lock, so two processes
    // opening a fresh workspace at the same moment would otherwise both die with
    // `database is locked` before any timeout was in effect.
    db.exec('PRAGMA busy_timeout = 5000')
    enableWriteAheadLog(db, layout.dbPath)
    migrateSchema(db)
  } catch (error) {
    // Never leak the handle when initialization fails: a caller that retries would otherwise
    // accumulate open connections, each still holding locks on the workspace.
    try {
      db.close()
    } catch {
      // Already unusable; the initialization error below is the one that matters.
    }
    throw error
  }
  return db
}

/**
 * Switch to WAL so a reader and a writer can coexist. PLAN.md has the web app and a separate
 * worker both submitting jobs, so two processes on one workspace is expected.
 *
 * The mode is a durable property of the file, so this is a no-op once set. It is only an
 * optimization -- a filesystem that cannot support WAL keeps the rollback journal and remains
 * correct -- so a failure here must not fail the open. But it must not be invisible either: the
 * effective mode is read back so a workspace that quietly fell back can be diagnosed.
 */
function enableWriteAheadLog(db: DatabaseSync, dbPath: string): void {
  let reason: string | null = null
  try {
    db.exec('PRAGMA journal_mode = WAL')
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error)
  }

  const effective = (db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string })
    .journal_mode
  if (effective?.toLowerCase() === 'wal') return

  console.warn(
    `[persistence] ${dbPath} is using journal_mode=${effective ?? 'unknown'} instead of WAL` +
      `${reason === null ? '' : `: ${reason}`}. Concurrent access will serialize more aggressively.`,
  )
}

/** SHA-256 of a file on disk. */
export function sha256OfFile(path: string): string {
  const hash = createHash('sha256')
  hash.update(readFileSync(path))
  return hash.digest('hex')
}

/** Build the WAV path for a segment in this workspace. */
export function wavPathFor(
  layout: WorkspaceLayout,
  segmentId: string,
  inputIdentity: string,
): string {
  const safe = hashSlug(inputIdentity)
  return join(layout.wavDir, `${segmentId}-${safe}.wav`)
}

/** Build an output base name from a book title. */
export function outputBaseName(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 60)
      .replace(/-$/g, '') || 'audiobook'
  )
}

/** Generate a filesystem-safe slug from a string. */
function hashSlug(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

/** SHA-256 of a text string. */
export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
