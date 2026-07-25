import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, statfsSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { BookLockError, FileBookLockCoordinator } from '../src/book-lock.js'
import { deriveBookId, EpubIngestionAdapter, extractEpubDeterministically } from '../src/index.js'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(testDirectory, '../../..')
const fixtureRoot = path.join(repositoryRoot, 'tests/fixtures/epub')
const tsx = path.join(repositoryRoot, 'node_modules/.bin/tsx')
const holdHelper = path.join(testDirectory, 'helpers/hold-book-lock.mts')
const ingestHelper = path.join(testDirectory, 'helpers/ingest-book.mts')

const temporaryDirectories: string[] = []
const runningChildren: ChildProcessWithoutNullStreams[] = []

/** `EPERM` proves existence under another user; only `ESRCH` proves absence. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function processGroupAlive(groupPid: number): boolean {
  try {
    process.kill(-groupPid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * The workspace default lives on ext4 (`~/.local/share/...`), but `AUDIOBOOK_WORKSPACE_DIR` can
 * point at a Windows-mounted path, so both filesystems have to hold the lock correctly. Every other
 * durability test uses `os.tmpdir()` only, which never exercises 9p/drvfs.
 *
 * The Windows mount only exists on a WSL2 host. Hosted CI runners are plain Linux VMs, so that half
 * is skipped there -- by name, never silently, so a reader of CI output can see that drvfs lock
 * coverage did not run and why. The environment is probed rather than assumed from the path string:
 * the mount must exist, be a real 9p/drvfs mount according to `/proc/mounts`, and be writable.
 */
const WINDOWS_MOUNT_FSTYPES = new Set(['9p', 'v9fs', 'drvfs', 'virtiofs'])
const DRVFS_MOUNT = '/mnt/c'
const DRVFS_TEST_ROOT = '/mnt/c/Temp/lna-epub-ingestion-tests'

/** Longest matching mount point wins, so a nested mount is not mistaken for its parent. */
function mountFsType(candidate: string): { fstype: string; options: string } | undefined {
  let best: { point: string; fstype: string; options: string } | undefined
  for (const line of readFileSync('/proc/mounts', 'utf8').split('\n')) {
    const [, rawPoint, fstype, options] = line.split(' ')
    if (!rawPoint || !fstype) continue
    const point = rawPoint.replace(/\\040/g, ' ')
    const prefix = point.endsWith('/') ? point : `${point}/`
    if (candidate !== point && !candidate.startsWith(prefix)) continue
    if (!best || point.length > best.point.length) {
      best = { point, fstype, options: options ?? '' }
    }
  }
  return best === undefined ? undefined : { fstype: best.fstype, options: best.options }
}

function probeDrvfs(): { available: boolean; reason: string } {
  let mountInfo: { fstype: string; options: string } | undefined
  try {
    if (!statSync(DRVFS_MOUNT).isDirectory()) {
      return { available: false, reason: `${DRVFS_MOUNT} exists but is not a directory` }
    }
  } catch {
    return { available: false, reason: `${DRVFS_MOUNT} does not exist; not a WSL2 host` }
  }
  mountInfo = mountFsType(DRVFS_MOUNT)
  if (!mountInfo || !WINDOWS_MOUNT_FSTYPES.has(mountInfo.fstype)) {
    return {
      available: false,
      reason: `${DRVFS_MOUNT} is fstype "${mountInfo?.fstype ?? 'unknown'}", not a 9p/drvfs Windows mount`,
    }
  }
  try {
    mkdirSync(DRVFS_TEST_ROOT, { recursive: true, mode: 0o700 })
    const probe = path.join(DRVFS_TEST_ROOT, `.write-probe-${process.pid}`)
    writeFileSync(probe, '')
    unlinkSync(probe)
  } catch (error) {
    return {
      available: false,
      reason: `${DRVFS_TEST_ROOT} is not writable (${(error as NodeJS.ErrnoException).code ?? 'unknown'})`,
    }
  }
  const magic = statfsSync(DRVFS_MOUNT).type
  return {
    available: true,
    reason: `fstype=${mountInfo.fstype} statfs=0x${magic.toString(16)}${
      mountInfo.options.includes('drvfs') ? ' aname=drvfs' : ''
    }`,
  }
}

