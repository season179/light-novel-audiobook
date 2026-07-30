import { inspect } from 'node:util'
import type { DirectChapterProgress } from '@light-novel-audiobook/application'
import { Book, Chapter, ExactSourceCoverage, SourcePassage } from '@light-novel-audiobook/domain'
import { DirectorError } from '@light-novel-audiobook/gemma-director'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createOpenAiCloudDirectorIdentity,
  OPENAI_CLOUD_DIRECTOR_PROFILE,
  OpenAiCloudDirectorModel,
  openAiCloudDirectorIdentityMaterial,
} from '../src/index.js'
import { FakeResponsesServer } from './fake-responses-server.js'

const API_KEY = 'fake-openai-key-do-not-leak-0000000001'
const SOURCE = 'Rain\u00a0fell.'

function makeBook(sourceText = SOURCE): Book {
  const chapter = new Chapter({
    id: 'chapter-01',
    bookId: 'book-01',
    position: 1,
    title: 'A Visitor',
    sourcePassages: [
      new SourcePassage({
        id: 'passage-001',
        chapterId: 'chapter-01',
        sourceText,
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

function narrationSegment(sourceText: string, passageId: string): Record<string, unknown> {
  return {
    source_passage_id: passageId,
    source_text: sourceText,
    kind: 'narration',
    confidence: 0.98,
    delivery: {
      emotion: 'calm',
      pace: 'normal',
      volume: 'normal',
      pause_after_ms: 250,
    },
  }
}

function narrationOutput(
  sourceText = 'Rain fell.',
  passageId = 'passage-001',
): Record<string, unknown> {
  return { segments: [narrationSegment(sourceText, passageId)] }
}

function multiPassageOutput(
  passages: ReadonlyArray<{ readonly id: string; readonly text: string }>,
): Record<string, unknown> {
  return {
    segments: passages.map((passage) => narrationSegment(passage.text, passage.id)),
  }
}

function makeMultiWindowBook(): Book {
  const chapter = new Chapter({
    id: 'chapter-01',
    bookId: 'book-01',
    position: 1,
    title: 'Three Moments',
    sourcePassages: ['First.', 'Second.', 'Third.'].map(
      (sourceText, index) =>
        new SourcePassage({
          id: `passage-00${index + 1}`,
          chapterId: 'chapter-01',
          sourceText,
        }),
    ),
  })
  return new Book({
    id: 'book-01',
    title: 'Synthetic Window Fixture',
    author: null,
    coverPath: null,
    source: { epubPath: '/private/synthetic-window.epub', sha256: 'b'.repeat(64) },
    chapters: [chapter],
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('Timed out waiting for fake endpoint state')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('OpenAiCloudDirectorModel Responses contract', () => {
  let server: FakeResponsesServer
  let models: OpenAiCloudDirectorModel[]
  let officialRequestUrls: string[]

  beforeEach(async () => {
    server = new FakeResponsesServer()
    server.respondWith(narrationOutput())
    await server.start()
    models = []
    officialRequestUrls = []
  })

  afterEach(async () => {
    await Promise.allSettled(models.map(async (model) => await model.release()))
    await server.stop()
  })

  const redirectingFetch: typeof globalThis.fetch = async (input, init) => {
    const requestedUrl = input instanceof Request ? input.url : String(input)
    officialRequestUrls.push(requestedUrl)
    return await globalThis.fetch(`${server.baseUrl}/responses`, init)
  }

  const create = (apiKey = API_KEY): OpenAiCloudDirectorModel => {
    const model = new OpenAiCloudDirectorModel({
      apiKey,
      fetch: redirectingFetch,
      confidenceThreshold: 0.8,
      contextProvider: {
        forChapter: async () => ({
          speakers: [{ id: 'mira', aliases: ['Mira'] }],
          narratorSpeakerId: 'narrator',
          fallbackSpeakerId: 'fallback-dialogue',
        }),
      },
    })
    models.push(model)
    return model
  }

  it('sends the exact strict OpenAI Responses request and no unsupported sampling fields', async () => {
    const book = makeBook()
    await create().directChapter(book, book.chapters[0] as Chapter)

    expect(server.requests).toHaveLength(1)
    const captured = server.requests[0]
    if (captured === undefined) throw new Error('Fake Responses endpoint captured no request')
    expect(officialRequestUrls).toEqual(['https://api.openai.com/v1/responses'])
    expect(captured.url).toBe('/v1/responses')
    expect(captured.headers.authorization).toBe(`Bearer ${API_KEY}`)
    expect(captured.body).toMatchObject({
      model: 'gpt-5.6-luna',
      reasoning: { effort: 'low' },
      max_output_tokens: 8_192,
      store: false,
      stream: true,
      text: {
        format: {
          type: 'json_schema',
          name: 'structured_output',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['segments'],
          },
        },
      },
    })
    expect(captured.body).not.toHaveProperty('temperature')
    expect(captured.body).not.toHaveProperty('top_p')
    expect(captured.body).not.toHaveProperty('seed')
    expect(captured.body.reasoning).not.toHaveProperty('summary')
    const format = (captured.body.text as { format: { schema: Record<string, unknown> } }).format
    const serializedSchema = JSON.stringify(format.schema)
    expect(serializedSchema).toContain('mira')
    expect(serializedSchema).not.toContain('narrator')
    expect(serializedSchema).not.toContain('fallback-dialogue')
    expect(JSON.stringify(captured.body)).toContain(SOURCE)
  })

  it('repairs the narrowly allowed source echo and then passes exact fidelity', async () => {
    const book = makeBook()
    const result = await create().directChapter(book, book.chapters[0] as Chapter)

    expect(result.modelIdentity).toEqual({
      adapter: 'tanstack-ai-openai-compatible-responses',
      provider: 'openai',
      profileId: 'openai-gpt-5.6-luna-low',
      modelId: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      reasoningSummary: false,
      maxOutputTokens: 8_192,
      store: false,
      promptVersion: 'gemma-director@4',
      schemaVersion: 'gemma-direction-output@4',
    })
    expect(result.segments).toHaveLength(1)
    expect(result.segments[0]?.sourceText).toBe(SOURCE)
    expect(() =>
      ExactSourceCoverage.createSegments(book.chapters[0] as Chapter, result.segments),
    ).not.toThrow()
  })

  it('stitches contiguous exact source and honest progress across multiple windows', async () => {
    const book = makeMultiWindowBook()
    server.respondInSequence([
      multiPassageOutput([
        { id: 'passage-001', text: 'First.' },
        { id: 'passage-002', text: 'Second.' },
      ]),
      multiPassageOutput([{ id: 'passage-003', text: 'Third.' }]),
    ])
    const progress: DirectChapterProgress[] = []
    const model = new OpenAiCloudDirectorModel({
      apiKey: API_KEY,
      fetch: redirectingFetch,
      confidenceThreshold: 0.8,
      chunking: { windowPassageBudget: 2 },
      contextProvider: {
        forChapter: async () => ({
          speakers: [],
          narratorSpeakerId: 'narrator',
          fallbackSpeakerId: 'fallback-dialogue',
        }),
      },
    })
    models.push(model)

    const result = await model.directChapter(book, book.chapters[0] as Chapter, {
      onProgress: (event) => {
        progress.push(event)
      },
    })

    expect(server.requests).toHaveLength(2)
    expect(result.segments.map((segment) => segment.sourcePassageId)).toEqual([
      'passage-001',
      'passage-002',
      'passage-003',
    ])
    expect(result.segments.map((segment) => segment.sourceText).join('')).toBe(
      'First.Second.Third.',
    )
    expect(() =>
      ExactSourceCoverage.createSegments(book.chapters[0] as Chapter, result.segments),
    ).not.toThrow()
    expect(
      progress
        .filter((event) => event.state === 'requesting')
        .map((event) => event.completedPassages),
    ).toEqual([0, 2])
    expect(progress.at(-1)).toMatchObject({
      state: 'completed',
      completedPassages: 3,
      totalPassages: 3,
    })
  })

  it('blocks fidelity failures without an identical cloud rerequest', async () => {
    server.respondWith(narrationOutput('Rain changed.'))
    const book = makeBook()
    const error = await create()
      .directChapter(book, book.chapters[0] as Chapter)
      .then(
        () => undefined,
        (caught: unknown) => caught,
      )

    expect(error).toBeInstanceOf(DirectorError)
    expect((error as DirectorError).code).toBe('fidelity')
    expect((error as Error).message).toContain('deterministic fidelity validation')
    expect(server.requests).toHaveLength(1)
  })

  it.each([
    ['malformed', 'malformed_output'],
    ['schema-invalid', 'schema_validation'],
    ['http-error', 'http'],
    ['refusal', 'model'],
  ] as const)('classifies and sanitizes %s failures', async (mode, code) => {
    server.setMode(mode)
    const book = makeBook()
    const error = await create()
      .directChapter(book, book.chapters[0] as Chapter)
      .then(
        () => undefined,
        (caught: unknown) => caught,
      )

    expect(error).toBeInstanceOf(DirectorError)
    expect((error as DirectorError).code).toBe(code)
    const rendered = inspect(error, { depth: 20 })
    expect(rendered).not.toContain(API_KEY)
    expect(rendered).not.toContain('raw-provider-secret')
    expect(rendered).not.toContain('raw-source-excerpt')
    expect(rendered).not.toContain(SOURCE)
  })

  it('forces SDK logging off even when OPENAI_LOG is hostile', async () => {
    server.setMode('http-error')
    vi.stubEnv('OPENAI_LOG', 'debug')
    const spies = (['debug', 'info', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    )
    try {
      const identityBefore = create().identity
      const book = makeBook()
      await create()
        .directChapter(book, book.chapters[0] as Chapter)
        .catch(() => undefined)
      expect(create().identity).toBe(identityBefore)
      const logged = inspect(
        spies.flatMap((spy) => spy.mock.calls),
        { depth: 20 },
      )
      expect(logged).toBe('[]')
      expect(logged).not.toContain(API_KEY)
      expect(logged).not.toContain('raw-provider-secret')
      expect(logged).not.toContain('raw-source-excerpt')
      expect(logged).not.toContain(SOURCE)
    } finally {
      for (const spy of spies) spy.mockRestore()
      vi.unstubAllEnvs()
    }
  })

  it('aborts the in-flight Responses stream on caller cancellation', async () => {
    server.setMode('delay')
    const book = makeBook()
    const controller = new AbortController()
    const pending = create().directChapter(book, book.chapters[0] as Chapter, {
      signal: controller.signal,
    })
    await waitFor(() => server.requests.length === 1)
    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    await waitFor(() => server.abortedRequests > 0)
  })

  it('classifies a timer-first request abort as timeout, not cancellation', async () => {
    server.setMode('delay')
    const model = new OpenAiCloudDirectorModel({
      apiKey: API_KEY,
      confidenceThreshold: 0.8,
      requestTimeoutMs: 10,
      fetch: redirectingFetch,
      contextProvider: {
        forChapter: async () => ({
          speakers: [],
          narratorSpeakerId: 'narrator',
          fallbackSpeakerId: 'fallback-dialogue',
        }),
      },
    })
    models.push(model)
    const book = makeBook()

    await expect(model.directChapter(book, book.chapters[0] as Chapter)).rejects.toMatchObject({
      code: 'timeout',
      retryable: true,
    })
    await waitFor(() => server.abortedRequests > 0)
  })

  it('keeps caller cancellation authoritative when the timeout clock also expires', async () => {
    let fetchStarted = false
    const delayedAbortFetch: typeof globalThis.fetch = async (_input, init) => {
      fetchStarted = true
      return await new Promise<Response>((_resolve, reject) => {
        const rejectLater = () =>
          setTimeout(() => reject(new Error('delayed abort settlement')), 30)
        init?.signal?.addEventListener('abort', rejectLater, { once: true })
        if (init?.signal?.aborted) rejectLater()
      })
    }
    const model = new OpenAiCloudDirectorModel({
      apiKey: API_KEY,
      confidenceThreshold: 0.8,
      requestTimeoutMs: 10,
      fetch: delayedAbortFetch,
      contextProvider: {
        forChapter: async () => ({
          speakers: [],
          narratorSpeakerId: 'narrator',
          fallbackSpeakerId: 'fallback-dialogue',
        }),
      },
    })
    models.push(model)
    const book = makeBook()
    const controller = new AbortController()
    const pending = model.directChapter(book, book.chapters[0] as Chapter, {
      signal: controller.signal,
    })
    await waitFor(() => fetchStarted)
    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('keeps credentials, source, and provider data out of identity and progress', async () => {
    const progress: DirectChapterProgress[] = []
    const book = makeBook('UNIQUE_PRIVATE_SOURCE_113')
    server.respondWith(narrationOutput('UNIQUE_PRIVATE_SOURCE_113'))
    const first = create(API_KEY)
    const second = create('different-key-that-must-not-affect-identity')
    const result = await first.directChapter(book, book.chapters[0] as Chapter, {
      onProgress: (event) => {
        progress.push(event)
      },
    })

    expect(first.identity).toBe(second.identity)
    const safeSurface = JSON.stringify({
      identity: first.identity,
      modelIdentity: result.modelIdentity,
      parameters: result.parameters,
      progress,
    })
    expect(safeSurface).not.toContain(API_KEY)
    expect(safeSurface).not.toContain('UNIQUE_PRIVATE_SOURCE_113')
    expect(safeSurface).not.toContain('raw-provider-secret')
  })
})

describe('OpenAI cloud identity', () => {
  it('honestly binds the fixed profile without inventing model provenance', () => {
    const settings = { confidenceThreshold: 0.5 }
    const material = openAiCloudDirectorIdentityMaterial(settings)

    expect(createOpenAiCloudDirectorIdentity(settings)).toMatch(/^[a-f0-9]{64}$/u)
    expect(material).toMatchObject({
      adapter: {
        api: 'responses',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        maxRetries: 0,
      },
      model: { profileId: 'openai-gpt-5.6-luna-low', modelId: 'gpt-5.6-luna' },
      generation: {
        reasoning: { effort: 'low' },
        reasoningSummary: false,
        maxOutputTokens: OPENAI_CLOUD_DIRECTOR_PROFILE.maxOutputTokens,
        store: false,
        temperature: 'omitted',
        topP: 'omitted',
        seed: 'omitted',
        confidenceThreshold: 0.5,
      },
      fidelity: { deterministicExactSourceValidation: true, rerequests: 0 },
    })
    expect(material.model).not.toHaveProperty('revision')
    expect(material.model).not.toHaveProperty('sha256')
    expect(JSON.stringify(material)).not.toContain('apiKey')
  })
})
