import { type ChildProcess, spawn } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadRegistry, reapOrphanedHolders } from './fixture-reaper.js'

interface InterruptMarker {
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

async function waitForMarker(path: string): Promise<InterruptMarker> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const raw = await readFile(path, 'utf8').catch(() => undefined)
    if (raw !== undefined) return JSON.parse(raw) as InterruptMarker
    await delay(50)
  }
  throw new Error('interrupt holder did not publish its marker')
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
  await reapOrphanedHolders().catch(() => undefined)
  await Promise.all([...cleanupRoots].map((root) => rm(root, { recursive: true, force: true })))
  cleanupRoots.clear()
})

describe('interrupt fixture reaper round trip (#67)', () => {
  it('registers before worker SIGINT and the next suite startup reaps that exact holder', async () => {
    const fixturePath = join(
      process.cwd(),
      'packages/gpu-lease/test/fixtures/interrupt-holder.fixture.test.ts',
    )
    const markerPath = join(tmpdir(), `gpu-lease-interrupt-marker-${crypto.randomUUID()}.json`)
    cleanupRoots.add(markerPath)
    const first = startProbe(fixturePath, {
      LNA_REAPER_PROBE_PHASE: 'hold',
      LNA_REAPER_PROBE_MARKER: markerPath,
    })
    const marker = await waitForMarker(markerPath)
    cleanupGroups.add(marker.holderPgid)
    cleanupRoots.add(marker.root)
    cleanupRoots.add(marker.scriptsRoot)

    process.kill(marker.workerPid, 'SIGINT')
    expect(await waitForExit(first, 10_000)).not.toBe(0)
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
  }, 30_000)
})
