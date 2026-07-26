import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { SELECTED_GEMMA_PROFILE } from '@light-novel-audiobook/gemma-director'

/**
 * A fake llama.cpp-compatible endpoint that **derives its answer from the request**.
 *
 * The one in `gemma-director/test` answers with a value fixed in advance, which is right for contract
 * tests and useless here: to direct an arbitrary real chapter the response has to echo that chapter's
 * actual passages, or `ExactSourceCoverage` correctly rejects it as rewritten text.
 *
 * So this reads the passages out of the request and returns one narration fragment per passage,
 * copying the text verbatim as one whole-passage fragment. Every segment is narration, whose speaker
 * the adapter derives deterministically rather than asking this transport to choose a role. That is
 * what makes a first real run survivable: no unresolved speaker means no fallback approval is
 * required (issue #45) and no character voice is needed beyond the pinned narrator.
 *
 * It is a stand-in for the transport, not for the director: the real `GemmaDirectorModel` still builds
 * the request, streams the response, validates the schema, checks confidence, and maps to domain
 * segments.
 */
export interface FakeDirectorRequest {
  readonly chapterId: string
  readonly passageCount: number
}

/** The wire payload is snake_case, and differs from the port's camelCase `DirectorSourcePassage`. */
interface PromptPassage {
  readonly source_passage_id: string
  readonly source_text: string
}

interface PromptInput {
  readonly chapterId: string
  readonly speakers: readonly { readonly speaker_id: string; readonly aliases: readonly string[] }[]
  readonly passages: readonly PromptPassage[]
}

/** Picks the message carrying the direction payload, identified by shape rather than position. */
function findPromptInput(messages: readonly { content?: unknown }[]): PromptInput {
  for (const message of messages) {
    if (typeof message.content !== 'string') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(message.content)
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object') continue
    const candidate = parsed as {
      passages?: unknown
      speakers?: unknown
      chapter?: { chapter_id?: unknown }
    }
    if (!Array.isArray(candidate.passages) || !Array.isArray(candidate.speakers)) continue
    return {
      chapterId:
        typeof candidate.chapter?.chapter_id === 'string' ? candidate.chapter.chapter_id : '',
      speakers: candidate.speakers as PromptInput['speakers'],
      passages: candidate.passages as readonly PromptPassage[],
    }
  }
  throw new Error('no message carried a direction payload with passages')
}

export class NarrationEchoDirectorServer {
  #server: Server | undefined
  #port = 0
  readonly requests: FakeDirectorRequest[] = []

  constructor(private readonly characterKind?: 'dialogue' | 'thought') {}

  get baseUrl(): string {
    if (this.#port === 0) throw new Error('Fake director server is not running')
    return `http://127.0.0.1:${this.#port}/v1`
  }

  async start(): Promise<void> {
    this.#server = createServer((request, response) => {
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
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'not found' } }))
        return
      }
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
      request.on('end', () => {
        let input: PromptInput
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            messages?: { content?: unknown }[]
          }
          // The request carries a system prompt as well as the JSON payload, so the payload is found
          // by shape rather than by position: the message that parses to an object with passages.
          input = findPromptInput(body.messages ?? [])
        } catch (error) {
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end(
            JSON.stringify({ error: { message: `unusable request: ${(error as Error).message}` } }),
          )
          return
        }
        const passages = input.passages
        this.requests.push({
          chapterId: input.chapterId,
          passageCount: passages.length,
        })
        const selectedSpeaker = input.speakers[0]
        if (this.characterKind !== undefined && selectedSpeaker === undefined) {
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { message: 'character mode requires a roster' } }))
          return
        }
        const segments = passages.map((passage) => ({
          source_passage_id: passage.source_passage_id,
          source_text: passage.source_text,
          kind: this.characterKind ?? 'narration',
          ...(selectedSpeaker === undefined || this.characterKind === undefined
            ? {}
            : { speaker_id: selectedSpeaker.speaker_id, speaker_reason: null }),
          confidence: 1,
          delivery: {
            emotion: 'neutral',
            pace: 'normal',
            volume: 'normal',
            pause_after_ms: 0,
          },
        }))
        this.#sendStream(response, JSON.stringify({ segments }))
      })
    })
    const server = this.#server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    this.#port = (server.address() as AddressInfo).port
  }

  async stop(): Promise<void> {
    const server = this.#server
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
    this.#server = undefined
    this.#port = 0
  }

  /** Split across chunks so the adapter's streaming path, not just its parser, is exercised. */
  #sendStream(response: import('node:http').ServerResponse, value: string): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const chunk = (content: string, finishReason: string | null = null): string =>
      JSON.stringify({
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
    const midpoint = Math.max(1, Math.floor(value.length / 2))
    response.write(`data: ${chunk(value.slice(0, midpoint))}\n\n`)
    response.write(`data: ${chunk(value.slice(midpoint))}\n\n`)
    response.write(`data: ${chunk('', 'stop')}\n\n`)
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
}
