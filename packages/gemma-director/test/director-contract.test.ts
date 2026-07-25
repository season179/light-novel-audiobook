import type { DirectorModel as ApplicationDirectorModel } from '@light-novel-audiobook/application'
import { Book, Chapter, ExactSourceCoverage, SourcePassage } from '@light-novel-audiobook/domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type DirectionRequest,
  DirectorError,
  DirectorFidelityError,
  type DirectorProgressEvent,
  type DirectorProgressStore,
  type DirectorRuntimeLifecycle,
  GemmaDirectorEndpoint,
  GemmaDirectorModel,
  SELECTED_GEMMA_PROFILE,
  validateDirectionOutput,
} from '../src/index.js'
import { FakeLlamaServer } from './fake-llama-server.js'

const API_KEY = 'fake-server-side-key-0000000001'
const CONFIDENCE_THRESHOLD = 0.8

class MemoryProgressStore implements DirectorProgressStore {
  readonly events: DirectorProgressEvent[] = []

  async append(event: DirectorProgressEvent): Promise<void> {
    this.events.push(event)
  }
}

class FakeLifecycle implements DirectorRuntimeLifecycle {
  releaseCalls = 0

  async release(): Promise<void> {
    this.releaseCalls += 1
  }
}

function makeBook(): Book {
  const chapter = new Chapter({
    id: 'chapter-01',
    bookId: 'book-01',
    position: 1,
    title: 'A Visitor',
    sourcePassages: [
      new SourcePassage({
        id: 'passage-001',
        chapterId: 'chapter-01',
        sourceText: 'Rain. “Run!”',
      }),
      new SourcePassage({
        id: 'passage-002',
        chapterId: 'chapter-01',
        sourceText: '“Who?”',
      }),
    ],
  })
  return new Book({
    id: 'book-01',
    title: 'Fixture Book',
    author: 'Fixture Author',
    coverPath: null,
    source: { epubPath: '/private/fixture.epub', sha256: 'a'.repeat(64) },
    chapters: [chapter],
  })
}

const validationRequest: DirectionRequest = {
  requestId: 'direction-run-001',
  bookId: 'book-01',
  bookTitle: 'Fixture Book',
  bookAuthor: 'Fixture Author',
  bookSourceSha256: 'a'.repeat(64),
  chapterId: 'chapter-01',
  chapterPosition: 1,
  chapterTitle: 'A Visitor',
  passages: [
    { id: 'passage-001', text: 'Rain. “Run!”' },
    { id: 'passage-002', text: '“Who?”' },
  ],
  speakers: [{ id: 'mira', aliases: ['Mira'] }],
  narratorSpeakerId: 'narrator',
  fallbackSpeakerId: 'fallback-dialogue',
  storyContext: 'Mira says “Run!”; the final speaker is unidentified.',
}

