import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_BRAIN_ENDPOINT,
  LlamaCppSpikeClient,
  LoopbackEndpoint,
  LoopbackRecordingFetch,
  SpikeError,
  type SpikeErrorCode,
} from '../src'
import { LlamaFixtureServer } from './llama-fixture-server'

const FIXTURE_API_KEY = 'fixture-server-side-key-00000001'

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for fixture state')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function expectCode(promise: Promise<unknown>, code: SpikeErrorCode): Promise<SpikeError> {
  try {
    await promise
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(SpikeError)
    expect((error as SpikeError).code).toBe(code)
    return error as SpikeError
  }
  throw new Error(`Expected ${code} error`)
}

describe('LoopbackEndpoint', () => {
  it('uses the fixed direct-brain default and refuses LAN/public origins', () => {
    expect(new LoopbackEndpoint().origin).toBe(DEFAULT_BRAIN_ENDPOINT)
    expect(() => new LoopbackEndpoint('http://0.0.0.0:8080')).toThrow(/loopback/)
    expect(() => new LoopbackEndpoint('http://192.168.1.2:8080')).toThrow(/loopback/)
    expect(() => new LoopbackEndpoint('https://127.0.0.1:8080')).toThrow(/loopback/)
    expect(() => new LoopbackEndpoint('http://localhost:8080')).toThrow(/loopback/)
    expect(() => new LlamaCppSpikeClient({ model: 'fixture', apiKey: 'short' })).toThrow(
      /server-side/,
    )
  })
})

