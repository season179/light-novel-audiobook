import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { chat } from '@tanstack/ai'
import { openaiCompatibleText } from '@tanstack/ai-openai/compatible'
import { canonicalSha256 } from '../../../packages/gemma-director/src/canonical-json.js'
import { DirectorError, classifyDirectorError } from '../../../packages/gemma-director/src/errors.js'
import {
  type MechanicalSourceRepair,
  repairMechanicalSourceEcho,
} from '../../../packages/gemma-director/src/fidelity-recovery.js'
import type { DirectionRequest } from '../../../packages/gemma-director/src/port.js'
import {
  type DirectionWireOutput,
  directionWireOutputSchemaFor,
  parseDirectionRequest,
} from '../../../packages/gemma-director/src/schema.js'
import {
  DirectorFidelityError,
  type ValidatedDirection,
  validateDirectionOutput,
} from '../../../packages/gemma-director/src/validation.js'

/**
 * Prompt/schema versions and the system prompt are copied verbatim from
 * packages/gemma-director/src/profile.ts (GEMMA_DIRECTOR_PROMPT_VERSION,
 * GEMMA_DIRECTOR_SCHEMA_VERSION, GEMMA_DIRECTOR_SYSTEM_PROMPT). profile.ts also exports the
 * CUDA SELECTED_GEMMA_PROFILE, which this driver must not import, so the prompt text is
 * duplicated here and bound into evidence by its sha256 at runtime. The sampling constants are
 * the production SELECTED_GEMMA_PROFILE generation parameters (seed 42, temperature 0,
 * topP 1, maxTokens 8192) — the request must be the representative operational one.
 */
export const PROMPT_VERSION = 'gemma-director@4'
export const SCHEMA_VERSION = 'gemma-direction-output@4'

export const SYSTEM_PROMPT = `You are a deterministic audiobook director.
Cover every supplied source passage with one or more ordered fragments. A passage may and should be split when narration, spoken dialogue, thought, message, or sound-cue kind changes inside it.
For every fragment, copy source_passage_id and source_text exactly. The ordered fragment texts for each passage must concatenate to that passage's complete source_text exactly. Keep passages and fragments in source order. Never trim, join across passages, omit, duplicate, overlap, reorder, rewrite, or invent story text. Source ranges are derived deterministically after validation; do not calculate or return character offsets.
Speaker roles are constrained by the response schema. For narration and sound cues, do not choose a speaker; the adapter assigns the narrator deterministically. For dialogue, thought, and messages, choose only a character speaker ID admitted by the response schema. If none can be resolved from the supplied roster and context, set speaker_id null and give a short factual speaker_reason. A resolved character speaker must have speaker_reason null.
Choose restrained delivery only from the schema enums. Prefer neutral, normal pace, and normal volume unless the text clearly supports a different choice; avoid theatrical exaggeration.
Confidence is from 0 to 1 and measures the kind and speaker assignment. Return schema-constrained JSON only. Legitimate fiction must not be refused.`

/** Production generation parameters (SELECTED_GEMMA_PROFILE), sent per-request exactly as on CUDA. */
export const SAMPLING = Object.freeze({
  seed: 42,
  temperature: 0,
  topP: 1,
  maxTokens: 8_192,
} as const)

/** Model id sent on the wire; mlx_lm.server serves the snapshot it was started with regardless. */
export const SPIKE_WIRE_MODEL_ID = 'Jiunsong/SuperGemma-4-12b-abliterated-mlx-4bit'

/**
 * The representative operational request: the same public synthetic passages, roster, and
 * context as packages/gemma-director/scripts/real-smoke.ts (smokeBook + its contextProvider),
 * parsed through the production request schema so identity/duplicate checks are shared.
 */
export function representativeRequest(): DirectionRequest {
  return parseDirectionRequest({
    requestId: 'gemma-mlx-spike-representative@1',
    bookId: 'public-smoke-book',
    bookTitle: 'Public Synthetic Smoke',
    bookAuthor: null,
    bookSourceSha256: 'b'.repeat(64),
    chapterId: 'public-smoke-chapter',
    chapterPosition: 1,
    chapterTitle: 'Public Smoke Chapter',
    passages: [
      { id: 'public-smoke-passage-001', text: 'Rain tapped against the window.' },
      { id: 'public-smoke-passage-002', text: '“I will return before dawn,” Mira said.' },
    ],
    speakers: [{ id: 'mira', aliases: ['Mira'] }],
    narratorSpeakerId: 'narrator',
    fallbackSpeakerId: 'fallback-dialogue',
    storyContext: 'Mira speaks the second supplied passage.',
  })
}

