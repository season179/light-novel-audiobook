import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type DirectionRequest,
  DirectorError,
  DirectorFidelityError,
  type DirectorModel,
  type DirectorProgressEvent,
  type DirectorProgressStore,
  GemmaDirectorEndpoint,
  GemmaDirectorModel,
  SELECTED_GEMMA_PROFILE,
  validateDirectionOutput,
} from '../src/index.js'
import { FakeLlamaServer } from './fake-llama-server.js'

const API_KEY = 'fake-server-side-key-0000000001'

class MemoryProgressStore implements DirectorProgressStore {
  readonly events: DirectorProgressEvent[] = []

  async append(event: DirectorProgressEvent): Promise<void> {
    this.events.push(event)
  }
}

const request: DirectionRequest = {
  requestId: 'direction-run-001',
  chapterId: 'chapter-01',
  passages: [
    { id: 'passage-001', text: 'Rain tapped against the window.' },
    { id: 'passage-002', text: '“Who is there?”' },
  ],
  speakers: [{ id: 'mira', aliases: ['Mira'] }],
  narratorSpeakerId: 'narrator',
  fallbackSpeakerId: 'fallback-dialogue',
  storyContext: 'Mira is alone and hears an unidentified visitor.',
}

function wireSegment(
  id: string,
  text: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    source_passage_id: id,
    source_text: text,
    kind: 'narration',
    speaker_id: 'narrator',
    confidence: 0.98,
    delivery: {
      emotion: 'calm',
      pace: 'normal',
      volume: 'normal',
      pause_after_ms: 250,
    },
    unresolved_speaker: false,
    speaker_reason: null,
    ...overrides,
  }
}

function validWireOutput(): Record<string, unknown> {
  return {
    segments: [
      wireSegment('passage-001', 'Rain tapped against the window.'),
      wireSegment('passage-002', '“Who is there?”', {
        kind: 'dialogue',
        speaker_id: 'fallback-dialogue',
        confidence: 0.44,
        unresolved_speaker: true,
        speaker_reason: 'The visitor is not identified in the supplied context.',
      }),
    ],
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for fake endpoint state')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function directorModelContract(
  create: () => { model: DirectorModel; progress: MemoryProgressStore },
  fake: () => FakeLlamaServer,
): void {
  it('reports selected-model health and returns exact validated direction with fallback warnings', async () => {
    const { model, progress } = create()
    await expect(model.health()).resolves.toEqual({
      status: 'ok',
      selectedModelAvailable: true,
      modelIds: [SELECTED_GEMMA_PROFILE.modelId],
    })

    const result = await model.direct(request)
    expect(result.identity).toMatchObject({
      profileId: SELECTED_GEMMA_PROFILE.id,
      modelId: SELECTED_GEMMA_PROFILE.modelId,
      adapter: 'tanstack-ai-openai-compatible',
    })
    expect(
      result.segments.map(({ sourcePassageId, sourceText }) => ({ sourcePassageId, sourceText })),
    ).toEqual(request.passages.map(({ id, text }) => ({ sourcePassageId: id, sourceText: text })))
    expect(result.warnings).toEqual([
      {
        code: 'unresolved_speaker',
        sourcePassageId: 'passage-002',
        fallbackSpeakerId: 'fallback-dialogue',
        confidence: 0.44,
        message: 'The visitor is not identified in the supplied context.',
        reviewRequired: true,
      },
    ])
    expect(result.parameters).toEqual({ seed: 42, temperature: 0, topP: 1, maxTokens: 8192 })
    expect(result.requestSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.outputSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(progress.events.map((event) => event.state)).toEqual([
      'started',
      'requesting',
      'response_started',
      'validating',
      'completed',
    ])
    expect(progress.events.at(-1)).toMatchObject({
      completedPassages: 2,
      totalPassages: 2,
    })
    expect(JSON.stringify(progress.events)).not.toContain('Rain tapped')
  })

  it('sends the fixed Gemma profile, deterministic parameters, exact input, and JSON Schema', async () => {
    const { model } = create()
    await model.direct(request, { maxTokens: 512 })
    const captured = fake().requests.at(-1)
    expect(captured?.headers.authorization).toBe(`Bearer ${API_KEY}`)
    expect(captured?.body).toMatchObject({
      model: SELECTED_GEMMA_PROFILE.modelId,
      temperature: 0,
      seed: 42,
      top_p: 1,
      max_tokens: 512,
      stream: true,
      stream_options: { include_usage: true },
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'structured_output',
          strict: true,
          schema: {
            type: 'object',
            required: ['segments'],
            additionalProperties: false,
          },
        },
      },
    })
    const messages = captured?.body.messages as Array<{ role: string; content: string }>
    const userInput = JSON.parse(
      messages.find((message) => message.role === 'user')?.content ?? '{}',
    ) as Record<string, unknown>
    expect(userInput.passages).toEqual([
      { source_passage_id: 'passage-001', source_text: 'Rain tapped against the window.' },
      { source_passage_id: 'passage-002', source_text: '“Who is there?”' },
    ])
    expect(messages.find((message) => message.role === 'system')?.content).toContain(
      'never rewrite, trim, split, join, omit, duplicate',
    )
  })

  it('classifies malformed/schema-invalid provider output and persists safe failures', async () => {
    const first = create()
    fake().setMode('malformed')
    await expect(first.model.direct(request)).rejects.toMatchObject({
      code: 'malformed_output',
    })
    expect(first.progress.events.at(-1)).toMatchObject({
      state: 'failed',
      error: { code: 'malformed_output', retryable: false },
    })

    fake().setMode('schema-invalid')
    const second = create()
    await expect(second.model.direct(request)).rejects.toMatchObject({
      code: 'schema_validation',
    })
    expect(second.progress.events.at(-1)?.state).toBe('failed')
  })

  it('persists useful HTTP errors without retaining provider bodies', async () => {
    fake().setMode('http-error')
    const { model, progress } = create()
    await expect(model.direct(request)).rejects.toMatchObject({
      code: 'http',
      retryable: true,
      status: 503,
    })
    expect(progress.events.at(-1)).toMatchObject({
      state: 'failed',
      error: { code: 'http', retryable: true },
    })
    expect(JSON.stringify(progress.events)).not.toContain('fake unavailable')
  })

  it('propagates caller cancellation to the endpoint and persists cancellation', async () => {
    fake().setMode('delay')
    const { model, progress } = create()
    const controller = new AbortController()
    const result = model.direct(request, { signal: controller.signal, timeoutMs: 2_000 })
    await waitFor(() => fake().requests.length > 0)
    controller.abort(new DOMException('contract cancellation', 'AbortError'))
    await expect(result).rejects.toMatchObject({ code: 'cancelled', retryable: false })
    await waitFor(() => fake().abortedRequests > 0)
    expect(progress.events.at(-1)).toMatchObject({
      state: 'cancelled',
      error: { code: 'cancelled' },
    })
  })
}

