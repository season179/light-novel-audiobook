// GPU lease test fixture reaper: a durable per-run registry that survives interruption.
//
// When a vitest worker is killed by SIGINT (Ctrl-C), afterEach never runs, and the deliberately
// unkillable fixture holders (SIGTERM-immune, EOF-immune, nested) survive as orphans. This module
// provides the ownership layer that makes a later run safe to reap them:
//
// 1. A per-run registry file records the owner PID and its **process start time** (PIDs recycle).
// 2. Each fixture holder PGID spawned during the run is recorded alongside it.
// 3. On the next run's startup, every registry entry whose owner (PID + start time) is provably
//    dead is reaped; live owners are left untouched, so concurrent runs never kill each other's
//    fixtures.
//
// The registry lives in a stable directory (not a temp dir that gets cleaned): XDG runtime or
// /tmp with a fixed name. It is a JSON array of entries, each self-describing.

import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { kill } from 'node:process'

export interface HolderRegistryEntry {
  /** Owner PID at the time the holder was spawned. */
  readonly ownerPid: number
  /** Owner process start time in clock ticks (/proc/<pid>/stat field 22). PIDs recycle. */
  readonly ownerStartTime: number
  /** Process-group ID of the holder to reap. */
  readonly holderPgid: number
  /** Temp directory root the holder was running from. */
  readonly rootDir: string
}

const REGISTRY_DIR = resolve(tmpdir(), 'light-novel-audiobook-reaper')
export const REGISTRY_PATH = join(REGISTRY_DIR, 'gpu-lease-fixture-registry.json')

async function ensureRegistryDir(): Promise<void> {
  await mkdir(REGISTRY_DIR, { recursive: true, mode: 0o700 })
}

/** Reads the current owner's start time from /proc, or returns null if the PID is gone/recycled. */
async function readStartTime(pid: number): Promise<number | null> {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8')
    const fields = raw
      .slice(raw.lastIndexOf(')') + 1)
      .trim()
      .split(/\s+/u)
    return Number(fields[19]) // field 22 in /proc/pid/stat (1-indexed), 0-indexed [19]
  } catch {
    return null
  }
}

/** True only if this exact process instance (PID + start time) is provably gone. */
export async function isOwnerDead(ownerPid: number, ownerStartTime: number): Promise<boolean> {
  const startTime = await readStartTime(ownerPid)
  if (startTime === null) return true // PID does not exist.
  // PID exists, but if its start time differs the original has exited and the PID was recycled.
  return startTime !== ownerStartTime
}

export async function loadRegistry(): Promise<readonly HolderRegistryEntry[]> {
  try {
    const data = await readFile(REGISTRY_PATH, 'utf8')
    return JSON.parse(data) as HolderRegistryEntry[]
  } catch {
    return []
  }
}

async function saveRegistry(entries: readonly HolderRegistryEntry[]): Promise<void> {
  await ensureRegistryDir()
  await writeFile(REGISTRY_PATH, JSON.stringify(entries, null, 2), 'utf8')
}

/**
 * Registers a holder PGID for the current process. Called when a fixture holder is spawned.
 */
export async function registerHolder(holderPgid: number, rootDir: string): Promise<void> {
  const ownerPid = process.pid
  const ownerStartTime = await readStartTime(ownerPid)
  if (ownerStartTime === null) return // Cannot prove ownership; skip registration.
  const entries = await loadRegistry()
  // Remove stale entries for this owner to avoid duplicates.
  const filtered = entries.filter(
    (e) => !(e.ownerPid === ownerPid && e.ownerStartTime === ownerStartTime),
  )
  filtered.push({ ownerPid, ownerStartTime, holderPgid, rootDir })
  await saveRegistry(filtered)
}

/**
 * Reaps every registered holder whose owner is provably dead, and removes those entries.
 * Live owners (same PID + start time, still running) are left untouched. Returns the number
 * of holders reaped. Safe to call at the start of any run — concurrent live runs are immune.
 */
export async function reapOrphanedHolders(): Promise<number> {
  const entries = await loadRegistry()
  if (entries.length === 0) return 0
  const alive: HolderRegistryEntry[] = []
  let reaped = 0
  for (const entry of entries) {
    if (await isOwnerDead(entry.ownerPid, entry.ownerStartTime)) {
      try {
        kill(-entry.holderPgid, 'SIGKILL')
      } catch {
        // Already gone.
      }
      // Clean up the temp directory if it still exists.
      await rm(entry.rootDir, { force: true, recursive: true }).catch(() => undefined)
      reaped += 1
    } else {
      alive.push(entry)
    }
  }
  if (reaped > 0) await saveRegistry(alive)
  return reaped
}

/**
 * Clears the current run's own entries from the registry. Called in afterEach when the normal
 * cleanup (afterEach reap) has handled the holders in-process. This prevents the registry from
 * growing unboundedly with entries that afterEach already reaped.
 */
export async function clearOwnEntries(): Promise<void> {
  const ownerPid = process.pid
  const ownerStartTime = await readStartTime(ownerPid)
  if (ownerStartTime === null) return
  const entries = await loadRegistry()
  const remaining = entries.filter(
    (e) => !(e.ownerPid === ownerPid && e.ownerStartTime === ownerStartTime),
  )
  if (remaining.length === 0) {
    await unlink(REGISTRY_PATH).catch(() => undefined)
  } else {
    await saveRegistry(remaining)
  }
}