function wireSegment(
  id: string,
  start: number,
  end: number,
  text: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    source_passage_id: id,
    source_start: start,
    source_end: end,
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

function validWireOutput(): { segments: Array<Record<string, unknown>> } {
  return {
    segments: [
      wireSegment('passage-001', 0, 6, 'Rain. '),
      wireSegment('passage-001', 6, 12, '“Run!”', {
        kind: 'dialogue',
        speaker_id: 'mira',
        confidence: 0.95,
        delivery: {
          emotion: 'firm',
          pace: 'fast',
          volume: 'normal',
          pause_after_ms: 150,
        },
      }),
      wireSegment('passage-002', 0, 6, '“Who?”', {
        kind: 'dialogue',
        speaker_id: 'fallback-dialogue',
        confidence: 0.44,
        unresolved_speaker: true,
        speaker_reason: 'The speaker is not identified in the supplied context.',
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

describe('GemmaDirectorModel issue #29 DirectorModel contract', () => {
  let server: FakeLlamaServer
  let models: GemmaDirectorModel[]

  beforeEach(async () => {
    server = new FakeLlamaServer()
    server.respondWith(validWireOutput())
    await server.start()
    models = []
  })

  afterEach(async () => {
    await Promise.allSettled(models.map(async (model) => await model.release()))
    await server.stop()
  })

  const create = (): {
    model: GemmaDirectorModel
    progress: MemoryProgressStore
    lifecycle: FakeLifecycle
  } => {
    const progress = new MemoryProgressStore()
    const lifecycle = new FakeLifecycle()
    const model = new GemmaDirectorModel({
      baseUrl: server.baseUrl,
      apiKey: API_KEY,
      confidenceThreshold: CONFIDENCE_THRESHOLD,
      contextProvider: {
        forChapter: async () => ({
          speakers: validationRequest.speakers,
          narratorSpeakerId: validationRequest.narratorSpeakerId,
          fallbackSpeakerId: validationRequest.fallbackSpeakerId,
          ...(validationRequest.storyContext === undefined
            ? {}
            : { storyContext: validationRequest.storyContext }),
        }),
      },
      progressStore: progress,
      lifecycle,
    })
    models.push(model)
    return { model, progress, lifecycle }
  }

  it('implements directChapter(Book, Chapter) with exact issue #29 DirectedChapter mapping', async () => {
    const book = makeBook()
    const { model, progress } = create()
    const contract: ApplicationDirectorModel = model
    expect(contract.identity).toContain(SELECTED_GEMMA_PROFILE.id)
    await expect(model.health()).resolves.toEqual({
      status: 'ok',
      selectedModelAvailable: true,
      modelIds: [SELECTED_GEMMA_PROFILE.modelId],
    })

    const result = await contract.directChapter(book, book.chapters[0] as Chapter)
    expect(result).toMatchObject({
      chapterId: 'chapter-01',
      segments: [
        {
          sourcePassageId: 'passage-001',
          sourceText: 'Rain. ',
          kind: 'narration',
          speakerId: null,
          confidence: 0.98,
          delivery: { emotion: 'calm', pace: 'normal', volume: 'normal', pauseAfterMs: 250 },
        },
        {
          sourcePassageId: 'passage-001',
          sourceText: '“Run!”',
          kind: 'dialogue',
          speakerId: 'mira',
          confidence: 0.95,
          delivery: { emotion: 'firm', pace: 'fast', volume: 'normal', pauseAfterMs: 150 },
        },
        {
          sourcePassageId: 'passage-002',
          sourceText: '“Who?”',
          kind: 'dialogue',
          speakerId: null,
          confidence: 0.44,
          delivery: { emotion: 'calm', pace: 'normal', volume: 'normal', pauseAfterMs: 250 },
        },
      ],
    })
    expect(() =>
      ExactSourceCoverage.createSegments(book.chapters[0] as Chapter, result.segments),
    ).not.toThrow()
    const concrete = await model.directChapter(book, book.chapters[0] as Chapter)
    expect(concrete.modelIdentity.profileId).toBe(SELECTED_GEMMA_PROFILE.id)
    expect(concrete.warnings).toEqual([
      expect.objectContaining({
        code: 'unresolved_speaker',
        sourcePassageId: 'passage-002',
        candidateSpeakerId: null,
        usesFallback: true,
        reviewRequired: true,
      }),
    ])
    expect(concrete.parameters).toEqual({
      seed: 42,
      temperature: 0,
      topP: 1,
      maxTokens: 8192,
      confidenceThreshold: 0.8,
    })
    expect(progress.events.at(-1)).toMatchObject({
      state: 'completed',
      completedPassages: 2,
      totalPassages: 2,
      warningCount: 1,
    })
    expect(JSON.stringify(progress.events)).not.toContain('Rain.')
  })

  it('sends exact source passages, split-range schema, fixed parameters, and system prompt', async () => {
    const book = makeBook()
    const { model } = create()
    await model.directChapter(book, book.chapters[0] as Chapter)
    const captured = server.requests.at(-1)
    if (captured === undefined) throw new Error('Fake endpoint did not capture a request')
    expect(captured.headers.authorization).toBe(`Bearer ${API_KEY}`)
    expect(captured.body).toMatchObject({
      model: SELECTED_GEMMA_PROFILE.modelId,
      temperature: 0,
      seed: 42,
      top_p: 1,
      max_tokens: 8192,
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
    const schema = (
      captured.body.response_format as {
        json_schema: { schema: { properties: { segments: { items: { required: string[] } } } } }
      }
    ).json_schema.schema
    expect(schema.properties.segments.items.required).toEqual(
      expect.arrayContaining(['source_passage_id', 'source_start', 'source_end', 'source_text']),
    )
    const messages = captured.body.messages as Array<{ role: string; content: string }>
    const userInput = JSON.parse(
      messages.find((message) => message.role === 'user')?.content ?? '{}',
    ) as Record<string, unknown>
    expect(userInput.passages).toEqual([
      { source_passage_id: 'passage-001', source_text: 'Rain. “Run!”' },
      { source_passage_id: 'passage-002', source_text: '“Who?”' },
    ])
    expect(messages.find((message) => message.role === 'system')?.content).toContain(
      'one or more ordered fragments',
    )
  })

  it('maps low-confidence known speakers to review-visible fallback semantics', async () => {
    const output = validWireOutput()
    const dialogue = output.segments[1]
    if (dialogue === undefined) throw new Error('Missing fixture dialogue')
    dialogue.confidence = 0.79
    server.respondWith(output)
    const book = makeBook()
    const { model } = create()
    const result = await model.directChapter(book, book.chapters[0] as Chapter)

    expect(result.segments[1]?.speakerId).toBeNull()
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'low_confidence_speaker',
        candidateSpeakerId: 'mira',
        confidence: 0.79,
        confidenceThreshold: 0.8,
        usesFallback: true,
        reviewRequired: true,
      }),
    )
  })

  it('classifies malformed/schema-invalid provider output and persists safe failures', async () => {
    const book = makeBook()
    server.setMode('malformed')
    const first = create()
    await expect(
      first.model.directChapter(book, book.chapters[0] as Chapter),
    ).rejects.toMatchObject({
      code: 'malformed_output',
    })
    expect(first.progress.events.at(-1)).toMatchObject({
      state: 'failed',
      error: { code: 'malformed_output', retryable: false },
    })

    server.setMode('schema-invalid')
    const second = create()
    await expect(
      second.model.directChapter(book, book.chapters[0] as Chapter),
    ).rejects.toMatchObject({
      code: 'schema_validation',
    })
    expect(second.progress.events.at(-1)?.state).toBe('failed')
  })

  it('persists useful HTTP errors without retaining provider bodies', async () => {
    server.setMode('http-error')
    const book = makeBook()
    const { model, progress } = create()
    await expect(model.directChapter(book, book.chapters[0] as Chapter)).rejects.toMatchObject({
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

  it('propagates caller cancellation to the endpoint', async () => {
    server.setMode('delay')
    const book = makeBook()
    const { model, progress } = create()
    const controller = new AbortController()
    const result = model.directChapter(book, book.chapters[0] as Chapter, {
      signal: controller.signal,
      timeoutMs: 2_000,
    })
    await waitFor(() => server.requests.length > 0)
    controller.abort(new DOMException('contract cancellation', 'AbortError'))
    await expect(result).rejects.toMatchObject({ code: 'cancelled', retryable: false })
    await waitFor(() => server.abortedRequests > 0)
    expect(progress.events.at(-1)).toMatchObject({
      state: 'cancelled',
      error: { code: 'cancelled' },
    })
  })

  it('release cancels active work, waits for it, invokes lifecycle once, and is idempotent', async () => {
    server.setMode('delay')
    const book = makeBook()
    const { model, lifecycle } = create()
    const direction = model.directChapter(book, book.chapters[0] as Chapter)
    await waitFor(() => server.requests.length > 0)

    const firstRelease = model.release()
    const secondRelease = model.release()
    expect(secondRelease).toBe(firstRelease)
    await expect(direction).rejects.toMatchObject({ code: 'cancelled' })
    await firstRelease
    expect(lifecycle.releaseCalls).toBe(1)
    await waitFor(() => server.abortedRequests > 0)
    expect(() => model.directChapter(book, book.chapters[0] as Chapter)).toThrow(/released/)
    await model.release()
    expect(lifecycle.releaseCalls).toBe(1)
  })
})

describe('deterministic split-fragment validation', () => {
  it('accepts ordered narration/dialogue changes and reconstructs every exact passage', () => {
    const validated = validateDirectionOutput(
      validWireOutput(),
      validationRequest,
      CONFIDENCE_THRESHOLD,
    )
    expect(validated.annotations.map((segment) => segment.kind)).toEqual([
      'narration',
      'dialogue',
      'dialogue',
    ])
    for (const passage of validationRequest.passages) {
      expect(
        validated.annotations
          .filter((segment) => segment.sourcePassageId === passage.id)
          .map((segment) => segment.sourceText)
          .join(''),
      ).toBe(passage.text)
    }
  })

  it.each([
    {
      name: 'gap',
      mutate: (output: ReturnType<typeof validWireOutput>) => {
        output.segments[1] = wireSegment('passage-001', 7, 12, 'Run!”', {
          kind: 'dialogue',
          speaker_id: 'mira',
        })
      },
      code: 'gap',
    },
    {
      name: 'overlap',
      mutate: (output: ReturnType<typeof validWireOutput>) => {
        output.segments[1] = wireSegment('passage-001', 5, 12, ' “Run!”', {
          kind: 'dialogue',
          speaker_id: 'mira',
        })
      },
      code: 'overlap',
    },
    {
      name: 'duplicate range',
      mutate: (output: ReturnType<typeof validWireOutput>) => {
        output.segments.splice(1, 0, wireSegment('passage-001', 0, 6, 'Rain. '))
      },
      code: 'duplicate',
    },
    {
      name: 'passage reorder',
      mutate: (output: ReturnType<typeof validWireOutput>) => {
        const final = output.segments.pop()
        if (final === undefined) throw new Error('Missing final fixture segment')
        output.segments.unshift(final)
      },
      code: 'reorder',
    },
    {
      name: 'invented passage',
      mutate: (output: ReturnType<typeof validWireOutput>) => {
        output.segments[2] = wireSegment('passage-invented', 0, 6, 'Made up')
      },
      code: 'invention',
    },
    {
      name: 'omitted passage',
      mutate: (output: ReturnType<typeof validWireOutput>) => {
        output.segments.pop()
      },
      code: 'omission',
    },
    {
      name: 'rewritten fragment',
      mutate: (output: ReturnType<typeof validWireOutput>) => {
        output.segments[0] = wireSegment('passage-001', 0, 6, 'Storm ')
      },
      code: 'text_mismatch',
    },
  ])('rejects $name', ({ mutate, code }) => {
    const output = validWireOutput()
    mutate(output)
    try {
      validateDirectionOutput(output, validationRequest, CONFIDENCE_THRESHOLD)
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(DirectorFidelityError)
      expect((error as DirectorFidelityError).findings.map((finding) => finding.code)).toContain(
        code,
      )
      return
    }
    throw new Error('Expected deterministic validation failure')
  })

  it('rejects invented speakers and inconsistent fallback semantics', () => {
    const output = validWireOutput()
    output.segments[1] = wireSegment('passage-001', 6, 12, '“Run!”', {
      kind: 'dialogue',
      speaker_id: 'invented-character',
    })
    expect(() => validateDirectionOutput(output, validationRequest, CONFIDENCE_THRESHOLD)).toThrow(
      DirectorFidelityError,
    )

    output.segments[1] = wireSegment('passage-001', 6, 12, '“Run!”', {
      kind: 'dialogue',
      speaker_id: 'fallback-dialogue',
    })
    expect(() => validateDirectionOutput(output, validationRequest, CONFIDENCE_THRESHOLD)).toThrow(
      DirectorFidelityError,
    )

    output.segments[1] = wireSegment('passage-001', 6, 12, '“Run!”', {
      kind: 'dialogue',
      speaker_id: 'narrator',
    })
    expect(() => validateDirectionOutput(output, validationRequest, CONFIDENCE_THRESHOLD)).toThrow(
      DirectorFidelityError,
    )
  })

  it('rejects malformed output before semantic validation', () => {
    try {
      validateDirectionOutput(
        { segments: [{ source_passage_id: 'passage-001' }] },
        validationRequest,
        CONFIDENCE_THRESHOLD,
      )
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
