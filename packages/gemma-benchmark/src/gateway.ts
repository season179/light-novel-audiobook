import { execFile as execFileCallback } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { ResourceCapture } from './schemas.js'

const execFile = promisify(execFileCallback)

export interface ResourceSample {
  readonly ramMib: number
  readonly vramMib: number
}

export interface ResourceCollector {
  sample(): Promise<ResourceSample>
}

export interface GatewayResponse {
  readonly ok: boolean
  readonly status: number
  readonly raw: string
  readonly json: unknown
  readonly jsonValid: boolean
}

export interface GatewayCompletion {
  readonly response: GatewayResponse | null
  readonly failure: 'none' | 'timeout' | 'transport'
  readonly resources: ResourceCapture
}

export interface ModelGateway {
  countTokens(content: string): Promise<number>
  complete(body: Record<string, unknown>): Promise<GatewayCompletion>
}

class WslResourceCollector implements ResourceCollector {
  async sample(): Promise<ResourceSample> {
    const [text, result] = await Promise.all([
      readFile('/proc/meminfo', 'utf8'),
      execFile('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits']),
    ])
    const total = Number(/^MemTotal:\s+(\d+) kB$/m.exec(text)?.[1] ?? Number.NaN)
    const available = Number(/^MemAvailable:\s+(\d+) kB$/m.exec(text)?.[1] ?? Number.NaN)
    const vramValues = result.stdout
      .trim()
      .split('\n')
      .map((value) => Number(value.trim()))
      .filter(Number.isFinite)
    if (!Number.isFinite(total) || !Number.isFinite(available) || vramValues.length === 0) {
      throw new Error('Resource collector returned incomplete data')
    }
    return {
      ramMib: Math.ceil((total - available) / 1024),
      vramMib: Math.ceil(Math.max(...vramValues)),
    }
  }
}

export interface MeasuredOutcome<T> {
  readonly value: T | null
  readonly error: unknown
  readonly resources: ResourceCapture
}

export async function measureOperation<T>(options: {
  operation: () => Promise<T>
  collector: ResourceCollector
  sampleIntervalMs?: number
}): Promise<MeasuredOutcome<T>> {
  const started = performance.now()
  let peakVramMib = 0
  let peakRamMib = 0
  let sampleCount = 0
  let collectorFailed = false
  let initialSampleCaptured = false
  let finalSampleCaptured = false
  let sampleChain = Promise.resolve()

  const sample = async (phase: 'initial' | 'periodic' | 'final'): Promise<void> => {
    try {
      const value = await options.collector.sample()
      peakRamMib = Math.max(peakRamMib, value.ramMib)
      peakVramMib = Math.max(peakVramMib, value.vramMib)
      sampleCount += 1
      if (phase === 'initial') initialSampleCaptured = true
      if (phase === 'final') finalSampleCaptured = true
    } catch {
      collectorFailed = true
    }
  }
  const enqueue = (phase: 'initial' | 'periodic' | 'final'): Promise<void> => {
    sampleChain = sampleChain.then(async () => await sample(phase))
    return sampleChain
  }

  await enqueue('initial')
  const timer = setInterval(() => {
    void enqueue('periodic')
  }, options.sampleIntervalMs ?? 250)
  let value: T | null = null
  let error: unknown
  try {
    value = await options.operation()
  } catch (caught: unknown) {
    error = caught
  } finally {
    clearInterval(timer)
    await sampleChain
    await enqueue('final')
  }

  const complete = !collectorFailed && initialSampleCaptured && finalSampleCaptured
  return {
    value,
    error,
    resources: {
      method_version: 'wsl-system-resource-sampling@2',
      elapsed_ms: Math.ceil(performance.now() - started),
      peak_vram_mib: peakVramMib,
      peak_ram_mib: peakRamMib,
      sample_count: sampleCount,
      initial_sample_captured: initialSampleCaptured,
      final_sample_captured: finalSampleCaptured,
      complete,
      error_code: complete ? 'none' : 'collector_failed',
    },
  }
}

class RequestFailure extends Error {
  constructor(readonly failure: 'timeout' | 'transport') {
    super('llama.cpp request failed')
  }
}

export class LlamaCppGateway implements ModelGateway {
  private readonly collector: ResourceCollector

  constructor(
    private readonly origin: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 3_600_000,
    collector?: ResourceCollector,
  ) {
    const endpoint = new URL(origin)
    if (
      endpoint.protocol !== 'http:' ||
      endpoint.hostname !== '127.0.0.1' ||
      endpoint.pathname !== '/'
    ) {
      throw new Error('Benchmark endpoint must be an HTTP numeric loopback origin')
    }
    this.collector = collector ?? new WslResourceCollector()
  }

  async countTokens(content: string): Promise<number> {
    const response = await this.request('/tokenize', { content, add_special: true }, 120_000)
    if (!response.ok) throw new Error('Token preflight failed')
    const body = response.json as { tokens?: unknown }
    if (!Array.isArray(body.tokens)) throw new Error('Token preflight response is malformed')
    return body.tokens.length
  }

  async complete(body: Record<string, unknown>): Promise<GatewayCompletion> {
    const measured = await measureOperation({
      operation: async () => await this.request('/v1/chat/completions', body, this.timeoutMs),
      collector: this.collector,
    })
    if (measured.error) {
      return {
        response: null,
        failure:
          measured.error instanceof RequestFailure
            ? measured.error.failure
            : ('transport' as const),
        resources: measured.resources,
      }
    }
    return { response: measured.value, failure: 'none', resources: measured.resources }
  }

  private async request(
    path: string,
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<GatewayResponse> {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new DOMException('llama.cpp request timeout', 'TimeoutError'))
    }, timeoutMs)
    try {
      let response: Response
      try {
        response = await fetch(`${this.origin.slice(0, -1)}${path}`, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      } catch (error: unknown) {
        void error
        throw new RequestFailure(timedOut ? 'timeout' : 'transport')
      }
      const raw = await response.text()
      let json: unknown = null
      let jsonValid = false
      try {
        json = JSON.parse(raw) as unknown
        jsonValid = true
      } catch {
        // Exact private bytes and explicit validity are retained in the run manifest.
      }
      return { ok: response.ok, status: response.status, raw, json, jsonValid }
    } finally {
      clearTimeout(timer)
    }
  }
}
