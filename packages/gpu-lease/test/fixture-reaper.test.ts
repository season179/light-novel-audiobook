import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FixtureHolderRegistry, type StatReader } from './fixture-reaper.js'

const children: ChildProcess[] = []
const groups = new Set<number>()
const roots = new Set<string>()

const delay = async (ms: number): Promise<void> =>
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms))

async function makeRegistry(inspectOwner?: () => Promise<'alive' | 'dead' | 'unknown'>) {
  const root = await mkdtemp(join(tmpdir(), 'fixture-registry-test-'))
  roots.add(root)
  return new FixtureHolderRegistry({
    registryPath: join(root, 'registry.json'),
    ...(inspectOwner === undefined ? {} : { inspectOwner }),
  })
}

async function makeRegistryWithReadStat(readStat: StatReader) {
  const root = await mkdtemp(join(tmpdir(), 'fixture-registry-test-'))
  roots.add(root)
  return new FixtureHolderRegistry({ registryPath: join(root, 'registry.json'), readStat })
}

async function spawnStubbornHolder(): Promise<number> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      "process.stdin.resume(); process.on('SIGTERM',()=>{}); process.on('SIGHUP',()=>{}); setInterval(()=>{},1000)",
    ],
    { stdio: 'ignore', detached: true },
  )
  children.push(child)
  const pid = child.pid
  if (pid === undefined) throw new Error('stubborn holder did not spawn')
  groups.add(pid)
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      process.kill(-pid, 0)
      return pid
    } catch {
      await delay(5)
    }
  }
  throw new Error('stubborn holder process group did not start')
}

async function waitForGroupExit(pgid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      process.kill(-pgid, 0)
      await delay(5)
    } catch {
      return
    }
  }
  throw new Error(`process group ${pgid} survived cleanup`)
}

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  for (const pgid of groups) {
    try {
      process.kill(-pgid, 'SIGKILL')
    } catch {
      // Gone.
    }
  }
  groups.clear()
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

describe('owner inspection maps real /proc outcomes to the tri-state (#67)', () => {
  const statWith = (startTime: number): string => {
    const fields = Array.from({ length: 25 }, (_, index) =>
      index === 19 ? String(startTime) : '0',
    )
    return `123 (node) ${fields.join(' ')}\n`
  }

  const ownStartTime = async (): Promise<number> => {
    const raw = await readFile('/proc/self/stat', 'utf8')
    return Number(
      raw
        .slice(raw.lastIndexOf(')') + 1)
        .trim()
        .split(/\s+/u)[19],
    )
  }

  const failingReader =
    (code: string): StatReader =>
    async () => {
      throw Object.assign(new Error(`injected ${code}`), { code })
    }

  it('maps a vanished /proc entry (ENOENT) to dead and reaps', async () => {
    const registry = await makeRegistryWithReadStat(failingReader('ENOENT'))
    await registry.registerHolder(720_001, join(tmpdir(), 'fixture-seam-holder'))

    expect(await registry.reapOrphanedHolders()).toBe(1)
    expect(await registry.loadRegistry()).toHaveLength(0)
  })

  it('maps any other /proc failure to unknown and retains', async () => {
    const registry = await makeRegistryWithReadStat(failingReader('EACCES'))
    await registry.registerHolder(720_002, join(tmpdir(), 'fixture-seam-holder'))

    expect(await registry.reapOrphanedHolders()).toBe(0)
    expect(await registry.loadRegistry()).toHaveLength(1)
  })

  it('maps stat content without a closing paren to unknown and retains', async () => {
    const registry = await makeRegistryWithReadStat(async () => 'no closing paren here\n')
    await registry.registerHolder(720_003, join(tmpdir(), 'fixture-seam-holder'))

    expect(await registry.reapOrphanedHolders()).toBe(0)
    expect(await registry.loadRegistry()).toHaveLength(1)
  })

  it('maps a truncated field list to unknown and retains', async () => {
    const registry = await makeRegistryWithReadStat(async () => '123 (node) 0 0 0\n')
    await registry.registerHolder(720_004, join(tmpdir(), 'fixture-seam-holder'))

    expect(await registry.reapOrphanedHolders()).toBe(0)
    expect(await registry.loadRegistry()).toHaveLength(1)
  })

  it('maps a start-time mismatch to dead and reaps', async () => {
    const registry = await makeRegistryWithReadStat(async () =>
      statWith((await ownStartTime()) + 1_000),
    )
    await registry.registerHolder(720_005, join(tmpdir(), 'fixture-seam-holder'))

    expect(await registry.reapOrphanedHolders()).toBe(1)
    expect(await registry.loadRegistry()).toHaveLength(0)
  })

  it('maps a matching start time to alive and retains', async () => {
    const registry = await makeRegistryWithReadStat(async () => statWith(await ownStartTime()))
    await registry.registerHolder(720_006, join(tmpdir(), 'fixture-seam-holder'))

    expect(await registry.reapOrphanedHolders()).toBe(0)
    expect(await registry.loadRegistry()).toHaveLength(1)
  })
})

