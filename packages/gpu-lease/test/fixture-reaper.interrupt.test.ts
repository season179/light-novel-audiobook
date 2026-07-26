import { type ChildProcess, spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadRegistry, reapOrphanedHolders } from './fixture-reaper.js'

interface RegisteredMarker {
  readonly workerPid: number
  readonly holderPgid: number
  readonly root: string
  readonly scriptsRoot: string
  readonly registered: boolean
  readonly registeredAt: number
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

function startProbe(
  fixturePath: string,
  environment: Readonly<Record<string, string>>,
): ChildProcess {
  const child = spawn(
    process.execPath,
    [join(process.cwd(), 'node_modules/vitest/vitest.mjs'), 'run', fixturePath],
    {
      cwd: process.cwd(),
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
      process.cwd(),
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
    // The observer read the registry back after registering: this is proof the entry was durable
    // before acquisition control returned, not merely that a registration was attempted.
    expect(marker.registered).toBe(true)
    cleanupGroups.add(marker.holderPgid)

    process.kill(marker.workerPid, 'SIGINT')
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
})
