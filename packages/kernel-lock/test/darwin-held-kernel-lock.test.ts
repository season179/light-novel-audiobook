import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { darwinHelperPinPath, resolveVerifiedDarwinHelper } from '../src/helper-artifact.js'
import {
  DARWIN_KERNEL_LOCK_PROTOCOL,
  DarwinHeldKernelLockStrategy,
  KernelLockError,
} from '../src/index.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []
const children: import('node:child_process').ChildProcess[] = []
const fixture = fileURLToPath(new URL('./fixtures/lock-worker.mts', import.meta.url))
const tsx = resolve('node_modules/.bin/tsx')

async function root(label: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), `kernel-lock-${label}-`))
  roots.push(value)
  return value
}

function spawnWorker(args: readonly string[]) {
  const child = spawn(tsx, [fixture, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  return child
}

async function line(child: import('node:child_process').ChildProcess): Promise<string> {
  child.stdout?.setEncoding('utf8')
  return await new Promise((resolveLine, rejectLine) => {
    let output = ''
    child.stdout?.on('data', (chunk: string) => {
      output += chunk
      const first = output.split(/\r?\n/u)[0]
      if (first) resolveLine(first)
    })
    child.once('error', rejectLine)
    child.once('exit', (code) => rejectLine(new Error(`worker exited before report: ${code}`)))
  })
}

async function exit(child: import('node:child_process').ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()))
}

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })))
})

const describeDarwin = process.platform === 'darwin' ? describe : describe.skip