const drvfs = probeDrvfs()
const filesystems = (
  [
    ['ext4', path.join(os.homedir(), '.local/share/light-novel-audiobook/test-workspaces')],
    ...(drvfs.available ? [['drvfs-mnt-c', DRVFS_TEST_ROOT] as const] : []),
  ] as const
).map((entry) => entry as readonly [string, string])

if (!drvfs.available) {
  // Visible in CI output rather than an absent describe block nobody notices.
  describe.skip(`book locking on drvfs-mnt-c — SKIPPED: ${drvfs.reason}`, () => {
    it('drvfs 9p lock coverage requires a WSL2 host and did not run here', () => {})
  })
}

/**
 * Spawning real `tsx` subprocesses is slow, and slower still on a loaded machine, so the tests that
 * do it get a defensible budget instead of the suite default.
 */
const SUBPROCESS_TEST_TIMEOUT_MS = 90_000
const HELPER_REPORT_TIMEOUT_MS = 60_000

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

/** Resolves with the first JSON line the helper writes, or rejects with a diagnosable timeout. */
function firstReport(
  child: ChildProcessWithoutNullStreams,
  budgetMs = HELPER_REPORT_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let output = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(
        new Error(
          `helper produced no report within ${budgetMs} ms; stdout: ${output.slice(-500)}; stderr: ${stderr.slice(-1000)}`,
        ),
      )
    }, budgetMs)
    timer.unref()
    const finish = (settle: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      settle()
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.stdout.on('data', (chunk: string) => {
      output += chunk
      const line = output.split(/\r?\n/u).find((candidate) => candidate.trim().length > 0)
      if (line) finish(() => resolve(JSON.parse(line) as Record<string, unknown>))
    })
    child.once('close', () => {
      if (output.trim().length === 0) {
        finish(() =>
          reject(new Error(`helper exited without a report; stderr: ${stderr.slice(-2000)}`)),
        )
      }
    })
    child.once('error', (error) => finish(() => reject(error)))
  })
}

/** Polls a condition to a deadline instead of assuming a fixed interval is enough under load. */
async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  budgetMs: number,
  describeFailure: string,
): Promise<void> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() >= deadline) throw new Error(`${describeFailure} within ${budgetMs} ms`)
    await delay(25)
  }
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
}, 60_000)

