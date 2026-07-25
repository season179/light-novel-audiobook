import { once } from 'node:events'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { LlamaCppGateway, measureOperation, type ResourceCollector } from '../src/gateway.js'

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      async (server) =>
        await new Promise<void>((resolvePromise) => {
          server.closeAllConnections()
          server.close(() => resolvePromise())
        }),
    ),
  )
})

class CountingCollector implements ResourceCollector {
  calls = 0
  constructor(private readonly failAt?: number) {}

  async sample() {
    this.calls += 1
    if (this.calls === this.failAt) throw new Error('synthetic collector failure')
    return { ramMib: 100 + this.calls, vramMib: 200 + this.calls }
  }
}

describe('resource and timeout capture', () => {
  it('captures initial/final resources and elapsed time when the operation throws', async () => {
    const collector = new CountingCollector()
    const measured = await measureOperation({
      operation: async () => {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
        throw new Error('synthetic failure')
      },
      collector,
      sampleIntervalMs: 1,
    })
    expect(measured.error).toBeInstanceOf(Error)
    expect(measured.value).toBeNull()
    expect(measured.resources).toMatchObject({
      complete: true,
      initial_sample_captured: true,
      final_sample_captured: true,
      error_code: 'none',
    })
    expect(measured.resources.sample_count).toBeGreaterThanOrEqual(2)
    expect(measured.resources.elapsed_ms).toBeGreaterThanOrEqual(1)
    const callsAfterReturn = collector.calls
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
    expect(collector.calls).toBe(callsAfterReturn)
  })

  it('fails closed but still awaits final sampling when any collector sample fails', async () => {
    const collector = new CountingCollector(1)
    const measured = await measureOperation({
      operation: async () => 'done',
      collector,
      sampleIntervalMs: 1,
    })
    expect(measured.value).toBe('done')
    expect(measured.resources).toMatchObject({
      complete: false,
      initial_sample_captured: false,
      final_sample_captured: true,
      error_code: 'collector_failed',
    })
    expect(collector.calls).toBeGreaterThanOrEqual(2)
  })

  it('returns timeout plus complete resource evidence instead of throwing or leaking a timer', async () => {
    const server = createServer((_request, _response) => {
      // Deliberately hold the request until the client timeout aborts it.
    })
    servers.push(server)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing fixture address')
    const collector = new CountingCollector()
    const gateway = new LlamaCppGateway(
      `http://127.0.0.1:${address.port}/`,
      'synthetic-server-side-key',
      20,
      collector,
    )
    const completion = await gateway.complete({ synthetic: true })
    expect(completion.response).toBeNull()
    expect(completion.failure).toBe('timeout')
    expect(completion.resources.complete).toBe(true)
    expect(completion.resources.final_sample_captured).toBe(true)
    expect(collector.calls).toBeGreaterThanOrEqual(2)
    const callsAfterReturn = collector.calls
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
    expect(collector.calls).toBe(callsAfterReturn)
  })
})
