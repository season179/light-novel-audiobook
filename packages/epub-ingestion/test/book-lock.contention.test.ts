import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { FileBookLockCoordinator } from '../src/book-lock.js'
import { deriveBookId, EpubIngestionAdapter, extractEpubDeterministically } from '../src/index.js'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(testDirectory, '../../..')
const fixtureRoot = path.join(repositoryRoot, 'tests/fixtures/epub')
const tsx = path.join(repositoryRoot, 'node_modules/.bin/tsx')
const holdHelper = path.join(testDirectory, 'helpers/hold-book-lock.mts')
const ingestHelper = path.join(testDirectory, 'helpers/ingest-book.mts')

const temporaryDirectories: string[] = []
const runningChildren: ChildProcessWithoutNullStreams[] = []

/**
 * The workspace default lives on ext4 (`~/.local/share/...`), but `AUDIOBOOK_WORKSPACE_DIR` can
 * point at a Windows-mounted path, so both filesystems have to hold the lock correctly. Every
 * existing durability test uses `os.tmpdir()` only, which never exercises 9p/drvfs.
 */
const filesystems = [
  ['ext4', path.join(os.homedir(), '.local/share/light-novel-audiobook/test-workspaces')],
  ['drvfs-mnt-c', '/mnt/c/Temp/lna-epub-ingestion-tests'],
] as const

async function temporaryDirectory(parent: string, label: string): Promise<string> {
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(path.join(parent, `${label}-`))
  temporaryDirectories.push(directory)
  return directory
}

async function fixtureBytes(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path.join(fixtureRoot, `${name}.epub`)))
}

function run(script: string, args: readonly string[]): ChildProcessWithoutNullStreams {
  const child = spawn(tsx, [script, ...args], { stdio: ['pipe', 'pipe', 'pipe'] as const })
  runningChildren.push(child)
  return child
}

/** Resolves with the first JSON line the helper writes. */
function firstReport(child: ChildProcessWithoutNullStreams): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let output = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.stdout.on('data', (chunk: string) => {
      output += chunk
      const line = output.split(/\r?\n/u).find((candidate) => candidate.trim().length > 0)
      if (line) resolve(JSON.parse(line) as Record<string, unknown>)
    })
    child.once('close', () => {
      if (output.trim().length === 0) {
        reject(new Error(`helper produced no report; stderr: ${stderr.slice(-2000)}`))
      }
    })
    child.once('error', reject)
  })
}

async function exited(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => child.once('close', () => resolve()))
}