describe('GemmaDirectorModel shared DirectorModel contract', () => {
  let server: FakeLlamaServer

  beforeEach(async () => {
    server = new FakeLlamaServer()
    server.respondWith(validWireOutput())
    await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  directorModelContract(
    () => {
      const progress = new MemoryProgressStore()
      return {
        progress,
        model: new GemmaDirectorModel({
          baseUrl: server.baseUrl,
          apiKey: API_KEY,
          progressStore: progress,
        }),
      }
    },
    () => server,
  )
})

describe('deterministic direction validation', () => {
  it.each([
    {
      name: 'omission',
      output: { segments: [wireSegment('passage-001', 'Rain tapped against the window.')] },
      codes: ['omission'],
    },
    {
      name: 'duplicate',
      output: {
        segments: [
          wireSegment('passage-001', 'Rain tapped against the window.'),
          wireSegment('passage-001', 'Rain tapped against the window.'),
        ],
      },
      codes: ['duplicate', 'omission'],
    },
    {
      name: 'invention',
      output: {
        segments: [
          wireSegment('passage-001', 'Rain tapped against the window.'),
          wireSegment('passage-invented', 'Invented text.'),
        ],
      },
      codes: ['omission', 'invention'],
    },
    {
      name: 'reorder',
      output: {
        segments: [
          wireSegment('passage-002', '“Who is there?”', {
            kind: 'dialogue',
            speaker_id: 'mira',
          }),
          wireSegment('passage-001', 'Rain tapped against the window.'),
        ],
      },
      codes: ['reorder'],
    },
    {
      name: 'rewritten text',
      output: {
        segments: [
          wireSegment('passage-001', 'Rain fell against the window.'),
          wireSegment('passage-002', '“Who is there?”', {
            kind: 'dialogue',
            speaker_id: 'mira',
          }),
        ],
      },
      codes: ['text_mismatch'],
    },
  ])('rejects $name', ({ output, codes }) => {
    try {
      validateDirectionOutput(output, request)
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(DirectorFidelityError)
      expect((error as DirectorFidelityError).findings.map((finding) => finding.code)).toEqual(
        codes,
      )
      return
    }
    throw new Error('Expected deterministic validation failure')
  })

  it('rejects invented speakers and inconsistent fallback semantics', () => {
    const output = validWireOutput() as { segments: Array<Record<string, unknown>> }
    output.segments[1] = wireSegment('passage-002', '“Who is there?”', {
      kind: 'dialogue',
      speaker_id: 'invented-character',
    })
    expect(() => validateDirectionOutput(output, request)).toThrow(DirectorFidelityError)

    output.segments[1] = wireSegment('passage-002', '“Who is there?”', {
      kind: 'dialogue',
      speaker_id: 'fallback-dialogue',
    })
    expect(() => validateDirectionOutput(output, request)).toThrow(DirectorFidelityError)
  })

  it('rejects malformed output before semantic validation', () => {
    try {
      validateDirectionOutput({ segments: [{ source_passage_id: 'passage-001' }] }, request)
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(DirectorError)
      expect((error as DirectorError).code).toBe('schema_validation')
      return
    }
    throw new Error('Expected schema validation failure')
  })
})

describe('GemmaDirectorEndpoint', () => {
  it('allows only the direct numeric loopback /v1 boundary', () => {
    expect(new GemmaDirectorEndpoint().baseUrl).toBe('http://127.0.0.1:8080/v1')
    expect(() => new GemmaDirectorEndpoint('http://localhost:8080/v1')).toThrow(/loopback/)
    expect(() => new GemmaDirectorEndpoint('http://0.0.0.0:8080/v1')).toThrow(/loopback/)
    expect(() => new GemmaDirectorEndpoint('https://127.0.0.1:8080/v1')).toThrow(/loopback/)
    expect(() => new GemmaDirectorEndpoint('http://127.0.0.1:8080/other')).toThrow(/loopback/)
  })
})
