import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { SELECTED_GEMMA_PROFILE } from '../src/index.js'

export interface OracleFragment {
  readonly start: number
  readonly end: number
  readonly kind: 'narration' | 'dialogue' | 'thought' | 'message' | 'sound_cue'
  readonly speaker: string
  readonly unresolved: boolean
  readonly confidence: number
}

export type Oracle = ReadonlyMap<string, readonly OracleFragment[]>

export interface CapturedRequest {
  readonly passages: readonly { source_passage_id: string; source_text: string }[]
  readonly storyContext: string
  readonly raw: Record<string, unknown>
}

/**
 * Request-responsive fake llama.cpp server. For every request it answers with exactly the
 * oracle's fragments for the passages IN THAT REQUEST, so each window response is precisely as
 * valid — or as invalid — as a whole-chapter response would be.
 */
export class OracleLlamaServer {
  private server: Server | undefined
  private port = 0
  readonly requests: CapturedRequest[] = []
  /** When set, requests with more than this many passages get truncated (unparseable) JSON. */
  truncateAbovePassages: number | undefined
  /**
   * When set, requests with more than this many passages get an HTTP 400 OpenAI-style
   * `context_length_exceeded` rejection, as llama.cpp reports a prompt that cannot fit.
   */
  contextOverflowAbovePassages: number | undefined
  /** Artificial per-request delay, for timeout and deadline tests. */
  delayMs = 0

  constructor(private readonly oracle: Oracle) {}

  get baseUrl(): string {
    if (this.port === 0) throw new Error('Fake llama.cpp server is not running')
    return `http://127.0.0.1:${this.port}/v1`
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => void this.handle(request, response))
    await new Promise<void>((resolve) => {
      this.server?.listen(0, '127.0.0.1', resolve)
    })
    const address = this.server?.address()
    if (address === null || typeof address !== 'object') throw new Error('Missing fake port')
    this.port = address.port
  }

  async stop(): Promise<void> {
    if (!this.server) return
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve())
    })
    this.server = undefined
    this.port = 0
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"status":"ok"}')
      return
    }
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: SELECTED_GEMMA_PROFILE.modelId, object: 'model' }],
        }),
      )
      return
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404)
      response.end('{}')
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages?: { role: string; content: string }[]
    }
    const user = JSON.parse(
      body.messages?.find((message) => message.role === 'user')?.content ?? '{}',
    ) as {
      passages: { source_passage_id: string; source_text: string }[]
      story_context?: string
    }
    this.requests.push({
      passages: user.passages,
      storyContext: user.story_context ?? '',
      raw: body,
    })

    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs))
      if (response.destroyed) return
    }

    if (
      this.contextOverflowAbovePassages !== undefined &&
      user.passages.length > this.contextOverflowAbovePassages
    ) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          error: {
            message:
              'This model has a context window of 32768 tokens. The requested prompt cannot fit: context_length_exceeded.',
            type: 'invalid_request_error',
            code: 'context_length_exceeded',
          },
        }),
      )
      return
    }

    const truncated =
      this.truncateAbovePassages !== undefined && user.passages.length > this.truncateAbovePassages
    const value = truncated
      ? '{"segments":[{"source_passage_id":'
      : JSON.stringify({
          segments: user.passages.flatMap((passage) => {
            const fragments = this.oracle.get(passage.source_passage_id)
            if (fragments === undefined) throw new Error('Oracle missing passage')
            return fragments.map((fragment) => ({
              source_passage_id: passage.source_passage_id,
              source_text: passage.source_text.slice(fragment.start, fragment.end),
              kind: fragment.kind,
              speaker_id: fragment.speaker,
              confidence: fragment.confidence,
              delivery: {
                emotion: 'calm',
                pace: 'normal',
                volume: 'normal',
                pause_after_ms: 200,
              },
              unresolved_speaker: fragment.unresolved,
              speaker_reason: fragment.unresolved ? 'Not identified in context.' : null,
            }))
          }),
        })

    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = (content: string, finish: string | null = null): string =>
      JSON.stringify({
        id: 'fake',
        object: 'chat.completion.chunk',
        created: 1,
        model: SELECTED_GEMMA_PROFILE.modelId,
        choices: [{ index: 0, delta: finish === null ? { content } : {}, finish_reason: finish }],
      })
    const midpoint = Math.max(1, Math.floor(value.length / 2))
    response.write(`data: ${chunk(value.slice(0, midpoint))}\n\n`)
    response.write(`data: ${chunk(value.slice(midpoint))}\n\n`)
    response.write(`data: ${chunk('', 'stop')}\n\n`)
    response.end('data: [DONE]\n\n')
  }
}

/** Deterministic PRNG so a failing fuzz case reproduces from its seed. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}