describe('reaper containment (#67)', () => {
  it('never signals or deletes what a shape-valid decoy entry claims outside fixture roots', async () => {
    const registry = await makeRegistry(async () => 'dead')
    const decoyPgid = await spawnStubbornHolder()
    // Outside both tmpdir() and the repository: no fixture root can resolve here.
    const decoyRoot = await mkdtemp(join('/dev/shm', 'lna-reaper-decoy-'))
    roots.add(decoyRoot)
    await writeFile(
      registry.registryPath,
      JSON.stringify({
        schema: 1,
        entries: [
          {
            ownerPid: 2,
            ownerStartTime: 1,
            holderPgid: decoyPgid,
            rootDir: decoyRoot,
          },
          {
            ownerPid: 2,
            ownerStartTime: 1,
            // Above any kernel pid_max: cannot describe a process group at all.
            holderPgid: 4_500_000,
            rootDir: join(tmpdir(), 'lna-reaper-decoy-pid'),
          },
        ],
      }),
    )

    expect(await registry.reapOrphanedHolders()).toBe(0)
    expect(() => process.kill(-decoyPgid, 0)).not.toThrow()
    expect((await stat(decoyRoot)).isDirectory()).toBe(true)
    expect(await registry.loadRegistry()).toHaveLength(2)
  })
})

