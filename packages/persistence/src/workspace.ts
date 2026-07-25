import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
  migrateSchema(db)
  return db
}

/** Atomic write: write to temp file then rename. */
export function atomicWriteFile(targetPath: string, data: string | Buffer): void {
  mkdirSync(dirname(targetPath), { recursive: true })
  const tmp = `${targetPath}.tmp.${process.pid}-${Date.now()}`
  writeFileSync(tmp, data)
  renameSync(tmp, targetPath)
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
