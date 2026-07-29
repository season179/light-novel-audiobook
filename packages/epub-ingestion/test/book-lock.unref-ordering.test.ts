import { type ChildProcess, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileBookLockCoordinator } from '../src/book-lock.js'

/**
 * Pins **where** the holder may be detached from the caller's event loop.
 *
 * `detachFromEventLoop` unrefs the holder child and its stdio so a caller that forgets to release
 * cannot be held open by it. Called at spawn instead of after the handshake, it removes the only
 * handles keeping the loop alive while `acquire()` is still awaiting a child event, so the loop
 * drains and the caller **exits 0 having done nothing**. That failure is invisible to an in-process
 * assertion: the test process would simply stop rather than fail, and a suite would report green.
 *
 * So the observation has to happen from outside. Each case runs in a child process with **no stdio
 * handles of its own** and reports by writing a file. A silent exit therefore shows up as exit code
 * 0 with an empty outcome, which is what these assertions catch.
 */

const bookLockModule = new URL('../src/book-lock.ts', import.meta.url).href
const temporaryDirectories: string[] = []
const children: ChildProcess[] = []

/** Long enough to be unambiguous under load; a silent exit returns almost immediately anyway. */
const CALLER_DEADLINE_MS = 60_000

interface CallerResult {
  readonly outcome: string
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

async function temporaryLockDirectory(label: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `epub-unref-${label}-`))
  temporaryDirectories.push(root)
  const lockDirectory = path.join(root, '.book-locks')
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 })
  return lockDirectory
}

/**
 * Runs one book-lock interaction in a process whose only possible event-loop handles are the ones
 * the coordinator creates. Resolves with the recorded outcome, or `''` when the process wrote
 * nothing — the signature of a loop that drained while `acquire()` was still waiting.
 */
async function runDetachedLockCaller(
  script: readonly string[],
  lockDirectory: string,
  label: string,
): Promise<CallerResult> {
  const outcomePath = path.join(lockDirectory, `${label}.outcome`)
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      [
        "const { writeFileSync } = await import('node:fs')",
        'const { FileBookLockCoordinator } = await import(process.argv[3])',
        'const coordinator = (waitMs) =>',
        '  new FileBookLockCoordinator({ lockDirectory: process.argv[1], waitMs })',
        'const record = (outcome) => writeFileSync(process.argv[2], outcome)',
        ...script,
      ].join('\n'),
      lockDirectory,
      outcomePath,
      bookLockModule,
    ],
    // No pipes and no inherited terminal: the holder must be the only handle in play, otherwise an
    // unrelated handle could keep the loop alive and mask the hazard this test exists to catch.
    { stdio: ['ignore', 'ignore', 'ignore'] },
  )
  children.push(child)

  const exited = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`detached caller did not exit within ${CALLER_DEADLINE_MS} ms`)),
        CALLER_DEADLINE_MS,
      )
      timer.unref()
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        clearTimeout(timer)
        resolve({ code, signal })
      })
    },
  )
  return { outcome: await readFile(outcomePath, 'utf8').catch(() => ''), ...exited }
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('book lock holder detachment ordering', () => {
  it('settles an uncontended acquire in a caller with nothing else on its event loop', async () => {
    const lockDirectory = await temporaryLockDirectory('uncontended')

    // `acquire()` awaits the holder's handshake, and `release()` afterwards awaits the holder group
    // going away. Detaching at spawn removes the handles that let either complete.
    const result = await runDetachedLockCaller(
      [
        "const lock = await coordinator(5_000).acquire('pinned-book')",
        'lock.assertHeld()',
        'await lock.release()',
        "record('acquired-and-released')",
      ],
      lockDirectory,
      'uncontended',
    )

    expect(result).toMatchObject({ outcome: 'acquired-and-released', code: 0, signal: null })
  })

  it('settles a contended acquire in a caller with nothing else on its event loop', async () => {
    const lockDirectory = await temporaryLockDirectory('contended')
    // Held from this process, so the child has to wait on its holder for the whole timeout and then
    // observe it exit -- the longest stretch during which nothing but the holder is on its loop.
    const holder = await new FileBookLockCoordinator({ lockDirectory, waitMs: 5_000 }).acquire(
      'pinned-book',
    )

    try {
      const result = await runDetachedLockCaller(
        [
          'try {',
          "  const lock = await coordinator(800).acquire('pinned-book')",
          '  await lock.release()',
          "  record('unexpectedly-acquired')",
          '} catch (error) {',
          "  record('refused:' + error.code)",
          '}',
        ],
        lockDirectory,
        'contended',
      )

      expect(result).toMatchObject({ outcome: 'refused:busy', code: 0, signal: null })
    } finally {
      await holder.release()
    }
  })

  it('records something rather than exiting silently, whatever the outcome', async () => {
    // The property in one assertion, stated the way the failure actually presents: an empty outcome
    // with exit code 0. Any acquire result is acceptable here; silence is not.
    const lockDirectory = await temporaryLockDirectory('non-silent')

    const result = await runDetachedLockCaller(
      [
        "try { const lock = await coordinator(2_000).acquire('pinned-book'); await lock.release(); record('settled') }",
        "catch (error) { record('threw:' + (error && error.code)) }",
      ],
      lockDirectory,
      'non-silent',
    )

    expect(result.outcome).not.toBe('')
    expect(result.code).toBe(0)
  })
})