describe('fixture holder registry (#67)', () => {
  it('preserves every holder for one owner and deduplicates only the same holder', async () => {
    const registry = await makeRegistry()
    await registry.registerHolder(700_001, '/tmp/fixture-holder-a')
    await registry.registerHolder(700_002, '/tmp/fixture-holder-b')
    await registry.registerHolder(700_001, '/tmp/fixture-holder-a')

    const ownEntries = (await registry.loadRegistry()).filter(
      (entry) => entry.ownerPid === process.pid,
    )
    expect(ownEntries.map((entry) => entry.holderPgid).sort()).toEqual([700_001, 700_002])
  })

  it('runs the reaper against a live owner and leaves its hostile holder untouched', async () => {
    const registry = await makeRegistry()
    const holderPgid = await spawnStubbornHolder()
    await registry.registerHolder(holderPgid, '/tmp/fixture-live-holder')

    expect(await registry.reapOrphanedHolders()).toBe(0)
    expect(() => process.kill(-holderPgid, 0)).not.toThrow()
    expect((await registry.loadRegistry()).some((entry) => entry.holderPgid === holderPgid)).toBe(
      true,
    )
  })

  it('reaps a hostile holder only when its owner is proven dead', async () => {
    const registry = await makeRegistry(async () => 'dead')
    const holderPgid = await spawnStubbornHolder()
    await registry.registerHolder(holderPgid, '/tmp/fixture-dead-holder')

    expect(await registry.reapOrphanedHolders()).toBe(1)
    await waitForGroupExit(holderPgid)
    expect(await registry.loadRegistry()).toHaveLength(0)
  })

  it('fails closed when owner state is unknown', async () => {
    const registry = await makeRegistry(async () => 'unknown')
    const holderPgid = await spawnStubbornHolder()
    await registry.registerHolder(holderPgid, '/tmp/fixture-unknown-holder')

    expect(await registry.reapOrphanedHolders()).toBe(0)
    expect(() => process.kill(-holderPgid, 0)).not.toThrow()
    expect((await registry.loadRegistry()).some((entry) => entry.holderPgid === holderPgid)).toBe(
      true,
    )
  })

  it('rejects malformed registry data without signaling its claimed group', async () => {
    const registry = await makeRegistry()
    const registryPath = registry.registryPath
    await writeFile(
      registryPath,
      JSON.stringify({
        schema: 1,
        entries: [
          {
            ownerPid: process.pid,
            ownerStartTime: 'not-a-start-time',
            holderPgid: process.pid,
            rootDir: '/tmp',
          },
        ],
      }),
    )

    await expect(registry.loadRegistry()).rejects.toThrow('invalid')
    await expect(registry.reapOrphanedHolders()).rejects.toThrow('invalid')
  })

  it('publishes only complete schema-valid snapshots to lock-free readers', async () => {
    const registry = await makeRegistry()
    const readFailures: unknown[] = []
    const snapshotSizes: number[] = []
    let keepReading = true
    const reader = (async () => {
      while (keepReading) {
        try {
          snapshotSizes.push((await registry.loadRegistry()).length)
        } catch (error) {
          readFailures.push(error)
        }
        await new Promise<void>((resolveTurn) => setImmediate(resolveTurn))
      }
    })()

    try {
      await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          registry.registerHolder(
            710_000 + index,
            `/${'atomic-registry-payload-'.repeat(4_000)}${index}`,
          ),
        ),
      )
    } finally {
      keepReading = false
      await reader
    }

    expect(readFailures).toEqual([])
    expect(
      snapshotSizes.every((size, index) => {
        const previous = snapshotSizes[index - 1]
        return previous === undefined || size >= previous
      }),
    ).toBe(true)
    expect(await registry.loadRegistry()).toHaveLength(12)
  }, 30_000)

  it('serializes concurrent registrations and clears without losing another owner', async () => {
    const registry = await makeRegistry()
    const barrierPath = join(tmpdir(), `fixture-registry-barrier-${crypto.randomUUID()}`)
    roots.add(barrierPath)
    const writerPath = join(process.cwd(), 'packages/gpu-lease/test/fixtures/registry-writer.mjs')
    const moduleUrl = new URL('./fixture-reaper.ts', import.meta.url).href
    const writers = Array.from({ length: 8 }, () =>
      spawn(
        process.execPath,
        [
          join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
          writerPath,
          moduleUrl,
          barrierPath,
          registry.registryPath,
        ],
        { stdio: ['ignore', 'pipe', 'ignore'], detached: true },
      ),
    )
    children.push(...writers)
    for (const writer of writers) if (writer.pid !== undefined) groups.add(writer.pid)
    const registered = writers.map(
      (writer) =>
        new Promise<void>((resolveRegistered, rejectRegistered) => {
          writer.stdout?.setEncoding('utf8')
          writer.stdout?.once('data', () => resolveRegistered())
          writer.once('exit', (code) => rejectRegistered(new Error(`writer exited ${code}`)))
        }),
    )
    await writeFile(barrierPath, '')
    await Promise.all(registered)

    expect(await registry.loadRegistry()).toHaveLength(writers.length)

    const exited = writers.map(
      (writer) => new Promise<void>((resolveExit) => writer.once('exit', () => resolveExit())),
    )
    for (const writer of writers) {
      if (writer.pid !== undefined) process.kill(-writer.pid, 'SIGUSR1')
    }
    await Promise.all(exited)
    expect(await registry.loadRegistry()).toHaveLength(0)
  }, 60_000)
})
