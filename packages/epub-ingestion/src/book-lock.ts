import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/**
 * Cross-process mutual exclusion for one book, built on a kernel `flock` held for the whole ingest.
 * The same mechanism is used by `packages/gpu-lease` (duplicated rather than imported so ingestion
 * does not depend on a GPU-named package); the release path below is shared with the fix for
 * issue #37 and the two must not diverge.
 *
 * Why a held kernel lock rather than a lock file describing its owner: with a PID/heartbeat file,
 * every ownership check is separated from the mutation it guards by at least one `await`, and what
 * it checks -- a pathname -- can be replaced underneath it. A held lock cannot lapse that way, and
 * it deletes the stale-lock problem outright instead of solving it: when a holder dies for any
 * reason, the kernel drops the lock, so there is nothing to detect and nothing to reclaim.
 *
 * The holder is a two-process subtree, which drives the whole design of release below:
 *
 *     ingest parent
 *      └─ flock            (the direct child this class spawns)
 *          └─ node         (inherits the locked descriptor; this is what actually holds the lock)
 *
 * Measured on this project's WSL2 kernel, on ext4 and on `/mnt/c` alike:
 *
 * - A *well-behaved* holder (the one shipped here, which exits on stdin EOF) does go away when only
 *   the direct `flock` child is killed, so the clean case is not the problem.
 * - A *wedged* holder -- stopped, or one that never acts on EOF -- keeps the descriptor. Killing
 *   only the direct child then leaves the lock held, and because `'close'` waits for stdio that the
 *   survivor still owns, awaiting it never resolves. That made `release()` and therefore `ingest()`
 *   hang without bound, which is worse than leaking.
 *
 * So the holder is spawned `detached` to become a process-group leader, exit is observed via
 * `'exit'` rather than `'close'`, EOF is sent unconditionally, and release is defined as "no process
 * in the group is left" -- reached by force if necessary, and bounded either way.
 *
 * Two properties are deliberate and pinned by tests:
 *
 * - The lock file is created once and **never unlinked**. Unlinking it would let a waiter hold a
 *   lock on an inode that is no longer reachable by name while a newcomer creates a fresh inode at
 *   the same path, which breaks exclusivity.
 * - Exclusivity is a property of the inode, so it assumes nothing else renames or replaces files
 *   inside the lock directory. That is the same trust already placed in `books/`: an actor able to
 *   rewrite the workspace's internals is outside what any file lock can defend.
 */

const HOLDER_SOURCE = `
const token = process.argv[1]
process.stdout.write(token + ' ' + process.pid + '\\n')
process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
`

/** `flock` reports a refused or timed-out lock with this exit code. */
const CONFLICT_EXIT_CODE = 75
const HANDSHAKE_OUTPUT_LIMIT = 4_000
const GROUP_EXIT_POLL_MS = 20

export type BookLockErrorCode = 'busy' | 'unavailable'

export class BookLockError extends Error {
  override readonly name = 'BookLockError'
  readonly code: BookLockErrorCode

  constructor(code: BookLockErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
  }
}

export interface HeldBookLock {
  readonly bookId: string
  readonly lockFilePath: string
  /** Unique per acquisition; safe for naming this run's staging directory. */
  readonly token: string
  /** Process-group id of the holder subtree, for diagnostics and for tests that stop the group. */
  readonly holderGroupPid: number | undefined
  /** PID of the nested process that owns the locked descriptor. */
  readonly holderPid: number | undefined
  /**
   * Fails unless the kernel lock is still held.
   *
   * This asks the kernel about the live processes rather than reading the direct child's cached
   * `exitCode`/`signalCode`, because those are only updated when Node delivers the `exit` event: a
   * parent whose event loop is busy would otherwise keep passing this check for an arbitrarily long
   * time after every descriptor holder had exited and the lock had become available to someone
   * else. That is failing open in exactly the situation the check exists for.
   *
   * The primary signal is the **nested holder**, because that is the process owning the locked
   * descriptor. It is deliberately not this process' child, so it is reaped by init rather than by
   * our event loop, and its disappearance is therefore visible even while we are blocked. Our own
   * direct `flock` child cannot serve that role: killing the subtree leaves it a zombie until Node
   * reaps it, and a zombie still answers signal probes, so it would report "held" for as long as
   * the loop stayed busy -- the very hole being closed. The group is checked too, so either half
   * of the subtree vanishing fails closed.
   *
   * Residual, documented rather than hidden: between the holder's exit and init reaping it there is
   * a brief interval where a probe still succeeds although the descriptor is closed. This must
   * therefore not be a caller's only guard before a destructive step; `#discardTarget` independently
   * re-establishes that what it is about to destroy is not a committed record.
   */
  assertHeld(): void
  release(): Promise<void>
}

