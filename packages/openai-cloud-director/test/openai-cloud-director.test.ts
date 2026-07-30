import { inspect } from 'node:util'
import type { DirectChapterProgress } from '@light-novel-audiobook/application'
import { Book, Chapter, ExactSourceCoverage, SourcePassage } from '@light-novel-audiobook/domain'
import {
  DirectorError,
  DirectorFidelityError,
  parseDirectionRequest,
} from '@light-novel-audiobook/gemma-director'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createOpenAiCloudDirectorIdentity,
  OPENAI_CLOUD_DIRECTOR_PROFILE,
  OpenAiCloudDirectorModel,
  openAiCloudDirectorIdentityMaterial,
} from '../src/index.js'
import { executeOpenAiCloudWindow } from '../src/request.js'
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

function makeTwoPassageBook(sourceTexts: readonly [string, string] = ['First.', 'Second.']): Book {
  const chapter = new Chapter({
    id: 'chapter-01',
    bookId: 'book-01',
    position: 1,
    title: 'Two Passages',
    sourcePassages: sourceTexts.map(
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
    title: 'Two-Passage Fixture',
    author: null,
    coverPath: null,
    source: { epubPath: '/private/two-passage.epub', sha256: 'c'.repeat(64) },
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

  it('repairs a quote-free dropped tail on attempt 1 and surfaces IDs without source text', async () => {
    const source = 'Mira crossed the room quietly.'
    server.respondWith(narrationOutput('Mira crossed the room'))
    const progress: DirectChapterProgress[] = []
    const book = makeBook(source)

    const result = await create().directChapter(book, book.chapters[0] as Chapter, {
      onProgress: (event) => {
        progress.push(event)
      },
    })

    expect(server.requests).toHaveLength(1)
    expect(result.segments).toHaveLength(2)
    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      'Mira crossed the room',
      ' quietly.',
    ])
    expect(result.segments[1]).toMatchObject({
      sourcePassageId: 'passage-001',
      kind: 'narration',
      speakerId: null,
      confidence: 1,
      delivery: {
        emotion: 'neutral',
        pace: 'normal',
        volume: 'normal',
        pauseAfterMs: 0,
      },
    })
    expect(() =>
      ExactSourceCoverage.createSegments(book.chapters[0] as Chapter, result.segments),
    ).not.toThrow()

    const repairMessages = progress
      .filter((event) => event.message.startsWith('Repaired '))
      .map((event) => event.message)
    expect(repairMessages).toEqual([
      'Repaired 1 narration tail(s) in window 1 of 1 (attempt 1 of 3); modes: 0 attach-to-previous, 1 synthesize-narration, 0 merge-whitespace-segment; passage IDs: passage-001',
    ])
    expect(repairMessages.join('\n')).not.toContain(source)
    expect(repairMessages.join('\n')).not.toContain('quietly')
  })

  it('reports all three repair-mode counts without source text', async () => {
    const sources = ['First middle.', 'Second. ', 'Third ending.'] as const
    server.respondWith({
      segments: [
        narrationSegment('First', 'passage-001'),
        narrationSegment(' ', 'passage-001'),
        narrationSegment('middle.', 'passage-001'),
        narrationSegment('Second.', 'passage-002'),
        narrationSegment('Third', 'passage-003'),
      ],
    })
    const progress: DirectChapterProgress[] = []
    const book = new Book({
      id: 'book-01',
      title: 'Three-Mode Fixture',
      author: null,
      coverPath: null,
      source: { epubPath: '/private/three-mode.epub', sha256: 'f'.repeat(64) },
      chapters: [
        new Chapter({
          id: 'chapter-01',
          bookId: 'book-01',
          position: 1,
          title: 'Three Modes',
          sourcePassages: sources.map(
            (sourceText, index) =>
              new SourcePassage({
                id: `passage-00${index + 1}`,
                chapterId: 'chapter-01',
                sourceText,
              }),
          ),
        }),
      ],
    })

    await create().directChapter(book, book.chapters[0] as Chapter, {
      onProgress: (event) => {
        progress.push(event)
      },
    })

    const repairMessages = progress
      .filter((event) => event.message.startsWith('Repaired '))
      .map((event) => event.message)
    expect(repairMessages).toEqual([
      'Repaired 3 narration tail(s) in window 1 of 1 (attempt 1 of 3); modes: 1 attach-to-previous, 1 synthesize-narration, 1 merge-whitespace-segment; passage IDs: passage-001, passage-002, passage-003',
    ])
    for (const source of sources) expect(repairMessages.join('\n')).not.toContain(source)
    expect(repairMessages.join('\n')).not.toContain('First')
    expect(repairMessages.join('\n')).not.toContain('Second')
    expect(repairMessages.join('\n')).not.toContain('Third')
  })

  it('includes each repair mode in per-window output provenance', async () => {
    const request = parseDirectionRequest({
      requestId: 'request-provenance',
      bookId: 'book-provenance',
      bookTitle: 'Synthetic Provenance Fixture',
      bookAuthor: null,
      bookSourceSha256: 'e'.repeat(64),
      chapterId: 'chapter-provenance',
      chapterPosition: 1,
      chapterTitle: 'Three Modes',
      passages: [
        { id: 'passage-001', text: 'First middle.' },
        { id: 'passage-002', text: 'Second. ' },
        { id: 'passage-003', text: 'Third ending.' },
      ],
      speakers: [],
      narratorSpeakerId: 'narrator',
      fallbackSpeakerId: 'fallback-dialogue',
    })
    server.respondWith({
      segments: [
        narrationSegment('First', 'passage-001'),
        narrationSegment(' ', 'passage-001'),
        narrationSegment('middle.', 'passage-001'),
        narrationSegment('Second.', 'passage-002'),
        narrationSegment('Third', 'passage-003'),
      ],
    })

    const result = await executeOpenAiCloudWindow(
      {
        apiKey: API_KEY,
        confidenceThreshold: 0.8,
        directorIdentity: 'synthetic-director-identity',
        fetch: redirectingFetch,
        shutdownSignal: new AbortController().signal,
      },
      request,
      { timeoutMs: 1_000 },
    )

    expect(result.outputIdentity).toMatchObject({
      narrationTailCompletionRepairs: [
        {
          sourcePassageId: 'passage-001',
          appendedCodeUnitCount: 1,
          mode: 'merge-whitespace-segment',
        },
        {
          sourcePassageId: 'passage-002',
          appendedCodeUnitCount: 1,
          mode: 'attach-to-previous',
        },
        {
          sourcePassageId: 'passage-003',
          appendedCodeUnitCount: ' ending.'.length,
          mode: 'synthesize-narration',
        },
      ],
    })
  })

  it('does not repair a quoted dropped tail and exhausts the existing retry budget', async () => {
    const source = 'He waited. "No."'
    server.respondWith(narrationOutput('He waited. '))
    const progress: DirectChapterProgress[] = []
    const book = makeBook(source)
    const error = await create()
      .directChapter(book, book.chapters[0] as Chapter, {
        onProgress: (event) => {
          progress.push(event)
        },
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      )

    expect(error).toBeInstanceOf(DirectorFidelityError)
    expect(server.requests).toHaveLength(3)
    expect(progress.some((event) => event.message.startsWith('Repaired '))).toBe(false)
  })

  it('applies tail completion on every retry attempt before unchanged validation', async () => {
    server.respondInSequence([
      multiPassageOutput([
        { id: 'passage-001', text: 'First' },
        { id: 'passage-002', text: 'Second changed.' },
      ]),
      multiPassageOutput([
        { id: 'passage-001', text: 'First' },
        { id: 'passage-002', text: 'Second.' },
      ]),
    ])
    const progress: DirectChapterProgress[] = []
    const book = makeTwoPassageBook()

    const result = await create().directChapter(book, book.chapters[0] as Chapter, {
      onProgress: (event) => {
        progress.push(event)
      },
    })

    expect(server.requests).toHaveLength(2)
    expect(result.segments.map((segment) => segment.sourceText)).toEqual(['First', '.', 'Second.'])
    expect(
      progress
        .filter((event) => event.message.startsWith('Repaired '))
        .map((event) => event.message),
    ).toEqual([
      'Repaired 1 narration tail(s) in window 1 of 1 (attempt 1 of 3); modes: 0 attach-to-previous, 1 synthesize-narration, 0 merge-whitespace-segment; passage IDs: passage-001',
      'Repaired 1 narration tail(s) in window 1 of 1 (attempt 2 of 3); modes: 0 attach-to-previous, 1 synthesize-narration, 0 merge-whitespace-segment; passage IDs: passage-001',
    ])
  })

  it('does not turn an entirely omitted passage into a synthesized segment', async () => {
    server.respondWith(multiPassageOutput([{ id: 'passage-002', text: 'Second.' }]))
    const progress: DirectChapterProgress[] = []
    const book = makeTwoPassageBook()
    const error = await create()
      .directChapter(book, book.chapters[0] as Chapter, {
        onProgress: (event) => {
          progress.push(event)
        },
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      )

    expect(error).toBeInstanceOf(DirectorFidelityError)
    expect(server.requests).toHaveLength(3)
    expect(progress.some((event) => event.message.startsWith('Repaired '))).toBe(false)
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

  it('exhausts bounded retries on persistent fidelity failures and fails closed', async () => {
    // Each attempt corrupts a different passage, so the findings are distinguishable per attempt.
    // Attempt 3 corrupts passage-002; a stale first/second-attempt error would reference passage-001.
    server.respondInSequence([
      multiPassageOutput([
        { id: 'passage-001', text: 'First changed.' },
        { id: 'passage-002', text: 'Second.' },
      ]),
      multiPassageOutput([
        { id: 'passage-001', text: 'First changed.' },
        { id: 'passage-002', text: 'Second.' },
      ]),
      multiPassageOutput([
        { id: 'passage-001', text: 'First.' },
        { id: 'passage-002', text: 'Second changed.' },
      ]),
    ])
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
    const book = makeTwoPassageBook()
    const error = await model.directChapter(book, book.chapters[0] as Chapter).then(
      () => undefined,
      (caught: unknown) => caught,
    )

    // The final error is the DirectorFidelityError subclass (not just the base class) and carries
    // the FINAL attempt's findings — proving exhaustion throws the current attempt's error, not a
    // cached first/second-attempt error.
    expect(error).toBeInstanceOf(DirectorFidelityError)
    expect((error as DirectorError).code).toBe('fidelity')
    expect((error as Error).message).toContain('deterministic fidelity validation')
    const findings = (error as DirectorFidelityError).findings.map(
      (finding) => finding.sourcePassageId,
    )
    expect(findings).toContain('passage-002')
    expect(findings).not.toContain('passage-001')
    // Three total attempts (one initial + two bounded rerequests); the deterministic validator
    // is unchanged, so fail-closed still surfaces the same error class/shape as before.
    expect(server.requests).toHaveLength(3)
  })

  it('retries a single stochastic fidelity failure and then completes the chapter', async () => {
    server.respondInSequence([narrationOutput('Rain changed.'), narrationOutput()])
    const progress: DirectChapterProgress[] = []
    const book = makeBook()
    const result = await create().directChapter(book, book.chapters[0] as Chapter, {
      onProgress: (event) => {
        progress.push(event)
      },
    })

    expect(server.requests).toHaveLength(2)
    expect(result.segments).toHaveLength(1)
    expect(result.segments[0]?.sourceText).toBe(SOURCE)
    expect(() =>
      ExactSourceCoverage.createSegments(book.chapters[0] as Chapter, result.segments),
    ).not.toThrow()

    // The retry is observable through the progress sink and carries no passage IDs or source text —
    // only bounded values (window ordinal, finding codes, attempt budget, passage count).
    const retryEvents = progress.filter(
      (event) => event.state === 'requesting' && event.message.startsWith('Retrying window'),
    )
    expect(retryEvents).toHaveLength(1)
    expect(retryEvents[0]?.message).toContain('fidelity findings')
    expect(retryEvents[0]?.message).toContain('attempt 2 of 3')
    expect(retryEvents[0]?.message).toContain('window has 1 passage')
    expect(retryEvents[0]?.message).not.toContain('passage-001')
    expect(retryEvents[0]?.message).not.toContain(SOURCE)
    expect(retryEvents[0]?.message).not.toContain('Rain')
  })

  it('exhausts bounded retries on persistent malformed output and fails closed', async () => {
    server.setMode('malformed')
    const progress: DirectChapterProgress[] = []
    const book = makeBook()
    const error = await create()
      .directChapter(book, book.chapters[0] as Chapter, {
        onProgress: (event) => {
          progress.push(event)
        },
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      )

    expect(error).toBeInstanceOf(DirectorError)
    expect((error as DirectorError).code).toBe('malformed_output')
    expect(server.requests).toHaveLength(3)
    // Both malformed-output retry notices are text-free and carry no credentials.
    const retryMessages = progress
      .filter(
        (event) => event.state === 'requesting' && event.message.startsWith('Retrying window'),
      )
      .map((event) => event.message)
    expect(retryMessages).toHaveLength(2)
    expect(retryMessages.join('\n')).toContain('malformed output')
    expect(retryMessages.join('\n')).toContain('window has 1 passage')
    expect(retryMessages.join('\n')).not.toContain('passage-001')
    expect(retryMessages.join('\n')).not.toContain(SOURCE)
    expect(retryMessages.join('\n')).not.toContain(API_KEY)
  })

  it('does not retry non-stochastic failures such as schema validation', async () => {
    server.setMode('schema-invalid')
    const book = makeBook()
    const error = await create()
      .directChapter(book, book.chapters[0] as Chapter)
      .then(
        () => undefined,
        (caught: unknown) => caught,
      )

    expect(error).toBeInstanceOf(DirectorError)
    expect((error as DirectorError).code).toBe('schema_validation')
    expect(server.requests).toHaveLength(1)
  })

  it('does not retry transport or auth failures such as HTTP errors', async () => {
    server.setMode('http-error')
    const book = makeBook()
    const error = await create()
      .directChapter(book, book.chapters[0] as Chapter)
      .then(
        () => undefined,
        (caught: unknown) => caught,
      )

    expect(error).toBeInstanceOf(DirectorError)
    expect((error as DirectorError).code).toBe('http')
    // Transport/auth/rate-limit failures are not stochastic-validations and must not be retried.
    expect(server.requests).toHaveLength(1)
  })

  it('retries twice and completes when only the third attempt passes', async () => {
    server.respondInSequence([
      narrationOutput('Rain changed.'),
      narrationOutput('Rain stormed.'),
      narrationOutput(),
    ])
    const book = makeBook()
    const result = await create().directChapter(book, book.chapters[0] as Chapter)

    // Three requests, and the accepted output is the third attempt's (the only one that passed).
    expect(server.requests).toHaveLength(3)
    expect(result.segments).toHaveLength(1)
    expect(result.segments[0]?.sourceText).toBe(SOURCE)
    expect(() =>
      ExactSourceCoverage.createSegments(book.chapters[0] as Chapter, result.segments),
    ).not.toThrow()
  })

  it('does not start a retry after its progress callback exhausts the chapter deadline', async () => {
    server.respondWith(narrationOutput('Rain changed.'))
    const book = makeBook()
    const error = await create()
      .directChapter(book, book.chapters[0] as Chapter, {
        timeoutMs: 100,
        onProgress: async (event) => {
          // A slow retry-progress sink exhausts the chapter deadline during the retry notice.
          if (event.message.startsWith('Retrying window')) {
            await new Promise((resolve) => setTimeout(resolve, 300))
          }
        },
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      )

    // Attempt 1 failed fidelity (1 request); the retry must not start once its progress callback
    // has exhausted the deadline, and the chapter fails with the same timeout error as today.
    expect(server.requests).toHaveLength(1)
    expect(error).toBeInstanceOf(DirectorError)
    expect((error as DirectorError).code).toBe('timeout')
    expect((error as DirectorError).retryable).toBe(true)
  })

  it('does not retry or accept output when the caller signal is pre-aborted', async () => {
    server.respondWith(narrationOutput())
    const book = makeBook()
    const controller = new AbortController()
    controller.abort()
    const error = await create()
      .directChapter(book, book.chapters[0] as Chapter, { signal: controller.signal })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      )

    expect(error).toBeInstanceOf(DirectorError)
    expect((error as DirectorError).code).toBe('cancelled')
    // At most one request (the fetch may be initiated and immediately aborted); never retried.
    expect(server.requests.length).toBeLessThanOrEqual(1)
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
    // A cancelled attempt is never retried: the chapter surfaces exactly one request.
    expect(server.requests).toHaveLength(1)
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

    // Deliberately unchanged for resume compatibility: the old whitespace-only synthesized branch
    // could never pass application splitting and therefore could not persist a chapter checkpoint.
    expect(createOpenAiCloudDirectorIdentity(settings)).toBe(
      '9e0d2cf25e51b3a9d471baa2373e8bc0a347b7f7f8a0a60172774ed7aae9686a',
    )
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
