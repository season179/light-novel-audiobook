import { spawn } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { FileBookLockCoordinator } from '../src/book-lock.js'
import {
  deriveBookId,
  EpubIngestionAdapter,
  extractEpubDeterministically,
  INGESTION_SCHEMA_VERSION,
  type StoredEpubIngestion,
} from '../src/index.js'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(testDirectory, '../../..')
const fixtureRoot = path.join(repositoryRoot, 'tests/fixtures/epub')
const tsx = path.join(repositoryRoot, 'node_modules/.bin/tsx')
const ingestHelper = path.join(testDirectory, 'helpers/ingest-book.mts')
const temporaryDirectories: string[] = []

interface WorkspaceLayout {
  readonly root: string
  readonly books: string
  readonly staging: string
  readonly locks: string
  readonly quarantine: string
  readonly target: string
  readonly lock: string
  readonly committedManifest: string
  readonly pendingManifest: string
}

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), `epub-durability-${label}-`))
  temporaryDirectories.push(directory)
  return directory
}

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path.join(fixtureRoot, `${name}.epub`)))
}

function layout(root: string, bookId: string): WorkspaceLayout {
  const books = path.join(root, 'books')
  const target = path.join(books, bookId)
  return {
    root,
    books,
    staging: path.join(root, '.staging'),
    locks: path.join(root, '.book-locks'),
    quarantine: path.join(root, '.quarantine'),
    target,
    lock: path.join(root, '.book-locks', `${bookId}.lock`),
    committedManifest: path.join(target, 'book.json'),
    pendingManifest: path.join(target, 'book.pending.json'),
  }
}

/** Runs a full ingest of the ncx-only fixture in a separate OS process and reports the outcome. */
function runIngestSubprocess(
  workspaceRoot: string,
  lockWaitMs: number,
): Promise<{ state?: string; code?: string }> {
  const child = spawn(
    tsx,
    [
      ingestHelper,
      workspaceRoot,
      repositoryRoot,
      path.join(fixtureRoot, 'synthetic-ncx-only.epub'),
      String(lockWaitMs),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] as const },
  )
  return new Promise((resolve, reject) => {
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
    })
    child.once('error', reject)
    child.once('close', () => {
      const line = output.split(/\r?\n/u).find((candidate) => candidate.trim().length > 0)
      resolve(line ? (JSON.parse(line) as { state?: string; code?: string }) : {})
    })
  })
}

/**
 * After any settled ingestion no staging or quarantine residue may remain. The per-book lock file
 * is deliberately excluded: it is created once and never unlinked, because removing it would let a
 * newcomer lock a fresh inode at the same path while a waiter holds the old one.
 */