describe('LlamaCppSpikeClient', () => {
  let fixture: LlamaFixtureServer
  let client: LlamaCppSpikeClient
  let recordingFetch: LoopbackRecordingFetch

  beforeEach(async () => {
    fixture = new LlamaFixtureServer()
    await fixture.start()
    recordingFetch = new LoopbackRecordingFetch({
      inspectBody: (body) => {
        const parsed = JSON.parse(Buffer.from(body).toString('utf8')) as Record<string, unknown>
        return { model: parsed.model }
      },
    })
    client = new LlamaCppSpikeClient({
      endpoint: fixture.origin,
      model: 'fixture-smollm',
      apiKey: FIXTURE_API_KEY,
      maxConcurrency: 1,
      fetch: recordingFetch.fetch,
    })
  })

  afterEach(async () => {
    await fixture.stop()
  })

  it('obtains health, model identity, slots, and endpoint capabilities', async () => {
    await expect(client.health()).resolves.toBe('ok')
    await expect(client.capabilities()).resolves.toEqual({
      healthStatus: 'ok',
      modelIds: ['fixture-smollm'],
      totalSlots: 1,
      endpoints: {
        chatCompletions: true,
        health: true,
        models: true,
        props: true,
      },
    })
  })

  it('returns validated structured output and captures the llama.cpp request shape', async () => {
    await expect(
      client.generateStructured({ temperature: 0, seed: 17, maxTokens: 48 }),
    ).resolves.toEqual({ verdict: 'pass', summary: 'synthetic fixture' })

    const body = fixture.requests.at(-1)?.body
    expect(body).toMatchObject({
      model: 'fixture-smollm',
      temperature: 0,
      seed: 17,
      max_tokens: 48,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        {
          role: 'user',
          content: expect.stringContaining('Synthetic compatibility probe'),
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'structured_output',
          strict: true,
          schema: {
            type: 'object',
            required: ['verdict', 'summary'],
            additionalProperties: false,
          },
        },
      },
    })
    const boundaryCapture = recordingFetch.captures.at(-1)
    expect(boundaryCapture).toMatchObject({
      method: 'POST',
      path: '/v1/chat/completions',
      authorization: { present: true, scheme: 'Bearer', redacted: true },
      assertedFields: { model: 'fixture-smollm' },
      backendStatus: 200,
    })
    expect(boundaryCapture?.bodySha256).toBe(fixture.requests.at(-1)?.rawBodySha256)
    expect(boundaryCapture?.forwardedBodySha256).toBe(boundaryCapture?.bodySha256)
    expect(fixture.requests.at(-1)?.headers.authorization).toBe(`Bearer ${FIXTURE_API_KEY}`)
    expect(client.slotSnapshot()).toEqual({ capacity: 1, active: 0, queued: 0 })
  })

  it('classifies schema-invalid and malformed structured responses', async () => {
    fixture.setMode('schema-invalid')
    await expectCode(client.generateStructured(), 'schema_validation')
    fixture.setMode('malformed-json')
    await expectCode(client.generateStructured(), 'malformed_response')
    expect(client.slotSnapshot().active).toBe(0)
  })

  it('preserves predictable HTTP and model error classifications', async () => {
    fixture.setMode('http-error')
    const httpError = await expectCode(client.generateStructured(), 'http')
    expect(httpError.retryable).toBe(true)
    expect(httpError.status).toBe(429)
    expect(httpError.providerCode).toBe('rate_limit')
    expect(httpError.cause).toBeDefined()

    fixture.setMode('model-error')
    const modelError = await expectCode(client.generateStructured(), 'model')
    expect(modelError.retryable).toBe(false)
    expect(modelError.status).toBe(400)
    expect(modelError.providerCode).toBe('model_not_found')
    expect(modelError.cause).toBeDefined()
  })

  it('classifies a broken streaming response and releases its slot', async () => {
    fixture.setMode('stream-error')
    await expectCode(client.generateStructured(), 'stream')
    expect(client.slotSnapshot()).toEqual({ capacity: 1, active: 0, queued: 0 })
  })

  it('propagates timeout cancellation to the server, releases the slot, and recovers', async () => {
    fixture.setMode('delay')
    await expectCode(client.generateStructured({ timeoutMs: 50 }), 'timeout')
    await waitFor(() => fixture.abortedRequests > 0 && fixture.activeRequests === 0)
    expect(client.slotSnapshot()).toEqual({ capacity: 1, active: 0, queued: 0 })

    fixture.setMode('success')
    await expect(client.generateStructured()).resolves.toMatchObject({ verdict: 'pass' })
  })

  it('releases active and queued slots after caller cancellation', async () => {
    fixture.setMode('delay')
    const activeController = new AbortController()
    const queuedController = new AbortController()
    const active = client.runCancellationProbe(activeController.signal, 2_000)
    await waitFor(() => fixture.activeRequests === 1)
    const queued = client.generateStructured({ signal: queuedController.signal, timeoutMs: 2_000 })
    await waitFor(() => client.slotSnapshot().queued === 1)

    queuedController.abort()
    await expectCode(queued, 'cancelled')
    activeController.abort()
    await expectCode(active, 'cancelled')
    await waitFor(() => fixture.activeRequests === 0)
    expect(client.slotSnapshot()).toEqual({ capacity: 1, active: 0, queued: 0 })
  })

  it('classifies a deadline that expires while queued as timeout and releases the queue', async () => {
    fixture.setMode('delay')
    const activeController = new AbortController()
    const active = client.runCancellationProbe(activeController.signal, 2_000)
    await waitFor(() => fixture.activeRequests === 1)

    await expectCode(client.generateStructured({ timeoutMs: 30 }), 'timeout')
    expect(client.slotSnapshot()).toEqual({ capacity: 1, active: 1, queued: 0 })
    activeController.abort()
    await expectCode(active, 'cancelled')
    await waitFor(() => fixture.activeRequests === 0)

    fixture.setMode('success')
    await expect(client.generateStructured()).resolves.toMatchObject({ verdict: 'pass' })
    expect(client.slotSnapshot()).toEqual({ capacity: 1, active: 0, queued: 0 })
  })

  it('classifies connection failures as unavailable', async () => {
    const unusedOrigin = fixture.origin
    await fixture.stop()
    const unavailableClient = new LlamaCppSpikeClient({
      endpoint: unusedOrigin,
      model: 'fixture-smollm',
      apiKey: FIXTURE_API_KEY,
    })
    await expectCode(unavailableClient.generateStructured({ timeoutMs: 500 }), 'unavailable')
  })
})
