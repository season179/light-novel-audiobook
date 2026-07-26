// Durable ownership registry for deliberately hostile GPU-lease test fixtures.
//
// The registry is test infrastructure, but its safety boundary is production-shaped: only a
// holder recorded by its spawning worker may be signalled, and only after PID + process start time
// proves that exact worker instance is gone. All process-shared mutations use the package's existing
// kernel-flock coordinator and atomic replacement.

import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { FileGpuLeaseCoordinator, GpuLeaseError } from '../src/index.js'

export interface HolderRegistryEntry {
  readonly ownerPid: number
  /** `/proc/<pid>/stat` field 22, in kernel clock ticks. */
  readonly ownerStartTime: number
  readonly holderPgid: number
  readonly rootDir: string
}

interface RegistryDocument {
  readonly schema: 1
  readonly entries: readonly HolderRegistryEntry[]
}

export type OwnerState = 'alive' | 'dead' | 'unknown'

type OwnerInspector = (ownerPid: number, ownerStartTime: number) => Promise<OwnerState>

/**
 * The raw contents of `/proc/<pid>/stat`. This is the fault-injection boundary for owner
 * inspection: on a normal host `/proc/<pid>/stat` is world-readable and kernel-generated, so the
 * non-ENOENT and malformed-content outcomes are unreachable for real, and injecting at the
 * whole-inspector seam would leave the tri-state mapping itself untested.
 */
export type StatReader = (ownerPid: number) => Promise<string>

export interface FixtureHolderRegistryConfig {
  readonly registryPath: string
  /** Fault-injection seam used to prove unknown state fails closed. */
  readonly inspectOwner?: OwnerInspector
  /** Fault-injection seam at the `/proc` read boundary, so the tri-state mapping is tested. */
  readonly readStat?: StatReader
}

const REGISTRY_SCHEMA = 1
const REGISTRY_LOCK_WAIT_MS = 10_000
const REGISTRY_LOCK_RETRY_MS = 5
const HOLDER_EXIT_WAIT_MS = 2_000
const HOLDER_EXIT_POLL_MS = 10
const REGISTRY_DIR = resolve(tmpdir(), 'light-novel-audiobook-reaper')
export const REGISTRY_PATH = join(REGISTRY_DIR, 'gpu-lease-fixture-registry.json')

const delay = async (ms: number): Promise<void> =>
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms))

function isSafeProcessId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 1
}

function isSafeStartTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function parseRegistry(raw: string): RegistryDocument {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new Error('Fixture holder registry is invalid JSON', { cause: error })
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['entries', 'schema'])
  ) {
    throw new Error('Fixture holder registry document is invalid')
  }
  const document = value as { readonly schema?: unknown; readonly entries?: unknown }
  if (document.schema !== REGISTRY_SCHEMA || !Array.isArray(document.entries)) {
    throw new Error('Fixture holder registry schema is invalid')
  }

  const entries: HolderRegistryEntry[] = []
  const identities = new Set<string>()
  for (const candidate of document.entries) {
    if (
      candidate === null ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate) ||
      !exactKeys(candidate, ['holderPgid', 'ownerPid', 'ownerStartTime', 'rootDir'])
    ) {
      throw new Error('Fixture holder registry entry is invalid')
    }
    const entry = candidate as Record<string, unknown>
    if (
      !isSafeProcessId(entry.ownerPid) ||
      !isSafeStartTime(entry.ownerStartTime) ||
      !isSafeProcessId(entry.holderPgid) ||
      typeof entry.rootDir !== 'string' ||
      entry.rootDir.length === 0 ||
      !isAbsolute(entry.rootDir)
    ) {
      throw new Error('Fixture holder registry entry is invalid')
    }
    const identity = `${entry.ownerPid}:${entry.ownerStartTime}:${entry.holderPgid}`
    if (identities.has(identity)) throw new Error('Fixture holder registry has duplicate entries')
    identities.add(identity)
    entries.push({
      ownerPid: entry.ownerPid,
      ownerStartTime: entry.ownerStartTime,
      holderPgid: entry.holderPgid,
      rootDir: entry.rootDir,
    })
  }
  return { schema: REGISTRY_SCHEMA, entries }
}