describe.each(filesystems)('book locking on %s', (label, parentDirectory) => {
  it(
    'grants the book to exactly one of two competing OS processes',
    async () => {
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
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  )

  it(
    'releases the book when the holder is killed, with no cleanup step',
    async () => {
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
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  )

  it(
    'serialises two OS processes ingesting the same upload',
    async () => {
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
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  )
})

describe.each(filesystems)('book lock release on %s', (label, parentDirectory) => {
  /**
   * Release must be bounded in every path, so nothing here awaits without a deadline. A forced
   * release rejects on purpose (it reports that the holder had to be killed), so these helpers
   * assert *settlement* within a budget rather than success.
   */
  async function settleWithin(
    budgetMs: number,
    work: Promise<unknown>,
  ): Promise<{ settled: 'resolved' | 'rejected'; elapsedMs: number; error?: unknown }> {
    const startedAt = Date.now()
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`did not settle within ${budgetMs} ms`)), budgetMs)
    })
    try {
      const outcome = await Promise.race([
        work.then(
          () => ({ settled: 'resolved' as const, elapsedMs: Date.now() - startedAt }),
          (error: unknown) => ({
            settled: 'rejected' as const,
            elapsedMs: Date.now() - startedAt,
            error,
          }),
        ),
        deadline,
      ])
      return outcome
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function lockDirectoryFor(name: string): Promise<string> {
    const workspace = await temporaryDirectory(parentDirectory, `${name}-${label}`)
    const lockDirectory = path.join(workspace, '.book-locks')
    await mkdir(lockDirectory, { recursive: true, mode: 0o700 })
    return lockDirectory
  }

  it(
    'completes release after only the direct flock child is killed',
    async () => {
      const lockDirectory = await lockDirectoryFor('direct-child-killed')
      const coordinator = new FileBookLockCoordinator({
        lockDirectory,
        waitMs: 5_000,
        releaseGraceMs: 2_000,
        killGraceMs: 2_000,
      })

      const lock = await coordinator.acquire('orphan-release')
      const groupPid = lock.holderGroupPid
      if (groupPid === undefined) throw new Error('holder group unavailable')

      // Kill ONLY the direct flock child. Whether the nested holder happens to go with it is a kernel
      // detail that varies; what must hold either way is that release settles and the book frees.
      process.kill(groupPid, 'SIGKILL')
      await waitUntil(() => !processAlive(groupPid), 15_000, 'direct flock child did not exit')

      const released = await settleWithin(30_000, lock.release())
      expect(released.settled).toBeDefined()
      expect(processGroupAlive(groupPid)).toBe(false)

      const successor = await coordinator.acquire('orphan-release')
      successor.assertHeld()
      await settleWithin(30_000, successor.release())
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  )

  it(
    'terminates the group when the holder ignores stdin EOF instead of hanging',
    async () => {
      const lockDirectory = await lockDirectoryFor('eof-ignored')
      const releaseGraceMs = 400
      const coordinator = new FileBookLockCoordinator({
        lockDirectory,
        waitMs: 5_000,
        releaseGraceMs,
        killGraceMs: 3_000,
      })

      const lock = await coordinator.acquire('eof-ignored')
      const groupPid = lock.holderGroupPid
      const holderPid = lock.holderPid
      if (groupPid === undefined || holderPid === undefined)
        throw new Error('holder pids unavailable')

      // SIGSTOP makes the subtree incapable of acting on EOF without faking anything: a stopped
      // process is precisely a wedged holder. Only a signal can dislodge it. Before this fix the
      // waited-on promise settled on 'close', which a survivor holding inherited stdio never lets
      // arrive, so release() -- and therefore ingest() -- hung without bound.
      process.kill(-groupPid, 'SIGSTOP')

      const released = await settleWithin(30_000, lock.release())

      expect(released.settled).toBe('rejected')
      expect((released.error as Error).message).toMatch(/required SIGKILL/)
      expect(released.elapsedMs).toBeGreaterThanOrEqual(releaseGraceMs)
      expect(processAlive(holderPid)).toBe(false)
      expect(processGroupAlive(groupPid)).toBe(false)

      // And the book is genuinely usable again afterwards.
      const successor = await coordinator.acquire('eof-ignored')
      await settleWithin(30_000, successor.release())
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  )

  it(
    'bounds release when the direct child is dead and a wedged descendant survives',
    async () => {
      const lockDirectory = await lockDirectoryFor('wedged-descendant')
      const coordinator = new FileBookLockCoordinator({
        lockDirectory,
        waitMs: 5_000,
        releaseGraceMs: 400,
        killGraceMs: 3_000,
      })

      const lock = await coordinator.acquire('wedged')
      const groupPid = lock.holderGroupPid
      const holderPid = lock.holderPid
      if (groupPid === undefined || holderPid === undefined)
        throw new Error('holder pids unavailable')

      // The worst combination the reviewer measured: nothing left that could deliver EOF usefully, and
      // a descendant that cannot act on it. This is the shape that used to hang forever.
      process.kill(holderPid, 'SIGSTOP')
      process.kill(groupPid, 'SIGKILL')
      await waitUntil(() => !processAlive(groupPid), 15_000, 'direct flock child did not exit')
      // The stopped descendant must still be there; that is the whole point of this case.
      expect(processAlive(holderPid)).toBe(true)

      const released = await settleWithin(30_000, lock.release())

      expect(released.settled).toBe('rejected')
      expect(processAlive(holderPid)).toBe(false)
      const successor = await coordinator.acquire('wedged')
      await settleWithin(30_000, successor.release())
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  )

  it(
    'never unlinks the lock file across acquire, release, and force-release',
    async () => {
      const lockDirectory = await lockDirectoryFor('never-unlinked')
      const coordinator = new FileBookLockCoordinator({
        lockDirectory,
        waitMs: 5_000,
        releaseGraceMs: 300,
        killGraceMs: 3_000,
      })
      const lockFile = path.join(lockDirectory, 'persistent.lock')

      const first = await coordinator.acquire('persistent')
      expect((await stat(lockFile)).isFile()).toBe(true)
      await first.release()
      // Unlinking would let a newcomer lock a fresh inode at the same path while a waiter held the old
      // one, so the file must outlive every release path.
      expect((await stat(lockFile)).isFile()).toBe(true)

      const wedged = await coordinator.acquire('persistent')
      if (wedged.holderGroupPid === undefined) throw new Error('holder group unavailable')
      process.kill(-wedged.holderGroupPid, 'SIGSTOP')
      await settleWithin(30_000, wedged.release())
      expect((await stat(lockFile)).isFile()).toBe(true)
      expect(await readdir(lockDirectory)).toContain('persistent.lock')
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  )
})

describe('book lock ownership accuracy', () => {
  const workspaceParent = path.join(
    os.homedir(),
    '.local/share/light-novel-audiobook/test-workspaces',
  )

  it(
    'fails closed while the event loop is blocked after the holder subtree dies',
    async () => {
      const workspace = await temporaryDirectory(workspaceParent, 'assert-held-window')
      const lockDirectory = path.join(workspace, '.book-locks')
      await mkdir(lockDirectory, { recursive: true, mode: 0o700 })
      const coordinator = new FileBookLockCoordinator({
        lockDirectory,
        waitMs: 8_000,
        releaseGraceMs: 1_000,
        killGraceMs: 2_000,
      })

      const lock = await coordinator.acquire('window-book')
      const groupPid = lock.holderGroupPid
      if (groupPid === undefined) throw new Error('holder group unavailable')
      lock.assertHeld()

      // A separate OS process that will take the book the moment the kernel frees it.
      const contender = run(holdHelper, [lockDirectory, 'window-book', '8000'])
      const contenderReport = firstReport(contender)

      // The whole holder subtree dies, so the kernel lock is free from this instant.
      process.kill(-groupPid, 'SIGKILL')

      // Block the event loop so Node cannot deliver the direct child's `exit` event or reap it. Any
      // check reading cached exit state still believes the lock is held for this entire window, and
      // the window is as long as the loop stays busy.
      const blockUntil = Date.now() + 750
      while (Date.now() < blockUntil) {
        // deliberately synchronous
      }

      // Called with no intervening await, so nothing has been delivered to the loop.
      let thrown: unknown
      try {
        lock.assertHeld()
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(BookLockError)
      // Proof the lock really was available during the blocked window.
      expect(await contenderReport).toMatchObject({ state: 'held' })
      contender.stdin.end()
      await exited(contender)
      await lock.release().catch(() => undefined)
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  )

  it(
    'refuses to discard a book directory that has become a committed record',
    async () => {
      // Defence in depth for the reaping sliver above: `assertHeld()` is not the only thing standing
      // between a lapsed lock and the destructive step.
      const workspace = await temporaryDirectory(workspaceParent, 'discard-precondition')
      const bytes = await fixtureBytes('synthetic-ncx-only')
      const bookId = deriveBookId(extractEpubDeterministically(bytes))
      const committedManifest = path.join(workspace, 'books', bookId, 'book.json')

      const seeded = await new EpubIngestionAdapter({
        workspaceRoot: workspace,
        repositoryRoot,
      }).ingest({ bytes })
      const savedManifest = await readFile(committedManifest, 'utf8')
      // Leave a manifest-less directory, which recovery decides to discard.
      await rm(committedManifest)

      const adapter = new EpubIngestionAdapter({
        workspaceRoot: workspace,
        repositoryRoot,
        lockWaitMs: 8_000,
        async faultInjector(point) {
          // Stand in for the moment a lapsed lock would allow: a valid committed record appears
          // between the decision to discard and the destruction itself.
          if (point === 'after-discard-ownership-check') {
            await writeFile(committedManifest, savedManifest)
          }
        },
      })

      await expect(adapter.ingest({ bytes })).rejects.toMatchObject({ code: 'STORAGE_CONFLICT' })

      // The record that appeared was not destroyed.
      expect(JSON.parse(await readFile(committedManifest, 'utf8'))).toEqual(seeded)
      expect(await readdir(path.join(workspace, '.quarantine'))).toEqual([])
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  )
})

describe.each(filesystems)(
  'book lock lifetime inside an ingest on %s',
  (label, parentDirectory) => {
    it.each([
      ['after-target-rename', 'commit'],
      ['after-quarantine-rename', 'discard'],
    ] as const)(
      'still holds the book at %s, mid-%s',
      async (point, _phase) => {
        const workspace = await temporaryDirectory(parentDirectory, `held-at-${point}-${label}`)
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
      },
      SUBPROCESS_TEST_TIMEOUT_MS,
    )
  },
)
