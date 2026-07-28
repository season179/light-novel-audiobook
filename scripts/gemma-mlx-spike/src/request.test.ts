/**
 * Deterministic failure-evidence tests for runDirection.
 *
 * No network, model, or mlx_lm.server is involved: `globalThis.fetch` is replaced with canned
 * SSE responses so the real @tanstack/ai openai-compatible adapter + the production-shaped
 * client gates run end to end. These tests prove that on a malformed/schema/stream/cancel
 * failure the captured diagnostics (HTTP status, exact raw response byte count and SHA-256,
 * bounded SSE tail, bounded event sequence, terminal event, and truthful cancellation state)
 * survive to the caller via the `failed` outcome instead of being lost when the exception path
 * discarded them.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, test } from 'node:test'
import {
  type RunDirectionOptions,
  type RunDirectionOutcome,
  representativeRequest,
  runDirection,
} from './request.js'

const ENCODER = new TextEncoder()
const SSE_DONE = 'data: [DONE]\n\n'

/** One OpenAI-compatible chat.completion.chunk SSE frame carrying a content delta. */
function chatCompletionChunk(content: string): string {
  return `data: ${JSON.stringify({
    id: 'spike-test',
    object: 'chat.completion.chunk',
    model: 'spike-test-model',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Standard runDirection options with an optional (armed) cancellation timer. */
function options(cancelAfterMs?: number): RunDirectionOptions {
  return {
    baseUrl: 'http://127.0.0.1:8090/v1',
    request: representativeRequest(),
    confidenceThreshold: 0.8,
    timeoutMs: 5_000,
    ...(cancelAfterMs === undefined ? {} : { cancelAfterMs }),
  }
}

/** Replaces globalThis.fetch for the duration of `body`, then restores it. */
async function withFakeFetch<T>(
  fetchImpl: typeof globalThis.fetch,
  body: () => Promise<T>,
): Promise<T> {
  const saved = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    return await body()
  } finally {
    globalThis.fetch = saved
  }
}

/** A fetch that returns one fixed, already-complete response body. */
function fixedResponseFetch(bodyBytes: Uint8Array, status = 200): typeof globalThis.fetch {
  return async (): Promise<Response> => new Response(bodyBytes, { status })
}

/**
 * A schema- and fidelity-valid DirectionWireOutput for representativeRequest(): one narration
 * segment covering passage 1 exactly, one resolved dialogue segment (speaker 'mira') covering
 * passage 2 exactly. Used to drive runDirection to a clean `ok` outcome with canned SSE.
 */
const VALID_DIRECTION_OUTPUT = {
  segments: [
    {
      source_passage_id: 'public-smoke-passage-001',
      source_text: 'Rain tapped against the window.',
      confidence: 0.9,
      delivery: { emotion: 'neutral', pace: 'normal', volume: 'normal', pause_after_ms: 0 },
      kind: 'narration',
    },
    {
      source_passage_id: 'public-smoke-passage-002',
      source_text: '\u201cI will return before dawn,\u201d Mira said.',
      confidence: 0.9,
      delivery: { emotion: 'neutral', pace: 'normal', volume: 'normal', pause_after_ms: 0 },
      kind: 'dialogue',
      speaker_id: 'mira',
      speaker_reason: null,
    },
  ],
}

/** Narrows a failed outcome for assertions; throws (never) on an unexpected ok outcome. */
function failedOf(outcome: RunDirectionOutcome) {
  if (outcome.kind === 'ok') throw new Error('expected a failed outcome, got ok')
  return { error: outcome.error, fc: outcome.failureContext }
}

describe('runDirection failure_context preservation', () => {
  test('malformed JSON SSE preserves exact response bytes, sha256, status, terminal event, and a bounded event sequence', async () => {
    const bodyText = chatCompletionChunk('not valid json {') + SSE_DONE
    const bodyBytes = ENCODER.encode(bodyText)

    const outcome = await withFakeFetch(fixedResponseFetch(bodyBytes), () =>
      runDirection(options()),
    )
    const { error, fc } = failedOf(outcome)

    // The classified error is malformed_output, and the actual adapter failure code is captured.
    assert.equal(error.code, 'malformed_output')
    assert.equal(fc.terminalEvent?.type, 'RUN_ERROR')
    assert.equal(fc.terminalEvent?.code, 'structured-output-parse-failed')

    // Response diagnostics are exact (not estimates) and survive the failure path.
    assert.equal(fc.responseStatus, 200)
    assert.equal(fc.rawResponseBytes, bodyBytes.length)
    assert.equal(fc.rawResponseSha256, sha256Hex(bodyBytes))

    // Event sequence is bounded and includes the terminal RUN_ERROR event.
    assert.ok(fc.eventSequence.length > 0)
    assert.ok(fc.eventSequence.length <= fc.eventSequenceLimit)
    assert.ok(
      fc.eventSequence.some((event) => event.type === 'RUN_ERROR'),
      'event sequence must include the terminal RUN_ERROR',
    )

    // Tail equals the full (small) response and is within the cap.
    assert.equal(fc.sseTailBytes, bodyBytes.length)
    assert.ok(fc.sseTailBytes <= fc.sseTailLimitBytes)
    assert.equal(fc.sseTail, bodyText)

    // No cancellation was armed.
    assert.equal(fc.cancelRequested, false)
    assert.equal(fc.cancelTimerFired, false)
    assert.equal(fc.timeoutFired, false)

    // Request body text is never persisted — only its sha256.
    assert.equal(fc.transmitted.bodySha256.length, 64)
  })

  test('tail bound applies: a response larger than the cap stores only the bounded tail while total bytes and hash stay exact', async () => {
    const bodyText = chatCompletionChunk('x'.repeat(100_000)) + SSE_DONE
    const bodyBytes = ENCODER.encode(bodyText)

    const outcome = await withFakeFetch(fixedResponseFetch(bodyBytes), () =>
      runDirection(options()),
    )
    const { fc } = failedOf(outcome)

    assert.ok(
      fc.rawResponseBytes > fc.sseTailLimitBytes,
      'total response bytes must exceed the cap',
    )
    assert.equal(fc.rawResponseBytes, bodyBytes.length)
    assert.equal(fc.rawResponseSha256, sha256Hex(bodyBytes))
    assert.ok(fc.sseTailBytes <= fc.sseTailLimitBytes, 'stored tail must be bounded to the cap')
    assert.equal(fc.sseTail, bodyText.slice(-fc.sseTailLimitBytes))
  })

  test('event sequence is bounded: many stream events cap at the limit and the terminal event is still captured', async () => {
    const bodyText =
      Array.from({ length: 80 }, (_, index) => chatCompletionChunk(`bad${index} {`)).join('') +
      SSE_DONE
    const bodyBytes = ENCODER.encode(bodyText)

    const outcome = await withFakeFetch(fixedResponseFetch(bodyBytes), () =>
      runDirection(options()),
    )
    const { fc } = failedOf(outcome)

    assert.equal(fc.eventSequence.length, fc.eventSequenceLimit)
    assert.equal(fc.eventSequenceTruncated, true)
    assert.equal(fc.terminalEvent?.code, 'structured-output-parse-failed')
    // Ring buffer keeps the events nearest the failure: the terminal RUN_ERROR is the last entry.
    const last = fc.eventSequence[fc.eventSequence.length - 1]
    assert.equal(last?.type, 'RUN_ERROR')
    assert.equal(last?.code, 'structured-output-parse-failed')
  })

  test('cancellation armed but not fired: a fast malformed run with a large cancel timer reports requested=true, timer_fired=false', async () => {
    const bodyText = chatCompletionChunk('bad {') + SSE_DONE
    const bodyBytes = ENCODER.encode(bodyText)

    const outcome = await withFakeFetch(fixedResponseFetch(bodyBytes), () =>
      runDirection(options(10_000)),
    )
    const { error, fc } = failedOf(outcome)

    // The run failed at the gate before the timer could fire — it must NOT be labelled cancelled.
    assert.equal(error.code, 'malformed_output')
    assert.equal(fc.cancelRequested, true)
    assert.equal(fc.cancelTimerFired, false)
    assert.equal(fc.timeoutFired, false)
  })

  test('cancellation timer fires: aborting the in-flight stream reports timer_fired=true and observed_error_code=cancelled', async () => {
    const firstChunk = chatCompletionChunk('partial ')
    // The fetch returns a streaming body that emits one chunk, then errors when the request's
    // abort signal fires — mirroring a real mlx_lm.server connection torn down mid-stream.
    const abortableFetch: typeof globalThis.fetch = async (_input, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(ENCODER.encode(firstChunk))
          const onAbort = (): void => {
            controller.error(init?.signal?.reason ?? new DOMException('aborted', 'AbortError'))
          }
          if (init?.signal?.aborted === true) onAbort()
          else init?.signal?.addEventListener('abort', onAbort, { once: true })
        },
      })
      return new Response(stream, { status: 200 })
    }

    const outcome = await withFakeFetch(abortableFetch, () => runDirection(options(60)))
    const { error, fc } = failedOf(outcome)

    assert.equal(error.code, 'cancelled')
    assert.equal(fc.cancelRequested, true)
    assert.equal(fc.cancelTimerFired, true)
    assert.equal(fc.timeoutFired, false)
    assert.ok(fc.rawResponseBytes > 0, 'partial response bytes must be captured before the abort')
    assert.match(fc.rawResponseSha256 ?? '', /^[0-9a-f]{64}$/)
  })

  test('ok outcome under an armed cancel timer exposes cancel_timer_fired=false (the run completed before the timer fired)', async () => {
    const bodyText = chatCompletionChunk(JSON.stringify(VALID_DIRECTION_OUTPUT)) + SSE_DONE
    const bodyBytes = ENCODER.encode(bodyText)

    const outcome = await withFakeFetch(fixedResponseFetch(bodyBytes), () =>
      runDirection(options(10_000)),
    )

    assert.equal(outcome.kind, 'ok')
    if (outcome.kind !== 'ok') throw new Error('unreachable')
    // The run completed cleanly before the 10s cancel timer could fire, so the firing truth
    // surfaced on the ok outcome is false — the success-path phase must derive from this, not
    // from the mere presence of --cancel-after-ms.
    assert.equal(outcome.result.cancelTimerFired, false)
    assert.equal(outcome.result.timedOut, false)
  })

  test('tail bound is byte-true for multibyte output: a 4-byte-codepoint response never exceeds the byte cap', async () => {
    // 20 000 × U+1F600 = 80 000 UTF-8 bytes of content, well past the 64 KiB cap.
    const bodyText = chatCompletionChunk('\uD83D\uDE00'.repeat(20_000)) + SSE_DONE
    const bodyBytes = ENCODER.encode(bodyText)

    const outcome = await withFakeFetch(fixedResponseFetch(bodyBytes), () =>
      runDirection(options()),
    )
    const { fc } = failedOf(outcome)

    // The cap holds in BYTES (not UTF-16 code units): under the old code-unit slice this would
    // have stored ~80 000 bytes with zero truncation.
    assert.equal(fc.rawResponseBytes, bodyBytes.length)
    assert.equal(fc.rawResponseSha256, sha256Hex(bodyBytes))
    assert.ok(fc.rawResponseBytes > fc.sseTailLimitBytes)
    assert.equal(fc.sseTailBytes, fc.sseTailLimitBytes)
    assert.ok(fc.sseTailBytes <= fc.sseTailLimitBytes)
    // Multibyte content: the stored text has fewer characters than bytes, proving the tail is
    // not a code-unit slice.
    assert.ok(fc.sseTail.length < fc.sseTailBytes)
  })

  test('a dangling trailing multibyte sequence is represented in the tail (not silently dropped)', async () => {
    const baseBytes = ENCODER.encode(chatCompletionChunk('ok') + SSE_DONE)
    // Append an incomplete 4-byte sequence (lead + one continuation, no completion) — the exact
    // abrupt-truncation signature issue #106 needs to see.
    const bodyBytes = new Uint8Array(baseBytes.length + 2)
    bodyBytes.set(baseBytes, 0)
    bodyBytes.set([0xf0, 0x9f], baseBytes.length)

    const outcome = await withFakeFetch(fixedResponseFetch(bodyBytes), () =>
      runDirection(options()),
    )
    const { fc } = failedOf(outcome)

    // Decoding the byte tail with a fresh (non-streaming) decoder flushes the dangling bytes as a
    // replacement char instead of swallowing them.
    assert.ok(fc.sseTail.endsWith('\uFFFD'), 'dangling trailing bytes must surface as U+FFFD')
    assert.equal(fc.rawResponseBytes, bodyBytes.length)
    assert.equal(fc.rawResponseSha256, sha256Hex(bodyBytes))
  })

  test('fidelity gate failure preserves the full failure_context (repair/validate run inside the try)', async () => {
    // Schema-valid but source_text is corrupted: JSON parses and structured-output completes, but
    // deterministic validateDirectionOutput rejects it (DirectorFidelityError, code 'fidelity').
    const corrupted = {
      segments: [
        {
          source_passage_id: 'public-smoke-passage-001',
          source_text: 'WRONG — not the passage text',
          confidence: 0.9,
          delivery: { emotion: 'neutral', pace: 'normal', volume: 'normal', pause_after_ms: 0 },
          kind: 'narration',
        },
        {
          source_passage_id: 'public-smoke-passage-002',
          source_text: '\u201cI will return before dawn,\u201d Mira said.',
          confidence: 0.9,
          delivery: { emotion: 'neutral', pace: 'normal', volume: 'normal', pause_after_ms: 0 },
          kind: 'dialogue',
          speaker_id: 'mira',
          speaker_reason: null,
        },
      ],
    }
    const bodyText = chatCompletionChunk(JSON.stringify(corrupted)) + SSE_DONE
    const bodyBytes = ENCODER.encode(bodyText)

    const outcome = await withFakeFetch(fixedResponseFetch(bodyBytes), () =>
      runDirection(options()),
    )
    const { error, fc } = failedOf(outcome)

    assert.equal(error.code, 'fidelity')
    // The response diagnostics are preserved on this path — not lost as they were when
    // validateDirectionOutput ran outside the try/catch.
    assert.equal(fc.responseStatus, 200)
    assert.ok(fc.rawResponseBytes > 0)
    assert.equal(fc.rawResponseSha256, sha256Hex(bodyBytes))
    assert.ok(fc.sseTailBytes <= fc.sseTailLimitBytes)
    // The stream completed normally (structured-output.complete fired) before the fidelity gate;
    // there is no terminal RUN_ERROR, and the event sequence records the completed parse.
    assert.equal(fc.terminalEvent, null)
    assert.ok(
      fc.eventSequence.some(
        (event) => event.type === 'CUSTOM' && event.name === 'structured-output.complete',
      ),
    )
  })
})