const readProcStat: StatReader = async (ownerPid) =>
  await readFile(`/proc/${ownerPid}/stat`, 'utf8')

async function observeStartTime(
  pid: number,
  readStat: StatReader,
): Promise<
  | { readonly state: 'present'; readonly startTime: number }
  | { readonly state: 'absent' }
  | { readonly state: 'unknown' }
> {
  let raw: string
  try {
    raw = await readStat(pid)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'absent' }
      : { state: 'unknown' }
  }
  const closeParen = raw.lastIndexOf(')')
  if (closeParen < 0) return { state: 'unknown' }
  const fields = raw
    .slice(closeParen + 1)
    .trim()
    .split(/\s+/u)
  const startTime = Number(fields[19])
  return isSafeStartTime(startTime) ? { state: 'present', startTime } : { state: 'unknown' }
}

async function inspectOwner(
  ownerPid: number,
  ownerStartTime: number,
  readStat: StatReader,
): Promise<OwnerState> {
  const observation = await observeStartTime(ownerPid, readStat)
  if (observation.state === 'unknown') return 'unknown'
  if (observation.state === 'absent') return 'dead'
  return observation.startTime === ownerStartTime ? 'alive' : 'dead'
}

async function currentOwnerStartTime(): Promise<number> {
  const observation = await observeStartTime(process.pid, readProcStat)
  if (observation.state !== 'present') {
    throw new Error('Could not prove the fixture registry owner process identity')
  }
  return observation.startTime
}

