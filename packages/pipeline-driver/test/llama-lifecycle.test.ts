import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { NarrationEchoDirectorServer } from '../src/fake-director-server.js'
import { OwnedLlamaLifecycle } from '../src/llama-lifecycle.js'

const STUB = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/stub-llama-server.mjs',
)

const directories: string[] = []
const servers: NarrationEchoDirectorServer[] = []
const lifecycles: OwnedLlamaLifecycle[] = []

afterEach(async () => {
  // Never leave an owned process behind, even when an assertion fails mid-test.
  for (const lifecycle of lifecycles.splice(0)) await lifecycle.release().catch(() => undefined)
  for (const server of servers.splice(0)) await server.stop()
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function scratch(label: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), `owned-llama-${label}-`))
  directories.push(directory)
  return directory
}

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

/** A kernel probe, independent of the lifecycle's own bookkeeping. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    // EPERM means it exists but is not ours; that still counts as alive.
    return true
  }
}

async function portIsFree(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => {
      probe.close((error) => resolve(error === undefined))
    })
  })
}

async function upstream(): Promise<NarrationEchoDirectorServer> {
  const server = new NarrationEchoDirectorServer()
  servers.push(server)
  await server.start()
  return server
}

async function lifecycleOver(
  options: { readonly extraArgs?: readonly string[] } = {},
): Promise<{ lifecycle: OwnedLlamaLifecycle; port: number; keyPath: string; origin: string }> {
  const runtimeRoot = await scratch('runtime')
  const echo = await upstream()
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const keyPath = path.join(runtimeRoot, 'api-key')
  const lifecycle = new OwnedLlamaLifecycle({
    binaryPath: process.execPath,
    args: [STUB, String(port), echo.baseUrl, ...(options.extraArgs ?? [])],
    apiKey: 'owned-lifecycle-test-key',
    keyPath,
    origin,
    port,
    startupTimeoutMs: 30_000,
    terminateTimeoutMs: 2_000,
    killTimeoutMs: 5_000,
  })
  lifecycles.push(lifecycle)
  return { lifecycle, port, keyPath, origin }
}

describe('OwnedLlamaLifecycle', () => {
  it('spawns a real serving process on start and reaps it before release resolves', async () => {
    const { lifecycle, port, keyPath, origin } = await lifecycleOver()

    expect(lifecycle.running).toBe(false)
    expect(lifecycle.processId).toBeUndefined()

    await lifecycle.start()

    const pid = lifecycle.processId
    if (pid === undefined) throw new Error('owned lifecycle reported no process ID after start')
    // Actual process state, not a recorded string.
    expect(processAlive(pid)).toBe(true)
    expect(lifecycle.running).toBe(true)
    expect(await portIsFree(port)).toBe(false)
    expect((await fetch(`${origin}/health`)).ok).toBe(true)
    // The API key reached the server by file at 0600, never through argv.
    expect(await readFile(keyPath, 'utf8')).toBe('owned-lifecycle-test-key\n')
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600)

    await lifecycle.release()

    // The contract release() must honour: by the time it resolves, the GPU-resident process is gone
    // and its port is free. This is what makes handing the lease to Qwen safe.
    expect(processAlive(pid)).toBe(false)
    expect(lifecycle.running).toBe(false)
    expect(lifecycle.cleanupComplete).toBe(true)
    expect(await portIsFree(port)).toBe(true)
    await expect(stat(keyPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      fetch(`${origin}/health`, { signal: AbortSignal.timeout(2_000) }),
    ).rejects.toThrow()
  }, 60_000)

  it('escalates to SIGKILL when the owned process ignores SIGTERM', async () => {
    const { lifecycle, port } = await lifecycleOver({ extraArgs: ['--ignore-sigterm'] })
    await lifecycle.start()
    const pid = lifecycle.processId
    if (pid === undefined) throw new Error('owned lifecycle reported no process ID after start')

    await lifecycle.release()

    // A wedged server must not be able to keep the model resident past release().
    expect(processAlive(pid)).toBe(false)
    expect(await portIsFree(port)).toBe(true)
  }, 60_000)

  it('is idempotent: repeated start spawns once and repeated release reaps once', async () => {
    const { lifecycle } = await lifecycleOver()
    await Promise.all([lifecycle.start(), lifecycle.start()])
    const pid = lifecycle.processId
    if (pid === undefined) throw new Error('owned lifecycle reported no process ID after start')
    await lifecycle.start()
    expect(lifecycle.processId).toBe(pid)

    await Promise.all([lifecycle.release(), lifecycle.release()])
    await lifecycle.release()
    expect(processAlive(pid)).toBe(false)
  }, 60_000)

  it('release without start is safe, so a failed start cannot strand the lease', async () => {
    const { lifecycle } = await lifecycleOver()
    await expect(lifecycle.release()).resolves.toBeUndefined()
    expect(lifecycle.cleanupComplete).toBe(true)
  }, 30_000)
})
