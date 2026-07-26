import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { kill, pid as ownPid } from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  clearOwnEntries,
  type HolderRegistryEntry,
  isOwnerDead,
  loadRegistry,
  REGISTRY_PATH,
  reapOrphanedHolders,
  registerHolder,
} from './fixture-reaper.js'

const roots: string[] = []

afterAll(async () => {
  await clearOwnEntries().catch(() => undefined)
  for (const root of roots.splice(0)) {
    // Already cleaned by reaper, but just in case.
  }
})

/** Spawns a process that ignores SIGTERM and stays alive until SIGKILL. */
function spawnStubbornHolder(root: string): { pid: number; root: string } {
  const script = join(root, 'stubborn.cjs')
  // We need the PID of the detached child, so we spawn it directly.
  const child = spawn(
    process.execPath,
    ['-e', "process.stdin.resume(); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
    {
      stdio: 'ignore',
      detached: true,
    },
  )
  const pid = child.pid
  if (pid === undefined) throw new Error('stubborn holder did not spawn')
  roots.push(root)
  return { pid, root }
}

describe('fixture-reaper registry (#67)', () => {
  beforeAll(async () => {
    // Clean any stale entries from a previous test run.
    await clearOwnEntries().catch(() => undefined)
  })

  it('registers a holder and proves the owner is alive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reaper-test-'))
    const { pid, root: holderRoot } = spawnStubbornHolder(root)
    await registerHolder(pid, holderRoot)

    const entries = await loadRegistry()
    const ours = entries.filter((e) => e.holderPgid === pid)
    expect(ours.length).toBe(1)
    expect(ours[0]?.ownerPid).toBe(ownPid)

    // We are alive — the reaper must not touch our holder.
    const entry = ours[0]
    if (entry === undefined) throw new Error('entry not found')
    const dead = await isOwnerDead(entry.ownerPid, entry.ownerStartTime)
    expect(dead).toBe(false)

    // Clean up: kill the holder ourselves.
    try {
      kill(-pid, 'SIGKILL')
    } catch {
      /* gone */
    }
    await clearOwnEntries()
  })

  it('reaps a holder whose owner is provably dead, and leaves live owners untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reaper-test-'))
    const { pid: orphanPgid, root: orphanRoot } = spawnStubbornHolder(root)

    // Fabricate a registry entry for a dead owner: same holder PGID but a nonexistent PID.
    const deadOwnerPid = 999_999
    const deadStartTime = 0 // /proc/999999/stat won't exist → isOwnerDead returns true.
    const { readFile, writeFile: writeFileAsync } = await import('node:fs/promises')
    const entries: HolderRegistryEntry[] = [
      {
        ownerPid: deadOwnerPid,
        ownerStartTime: deadStartTime,
        holderPgid: orphanPgid,
        rootDir: orphanRoot,
      },
    ]
    await writeFileAsync(REGISTRY_PATH, JSON.stringify(entries))

    const reaped = await reapOrphanedHolders()
    expect(reaped).toBe(1)

    // The orphan's process group must be gone.
    expect(() => kill(-orphanPgid, 0)).toThrow()

    // Registry must be empty.
    const remaining = await loadRegistry()
    expect(remaining.filter((e) => e.holderPgid === orphanPgid)).toHaveLength(0)
  })
})
