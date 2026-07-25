import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import path from 'node:path'

/**
 * Cross-process mutual exclusion for one book, built on a kernel `flock` held by a dedicated child
 * process for the whole ingest. This mirrors the approach already proven in `packages/gpu-lease`
 * (duplicated rather than imported so ingestion does not depend on a GPU-named package).
 *
 * Why a held kernel lock rather than a lock file describing its owner: with a PID/heartbeat file,
 * every ownership check is separated from the mutation it guards by at least one `await`, and what
 * it checks -- a pathname -- can be replaced underneath it. A held lock cannot lapse that way, and
 * it deletes the stale-lock problem outright instead of solving it: when a holder dies for any
 * reason, the kernel drops the lock, so there is nothing to detect and nothing to reclaim.
 *
 * Two consequences are deliberate:
 *
 * - The lock file is created once and **never unlinked**. Unlinking it would let a waiter hold a
 *   lock on an inode that is no longer reachable by name while a newcomer creates a fresh inode at
 *   the same path, which breaks exclusivity. `gpu-lease` has a test pinning the same property.
 * - Exclusivity is a property of the inode, so it assumes nothing else renames or replaces files
 *   inside the lock directory. That is the same trust already placed in `books/`: an actor able to
 *   rewrite the workspace's internals is outside what any file lock can defend.
 */

const HOLDER_SOURCE = `
const token = process.argv[1]
process.stdout.write(token + '\\n')
process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
`

/** `flock` reports a refused or timed-out lock with this exit code. */
const CONFLICT_EXIT_CODE = 75
const HANDSHAKE_OUTPUT_LIMIT = 4_000

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
  /**
   * Fails unless the kernel lock is still held. This is a liveness check on a child process this
   * run owns, not a comparison against a path, so nothing can substitute the thing being checked.
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
  readonly releaseGraceMs?: number
}

interface HolderExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly error?: unknown
}

type HolderHandshake = 'acquired' | 'exited' | 'unusable'

export class FileBookLockCoordinator implements BookLockCoordinator {
  readonly #lockDirectory: string
  readonly #waitMs: number
  readonly #flockExecutable: string
  readonly #releaseGraceMs: number

  constructor(config: FileBookLockCoordinatorConfig) {
    this.#lockDirectory = path.resolve(config.lockDirectory)
    this.#waitMs = config.waitMs ?? 10_000
    this.#flockExecutable = config.flockExecutable ?? 'flock'
    this.#releaseGraceMs = config.releaseGraceMs ?? 5_000
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
      { stdio: ['pipe', 'pipe', 'pipe'] as const, windowsHide: true },
    )

    const exit = new Promise<HolderExit>((resolveExit) => {
      let settled = false
      const settle = (result: HolderExit): void => {
        if (settled) return
        settled = true
        resolveExit(result)
      }
      child.once('error', (error) => settle({ code: null, signal: null, error }))
      child.once('close', (code, closeSignal) => settle({ code, signal: closeSignal }))
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-HANDSHAKE_OUTPUT_LIMIT)
    })

    let acquired = false
    try {
      const handshake = await this.#waitForToken(child, exit, token)
      acquired = handshake === 'acquired'
      if (handshake === 'unusable') {
        await this.#stopHolderQuietly(child, exit)
        throw new BookLockError(
          'unavailable',
          'EPUB book lock holder produced an unusable handshake and was stopped',
        )
      }
      if (handshake === 'exited') {
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

      let released = false
      return {
        bookId,
        lockFilePath,
        token,
        assertHeld: () => {
          if (released)
            throw new BookLockError('unavailable', 'EPUB book lock was already released')
          if (child.exitCode !== null || child.signalCode !== null) {
            throw new BookLockError(
              'unavailable',
              `EPUB book lock holder for ${bookId} exited before the ingest finished`,
            )
          }
        },
        release: async () => {
          if (released) return
          released = true
          await this.#stopHolder(child, exit)
        },
      }
    } catch (error) {
      // Stopping the holder must never replace the cause that made acquisition fail.
      if (acquired) await this.#stopHolderQuietly(child, exit)
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
        if (output.split(/\r?\n/u).includes(token)) finish('acquired')
        if (output.length > HANDSHAKE_OUTPUT_LIMIT) finish('unusable')
      })
      void exit.then(() => finish('exited'))
    })
  }

  async #stopHolderQuietly(
    child: ChildProcessWithoutNullStreams,
    exit: Promise<HolderExit>,
  ): Promise<void> {
    try {
      await this.#stopHolder(child, exit)
    } catch {
      // The caller is already reporting a more informative failure.
    }
  }

  async #stopHolder(
    child: ChildProcessWithoutNullStreams,
    exit: Promise<HolderExit>,
  ): Promise<void> {
    if (child.exitCode === null && child.signalCode === null) child.stdin.end()
    const timeout = setTimeout(() => child.kill('SIGKILL'), this.#releaseGraceMs)
    timeout.unref()
    const result = await exit
    clearTimeout(timeout)
    if (result.error !== undefined) {
      throw new BookLockError('unavailable', 'EPUB book lock holder process failed', {
        cause: result.error,
      })
    }
  }
}
