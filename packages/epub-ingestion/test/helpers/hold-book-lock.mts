/**
 * Test helper, not a test. Acquires a real book lock in its own OS process, reports the outcome as
 * one JSON line on stdout, then holds the lock until stdin closes or SIGTERM arrives.
 *
 * Usage: tsx hold-book-lock.mts <lockDirectory> <bookId> <waitMs>
 */
import { mkdir } from 'node:fs/promises'
import { BookLockError, FileBookLockCoordinator } from '../../src/book-lock.js'

const [lockDirectory, bookId, waitMs] = process.argv.slice(2)
if (!lockDirectory || !bookId || !waitMs) {
  process.stdout.write(`${JSON.stringify({ state: 'usage-error' })}\n`)
  process.exit(2)
}

await mkdir(lockDirectory, { recursive: true, mode: 0o700 })
const coordinator = new FileBookLockCoordinator({ lockDirectory, waitMs: Number(waitMs) })

try {
  const lock = await coordinator.acquire(bookId)
  process.stdout.write(`${JSON.stringify({ state: 'held', pid: process.pid })}\n`)
  const stopped = new Promise<void>((resolve) => {
    process.stdin.resume()
    process.stdin.on('end', () => resolve())
    process.on('SIGTERM', () => resolve())
  })
  await stopped
  await lock.release()
  process.stdout.write(`${JSON.stringify({ state: 'released' })}\n`)
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      state: 'refused',
      code: error instanceof BookLockError ? error.code : 'unknown',
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  )
  process.exit(1)
}