export async function loadRequest(requestFile: string | undefined): Promise<{
  request: DirectionRequest
  source: 'built-in-representative' | 'request-file'
}> {
  if (requestFile === undefined) {
    return { request: representativeRequest(), source: 'built-in-representative' }
  }
  const parsed = parseDirectionRequest(JSON.parse(await readFile(requestFile, 'utf8')))
  return { request: parsed, source: 'request-file' }
}

/** Identical envelope to GemmaDirectorModel.requestPayload (gemma-director-model.ts). */
export function requestPayload(request: DirectionRequest): {
  systemPrompts: string[]
  messages: Array<{ role: 'user'; content: string }>
} {
  const userInput = {
    book: {
      book_id: request.bookId,
      title: request.bookTitle,
      author: request.bookAuthor,
      source_sha256: request.bookSourceSha256,
    },
    chapter: {
      chapter_id: request.chapterId,
      position: request.chapterPosition,
      title: request.chapterTitle,
    },
    story_context: request.storyContext ?? '',
    speakers: request.speakers.map((speaker) => ({
      speaker_id: speaker.id,
      aliases: speaker.aliases,
    })),
    passages: request.passages.map((passage) => ({
      source_passage_id: passage.id,
      source_text: passage.text,
    })),
  }
  return {
    systemPrompts: [SYSTEM_PROMPT],
    messages: [{ role: 'user', content: JSON.stringify(userInput) }],
  }
}

export interface TokenUsage {
  readonly promptTokens: number
  readonly completionTokens: number
  readonly totalTokens: number
  readonly cachedPromptTokens: number | null
}

export interface TransmittedRequestRecord {
  readonly url: string
  readonly bodySha256: string
  readonly model: string | null
  readonly stream: boolean | null
  readonly streamOptions: unknown
  /** The exact strict JSON-schema response_format placed on the wire; null only if capture failed. */
  readonly responseFormat: unknown
  readonly responseFormatSha256: string | null
  readonly sampling: {
    readonly temperature: number | null
    readonly seed: number | null
    readonly topP: number | null
    readonly maxTokens: number | null
  }
}

export interface DirectionRunResult {
  readonly validated: ValidatedDirection
  readonly output: DirectionWireOutput
  readonly repairs: readonly MechanicalSourceRepair[]
  readonly requestPayloadSha256: string
  readonly rawOutputSha256: string
  readonly validatedOutputSha256: string
  readonly transmitted: TransmittedRequestRecord
  readonly responseStatus: number | null
  readonly usage: TokenUsage | null
  readonly runFinishedUsage: unknown
  readonly rawResponseSha256: string | null
  readonly dispatchToFirstTokenMs: number | null
  readonly dispatchToCompleteMs: number
}

const SSE_TAIL_LIMIT_BYTES = 256 * 1024

/**
 * Wire-level view of the TanStack AI stream events this driver consumes. The library's own
 * StructuredOutputStream union loses its `.type` discriminant under this spike's npm layout
 * (AG-UI's CustomEvent is zod-inferred through a nested second zod copy, which degrades to a
 * type the union cannot discriminate). The checks below are exactly the ones production runs
 * in gemma-director-model.ts: TEXT_MESSAGE_CONTENT, RUN_FINISHED, RUN_ERROR with the two
 * structured-output failure codes, and CUSTOM 'structured-output.complete'.
 */
interface StreamWireEvent {
  readonly type?: string
  readonly code?: string
  readonly name?: string
  readonly delta?: string
  readonly value?: { readonly object?: unknown }
  readonly usage?: unknown
}

