import { execFile as execFileCallback } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

export interface ResourceResult {
  readonly elapsedMs: number
  readonly peakVramMib: number
  readonly peakRamMib: number
}

export interface GatewayResponse {
  readonly ok: boolean
  readonly status: number
  readonly raw: string
  readonly json: unknown
  readonly resources: ResourceResult
}

export interface ModelGateway {
  countTokens(content: string): Promise<number>
  complete(body: Record<string, unknown>): Promise<GatewayResponse>
}

async function effectiveWslRamMib(): Promise<number> {
  const text = await readFile('/proc/meminfo', 'utf8')
  const total = Number(/^MemTotal:\s+(\d+) kB$/m.exec(text)?.[1] ?? 0)
  const available = Number(/^MemAvailable:\s+(\d+) kB$/m.exec(text)?.[1] ?? 0)
  return Math.ceil((total - available) / 1024)
}

async function deviceVramMib(): Promise<number> {
  const { stdout } = await execFile('nvidia-smi', [
    '--query-gpu=memory.used',
    '--format=csv,noheader,nounits',
  ])
  const values = stdout
    .trim()
    .split('\n')
    .map((value) => Number(value.trim()))
    .filter(Number.isFinite)
  return Math.ceil(Math.max(0, ...values))
}

async function measured<T>(
  operation: () => Promise<T>,
): Promise<{ value: T; resources: ResourceResult }> {
  const started = performance.now()
  let peakVramMib = 0
  let peakRamMib = 0
  let stopped = false
  const sample = async (): Promise<void> => {
    const [ram, vram] = await Promise.all([effectiveWslRamMib(), deviceVramMib()])
    peakRamMib = Math.max(peakRamMib, ram)
    peakVramMib = Math.max(peakVramMib, vram)
  }
  await sample()
  const timer = setInterval(() => {
    if (!stopped) void sample().catch(() => undefined)
  }, 250)
  try {
    const value = await operation()
    await sample()
    return {
      value,
      resources: {
        elapsedMs: Math.ceil(performance.now() - started),
        peakVramMib,
        peakRamMib,
      },
    }
  } finally {
    stopped = true
    clearInterval(timer)
  }
}

export class LlamaCppGateway implements ModelGateway {
  constructor(
    private readonly origin: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 3_600_000,
  ) {
    const endpoint = new URL(origin)
    if (
      endpoint.protocol !== 'http:' ||
      endpoint.hostname !== '127.0.0.1' ||
      endpoint.pathname !== '/'
    ) {
      throw new Error('Benchmark endpoint must be an HTTP numeric loopback origin')
    }
  }

  async countTokens(content: string): Promise<number> {
    const response = await this.request('/tokenize', { content, add_special: true }, 120_000)
    if (!response.ok) throw new Error('Token preflight failed')
    const body = response.json as { tokens?: unknown }
    if (!Array.isArray(body.tokens)) throw new Error('Token preflight response is malformed')
    return body.tokens.length
  }

  async complete(body: Record<string, unknown>): Promise<GatewayResponse> {
    const measuredResponse = await measured(() =>
      this.request('/v1/chat/completions', body, this.timeoutMs),
    )
    return { ...measuredResponse.value, resources: measuredResponse.resources }
  }

  private async request(
    path: string,
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Omit<GatewayResponse, 'resources'>> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${this.origin.slice(0, -1)}${path}`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const raw = await response.text()
      let json: unknown = null
      try {
        json = JSON.parse(raw) as unknown
      } catch {
        // The immutable private raw response retains the parse evidence.
      }
      return { ok: response.ok, status: response.status, raw, json }
    } finally {
      clearTimeout(timer)
    }
  }
}