async function waitForProcessGroupExit(groupId: number): Promise<void> {
  const deadline = performance.now() + HOLDER_EXIT_WAIT_MS
  for (;;) {
    try {
      process.kill(-groupId, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw new Error(`Could not prove fixture holder group ${groupId} exited`, { cause: error })
    }
    if (performance.now() >= deadline) {
      throw new Error(`Fixture holder group ${groupId} survived SIGKILL`)
    }
    await delay(HOLDER_EXIT_POLL_MS)
  }
}

/** Kernel ceiling for pids; an entry claiming a pid at or above it cannot describe a process. */
async function readPidMax(): Promise<number | undefined> {
  const raw = await readFile('/proc/sys/kernel/pid_max', 'utf8').catch(() => undefined)
  const value = Number(raw?.trim())
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** Directories a fixture may own: under the OS temp dir, or under this repository. */
function containedRoots(): readonly string[] {
  return [resolve(tmpdir()), process.cwd()]
}

/**
 * The reaper turns a registry value into SIGKILL and `rm -rf`, so shape-valid is not enough:
 * an entry whose root resolves outside every fixture root, or whose pids cannot exist, is
 * retained but never acted on. This bounds the blast radius of a wrong entry without changing
 * what happens to any entry a fixture actually wrote.
 */
function isContainedEntry(entry: HolderRegistryEntry, pidMax: number | undefined): boolean {
  const root = resolve(entry.rootDir)
  const contained = containedRoots().some(
    (base) => root === base || root.startsWith(`${base}${sep}`),
  )
  if (!contained) return false
  if (pidMax !== undefined && (entry.ownerPid >= pidMax || entry.holderPgid >= pidMax)) return false
  return true
}

export class FixtureHolderRegistry {
  readonly registryPath: string
  readonly #lockPath: string
  readonly #inspectOwner: OwnerInspector

  constructor(config: FixtureHolderRegistryConfig) {
    if (config.registryPath.length === 0 || !isAbsolute(config.registryPath)) {
      throw new Error('Fixture holder registry path must be absolute')
    }
    this.registryPath = resolve(config.registryPath)
    this.#lockPath = `${this.registryPath}.lock`
    this.#inspectOwner =
      config.inspectOwner ??
      ((ownerPid, ownerStartTime) =>
        inspectOwner(ownerPid, ownerStartTime, config.readStat ?? readProcStat))
  }

  async loadRegistry(): Promise<readonly HolderRegistryEntry[]> {
    try {
      return parseRegistry(await readFile(this.registryPath, 'utf8')).entries
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async registerHolder(holderPgid: number, rootDir: string): Promise<void> {
    if (!isSafeProcessId(holderPgid) || rootDir.length === 0 || !isAbsolute(rootDir)) {
      throw new Error('Fixture holder registration is invalid')
    }
    const ownerPid = process.pid
    const ownerStartTime = await currentOwnerStartTime()
    await this.#transaction(async (entries) => {
      const remaining = entries.filter(
        (entry) =>
          !(
            entry.ownerPid === ownerPid &&
            entry.ownerStartTime === ownerStartTime &&
            entry.holderPgid === holderPgid
          ),
      )
      remaining.push({ ownerPid, ownerStartTime, holderPgid, rootDir: resolve(rootDir) })
      return remaining
    })
  }

  async reapOrphanedHolders(): Promise<number> {
    let reaped = 0
    const pidMax = await readPidMax()
    await this.#transaction(async (entries) => {
      const retained: HolderRegistryEntry[] = []
      for (const entry of entries) {
        if (!isContainedEntry(entry, pidMax)) {
          retained.push(entry)
          continue
        }
        const state = await this.#inspectOwner(entry.ownerPid, entry.ownerStartTime)
        if (state !== 'dead') {
          retained.push(entry)
          continue
        }
        try {
          process.kill(-entry.holderPgid, 'SIGKILL')
          await waitForProcessGroupExit(entry.holderPgid)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
        await rm(entry.rootDir, { force: true, recursive: true }).catch(() => undefined)
        reaped += 1
      }
      return retained
    })
    return reaped
  }

  async clearOwnEntries(): Promise<void> {
    const ownerPid = process.pid
    const ownerStartTime = await currentOwnerStartTime()
    await this.#transaction(async (entries) =>
      entries.filter(
        (entry) => !(entry.ownerPid === ownerPid && entry.ownerStartTime === ownerStartTime),
      ),
    )
  }

  async #transaction(
    update: (entries: readonly HolderRegistryEntry[]) => Promise<readonly HolderRegistryEntry[]>,
  ): Promise<void> {
    const lease = await this.#acquireRegistryLock()
    try {
      const updated = await update(await this.loadRegistry())
      await this.#saveRegistry(updated)
    } finally {
      await lease.release()
    }
  }

  async #acquireRegistryLock() {
    const deadline = performance.now() + REGISTRY_LOCK_WAIT_MS
    for (;;) {
      try {
        return await new FileGpuLeaseCoordinator({
          lockFilePath: this.#lockPath,
          inspectExistingComputeProcesses: false,
        }).acquire('composition')
      } catch (error) {
        if (!(error instanceof GpuLeaseError) || error.code !== 'busy') throw error
        if (performance.now() >= deadline) {
          throw new Error(`Timed out waiting for fixture registry lock: ${this.#lockPath}`, {
            cause: error,
          })
        }
        await delay(REGISTRY_LOCK_RETRY_MS)
      }
    }
  }

  async #saveRegistry(entries: readonly HolderRegistryEntry[]): Promise<void> {
    await mkdir(dirname(this.registryPath), { recursive: true, mode: 0o700 })
    if (entries.length === 0) {
      await rm(this.registryPath, { force: true })
      return
    }
    const temporaryPath = `${this.registryPath}.${process.pid}.${crypto.randomUUID()}.tmp`
    let file: Awaited<ReturnType<typeof open>> | undefined
    try {
      file = await open(temporaryPath, 'wx', 0o600)
      await file.writeFile(
        `${JSON.stringify({ schema: REGISTRY_SCHEMA, entries } satisfies RegistryDocument)}\n`,
        'utf8',
      )
      await file.sync()
      await file.close()
      file = undefined
      await rename(temporaryPath, this.registryPath)
      const directory = await open(dirname(this.registryPath), 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } finally {
      await file?.close()
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }
}

const defaultRegistry = new FixtureHolderRegistry({ registryPath: REGISTRY_PATH })

export async function loadRegistry(): Promise<readonly HolderRegistryEntry[]> {
  return await defaultRegistry.loadRegistry()
}

export async function registerHolder(holderPgid: number, rootDir: string): Promise<void> {
  await defaultRegistry.registerHolder(holderPgid, rootDir)
}

export async function reapOrphanedHolders(): Promise<number> {
  return await defaultRegistry.reapOrphanedHolders()
}

export async function clearOwnEntries(): Promise<void> {
  await defaultRegistry.clearOwnEntries()
}