function extractSseUsage(tail: string): TokenUsage | null {
  let usage: TokenUsage | null = null
  for (const line of tail.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const data = line.slice('data: '.length).trim()
    if (data === '[DONE]' || data.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      continue
    }
    const candidate = (parsed as { usage?: Record<string, unknown> }).usage
    if (candidate === undefined || candidate === null) continue
    const prompt = Number(candidate.prompt_tokens)
    const completion = Number(candidate.completion_tokens)
    if (!Number.isFinite(prompt) || !Number.isFinite(completion)) continue
    const cached = (candidate.prompt_tokens_details as { cached_tokens?: unknown } | undefined)
      ?.cached_tokens
    usage = {
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: Number(candidate.total_tokens ?? prompt + completion),
      cachedPromptTokens: typeof cached === 'number' ? cached : null,
    }
  }
  return usage
}

export interface RunDirectionOptions {
  readonly baseUrl: string
  readonly request: DirectionRequest
  readonly confidenceThreshold: number
  readonly timeoutMs: number
  readonly cancelAfterMs?: number | undefined
  readonly signal?: AbortSignal | undefined
}

/**
 * Drives one representative direction through the exact production-shaped path: TanStack AI
 * chat() with a streaming outputSchema (which places the strict JSON-schema response_format on
 * the wire), client-side structured-output parse/schema validation, the production mechanical
 * source-echo repair, then deterministic validateDirectionOutput. A wrapping fetch records the
 * transmitted request body and tees the SSE stream so token usage is auditable independent of
 * the SDK's own parsing.
 */
