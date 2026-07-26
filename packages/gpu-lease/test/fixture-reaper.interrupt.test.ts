import { type ChildProcess, spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { loadRegistry, reapOrphanedHolders } from './fixture-reaper.js'

/** Resolved from this file, never from the shell cwd, so the package's own test script works. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

interface RegisteredMarker {
  readonly workerPid: number
  readonly holderPgid: number
  readonly root: string
  readonly scriptsRoot: string
  readonly registered: boolean
  readonly registeredAt: number
}

interface StartedMarker {
  readonly workerPid: number
  readonly holderPgid: number
  readonly root: string
  readonly scriptsRoot: string
}

const spawned: ChildProcess[] = []
const cleanupGroups = new Set<number>()
const cleanupRoots = new Set<string>()

const delay = async (ms: number): Promise<void> =>
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms))

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const raw = await readFile(path, 'utf8').catch(() => undefined)
    if (raw !== undefined) return raw
    await delay(50)
  }
  throw new Error(`interrupt holder did not publish ${path}`)
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      new Promise<number | null>((resolveExit) => child.once('exit', (code) => resolveExit(code))),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('nested Vitest did not exit')), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function waitForGroupExit(groupId: number, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    try {
      process.kill(-groupId, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    if (performance.now() >= deadline) {
      throw new Error(`holder group ${groupId} is still alive`)
    }
    await delay(10)
  }
}

function startProbe(
  fixturePath: string,
  environment: Readonly<Record<string, string>>,
): ChildProcess {
  const child = spawn(
    process.execPath,
    [join(REPO_ROOT, 'node_modules/vitest/vitest.mjs'), 'run', fixturePath],
    {
      cwd: REPO_ROOT,
      detached: true,
      env: { ...process.env, VITEST_MAX_WORKERS: '2', ...environment },
      stdio: 'ignore',
    },
  )
  spawned.push(child)
  return child
}

afterEach(async () => {
  for (const child of spawned.splice(0)) {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // Gone.
      }
    }
  }
  for (const groupId of cleanupGroups) {
    try {
      process.kill(-groupId, 'SIGKILL')
    } catch {
      // Gone.
    }
  }
  for (const groupId of cleanupGroups) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        process.kill(-groupId, 0)
        await delay(5)
      } catch {
        break
      }
      if (attempt === 199) throw new Error(`probe holder group ${groupId} survived cleanup`)
    }
  }
  cleanupGroups.clear()
  await reapOrphanedHolders()
  await Promise.all([...cleanupRoots].map((root) => rm(root, { recursive: true, force: true })))
  cleanupRoots.clear()
})

describe('interrupt fixture reaper round trip (#67)', () => {
  it('registers before worker SIGINT and the next suite startup reaps that exact holder', async () => {
    const fixturePath = join(
      REPO_ROOT,
      'packages/gpu-lease/test/fixtures/interrupt-holder.fixture.test.ts',
    )
    const probeDir = join(tmpdir(), `gpu-lease-interrupt-probe-${crypto.randomUUID()}`)
    await mkdir(probeDir, { recursive: true })
    const nonce = crypto.randomUUID()
    cleanupRoots.add(probeDir)
    cleanupRoots.add(join(tmpdir(), `gpu-lease-interrupt-holder-${nonce}`))
    cleanupRoots.add(join(tmpdir(), `gpu-lease-interrupt-scripts-${nonce}`))
    const first = startProbe(fixturePath, {
      LNA_REAPER_PROBE_PHASE: 'hold',
      LNA_REAPER_PROBE_DIR: probeDir,
      LNA_REAPER_PROBE_NONCE: nonce,
    })

    // The observer publishes that registration has started; only then may the holder's token
    // gate open. This keeps acquire() in flight at a point only in-acquisition registration can
    // survive: moving the observer past the handshake deadlocks here, and registering after
    // acquire() returns never reaches this point at all.
    await waitForFile(join(probeDir, 'started.json'))
    await writeFile(join(probeDir, 'token-gate'), '', 'utf8')
    const marker = JSON.parse(
      await waitForFile(join(probeDir, 'registered.json')),
    ) as RegisteredMarker
    // Track the holder group before any assertion can abort the test, so afterEach always reaps it.
    cleanupGroups.add(marker.holderPgid)
    // The observer read the registry back after registering: this is proof the entry was durable
    // before acquisition control returned, not merely that a registration was attempted.
    expect(marker.registered).toBe(true)

    // The worker may already have failed itself through the ordering tripwire below; an ESRCH
    // here just means the interrupt was unnecessary, not that the round trip passed.
    try {
      process.kill(marker.workerPid, 'SIGINT')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    expect(await waitForExit(first, 10_000)).not.toBe(0)
    // Registration must complete before acquire() returns; the worker publishes a violation and
    // fails itself otherwise (a fire-and-forget observer trips exactly this).
    await expect(readFile(join(probeDir, 'ordering-violation.json'), 'utf8')).rejects.toThrow()
    expect(() => process.kill(-marker.holderPgid, 0)).not.toThrow()
    expect((await loadRegistry()).some((entry) => entry.holderPgid === marker.holderPgid)).toBe(
      true,
    )

    const second = startProbe(fixturePath, {
      LNA_REAPER_PROBE_PHASE: 'verify',
      LNA_REAPER_PROBE_HOLDER_PGID: String(marker.holderPgid),
    })
    expect(await waitForExit(second, 15_000)).toBe(0)
    expect(() => process.kill(-marker.holderPgid, 0)).toThrow()
    expect((await loadRegistry()).some((entry) => entry.holderPgid === marker.holderPgid)).toBe(
      false,
    )
  }, 60_000)

  it('an interrupt in the pre-registration window leaves no live unregistered holder', async () => {
    const fixturePath = join(
      REPO_ROOT,
      'packages/gpu-lease/test/fixtures/interrupt-holder.fixture.test.ts',
    )
    const probeDir = join(tmpdir(), `gpu-lease-interrupt-probe-${crypto.randomUUID()}`)
    await mkdir(probeDir, { recursive: true })
    const nonce = crypto.randomUUID()
    cleanupRoots.add(probeDir)
    cleanupRoots.add(join(tmpdir(), `gpu-lease-interrupt-holder-${nonce}`))
    cleanupRoots.add(join(tmpdir(), `gpu-lease-interrupt-scripts-${nonce}`))
    const first = startProbe(fixturePath, {
      LNA_REAPER_PROBE_PHASE: 'hold-pre',
      LNA_REAPER_PROBE_DIR: probeDir,
      LNA_REAPER_PROBE_NONCE: nonce,
    })

    // The worker has spawned the hostile flock subtree and published its pgid, but is blocked
    // before registerHolder: this is the pre-registration window itself. A genuine SIGINT to
    // the whole nested Vitest process group interrupts it there.
    const started = JSON.parse(await waitForFile(join(probeDir, 'started.json'))) as StartedMarker
    cleanupGroups.add(started.holderPgid)
    if (first.pid === undefined) throw new Error('nested Vitest did not expose a pid')
    process.kill(-first.pid, 'SIGINT')
    expect(await waitForExit(first, 15_000)).not.toBe(0)
    // The holder never saw the arming gate, so it was still benign: the worker's death EOF'd its
    // stdin and it exited like the production holder. Nothing hostile survives the window, so
    // nothing needs reaping and the registry carries no entry for it.
    await waitForGroupExit(started.holderPgid, 10_000)
    expect((await loadRegistry()).some((entry) => entry.holderPgid === started.holderPgid)).toBe(
      false,
    )
    expect(await reapOrphanedHolders()).toBe(0)
    expect(() => process.kill(-started.holderPgid, 0)).toThrow()
  }, 60_000)
})