export interface BookLockCoordinator {
  acquire(bookId: string): Promise<HeldBookLock>
}

export interface FileBookLockCoordinatorConfig {
  /** Directory holding one never-unlinked lock file per book. */
  readonly lockDirectory: string
  /** How long to wait for a competing holder before reporting `busy`. */
  readonly waitMs?: number
  readonly flockExecutable?: string
  /** How long a well-behaved holder gets to exit on stdin EOF before the group is signalled. */
  readonly releaseGraceMs?: number
  /** How long the group gets to disappear after `SIGKILL` before release reports failure. */
  readonly killGraceMs?: number
}

interface HolderExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly error?: unknown
}

interface HolderHandshake {
  readonly state: 'acquired' | 'exited' | 'unusable'
  /** PID of the nested process that owns the locked descriptor. */
  readonly holderPid?: number
}

/** `EPERM` means the process exists but is not ours; only `ESRCH` proves it is gone. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** `EPERM` means the group exists but is not ours; only `ESRCH` proves it is gone. */
function processGroupAlive(groupPid: number): boolean {
  try {
    process.kill(-groupPid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function signalProcessGroup(groupPid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-groupPid, signal)
  } catch (error) {
    // The group being gone already is the outcome this call wanted.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

/** Unconditional: the holder releases only on EOF, so this must not depend on the direct child. */
function endHolderStdin(child: ChildProcessWithoutNullStreams): void {
  try {
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end()
  } catch {
    // A broken pipe means the holder is already gone, which is what EOF was asking for.
  }
}

/** Keeps a detached holder from holding this process' event loop open. */
function detachFromEventLoop(child: ChildProcessWithoutNullStreams): void {
  child.unref()
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    ;(stream as { unref?: () => void }).unref?.()
  }
}

export class FileBookLockCoordinator implements BookLockCoordinator {
  readonly #lockDirectory: string
  readonly #waitMs: number
  readonly #flockExecutable: string
  readonly #releaseGraceMs: number
  readonly #killGraceMs: number

  constructor(config: FileBookLockCoordinatorConfig) {
    this.#lockDirectory = path.resolve(config.lockDirectory)
    this.#waitMs = config.waitMs ?? 10_000
    this.#flockExecutable = config.flockExecutable ?? 'flock'
    this.#releaseGraceMs = config.releaseGraceMs ?? 5_000
    this.#killGraceMs = config.killGraceMs ?? 5_000
    if (!Number.isFinite(this.#waitMs) || this.#waitMs < 0) {
      throw new BookLockError('unavailable', 'EPUB book lock wait must be a non-negative duration')
    }
  }

  async acquire(bookId: string): Promise<HeldBookLock> {
    const lockFilePath = path.join(this.#lockDirectory, `${bookId}.lock`)
    // Created if absent and then left in place for good; see the note on never unlinking.
    const file = await open(lockFilePath, 'a', 0o600)
    await file.close()

    const token = `${bookId}-${process.pid}-${randomUUID()}`
    const child = spawn(
      this.#flockExecutable,
      [
        '--exclusive',
        '--timeout',
        (this.#waitMs / 1_000).toFixed(3),
        '--conflict-exit-code',
        String(CONFLICT_EXIT_CODE),
        lockFilePath,
        process.execPath,
        '-e',
        HOLDER_SOURCE,
        token,
      ],
      // `detached` makes the holder subtree its own process group, which is the only handle that
      // reaches the nested process actually holding the descriptor.
      { stdio: ['pipe', 'pipe', 'pipe'] as const, detached: true, windowsHide: true },
    )

    // Settles on `exit`, not `close`: `close` waits for every inherited stdio handle, so a
    // surviving descendant could otherwise stall release indefinitely.
    const exit = new Promise<HolderExit>((resolveExit) => {
      let settled = false
      const settle = (result: HolderExit): void => {
        if (settled) return
        settled = true
        resolveExit(result)
      }
      child.once('error', (error) => settle({ code: null, signal: null, error }))
      child.once('exit', (code, exitSignal) => settle({ code, signal: exitSignal }))
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-HANDSHAKE_OUTPUT_LIMIT)
    })

    let acquired = false
    try {
      const handshake = await this.#waitForToken(child, exit, token)
      acquired = handshake.state === 'acquired'
      if (handshake.state === 'unusable') {
        await this.#stopHolderQuietly(child)
        throw new BookLockError(
          'unavailable',
          'EPUB book lock holder produced an unusable handshake and was stopped',
        )
      }
      if (handshake.state === 'exited') {
        const result = await exit
        if (result.code === CONFLICT_EXIT_CODE) {
          throw new BookLockError(
            'busy',
            `Timed out after ${this.#waitMs} ms waiting for the EPUB book lock: ${path.basename(lockFilePath)}`,
          )
        }
        throw new BookLockError(
          'unavailable',
          `EPUB book lock holder failed to start: ${stderr.trim() || String(result.error ?? `exit ${result.code}`)}`,
        )
      }

      const groupPid = child.pid
      const holderPid = handshake.holderPid
      detachFromEventLoop(child)
      let released = false
      return {
        bookId,
        lockFilePath,
        token,
        holderGroupPid: groupPid,
        holderPid,
        assertHeld: () => {
          if (released) {
            throw new BookLockError('unavailable', 'EPUB book lock was already released')
          }
          // The nested holder owns the descriptor, so its death is what frees the lock. It is not
          // this process' child, so it is reaped by init rather than by our event loop, which is
          // why this stays accurate even while we are busy.
          const holderGone = holderPid === undefined || !processAlive(holderPid)
          const groupGone = groupPid === undefined || !processGroupAlive(groupPid)
          if (holderGone || groupGone) {
            throw new BookLockError(
              'unavailable',
              `EPUB book lock holder for ${bookId} is gone; the lock is no longer held`,
            )
          }
        },
        release: async () => {
          if (released) return
          released = true
          await this.#stopHolder(child)
        },
      }
    } catch (error) {
      // Stopping the holder must never replace the cause that made acquisition fail.
      if (acquired) await this.#stopHolderQuietly(child)
      if (error instanceof BookLockError) throw error
      throw new BookLockError('unavailable', `Could not acquire the EPUB book lock for ${bookId}`, {
        cause: error,
      })
    }
  }

  async #waitForToken(
    child: ChildProcessWithoutNullStreams,
    exit: Promise<HolderExit>,
    token: string,
  ): Promise<HolderHandshake> {
    child.stdout.setEncoding('utf8')
    return await new Promise<HolderHandshake>((resolveReady) => {
      let settled = false
      let output = ''
      const finish = (value: HolderHandshake): void => {
        if (settled) return
        settled = true
        resolveReady(value)
      }
      child.stdout.on('data', (chunk: string) => {
        output += chunk
        const line = output.split(/\r?\n/u).find((candidate) => candidate.startsWith(`${token} `))
        if (line) {
          const holderPid = Number(line.slice(token.length + 1).trim())
          finish(
            Number.isSafeInteger(holderPid) && holderPid > 0
              ? { state: 'acquired', holderPid }
              : { state: 'unusable' },
          )
        }
        if (output.length > HANDSHAKE_OUTPUT_LIMIT) finish({ state: 'unusable' })
      })
      void exit.then(() => finish({ state: 'exited' }))
    })
  }

  async #stopHolderQuietly(child: ChildProcessWithoutNullStreams): Promise<void> {
    try {
      await this.#stopHolder(child)
    } catch {
      // The caller is already reporting a more informative failure.
    }
  }

  /**
   * Releases the lock, bounded in every path.
   *
   * Release means "no process in the holder group is left", because the nested holder -- not the
   * direct child -- owns the descriptor. Waiting on the direct child's exit would report success
   * while an orphaned holder kept the book locked, and EOF alone cannot be relied on: a holder that
   * is stopped, wedged, or ignoring stdin never acts on it. So EOF is sent unconditionally, the
   * group is given a grace period to leave on its own, and then it is killed.
   */
  async #stopHolder(child: ChildProcessWithoutNullStreams): Promise<void> {
    endHolderStdin(child)
    const groupPid = child.pid
    if (groupPid === undefined) return
    if (await this.#waitForGroupExit(groupPid, this.#releaseGraceMs)) return

    // Reaching here means the holder did not act on EOF. Force is the only remaining option, and it
    // is reported rather than swallowed: a release that needed SIGKILL says something pathological
    // happened, which a caller should hear about even though the group is confirmed gone below.
    signalProcessGroup(groupPid, 'SIGKILL')
    const terminated = await this.#waitForGroupExit(groupPid, this.#killGraceMs)
    throw new BookLockError(
      'unavailable',
      terminated
        ? `EPUB book lock holder group ${groupPid} ignored EOF and required SIGKILL; the lock was force-released`
        : `EPUB book lock holder group ${groupPid} survived SIGKILL; the book may remain locked`,
    )
  }

  async #waitForGroupExit(groupPid: number, budgetMs: number): Promise<boolean> {
    const deadline = Date.now() + budgetMs
    while (processGroupAlive(groupPid)) {
      if (Date.now() >= deadline) return false
      await delay(Math.min(GROUP_EXIT_POLL_MS, Math.max(1, deadline - Date.now())))
    }
    return true
  }
}
