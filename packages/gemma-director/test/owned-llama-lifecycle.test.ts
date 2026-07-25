import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { OwnedLlamaLifecycle } from '../scripts/real-smoke.js'

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
        if (healthy) setTimeout(() => server?.close(), 25)
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

    // Pre-fix this rejects: release() killed the child underneath the health wait, and the
    // (honest) health endpoint then stopped answering healthy.
    await expect(startPromise).resolves.toBeUndefined()
    await releasePromise

    expect(performance.now() - started).toBeGreaterThanOrEqual(250)
    expect(lifecycle.cleanupComplete).toBe(true)
    // The child really is dead: signalling its pid must fail with ESRCH.
    expect(childPid).toBeDefined()
    expect(isAlive(childPid as number)).toBe(false)
  }, 20_000)
})
