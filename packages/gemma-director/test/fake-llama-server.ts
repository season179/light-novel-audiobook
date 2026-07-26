import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { SELECTED_GEMMA_PROFILE } from '../src/index.js'

export type FakeMode = 'success' | 'malformed' | 'schema-invalid' | 'http-error' | 'delay'

export interface CapturedRequest {
  readonly headers: IncomingMessage['headers']
  readonly body: Record<string, unknown>
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

function sseChunk(content: string, finishReason: string | null = null): string {
  return JSON.stringify({
    id: 'fake-direction',
    object: 'chat.completion.chunk',
    created: 1,
    model: SELECTED_GEMMA_PROFILE.modelId,
    choices: [
      {
        index: 0,
        delta: finishReason === null ? { content } : {},
        finish_reason: finishReason,
      },
    ],
  })
}

function sendSse(response: ServerResponse, value: string): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const midpoint = Math.max(1, Math.floor(value.length / 2))
  response.write(`data: ${sseChunk(value.slice(0, midpoint))}\n\n`)
  response.write(`data: ${sseChunk(value.slice(midpoint))}\n\n`)
  response.write(`data: ${sseChunk('', 'stop')}\n\n`)
  response.write(
    `data: ${JSON.stringify({
      id: 'fake-direction',
      object: 'chat.completion.chunk',
      created: 1,
      model: SELECTED_GEMMA_PROFILE.modelId,
      choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    })}\n\n`,
  )
  response.end('data: [DONE]\n\n')
}

export class FakeLlamaServer {
  private server: Server | undefined
  private mode: FakeMode = 'success'
  private responseValue: unknown
  private responseSequence: unknown[] = []
  readonly requests: CapturedRequest[] = []
  abortedRequests = 0
  port = 0

  get baseUrl(): string {
    if (this.port === 0) throw new Error('Fake llama.cpp server is not running')
    return `http://127.0.0.1:${this.port}/v1`
  }

  setMode(mode: FakeMode): void {
    this.mode = mode
  }

  respondWith(value: unknown): void {
    this.responseValue = value
    this.responseSequence = []
  }

  /** One response per request; the final value is reused if more requests arrive. */
  respondInSequence(values: readonly unknown[]): void {
    if (values.length === 0) throw new Error('Fake response sequence cannot be empty')
    this.responseSequence = [...values]
    this.responseValue = values[values.length - 1]
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => void this.handle(request, response))
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(0, '127.0.0.1', resolve)
    })
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('Missing fake server port')
    this.port = address.port
  }

  async stop(): Promise<void> {
    if (!this.server) return
    this.server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => (error ? reject(error) : resolve()))
    })
    this.server = undefined
    this.port = 0
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === 'GET' && request.url === '/health') {
      sendJson(response, 200, { status: 'ok' })
      return
    }
    if (request.method === 'GET' && request.url === '/v1/models') {
      sendJson(response, 200, {
        object: 'list',
        data: [{ id: SELECTED_GEMMA_PROFILE.modelId, object: 'model' }],
      })
      return
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      sendJson(response, 404, { error: { message: 'not found' } })
      return
    }

    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    this.requests.push({
      headers: { ...request.headers },
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
    })
    request.once('aborted', () => {
      this.abortedRequests += 1
    })
    response.once('close', () => {
      if (!response.writableEnded) this.abortedRequests += 1
    })

    switch (this.mode) {
      case 'success': {
        const sequenced = this.responseSequence.shift()
        sendSse(response, JSON.stringify(sequenced ?? this.responseValue))
        break
      }
      case 'malformed':
        sendSse(response, '{"segments":[')
        break
      case 'schema-invalid':
        sendSse(response, JSON.stringify({ segments: [{ source_passage_id: 4 }] }))
        break
      case 'http-error':
        sendJson(response, 503, {
          error: { message: 'fake unavailable', type: 'server_error', code: 'server_error' },
        })
        break
      case 'delay': {
        const timer = setTimeout(() => {
          if (!response.destroyed) sendSse(response, JSON.stringify(this.responseValue))
        }, 10_000)
        timer.unref()
        response.once('close', () => clearTimeout(timer))
        break
      }
    }
  }
}
