import { describe, expect, it } from 'vitest'
import {
  assertOwnedLoopbackListener,
  assertOwnedProcessIdentity,
  probeBrowserBoundary,
} from '../src/index.js'

describe('real-smoke ownership proof', () => {
  it('requires the verified executable, exact model argv, loopback listener, and owned PID', () => {
    const expectedArgv = [
      '/runtime/llama-server',
      '--model',
      '/runtime/gemma.gguf',
      '--host',
      '127.0.0.1',
    ]
    expect(() =>
      assertOwnedProcessIdentity({
        expectedExecutable: '/runtime/llama-server',
        observedExecutable: '/runtime/llama-server',
        expectedArgv,
        observedArgv: expectedArgv,
      }),
    ).not.toThrow()
    expect(() =>
      assertOwnedProcessIdentity({
        expectedExecutable: '/runtime/llama-server',
        observedExecutable: '/other/llama-server',
        expectedArgv,
        observedArgv: expectedArgv,
      }),
    ).toThrow(/executable identity/)
    expect(() =>
      assertOwnedProcessIdentity({
        expectedExecutable: '/runtime/llama-server',
        observedExecutable: '/runtime/llama-server',
        expectedArgv,
        observedArgv: [...expectedArgv.slice(0, 2), '/other/model.gguf', ...expectedArgv.slice(3)],
      }),
    ).toThrow(/command line/)

    const owned = 'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("llama-server",pid=321,fd=7))'
    expect(() => assertOwnedLoopbackListener(owned, 321, '127.0.0.1', 8080)).not.toThrow()
    expect(() =>
      assertOwnedLoopbackListener(owned.replace('pid=321', 'pid=999'), 321, '127.0.0.1', 8080),
    ).toThrow(/owned loopback/)
    expect(() =>
      assertOwnedLoopbackListener(owned.replace('127.0.0.1', '0.0.0.0'), 321, '127.0.0.1', 8080),
    ).toThrow(/owned loopback/)
  })
})

describe('real-smoke browser boundary', () => {
  it('proves authenticated Origin and Sec-Fetch-Site requests are rejected before inference', async () => {
    const browserHeaders: Array<Headers> = []
    const fakeFetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/slots')) {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer server-key')
        return new Response(JSON.stringify([{ is_processing: false }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      const headers = new Headers(init?.headers)
      browserHeaders.push(headers)
      return new Response(JSON.stringify({ error: { message: 'browser metadata rejected' } }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })
    }

    await expect(
      probeBrowserBoundary({
        fetch: fakeFetch,
        origin: 'http://127.0.0.1:8080',
        apiKey: 'server-key',
        modelId: 'selected-model',
      }),
    ).resolves.toEqual({
      originStatus: 403,
      fetchMetadataStatus: 403,
      accessControlAllowOrigin: null,
      slotsIdleBefore: true,
      slotsIdleAfter: true,
      slotObservedBusy: false,
    })
    expect(browserHeaders.some((headers) => headers.has('origin'))).toBe(true)
    expect(browserHeaders.some((headers) => headers.get('sec-fetch-site') === 'cross-site')).toBe(
      true,
    )
    expect(
      browserHeaders.every((headers) => headers.get('authorization') === 'Bearer server-key'),
    ).toBe(true)
  })

  it('rejects false browser-boundary attestations', async () => {
    const unsafeFetch: typeof globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/slots')) {
        return new Response(JSON.stringify([{ is_processing: false }]), { status: 200 })
      }
      return new Response('{}', {
        status: 200,
        headers: { 'access-control-allow-origin': '*' },
      })
    }
    await expect(
      probeBrowserBoundary({
        fetch: unsafeFetch,
        origin: 'http://127.0.0.1:8080',
        apiKey: 'server-key',
        modelId: 'selected-model',
      }),
    ).rejects.toThrow(/not rejected before inference/)
  })
})