describeDarwin('Darwin held kernel lock on real APFS paths', () => {
  it('pins source separately from the locally built binary and fails closed on binary drift', async () => {
    const directory = await root('artifact')
    const artifactDirectory = join(directory, 'artifact')
    const helper = await resolveVerifiedDarwinHelper({ artifactDirectory })
    const manifest = JSON.parse(
      await readFile(join(artifactDirectory, 'manifest.json'), 'utf8'),
    ) as {
      protocol: string
      source: { sha256: string }
      compiler: { identity: string }
      binary: { sha256: string }
    }
    const pin = JSON.parse(await readFile(darwinHelperPinPath(), 'utf8')) as {
      source: { sha256: string }
    }
    expect(helper.protocol).toBe(DARWIN_KERNEL_LOCK_PROTOCOL)
    expect(manifest.source.sha256).toBe(pin.source.sha256)
    expect(manifest.compiler.identity).toMatch(/clang/i)
    expect(manifest.binary.sha256).toBe(
      createHash('sha256')
        .update(await readFile(helper.path))
        .digest('hex'),
    )
    expect(manifest.binary.sha256).not.toBe(manifest.source.sha256)

    await appendFile(helper.path, '\n')
    await expect(resolveVerifiedDarwinHelper({ artifactDirectory })).rejects.toThrow(
      /binary manifest\/hash verification failed/,
    )

    const manifestDriftDirectory = join(directory, 'manifest-drift')
    await resolveVerifiedDarwinHelper({ artifactDirectory: manifestDriftDirectory })
    const manifestPath = join(manifestDriftDirectory, 'manifest.json')
    const drifted = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      compiler: { identity: string }
    }
    drifted.compiler.identity = ''
    await writeFile(manifestPath, `${JSON.stringify(drifted)}\n`)
    await expect(
      resolveVerifiedDarwinHelper({ artifactDirectory: manifestDriftDirectory }),
    ).rejects.toThrow(/binary manifest\/hash verification failed/)

    const missingCompilerDirectory = join(directory, 'missing-compiler')
    await resolveVerifiedDarwinHelper({ artifactDirectory: missingCompilerDirectory })
    const missingCompilerManifestPath = join(missingCompilerDirectory, 'manifest.json')
    const missingCompiler = JSON.parse(
      await readFile(missingCompilerManifestPath, 'utf8'),
    ) as Record<string, unknown>
    delete missingCompiler.compiler
    await writeFile(missingCompilerManifestPath, `${JSON.stringify(missingCompiler)}\n`)
    await expect(
      resolveVerifiedDarwinHelper({ artifactDirectory: missingCompilerDirectory }),
    ).rejects.toThrow(/binary manifest\/hash verification failed/)
  })

  it('provides nonblocking contention, bounded timeout, cancellation, release, and a persistent inode', async () => {
    const directory = await root('contention')
    const artifactDirectory = join(directory, 'artifact')
    const lockFilePath = join(directory, 'lease.lock')
    const strategy = new DarwinHeldKernelLockStrategy({ artifactDirectory })
    const first = await strategy.acquire({
      lockFilePath,
      acquisition: { kind: 'nonblocking' },
      conflictExitCode: 75,
    })
    first.assertHeld()
    await expect(
      strategy.acquire({
        lockFilePath,
        acquisition: { kind: 'nonblocking' },
        conflictExitCode: 75,
      }),
    ).rejects.toMatchObject({ code: 'busy' })

    const started = performance.now()
    await expect(
      strategy.acquire({
        lockFilePath,
        acquisition: { kind: 'bounded', waitMs: 120 },
        conflictExitCode: 75,
      }),
    ).rejects.toMatchObject({ code: 'busy' })
    expect(performance.now() - started).toBeGreaterThanOrEqual(100)

    const controller = new AbortController()
    const cancelled = strategy.acquire({
      lockFilePath,
      acquisition: { kind: 'bounded', waitMs: 5_000 },
      conflictExitCode: 75,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 50)
    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' })

    await first.release()
    expect((await stat(lockFilePath)).isFile()).toBe(true)
    expect(() => first.assertHeld()).toThrow(KernelLockError)
    const successor = await strategy.acquire({
      lockFilePath,
      acquisition: { kind: 'nonblocking' },
      conflictExitCode: 75,
    })
    await successor.release()
    expect((await stat(lockFilePath)).isFile()).toBe(true)
  })

  it('releases after caller SIGKILL without cleanup and never overlaps critical sections', async () => {
    const directory = await root('caller-death')
    const artifactDirectory = join(directory, 'artifact')
    const lockFilePath = join(directory, 'lease.lock')
    const markerPath = join(directory, 'critical.marker')
    const caller = spawnWorker([lockFilePath, artifactDirectory, markerPath, 'hold'])
    expect(await line(caller)).toBe('acquired')
    caller.kill('SIGKILL')
    await exit(caller)

    const strategy = new DarwinHeldKernelLockStrategy({ artifactDirectory })
    let successor: Awaited<ReturnType<typeof strategy.acquire>> | undefined
    const deadline = performance.now() + 3_000
    while (successor === undefined) {
      try {
        successor = await strategy.acquire({
          lockFilePath,
          acquisition: { kind: 'nonblocking' },
          conflictExitCode: 75,
        })
      } catch (error) {
        if (
          !(error instanceof KernelLockError) ||
          error.code !== 'busy' ||
          performance.now() >= deadline
        )
          throw error
        await delay(20)
      }
    }
    await successor.release()

    const workers = Array.from({ length: 6 }, () =>
      spawnWorker([lockFilePath, artifactDirectory, markerPath, 'critical']),
    )
    const outputs = await Promise.all(
      workers.map(async (worker) => {
        let output = ''
        worker.stdout?.setEncoding('utf8')
        worker.stdout?.on('data', (chunk: string) => {
          output += chunk
        })
        await exit(worker)
        return output
      }),
    )
    expect(outputs.every((output) => output.includes('exclusive'))).toBe(true)
    expect(outputs.some((output) => output.includes('overlap'))).toBe(false)
  }, 30_000)

  it('notices external holder failure through kernel process probes', async () => {
    const directory = await root('holder-failure')
    const artifactDirectory = join(directory, 'artifact')
    const lockFilePath = join(directory, 'lease.lock')
    const strategy = new DarwinHeldKernelLockStrategy({ artifactDirectory })
    const lock = await strategy.acquire({
      lockFilePath,
      acquisition: { kind: 'nonblocking' },
      conflictExitCode: 75,
    })
    const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,pgid=,command='], {
      encoding: 'utf8',
    })
    const row = stdout.split('\n').find((candidate) => candidate.includes(lockFilePath))
    if (row === undefined) throw new Error('Darwin helper process was not visible')
    const fields = row.trim().split(/\s+/u)
    const pgid = Number(fields[1])
    if (!Number.isSafeInteger(pgid) || pgid <= 1) throw new Error('Darwin helper pgid unavailable')
    process.kill(-pgid, 'SIGKILL')

    // Do not let Node deliver the direct child's exit while the kernel/init retire the nested
    // holder. assertHeld must probe live processes, not a cached ChildProcess exitCode.
    const blockedUntil = performance.now() + 750
    while (performance.now() < blockedUntil) {
      // Deliberately synchronous.
    }
    expect(() => lock.assertHeld()).toThrow(KernelLockError)
    await lock.release().catch(() => undefined)
  })
})
