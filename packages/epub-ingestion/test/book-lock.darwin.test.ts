import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { FileBookLockCoordinator } from '../src/book-lock.js'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const tsx = path.resolve('node_modules/.bin/tsx')
const holdHelper = path.join(testDirectory, 'helpers/hold-book-lock.mts')
const roots: string[] = []
const children: ChildProcess[] = []

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), 'darwin-book-lock-'))
  roots.push(value)
  return value
}

async function firstLine(child: ChildProcess): Promise<Record<string, unknown>> {
  child.stdout?.setEncoding('utf8')
  return await new Promise((resolveLine, rejectLine) => {
    let output = ''
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.stdout?.on('data', (chunk: string) => {
      output += chunk
      const line = output.split(/\r?\n/u)[0]
      if (line) resolveLine(JSON.parse(line) as Record<string, unknown>)
    })
    child.once('error', rejectLine)
    child.once('exit', (code) => {
      if (output.length === 0)
        rejectLine(new Error(`book-lock helper exited ${code}: ${stderr.trim()}`))
    })
  })
}

async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()))
}

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })))
})

const describeDarwin = process.platform === 'darwin' ? describe : describe.skip

describeDarwin('EPUB book lock with the Darwin kernel provider', () => {
  it('keeps bounded-wait policy, releases after caller SIGKILL, and never unlinks the inode', async () => {
    const workspace = await root()
    const lockDirectory = path.join(workspace, '.book-locks')
    const holder = spawn(tsx, [holdHelper, lockDirectory, 'darwin-book', '5000'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    children.push(holder)
    expect(await firstLine(holder)).toMatchObject({ state: 'held' })

    const started = performance.now()
    await expect(
      new FileBookLockCoordinator({ lockDirectory, waitMs: 120 }).acquire('darwin-book'),
    ).rejects.toMatchObject({ code: 'busy' })
    expect(performance.now() - started).toBeGreaterThanOrEqual(100)

    holder.kill('SIGKILL')
    await exited(holder)
    const successor = await new FileBookLockCoordinator({
      lockDirectory,
      waitMs: 5_000,
    }).acquire('darwin-book')
    successor.assertHeld()
    await successor.release()

    const lockPath = path.join(lockDirectory, 'darwin-book.lock')
    expect((await stat(lockPath)).isFile()).toBe(true)
    expect(await readdir(lockDirectory)).toContain('darwin-book.lock')
  })
})
