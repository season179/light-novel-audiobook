import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

export type FixtureMode =
  | 'success'
  | 'schema-invalid'
  | 'malformed-json'
  | 'http-error'
  | 'model-error'
  | 'stream-error'
  | 'delay'

export interface CapturedRequest {
  readonly headers: Record<string, string | Array<string> | undefined>
  readonly body: Record<string, unknown>
  readonly rawBodySha256: string
}

const FIXTURE_MODEL = 'fixture-smollm'

async function readJson(request: IncomingMessage): Promise<{
  body: Record<string, unknown>
  rawBodySha256: string
}> {
  const chunks: Array<Buffer> = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const rawBody = Buffer.concat(chunks)
  return {
    body: JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>,
    rawBodySha256: createHash('sha256').update(rawBody).digest('hex'),
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

function chunk(content: string, finishReason: string | null = null): string {
  return JSON.stringify({
    id: 'fixture-completion',
    object: 'chat.completion.chunk',
    created: 1,
    model: FIXTURE_MODEL,
    choices: [
      {
        index: 0,
        delta: finishReason === null ? { content } : {},
        finish_reason: finishReason,
      },
    ],
  })
}

function sendSse(response: ServerResponse, content: string): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const midpoint = Math.max(1, Math.floor(content.length / 2))
  response.write(`data: ${chunk(content.slice(0, midpoint))}\n\n`)
  response.write(`data: ${chunk(content.slice(midpoint))}\n\n`)
  response.write(`data: ${chunk('', 'stop')}\n\n`)
  response.write(
    `data: ${JSON.stringify({
      id: 'fixture-completion',
      object: 'chat.completion.chunk',
      created: 1,
      model: FIXTURE_MODEL,
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })}\n\n`,
  )
  response.end('data: [DONE]\n\n')
}

export class LlamaFixtureServer {
  private server: Server | undefined
  private mode: FixtureMode = 'success'
  readonly requests: Array<CapturedRequest> = []
  activeRequests = 0
  abortedRequests = 0
  port = 0

  get origin(): string {
    if (this.port === 0) throw new Error('Fixture server is not running')
    return `http://127.0.0.1:${this.port}`
  }

  setMode(mode: FixtureMode): void {
    this.mode = mode
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handle(request, response)
    })
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(0, '127.0.0.1', () => resolve())
    })
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('Missing fixture address')
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
      sendJson(response, 200, { object: 'list', data: [{ id: FIXTURE_MODEL, object: 'model' }] })
      return
    }
    if (request.method === 'GET' && request.url === '/props') {
      sendJson(response, 200, {
        total_slots: 1,
        default_generation_settings: { n_ctx: 1024 },
      })
      return
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      sendJson(response, 404, { error: { message: 'not found' } })
      return
    }

    this.activeRequests += 1
    let completed = false
    const finish = (): void => {
      if (completed) return
      completed = true
      this.activeRequests -= 1
    }
    request.once('aborted', () => {
      this.abortedRequests += 1
      finish()
    })
    response.once('close', () => {
      if (!response.writableEnded) this.abortedRequests += 1
      finish()
    })
    response.once('finish', finish)

    try {
      const { body, rawBodySha256 } = await readJson(request)
      this.requests.push({ headers: { ...request.headers }, body, rawBodySha256 })
      switch (this.mode) {
        case 'success':
          sendSse(response, JSON.stringify({ verdict: 'pass', summary: 'synthetic fixture' }))
          break
        case 'schema-invalid':
          sendSse(response, JSON.stringify({ verdict: 'fail', summary: '' }))
          break
        case 'malformed-json':
          sendSse(response, '{"verdict":"pass","summary":')
          break
        case 'http-error':
          sendJson(response, 429, {
            error: { message: 'synthetic rate limit', type: 'rate_limit', code: 'rate_limit' },
          })
          break
        case 'model-error':
          sendJson(response, 400, {
            error: {
              message: 'synthetic model not found',
              type: 'invalid_request_error',
              code: 'model_not_found',
            },
          })
          break
        case 'stream-error': {
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.write(`data: ${chunk('{"verdict":"pass",')}\n\n`)
          const timer = setTimeout(() => response.socket?.destroy(), 20)
          timer.unref()
          response.once('close', () => clearTimeout(timer))
          break
        }
        case 'delay': {
          const timer = setTimeout(() => {
            if (!response.destroyed) {
              sendSse(response, JSON.stringify({ verdict: 'pass', summary: 'late fixture' }))
            }
          }, 10_000)
          timer.unref()
          response.once('close', () => clearTimeout(timer))
          break
        }
      }
    } catch (error: unknown) {
      if (!response.headersSent) sendJson(response, 400, { error: { message: String(error) } })
      else response.destroy(error instanceof Error ? error : undefined)
    }
  }
}
