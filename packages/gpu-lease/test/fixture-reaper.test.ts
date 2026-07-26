import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FixtureHolderRegistry } from './fixture-reaper.js'

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
    inspectOwner,
  })
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

  it('serializes concurrent registrations and clears without losing another owner', async () => {
    const registry = await makeRegistry()
    const barrierPath = join(tmpdir(), `fixture-registry-barrier-${crypto.randomUUID()}`)
    roots.add(barrierPath)
    const writerPath = join(process.cwd(), 'packages/gpu-lease/test/fixtures/registry-writer.mjs')
    const moduleUrl = new URL('./fixture-reaper.ts', import.meta.url).href
    const writers = Array.from({ length: 16 }, () =>
      spawn(
        process.execPath,
        ['--experimental-strip-types', writerPath, moduleUrl, barrierPath, registry.registryPath],
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
    for (const writer of writers) writer.kill('SIGUSR1')
    await Promise.all(exited)
    expect(await registry.loadRegistry()).toHaveLength(0)
  }, 20_000)
})