export async function runDirection(options: RunDirectionOptions): Promise<DirectionRunResult> {
  const { request } = options
  const payload = requestPayload(request)
  const requestPayloadSha256 = canonicalSha256({
    promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    parameters: { ...SAMPLING, confidenceThreshold: options.confidenceThreshold },
    payload,
  })
  const outputSchema = directionWireOutputSchemaFor(request)

  // A per-run key preserves the production request shape (Authorization header) even though the
  // raw mlx_lm.server ignores it — recorded in evidence as part of the API-compat delta.
  const apiKey = randomBytes(32).toString('base64url')

  let transmitted: TransmittedRequestRecord | null = null
  let responseStatus: number | null = null
  const rawResponseHash = createHash('sha256')
  let rawResponseBytes = 0
  let sseTail = ''

  const capturingFetch: typeof globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    const response = await globalThis.fetch(input, init)
    if (!new URL(url).pathname.endsWith('/chat/completions')) return response

    responseStatus = response.status
    const bodyText = typeof init?.body === 'string' ? init.body : null
    if (bodyText !== null) {
      try {
        const body = JSON.parse(bodyText) as Record<string, unknown>
        const responseFormat = body.response_format ?? null
        transmitted = {
          url,
          bodySha256: createHash('sha256').update(bodyText).digest('hex'),
          model: typeof body.model === 'string' ? body.model : null,
          stream: typeof body.stream === 'boolean' ? body.stream : null,
          streamOptions: body.stream_options ?? null,
          responseFormat,
          responseFormatSha256:
            responseFormat === null ? null : canonicalSha256(responseFormat),
          sampling: {
            temperature: typeof body.temperature === 'number' ? body.temperature : null,
            seed: typeof body.seed === 'number' ? body.seed : null,
            topP: typeof body.top_p === 'number' ? body.top_p : null,
            maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : null,
          },
        }
      } catch {
        transmitted = null
      }
    }
    if (response.body === null) return response
    const decoder = new TextDecoder()
    const tap = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        rawResponseHash.update(chunk)
        rawResponseBytes += chunk.length
        sseTail = (sseTail + decoder.decode(chunk, { stream: true })).slice(-SSE_TAIL_LIMIT_BYTES)
        controller.enqueue(chunk)
      },
    })
    return new Response(response.body.pipeThrough(tap), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }

  const adapter = openaiCompatibleText(SPIKE_WIRE_MODEL_ID, {
    name: 'mlx-lm-gemma-director-spike',
    baseURL: options.baseUrl,
    apiKey,
    maxRetries: 0,
    defaultHeaders: { connection: 'close' },
    fetch: capturingFetch,
  })

  const controller = new AbortController()
  const onCallerAbort = (): void => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', onCallerAbort, { once: true })
  let timedOut = false
  let cancelledByDriver = false
  const timeoutTimer = setTimeout(() => {
    timedOut = true
    controller.abort(new DOMException('gemma-mlx-spike direction request timed out', 'TimeoutError'))
  }, options.timeoutMs)
  const cancelTimer =
    options.cancelAfterMs === undefined
      ? undefined
      : setTimeout(() => {
          cancelledByDriver = true
          controller.abort(new DOMException('gemma-mlx-spike cancellation exercised', 'AbortError'))
        }, options.cancelAfterMs)

  const dispatchAt = performance.now()
  let firstTokenMs: number | null = null
  let output: DirectionWireOutput | undefined
  let runFinishedUsage: unknown = null
  try {
    const stream = chat({
      adapter,
      messages: payload.messages,
      systemPrompts: payload.systemPrompts,
      outputSchema,
      stream: true,
      abortController: controller,
      debug: false,
      modelOptions: {
        temperature: SAMPLING.temperature,
        seed: SAMPLING.seed,
        top_p: SAMPLING.topP,
        max_tokens: SAMPLING.maxTokens,
      },
    })
    for await (const event of stream as AsyncIterable<StreamWireEvent>) {
      if (event.type === 'TEXT_MESSAGE_CONTENT' && firstTokenMs === null) {
        firstTokenMs = Math.round(performance.now() - dispatchAt)
      }
      if (event.type === 'RUN_FINISHED') {
        runFinishedUsage = event.usage ?? null
      }
      if (event.type === 'RUN_ERROR') {
        if (event.code === 'structured-output-parse-failed') {
          throw new DirectorError('malformed_output', 'MLX spike returned malformed JSON', false, {
            cause: event,
          })
        }
        if (event.code === 'structured-output-validation-failed') {
          throw new DirectorError(
            'schema_validation',
            'MLX spike output failed schema validation',
            false,
            { cause: event },
          )
        }
        throw new DirectorError('stream', 'MLX spike response stream failed', true, {
          cause: event,
        })
      }
      if (event.type === 'CUSTOM' && event.name === 'structured-output.complete') {
        output = outputSchema.parse(event.value?.object) as DirectionWireOutput
      }
    }
    if (controller.signal.aborted) {
      throw controller.signal.reason ?? new DOMException('Aborted', 'AbortError')
    }
    if (output === undefined) {
      throw new DirectorError('malformed_output', 'MLX spike response did not complete')
    }
  } catch (error: unknown) {
    throw classifyDirectorError(error, {
      timedOut,
      callerCancelled: cancelledByDriver || options.signal?.aborted === true,
      operation: 'MLX spike direction request',
    })
  } finally {
    clearTimeout(timeoutTimer)
    if (cancelTimer !== undefined) clearTimeout(cancelTimer)
    options.signal?.removeEventListener('abort', onCallerAbort)
  }
  const dispatchToCompleteMs = Math.round(performance.now() - dispatchAt)

  // Production gate order (gemma-director-model.ts): mechanical source-echo repair first,
  // then deterministic validateDirectionOutput as the final authority.
  const repaired = repairMechanicalSourceEcho(output, request)
  const rawOutputSha256 = canonicalSha256(output)
  const validatedOutputSha256 = canonicalSha256(repaired.output)
  const validated = validateDirectionOutput(
    repaired.output,
    request,
    options.confidenceThreshold,
  )

  return {
    validated,
    output: repaired.output,
    repairs: repaired.repairs,
    requestPayloadSha256,
    rawOutputSha256,
    validatedOutputSha256,
    transmitted:
      transmitted ??
      ({
        url: `${options.baseUrl}/chat/completions`,
        bodySha256: '',
        model: null,
        stream: null,
        streamOptions: null,
        responseFormat: null,
        responseFormatSha256: null,
        sampling: { temperature: null, seed: null, topP: null, maxTokens: null },
      } satisfies TransmittedRequestRecord),
    responseStatus,
    usage: extractSseUsage(sseTail),
    runFinishedUsage,
    rawResponseSha256: rawResponseBytes > 0 ? rawResponseHash.digest('hex') : null,
    dispatchToFirstTokenMs: firstTokenMs,
    dispatchToCompleteMs,
  }
}

export { DirectorFidelityError }
