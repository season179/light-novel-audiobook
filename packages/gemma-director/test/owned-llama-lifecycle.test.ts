import { type Mode, mkdtempSync, type PathLike, rmSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OwnedLlamaLifecycle } from '../src/owned-llama-lifecycle.js'

const chmodGate = vi.hoisted(() => {
  let armedPath: string | undefined
  let announceReached: (() => void) | undefined
  let openBarrier: (() => void) | undefined
  let opened: Promise<void> | undefined
  return {
    arm(keyPath: string): { readonly reached: Promise<void>; readonly open: () => void } {
      armedPath = keyPath
      const reached = new Promise<void>((resolve) => {
        announceReached = resolve
      })
      opened = new Promise<void>((resolve) => {
        openBarrier = resolve
      })
      return { reached, open: () => openBarrier?.() }
    },
    disarm(): void {
      openBarrier?.()
      armedPath = undefined
      announceReached = undefined
      openBarrier = undefined
      opened = undefined
    },
    async waitIfArmed(candidate: string): Promise<void> {
      if (armedPath === undefined || candidate !== armedPath) return
      announceReached?.()
      await opened
    },
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    chmod: async (target: PathLike, mode: Mode): Promise<void> => {
      await chmodGate.waitIfArmed(String(target))
      await actual.chmod(target, mode)
    },
  }
})

// Regression (issue #53 round 4, second window): the concrete lifecycle's release() could return
// while a concurrent startOnce() was still unresolved — pre-spawn it observed no child at all, and
// even with a child it killed and returned while start() was still heading for healthy. The
// invariant is the adapter's: startup settles and the runtime exits before anyone frees the GPU.
//
// No GPU, no model: the "runtime" is a bare node child that stays alive, and /health is a fake
// HTTP server that — like a real llama-server — only answers healthy while the child is alive.
// The distinguishing signal is the OUTCOME of start(): pre-fix, release() kills the child
// mid-startup and start() rejects ('exited during model load'); post-fix, release() lets startup
// settle first and start() resolves.

const API_KEY = 'fake-lifecycle-key-00000001'

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolveListen) => probe.listen(0, '127.0.0.1', resolveListen))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolveClose, rejectClose) =>
    probe.close((error) => (error === undefined ? resolveClose() : rejectClose(error))),
  )
  return port
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('OwnedLlamaLifecycle', () => {
  const roots: string[] = []
  let server: Server | undefined
  afterEach(async () => {
    chmodGate.disarm()
    if (server !== undefined) await new Promise<void>((done) => server?.close(() => done()))
    server = undefined
    for (const root of roots) rmSync(root, { recursive: true, force: true })
    roots.length = 0
  })

  it('a release racing an in-flight start waits for startup to settle, then unloads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lna-lifecycle-'))
    roots.push(root)

    // Healthy 300 ms out, and only while the child is actually alive — a dead llama-server stops
    // answering, which is exactly what waitForHealth must observe.
    let childPid: number | undefined
    const serverStarted = performance.now()
    server = createServer((request, response) => {
      if (request.url !== '/health') {
        response.writeHead(404)
        response.end()
        return
      }
      const respond = (): void => {
        const healthy = childPid !== undefined && isAlive(childPid)
        response.writeHead(healthy ? 200 : 500, { 'content-type': 'application/json' })
        response.end('{"status":"ok"}')
        setTimeout(() => server?.close(), 25)
      }
      const remaining = 300 - (performance.now() - serverStarted)
      if (remaining <= 0) respond()
      else setTimeout(respond, remaining)
    })
    await new Promise<void>((resolveListen) => server?.listen(0, '127.0.0.1', resolveListen))
    const address = server.address() as AddressInfo

    const lifecycle = new OwnedLlamaLifecycle({
      binaryPath: process.execPath,
      // A long-lived child with no GPU and no model: stands in for llama-server loading weights.
      args: ['-e', 'setInterval(() => undefined, 1000)'],
      apiKey: API_KEY,
      keyPath: join(root, 'llama.key'),
      origin: `http://127.0.0.1:${address.port}`,
      port: address.port,
      startupTimeoutMs: 10_000,
    })

    const started = performance.now()
    const startPromise = lifecycle.start()
    while (lifecycle.processId === undefined) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5))
    }
    childPid = lifecycle.processId

    // Race: release lands 50 ms into a 300 ms startup — mid health-wait, before settlement.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
    const releasePromise = lifecycle.release()

    // Release reaps first so health polling settles promptly by rejecting; a failed start still
    // counts as settled, and release does not resolve until both startup and the child are gone.
    await expect(startPromise).rejects.toThrow('exited during model load')
    await releasePromise

    expect(performance.now() - started).toBeGreaterThanOrEqual(250)
    expect(lifecycle.cleanupComplete).toBe(true)
    // The child really is dead: signalling its pid must fail with ESRCH.
    expect(childPid).toBeDefined()
    expect(isAlive(childPid as number)).toBe(false)
  }, 20_000)

  it('blocks a pre-spawn release, then permanently prohibits the pending spawn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lna-lifecycle-prespawn-'))
    roots.push(root)
    const keyPath = join(root, 'llama.key')
    const port = await freePort()
    const barrier = chmodGate.arm(keyPath)
    const lifecycle = new OwnedLlamaLifecycle({
      binaryPath: process.execPath,
      args: ['-e', 'setInterval(() => undefined, 1000)'],
      apiKey: API_KEY,
      keyPath,
      origin: `http://127.0.0.1:${port}`,
      port,
      startupTimeoutMs: 10_000,
      startupSettleTimeoutMs: 2_000,
    })

    let startSettled = false
    const start = lifecycle.start().then(
      () => {
        startSettled = true
        return 'resolved' as const
      },
      () => {
        startSettled = true
        return 'rejected' as const
      },
    )
    await barrier.reached
    expect((await stat(keyPath)).isFile()).toBe(true)
    expect(lifecycle.processId).toBeUndefined()

    const released = lifecycle.release().then(() => 'released' as const)
    expect(
      await Promise.race([
        released,
        new Promise<'blocked'>((resolveBlocked) => setTimeout(() => resolveBlocked('blocked'), 50)),
      ]),
    ).toBe('blocked')
    expect(startSettled).toBe(false)

    barrier.open()
    await expect(released).resolves.toBe('released')
    await expect(start).resolves.toBe('rejected')
    expect(lifecycle.processId).toBeUndefined()
    expect(lifecycle.running).toBe(false)
    expect(lifecycle.cleanupComplete).toBe(true)
    await expect(stat(keyPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed within a bound when a pre-spawn operation never settles', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lna-lifecycle-wedged-'))
    roots.push(root)
    const keyPath = join(root, 'llama.key')
    const port = await freePort()
    const barrier = chmodGate.arm(keyPath)
    const lifecycle = new OwnedLlamaLifecycle({
      binaryPath: process.execPath,
      args: ['-e', 'setInterval(() => undefined, 1000)'],
      apiKey: API_KEY,
      keyPath,
      origin: `http://127.0.0.1:${port}`,
      port,
      startupTimeoutMs: 10_000,
      startupSettleTimeoutMs: 50,
    })
    const start = lifecycle.start()
    void start.catch(() => undefined)
    await barrier.reached

    await expect(lifecycle.release()).rejects.toThrow(/had not settled 50ms after release began/)
    expect(lifecycle.cleanupComplete).toBe(false)
    expect(lifecycle.processId).toBeUndefined()

    barrier.open()
    await expect(start).rejects.toThrow()
    expect(lifecycle.processId).toBeUndefined()
  })
})
