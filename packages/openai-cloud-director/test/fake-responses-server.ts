import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { OPENAI_CLOUD_DIRECTOR_PROFILE } from '../src/index.js'

export type ResponsesMode =
  | 'success'
  | 'malformed'
  | 'schema-invalid'
  | 'http-error'
  | 'delay'
  | 'refusal'

export interface CapturedResponsesRequest {
  readonly url: string
  readonly headers: IncomingMessage['headers']
  readonly body: Record<string, unknown>
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

function event(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`
}

function sendResponsesStream(response: ServerResponse, output: string): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  response.write(
    event({
      type: 'response.created',
      response: { id: 'resp_fake', model: OPENAI_CLOUD_DIRECTOR_PROFILE.modelId, output: [] },
    }),
  )
  const midpoint = Math.max(1, Math.floor(output.length / 2))
  response.write(
    event({
      type: 'response.output_text.delta',
      item_id: 'msg_fake',
      output_index: 0,
      content_index: 0,
      delta: output.slice(0, midpoint),
    }),
  )
  response.write(
    event({
      type: 'response.output_text.delta',
      item_id: 'msg_fake',
      output_index: 0,
      content_index: 0,
      delta: output.slice(midpoint),
    }),
  )
  response.write(
    event({
      type: 'response.completed',
      response: {
        id: 'resp_fake',
        model: OPENAI_CLOUD_DIRECTOR_PROFILE.modelId,
        output: [],
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 5 },
        },
      },
    }),
  )
  response.end('data: [DONE]\n\n')
}

export class FakeResponsesServer {
  private server: Server | undefined
  private mode: ResponsesMode = 'success'
  private responseValue: unknown
  private responseSequence: unknown[] = []
  readonly requests: CapturedResponsesRequest[] = []
  abortedRequests = 0
  port = 0

  get baseUrl(): string {
    if (this.port === 0) throw new Error('Fake Responses server is not running')
    return `http://127.0.0.1:${this.port}/v1`
  }

  respondWith(value: unknown): void {
    this.responseValue = value
    this.responseSequence = []
  }

  respondInSequence(values: readonly unknown[]): void {
    if (values.length === 0) throw new Error('Fake response sequence cannot be empty')
    this.responseSequence = [...values]
    this.responseValue = values[values.length - 1]
  }

  setMode(mode: ResponsesMode): void {
    this.mode = mode
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
    if (this.server === undefined) return
    this.server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => (error ? reject(error) : resolve()))
    })
    this.server = undefined
    this.port = 0
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST' || request.url !== '/v1/responses') {
      sendJson(response, 404, { error: { message: 'not found' } })
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    this.requests.push({
      url: request.url,
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
        sendResponsesStream(response, JSON.stringify(sequenced ?? this.responseValue))
        break
      }
      case 'malformed':
        sendResponsesStream(response, '{"segments":[')
        break
      case 'schema-invalid':
        sendResponsesStream(response, JSON.stringify({ segments: [{ source_passage_id: 4 }] }))
        break
      case 'http-error':
        sendJson(response, 503, {
          error: {
            message: 'raw-provider-secret raw-source-excerpt fake-api-key',
            type: 'server_error',
            code: 'server_error',
          },
        })
        break
      case 'refusal':
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(
          event({
            type: 'response.refusal.delta',
            item_id: 'msg_fake',
            output_index: 0,
            content_index: 0,
            delta: 'raw-provider-secret refusal text',
          }),
        )
        response.end('data: [DONE]\n\n')
        break
      case 'delay': {
        const timer = setTimeout(() => {
          if (!response.destroyed) sendResponsesStream(response, JSON.stringify(this.responseValue))
        }, 10_000)
        timer.unref()
        response.once('close', () => clearTimeout(timer))
        break
      }
    }
  }
}