async function expectNoResidue(workspace: WorkspaceLayout): Promise<void> {
  expect(await readdir(workspace.staging)).toEqual([])
  expect(await readdir(workspace.quarantine)).toEqual([])
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('EPUB ingestion crash recovery', () => {
  it('promotes a pending manifest left behind by an interrupted commit', async () => {
    const bytes = await fixture('synthetic-ncx-only')
    const bookId = deriveBookId(extractEpubDeterministically(bytes))
    const root = await temporaryDirectory('pending-promote')
    const workspace = layout(root, bookId)
    const adapter = new EpubIngestionAdapter({ workspaceRoot: root, repositoryRoot })

    const committed = await adapter.ingest({ bytes, originalFilename: 'first.epub' })

    // Reproduce the exact on-disk state of a process killed between the staging rename and the
    // manifest rename: a complete book directory whose manifest is still pending.
    await rename(workspace.committedManifest, workspace.pendingManifest)
    expect(await readdir(workspace.target)).toContain('book.pending.json')

    const recovered = await adapter.ingest({ bytes, originalFilename: 'second.epub' })

    expect(recovered).toEqual(committed)
    // The interrupted upload's filename is provenance and must survive the retry.
    expect(recovered.upload.originalFilename).toBe('first.epub')
    expect(await readdir(workspace.target)).not.toContain('book.pending.json')
    const reloaded = JSON.parse(
      await readFile(workspace.committedManifest, 'utf8'),
    ) as StoredEpubIngestion
    expect(reloaded).toEqual(committed)
    await expectNoResidue(workspace)
  })

  it('discards a pending record that does not match the upload and re-commits from it', async () => {
    const bytes = await fixture('synthetic-ncx-only')
    const bookId = deriveBookId(extractEpubDeterministically(bytes))
    const root = await temporaryDirectory('pending-mismatch')
    const workspace = layout(root, bookId)
    const adapter = new EpubIngestionAdapter({ workspaceRoot: root, repositoryRoot })

    const committed = await adapter.ingest({ bytes })
    await rename(workspace.committedManifest, workspace.pendingManifest)
    const tampered = JSON.parse(
      await readFile(workspace.pendingManifest, 'utf8'),
    ) as StoredEpubIngestion
    Object.assign(tampered.metadata, { title: 'Half-written title' })
    await writeFile(workspace.pendingManifest, JSON.stringify(tampered, null, 2))

    // A pending record was never handed to the domain, so it is discarded rather than promoted.
    const recovered = await adapter.ingest({ bytes })

    expect(recovered).toEqual(committed)
    expect(recovered.metadata.title).not.toBe('Half-written title')
    expect(
      JSON.parse(await readFile(workspace.committedManifest, 'utf8')) as StoredEpubIngestion,
    ).toEqual(committed)
    await expectNoResidue(workspace)
  })

  it('discards a book directory that lost every manifest', async () => {
    const bytes = await fixture('synthetic-ncx-only')
    const bookId = deriveBookId(extractEpubDeterministically(bytes))
    const root = await temporaryDirectory('no-manifest')
    const workspace = layout(root, bookId)
    const adapter = new EpubIngestionAdapter({ workspaceRoot: root, repositoryRoot })

    const committed = await adapter.ingest({ bytes })
    await unlink(workspace.committedManifest)

    const recovered = await adapter.ingest({ bytes })

    expect(recovered).toEqual(committed)
    expect(
      JSON.parse(await readFile(workspace.committedManifest, 'utf8')) as StoredEpubIngestion,
    ).toEqual(committed)
    await expectNoResidue(workspace)
  })

  it('never destroys a committed record that conflicts with the upload', async () => {
    const bytes = await fixture('synthetic-ncx-only')
    const bookId = deriveBookId(extractEpubDeterministically(bytes))
    const root = await temporaryDirectory('committed-conflict')
    const workspace = layout(root, bookId)
    const adapter = new EpubIngestionAdapter({ workspaceRoot: root, repositoryRoot })

    await adapter.ingest({ bytes })
    const tampered = JSON.parse(
      await readFile(workspace.committedManifest, 'utf8'),
    ) as StoredEpubIngestion
    Object.assign(tampered.metadata, { title: 'Tampered title' })
    await writeFile(workspace.committedManifest, JSON.stringify(tampered, null, 2))

    await expect(adapter.ingest({ bytes })).rejects.toMatchObject({ code: 'STORAGE_CONFLICT' })

    // Failing closed means the operator's record is still there to inspect.
    expect(
      (JSON.parse(await readFile(workspace.committedManifest, 'utf8')) as StoredEpubIngestion)
        .metadata.title,
    ).toBe('Tampered title')
    await expectNoResidue(workspace)
  })

  it('still fails closed on a conflicting committed record after a previous holder died', async () => {
    const bytes = await fixture('synthetic-ncx-only')
    const bookId = deriveBookId(extractEpubDeterministically(bytes))
    const root = await temporaryDirectory('conflict-after-crash')
    const workspace = layout(root, bookId)
    const adapter = new EpubIngestionAdapter({ workspaceRoot: root, repositoryRoot })

    await adapter.ingest({ bytes })
    const tampered = JSON.parse(
      await readFile(workspace.committedManifest, 'utf8'),
    ) as StoredEpubIngestion
    Object.assign(tampered.metadata, { title: 'Operator edit' })
    await writeFile(workspace.committedManifest, JSON.stringify(tampered, null, 2))

    // A crash leaves the lock file behind -- it is never unlinked -- and the next run acquires it
    // freely because the kernel already released it. Acquiring the lock is still not authority to
    // delete a committed book: the reason verification failed is unknowable from here, and this
    // directory holds the only stored copy of the upload.
    expect((await stat(workspace.lock)).isFile()).toBe(true)

    await expect(adapter.ingest({ bytes })).rejects.toMatchObject({ code: 'STORAGE_CONFLICT' })

    expect(
      (JSON.parse(await readFile(workspace.committedManifest, 'utf8')) as StoredEpubIngestion)
        .metadata.title,
    ).toBe('Operator edit')
    expect(await readdir(workspace.target)).toContain('source.epub')
    expect(await readdir(workspace.quarantine)).toEqual([])
  })

  it('cannot let a second holder exist while a discard is mid-flight', async () => {
    // Ported from the independent reviewer's probe, which injected immediately after the ownership
    // assertion in `#discardTarget`. Under the old pathname protocol a delayed reclaimer could
    // vacate the lock path there, a third run could then become a legitimate holder and commit a
    // record, and the resuming first run would rename that record into its own quarantine and
    // recursively remove it -- the reviewer measured `committedTargetStillPresent: false`.
    //
    // The precondition is now unreachable: ownership is a held kernel lock, so no second process
    // can legitimately own this book while the discard runs, and therefore no committed record of
    // theirs can exist for the discard to destroy.
    const bytes = await fixture('synthetic-ncx-only')
    const bookId = deriveBookId(extractEpubDeterministically(bytes))
    const root = await temporaryDirectory('discard-exclusion')
    const workspace = layout(root, bookId)

    const seeded = await new EpubIngestionAdapter({
      workspaceRoot: root,
      repositoryRoot,
    }).ingest({ bytes })
    // Leave a book directory recovery must discard: present, but with no manifest.
    await unlink(workspace.committedManifest)

    let contender: { code?: string; state?: string } | undefined
    const adapter = new EpubIngestionAdapter({
      workspaceRoot: root,
      repositoryRoot,
      lockWaitMs: 15_000,
      async faultInjector(point) {
        if (point !== 'after-discard-ownership-check' || contender !== undefined) return
        // A real, separate OS process attempting a legitimate ingest of the same book.
        contender = await runIngestSubprocess(root, 400)
      },
    })

    const recommitted = await adapter.ingest({ bytes })

    expect(contender).toMatchObject({ state: 'failed', code: 'STORAGE_CONFLICT' })
    // One consistent record, written by the only process that ever held the book.
    expect(recommitted.id).toBe(bookId)
    expect(recommitted).toEqual(seeded)
    expect(await readdir(workspace.books)).toEqual([bookId])
    expect(
      JSON.parse(await readFile(workspace.committedManifest, 'utf8')) as StoredEpubIngestion,
    ).toEqual(seeded)
    expect(await readdir(workspace.quarantine)).toEqual([])
  })

  it('reports a schema-version mismatch distinctly from a content conflict', async () => {
    const bytes = await fixture('synthetic-ncx-only')
    const bookId = deriveBookId(extractEpubDeterministically(bytes))
    const root = await temporaryDirectory('schema-version')
    const workspace = layout(root, bookId)
    const adapter = new EpubIngestionAdapter({ workspaceRoot: root, repositoryRoot })

    await adapter.ingest({ bytes })
    const stored = JSON.parse(
      await readFile(workspace.committedManifest, 'utf8'),
    ) as StoredEpubIngestion
    await writeFile(
      workspace.committedManifest,
      JSON.stringify({ ...stored, schemaVersion: 'epub-ingestion@1' }, null, 2),
    )

    await expect(adapter.ingest({ bytes })).rejects.toMatchObject({
      code: 'STORAGE_CONFLICT',
      message: expect.stringContaining('epub-ingestion@1'),
    })
    await expect(adapter.ingest({ bytes })).rejects.toThrow(
      new RegExp(`this build reads ${INGESTION_SCHEMA_VERSION}`),
    )
  })

  it('confines an interrupted discard to .quarantine, never to books/', async () => {
    const bytes = await fixture('synthetic-ncx-only')
    const bookId = deriveBookId(extractEpubDeterministically(bytes))
    const root = await temporaryDirectory('discard-fault')
    const workspace = layout(root, bookId)
    const adapter = new EpubIngestionAdapter({ workspaceRoot: root, repositoryRoot })

    // Leave a book directory with no manifest, which recovery must discard.
    await adapter.ingest({ bytes })
    await unlink(workspace.committedManifest)

    const failing = new EpubIngestionAdapter({
      workspaceRoot: root,
      repositoryRoot,
      faultInjector(point) {
        if (point === 'after-quarantine-rename') throw new Error('injected crash mid-discard')
      },
    })
    await expect(failing.ingest({ bytes })).rejects.toThrow(/injected crash mid-discard/)

    // The single rename already cleared books/, so no partial record is reachable; the residue
    // sits under .quarantine, which nothing reads.
    expect(await readdir(workspace.books)).toEqual([])
    expect(await readdir(workspace.quarantine)).toHaveLength(1)
    // The lock file survives the crash by design; the kernel released the lock itself, so the
    // retry below needs no cleanup step.
    expect(await readdir(workspace.locks)).toEqual([`${bookId}.lock`])

    const retried = await new EpubIngestionAdapter({
      workspaceRoot: root,
      repositoryRoot,
    }).ingest({ bytes })
    expect(retried.id).toBe(bookId)
    expect(await readdir(workspace.books)).toEqual([bookId])
  })

  it('releases the book lock after a rollback so the next attempt is not blocked', async () => {
    const bytes = await fixture('synthetic-ncx-only')
    const bookId = deriveBookId(extractEpubDeterministically(bytes))
    const root = await temporaryDirectory('rollback-lock')
    const workspace = layout(root, bookId)

    const failing = new EpubIngestionAdapter({
      workspaceRoot: root,
      repositoryRoot,
      faultInjector(point) {
        if (point === 'after-target-rename') throw new Error('injected crash')
      },
    })
    await expect(failing.ingest({ bytes })).rejects.toMatchObject({ code: 'STORAGE_FAILURE' })
    expect(await readdir(workspace.books)).toEqual([])
    await expectNoResidue(workspace)

    const retried = await new EpubIngestionAdapter({
      workspaceRoot: root,
      repositoryRoot,
    }).ingest({ bytes })
    expect(retried.id).toBe(bookId)
    await expectNoResidue(workspace)
  })
})

describe('EPUB ingestion book locking', () => {
  it('wraps an unexpected lock-acquisition failure as a coded storage failure', async () => {
    const bytes = await fixture('synthetic-ncx-only')
    const root = await temporaryDirectory('lock-unavailable')
    const workspace = layout(root, deriveBookId(extractEpubDeterministically(bytes)))

    // Callers switch on EpubIngestionErrorCode; a raw spawn failure must not escape uncoded.
    await expect(
      new EpubIngestionAdapter({
        workspaceRoot: root,
        repositoryRoot,
        bookLocks: new FileBookLockCoordinator({
          lockDirectory: workspace.locks,
          flockExecutable: path.join(root, 'no-such-flock-binary'),
        }),
      }).ingest({ bytes }),
    ).rejects.toMatchObject({ name: 'EpubIngestionError', code: 'STORAGE_FAILURE' })
  })

  it('reports a busy book as a storage conflict rather than waiting forever', async () => {
    const bytes = await fixture('synthetic-ncx-only')
    const bookId = deriveBookId(extractEpubDeterministically(bytes))
    const root = await temporaryDirectory('lock-busy')
    const workspace = layout(root, bookId)
    await mkdir(workspace.locks, { recursive: true, mode: 0o700 })

    const holder = await new FileBookLockCoordinator({
      lockDirectory: workspace.locks,
      waitMs: 5_000,
    }).acquire(bookId)
    try {
      await expect(
        new EpubIngestionAdapter({
          workspaceRoot: root,
          repositoryRoot,
          lockWaitMs: 300,
        }).ingest({ bytes }),
      ).rejects.toMatchObject({ code: 'STORAGE_CONFLICT' })
      expect(await readdir(workspace.books)).toEqual([])
    } finally {
      await holder.release()
    }

    // With the lock free the same upload proceeds normally.
    const ingested = await new EpubIngestionAdapter({
      workspaceRoot: root,
      repositoryRoot,
    }).ingest({ bytes })
    expect(ingested.id).toBe(bookId)
  })
})

describe('EPUB ingestion rejection leaves no record', () => {
  it('does not disturb an existing book when a later upload is corrupt', async () => {
    const good = await fixture('synthetic-ncx-only')
    const bookId = deriveBookId(extractEpubDeterministically(good))
    const root = await temporaryDirectory('corrupt-after-good')
    const workspace = layout(root, bookId)
    const adapter = new EpubIngestionAdapter({ workspaceRoot: root, repositoryRoot })
    const committed = await adapter.ingest({ bytes: good })

    for (const corrupt of [
      (await fixture('synthetic-complex')).subarray(0, 80),
      await fixture('synthetic-malformed'),
    ]) {
      await expect(adapter.ingest({ bytes: corrupt })).rejects.toMatchObject({
        code: 'INVALID_EPUB',
      })
    }

    expect(await readdir(workspace.books)).toEqual([bookId])
    expect(
      JSON.parse(await readFile(workspace.committedManifest, 'utf8')) as StoredEpubIngestion,
    ).toEqual(committed)
    await expectNoResidue(workspace)
  })

  it('still stores the book when the declared cover is unusable, flagging it for review', async () => {
    const entries = unzipSync(await fixture('synthetic-complex'))
    const packageDocument = entries['EPUB/package.opf']
    if (!packageDocument) throw new Error('fixture has no package document')
    entries['EPUB/package.opf'] = strToU8(
      new TextDecoder()
        .decode(packageDocument)
        .replace('media-type="image/svg+xml"', 'media-type="image/png"'),
    )
    const bytes = zipSync(entries)
    const bookId = deriveBookId(extractEpubDeterministically(bytes))
    const root = await temporaryDirectory('bad-cover')
    const workspace = layout(root, bookId)

    const ingested = await new EpubIngestionAdapter({
      workspaceRoot: root,
      repositoryRoot,
    }).ingest({ bytes })

    // A decorative asset must not cost the reader the whole light novel.
    expect(ingested.cover).toBeNull()
    expect(ingested.audit.findings.map((finding) => finding.kind)).toContain('unusable-cover')
    expect(ingested.chapters.flatMap((chapter) => chapter.passages).length).toBe(15)
    expect(await readdir(workspace.target)).toEqual(['book.json', 'source.epub'])
    await expectNoResidue(workspace)
  })

  it('drops a cover whose media type is unsupported and still stores the book', async () => {
    // An unsupported media type is reported the same way as a damaged asset: no cover, one
    // finding, story text intact.
    const entries = unzipSync(await fixture('synthetic-complex'))
    const packageDocument = entries['EPUB/package.opf']
    if (!packageDocument) throw new Error('fixture has no package document')
    entries['EPUB/package.opf'] = strToU8(
      new TextDecoder()
        .decode(packageDocument)
        .replace('media-type="image/svg+xml"', 'media-type="image/tiff"'),
    )
    const bytes = zipSync(entries)
    const ingested = await new EpubIngestionAdapter({
      workspaceRoot: await temporaryDirectory('unsupported-cover'),
      repositoryRoot,
    }).ingest({ bytes })

    expect(ingested.cover).toBeNull()
    expect(
      ingested.audit.findings.find((finding) => finding.kind === 'unusable-cover')?.detail,
    ).toContain('Unsupported raster cover media type')
  })
})