afterEach(async () => {
  for (const child of runningChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe.each(filesystems)('book locking on %s', (label, parentDirectory) => {
  it('grants the book to exactly one of two competing OS processes', async () => {
    const workspace = await temporaryDirectory(parentDirectory, `two-processes-${label}`)
    const lockDirectory = path.join(workspace, '.book-locks')

    const first = run(holdHelper, [lockDirectory, 'contended-book', '500'])
    const firstReported = await firstReport(first)
    expect(firstReported).toMatchObject({ state: 'held' })

    // A genuinely separate process must not be able to hold the same book at the same time.
    const second = run(holdHelper, [lockDirectory, 'contended-book', '500'])
    expect(await firstReport(second)).toMatchObject({ state: 'refused', code: 'busy' })
    await exited(second)

    // A different book is unaffected, so the lock is per book and not a global mutex.
    const other = run(holdHelper, [lockDirectory, 'other-book', '500'])
    expect(await firstReport(other)).toMatchObject({ state: 'held' })
    other.stdin.end()
    await exited(other)

    // Once the first holder releases, the book is immediately available again.
    first.stdin.end()
    await exited(first)
    const third = run(holdHelper, [lockDirectory, 'contended-book', '5000'])
    expect(await firstReport(third)).toMatchObject({ state: 'held' })
    third.stdin.end()
    await exited(third)
  })

  it('releases the book when the holder is killed, with no cleanup step', async () => {
    const workspace = await temporaryDirectory(parentDirectory, `holder-death-${label}`)
    const lockDirectory = path.join(workspace, '.book-locks')

    const holder = run(holdHelper, [lockDirectory, 'orphaned-book', '500'])
    expect(await firstReport(holder)).toMatchObject({ state: 'held' })

    const refused = run(holdHelper, [lockDirectory, 'orphaned-book', '500'])
    expect(await firstReport(refused)).toMatchObject({ state: 'refused', code: 'busy' })
    await exited(refused)

    // SIGKILL leaves no opportunity to tidy up: the kernel is the only thing releasing this.
    holder.kill('SIGKILL')
    await exited(holder)

    const lockFile = path.join(lockDirectory, 'orphaned-book.lock')
    expect((await stat(lockFile)).isFile()).toBe(true)

    const successor = new FileBookLockCoordinator({ lockDirectory, waitMs: 5_000 })
    const acquired = await successor.acquire('orphaned-book')
    acquired.assertHeld()
    await acquired.release()

    // The lock file is deliberately never unlinked; removing it would break waiters.
    expect(await readdir(lockDirectory)).toContain('orphaned-book.lock')
  })

  it('serialises two OS processes ingesting the same upload', async () => {
    const workspace = await temporaryDirectory(parentDirectory, `two-ingests-${label}`)
    const epubPath = path.join(fixtureRoot, 'synthetic-ncx-only.epub')
    const bookId = deriveBookId(
      extractEpubDeterministically(await fixtureBytes('synthetic-ncx-only')),
    )

    const reports = await Promise.all(
      [0, 1].map(async () => {
        const child = run(ingestHelper, [workspace, repositoryRoot, epubPath, '15000'])
        const report = await firstReport(child)
        await exited(child)
        return report
      }),
    )

    // Neither process fails, and they converge on one identical record.
    for (const report of reports) {
      expect(report).toMatchObject({ state: 'ingested', id: bookId, passages: 2 })
    }
    expect(await readdir(path.join(workspace, 'books'))).toEqual([bookId])
    expect(await readdir(path.join(workspace, '.staging'))).toEqual([])
    expect(await readdir(path.join(workspace, '.quarantine'))).toEqual([])
  })
})

describe('book lock lifetime inside an ingest', () => {
  const workspaceParent = path.join(
    os.homedir(),
    '.local/share/light-novel-audiobook/test-workspaces',
  )

  it.each([
    ['after-target-rename', 'commit'],
    ['after-quarantine-rename', 'discard'],
  ] as const)('still holds the book at %s, mid-%s', async (point, _phase) => {
    const workspace = await temporaryDirectory(workspaceParent, `held-at-${point}`)
    const bytes = await fixtureBytes('synthetic-ncx-only')
    const bookId = deriveBookId(extractEpubDeterministically(bytes))
    const lockDirectory = path.join(workspace, '.book-locks')

    // The discard path needs an existing book directory with no manifest to discard.
    if (point === 'after-quarantine-rename') {
      const seed = new EpubIngestionAdapter({ workspaceRoot: workspace, repositoryRoot })
      await seed.ingest({ bytes })
      await rm(path.join(workspace, 'books', bookId, 'book.json'))
    }

    let contenderState: unknown
    const adapter = new EpubIngestionAdapter({
      workspaceRoot: workspace,
      repositoryRoot,
      lockWaitMs: 15_000,
      async faultInjector(candidate) {
        if (candidate !== point || contenderState !== undefined) return
        const contender = run(holdHelper, [lockDirectory, bookId, '500'])
        contenderState = await firstReport(contender)
        await exited(contender)
      },
    })

    await adapter.ingest({ bytes })

    // Ownership spans the mutation rather than being re-proved by looking at a path.
    expect(contenderState).toMatchObject({ state: 'refused', code: 'busy' })
  })
})
