import type { Chapter, DirectedSegment } from '@light-novel-audiobook/domain'
import {
  Book,
  Chapter as DomainChapter,
  ExactSourceCoverage,
  SourcePassage,
} from '@light-novel-audiobook/domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DirectionChunkingSettings } from '../src/chunking.js'
import { DirectorError } from '../src/errors.js'
import { GemmaDirectorModel } from '../src/gemma-director-model.js'
import type {
  DirectorProgressEvent,
  DirectorProgressStore,
  DirectorRuntimeLifecycle,
  ExclusiveGpuLeaseCoordinator,
  GpuLease,
  GpuOwner,
} from '../src/index.js'
import { type Oracle, type OracleFragment, OracleLlamaServer } from './oracle-llama-server.js'

const API_KEY = 'fake-server-side-key-0000000001'
const CONFIDENCE_THRESHOLD = 0.8

class MemoryProgressStore implements DirectorProgressStore {
  readonly events: DirectorProgressEvent[] = []
  async append(event: DirectorProgressEvent): Promise<void> {
    this.events.push(event)
  }
}

class FakeLifecycle implements DirectorRuntimeLifecycle {
  async start(): Promise<void> {}
  async release(): Promise<void> {}
}

class FakeGpuLeaseCoordinator implements ExclusiveGpuLeaseCoordinator {
  readonly lockFilePath = '/fixture/shared-gpu/exclusive.lock'
  async acquire(owner: GpuOwner): Promise<GpuLease> {
    return { owner, lockFilePath: this.lockFilePath, release: async () => {} }
  }
}

function makeChapterBook(
  passageTexts: readonly string[],
  ids: readonly string[] = passageTexts.map(
    (_, index) => `passage-${String(index + 1).padStart(3, '0')}`,
  ),
): Book {
  const chapter = new DomainChapter({
    id: 'chapter-01',
    bookId: 'book-01',
    position: 1,
    title: 'Windowed',
    sourcePassages: passageTexts.map(
      (text, index) =>
        new SourcePassage({
          id: ids[index] as string,
          chapterId: 'chapter-01',
          sourceText: text,
        }),
    ),
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

/** One narration fragment covering the whole passage; splits alternate narration/dialogue. */
function oracleFor(ids: readonly string[], texts: readonly string[], splitEvery = 0): Oracle {
  const oracle = new Map<string, readonly OracleFragment[]>()
  ids.forEach((id, index) => {
    const text = texts[index] as string
    if (splitEvery > 0 && text.length >= 2) {
      const cut = Math.floor(text.length / 2)
      oracle.set(id, [
        {
          start: 0,
          end: cut,
          kind: 'narration',
          speaker: 'narrator',
          unresolved: false,
          confidence: 0.95,
        },
        {
          start: cut,
          end: text.length,
          kind: 'dialogue',
          speaker: 'mira',
          unresolved: false,
          confidence: 0.95,
        },
      ])
      return
    }
    oracle.set(id, [
      {
        start: 0,
        end: text.length,
        kind: 'narration',
        speaker: 'narrator',
        unresolved: false,
        confidence: 0.95,
      },
    ])
  })
  return oracle
}

describe('GemmaDirectorModel passage-window chunking (issue #53)', () => {
  let server: OracleLlamaServer
  let models: GemmaDirectorModel[]

  beforeEach(() => {
    models = []
  })

  afterEach(async () => {
    await Promise.allSettled(models.map(async (model) => await model.release()))
    await server?.stop()
  })

  const create = (
    chunking: Partial<DirectionChunkingSettings> = {},
    storyContext = 'Mira travels with the party.',
  ): { model: GemmaDirectorModel; progress: MemoryProgressStore } => {
    const progress = new MemoryProgressStore()
    const model = new GemmaDirectorModel({
      baseUrl: server.baseUrl,
      apiKey: API_KEY,
      confidenceThreshold: CONFIDENCE_THRESHOLD,
      contextProvider: {
        forChapter: async () => ({
          speakers: [{ id: 'mira', aliases: ['Mira'] }],
          narratorSpeakerId: 'narrator',
          fallbackSpeakerId: 'fallback-dialogue',
          storyContext,
        }),
      },
      progressStore: progress,
      lifecycle: new FakeLifecycle(),
      gpuLeaseCoordinator: new FakeGpuLeaseCoordinator(),
      gpuLeaseLockFilePath: '/fixture/shared-gpu/exclusive.lock',
      chunking,
    })
    models.push(model)
    return { model, progress }
  }

  it('directs a chapter in one-passage windows and stitches exact coverage in order', async () => {
    const texts = [
      'Rain fell on the roof.',
      '“We should go,” Mira said.',
      'The road north was empty.',
      'A crow watched them pass.',
      '“Not yet.”',
      'By dusk they reached the gate.',
      'Nobody asked questions.',
    ]
    const ids = texts.map((_, index) => `passage-${String(index + 1).padStart(3, '0')}`)
    server = new OracleLlamaServer(oracleFor(ids, texts, 1))
    await server.start()
    const book = makeChapterBook(texts, ids)
    const { model, progress } = create({ windowPassageBudget: 1 })

    const result = await model.directChapter(book, book.chapters[0] as Chapter)

    // Seven windows, seven requests, and the requested passage lists concatenate to the exact
    // chapter in exact order: the boundary cannot lose, duplicate, or reorder a passage.
    expect(server.requests).toHaveLength(texts.length)
    expect(
      server.requests.flatMap((request) => request.passages.map((p) => p.source_passage_id)),
    ).toEqual(ids)
    // Every window carries the roster's story context.
    for (const request of server.requests) {
      expect(request.storyContext).toBe('Mira travels with the party.')
    }

    const chapter = book.chapters[0] as Chapter
    expect(() => ExactSourceCoverage.createSegments(chapter, result.segments)).not.toThrow()
    // Fragments arrive in window order: passage 1 fragments, then passage 2 fragments, ...
    const grouped = new Map<string, DirectedSegment[]>()
    for (const segment of result.segments) {
      const list = grouped.get(segment.sourcePassageId) ?? []
      list.push(segment)
      grouped.set(segment.sourcePassageId, list)
    }
    expect([...grouped.keys()]).toEqual(ids)
    for (const [index, id] of ids.entries()) {
      expect((grouped.get(id) ?? []).map((segment) => segment.sourceText).join('')).toBe(
        texts[index],
      )
    }

    // Chapter-level progress brackets per-window events with cumulative passage counts.
    expect(progress.events[0]).toMatchObject({ state: 'started', completedPassages: 0 })
    expect(progress.events.at(-1)).toMatchObject({
      state: 'completed',
      completedPassages: texts.length,
      totalPassages: texts.length,
    })
    expect(progress.events.filter((event) => event.state === 'failed')).toHaveLength(0)
    const requesting = progress.events.filter((event) => event.state === 'requesting')
    expect(requesting).toHaveLength(texts.length)
    // Sequence numbers stay monotonic across windows.
    const sequences = progress.events.map((event) => event.sequence)
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences)
  })

  it('sends an over-budget single passage as a solo window', async () => {
    const texts = ['Short one.', `Long ${'passage '.repeat(700)}here.`, 'Short two.']
    const ids = texts.map((_, index) => `passage-${String(index + 1).padStart(3, '0')}`)
    server = new OracleLlamaServer(oracleFor(ids, texts))
    await server.start()
    const book = makeChapterBook(texts, ids)
    const { model } = create({ windowCharBudget: 100, outputCharsBudget: 1_000_000 })

    const result = await model.directChapter(book, book.chapters[0] as Chapter)

    expect(server.requests).toHaveLength(3)
    expect(server.requests[1]?.passages.map((p) => p.source_passage_id)).toEqual([ids[1]])
    expect(() =>
      ExactSourceCoverage.createSegments(book.chapters[0] as Chapter, result.segments),
    ).not.toThrow()
  })

  it('shrinks windows pre-flight when the measured prompt would exceed the context budget', async () => {
    const texts = Array.from({ length: 8 }, (_, index) => `P${index} ${'text '.repeat(500)}end.`)
    const ids = texts.map((_, index) => `passage-${String(index + 1).padStart(3, '0')}`)
    server = new OracleLlamaServer(oracleFor(ids, texts))
    await server.start()
    const book = makeChapterBook(texts, ids)
    const { model } = create(
      { windowCharBudget: 1_000_000, windowPassageBudget: 1_000, outputCharsBudget: 1_000_000 },
      `Context. ${'story '.repeat(12_000)}`,
    )

    const result = await model.directChapter(book, book.chapters[0] as Chapter)

    // No request ever failed: the prompt pre-flight shrank the windows before sending.
    expect(server.requests.length).toBeGreaterThan(1)
    expect(
      server.requests.flatMap((request) => request.passages.map((p) => p.source_passage_id)),
    ).toEqual(ids)
    expect(() =>
      ExactSourceCoverage.createSegments(book.chapters[0] as Chapter, result.segments),
    ).not.toThrow()
  })

  it('fails explicitly when one passage plus story context can never fit the context budget', async () => {
    const texts = ['A perfectly ordinary passage.']
    const ids = ['passage-001']
    server = new OracleLlamaServer(oracleFor(ids, texts))
    await server.start()
    const book = makeChapterBook(texts, ids)
    // 90,000 chars is legal for the schema but cannot fit the context together with the output
    // reserve; the adapter must refuse loudly rather than truncate the context or the passage.
    const { model } = create({}, `x`.repeat(90_000))

    try {
      await model.directChapter(book, book.chapters[0] as Chapter)
      throw new Error('Expected an explicit budget failure')
    } catch (error) {
      expect(error).toBeInstanceOf(DirectorError)
      expect((error as DirectorError).code).toBe('configuration')
    }
    expect(server.requests).toHaveLength(0)
  })

  it('halves the window and retries when the response is cut at max_tokens', async () => {
    const texts = ['One passage.', 'Two passage.', 'Three passage.', 'Four passage.']
    const ids = texts.map((_, index) => `passage-${String(index + 1).padStart(3, '0')}`)
    server = new OracleLlamaServer(oracleFor(ids, texts))
    // Anything above one passage comes back truncated, as a max_tokens cut manifests.
    server.truncateAbovePassages = 1
    await server.start()
    const book = makeChapterBook(texts, ids)
    const { model, progress } = create({ windowPassageBudget: 8 })

    const result = await model.directChapter(book, book.chapters[0] as Chapter)

    expect(() =>
      ExactSourceCoverage.createSegments(book.chapters[0] as Chapter, result.segments),
    ).not.toThrow()
    // The first oversized attempts failed silently into smaller windows; later ones succeeded.
    expect(server.requests.length).toBeGreaterThan(texts.length)
    const successfulWindowSizes = server.requests
      .slice(-texts.length)
      .map((request) => request.passages.length)
    expect(successfulWindowSizes).toEqual([1, 1, 1, 1])
    expect(progress.events.filter((event) => event.state === 'failed')).toHaveLength(0)
    expect(progress.events.at(-1)).toMatchObject({ state: 'completed' })
  })

  it('gives up with the truncation error after the shrink budget is exhausted', async () => {
    const texts = ['One passage.', 'Two passage.', 'Three passage.', 'Four passage.']
    const ids = texts.map((_, index) => `passage-${String(index + 1).padStart(3, '0')}`)
    server = new OracleLlamaServer(oracleFor(ids, texts))
    server.truncateAbovePassages = 0 // every request truncates
    await server.start()
    const book = makeChapterBook(texts, ids)
    const { model, progress } = create({ windowPassageBudget: 8, maxWindowShrinks: 3 })

    try {
      await model.directChapter(book, book.chapters[0] as Chapter)
      throw new Error('Expected the truncation to propagate')
    } catch (error) {
      expect(error).toBeInstanceOf(DirectorError)
      expect((error as DirectorError).code).toBe('malformed_output')
    }
    // 1 initial + 3 shrunk retries, then the error propagates; it must not retry forever.
    expect(server.requests.length).toBeLessThanOrEqual(4)
    expect(progress.events.at(-1)).toMatchObject({ state: 'failed' })
  })

  it('halves and retries when the runtime rejects an oversized prompt with a context error', async () => {
    const texts = ['One passage.', 'Two passage.', 'Three passage.', 'Four passage.']
    const ids = texts.map((_, index) => `passage-${String(index + 1).padStart(3, '0')}`)
    server = new OracleLlamaServer(oracleFor(ids, texts))
    // The pre-flight estimate cannot know the real tokenizer, so the model itself reports the
    // overflow: HTTP 400 with provider wording that only survives in the causal chain after
    // classification. The adaptive path must still recognize it and shrink.
    server.contextOverflowAbovePassages = 1
    await server.start()
    const book = makeChapterBook(texts, ids)
    const { model, progress } = create({ windowPassageBudget: 8 })

    const result = await model.directChapter(book, book.chapters[0] as Chapter)

    expect(() =>
      ExactSourceCoverage.createSegments(book.chapters[0] as Chapter, result.segments),
    ).not.toThrow()
    expect(server.requests.length).toBeGreaterThan(texts.length)
    expect(server.requests.slice(-texts.length).map((request) => request.passages.length)).toEqual([
      1, 1, 1, 1,
    ])
    expect(progress.events.filter((event) => event.state === 'failed')).toHaveLength(0)
    expect(progress.events.at(-1)).toMatchObject({ state: 'completed' })
  })

  it('fails explicitly when a solo passage is declared unaffordable by the output budget', async () => {
    const texts = ['Short one.', `Long ${'passage '.repeat(700)}here.`, 'Short two.']
    const ids = texts.map((_, index) => `passage-${String(index + 1).padStart(3, '0')}`)
    server = new OracleLlamaServer(oracleFor(ids, texts))
    await server.start()
    const book = makeChapterBook(texts, ids)
    // The long passage must travel solo, and its response estimate (~8,035 chars) exceeds
    // 1,000 while the short first window's (~690) does not.
    const { model } = create({ windowCharBudget: 100, outputCharsBudget: 1_000 })

    try {
      await model.directChapter(book, book.chapters[0] as Chapter)
      throw new Error('Expected an explicit output-budget failure')
    } catch (error) {
      expect(error).toBeInstanceOf(DirectorError)
      expect((error as DirectorError).code).toBe('configuration')
      expect((error as DirectorError).message).toContain('output budget')
    }
    // The first window succeeds, then the solo passage is rejected BEFORE being sent.
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]?.passages.map((p) => p.source_passage_id)).toEqual([ids[0]])
  })

  it('times out a single window request at the configured per-request timeout', async () => {
    const texts = ['A passage that will be slow.']
    const ids = ['passage-001']
    server = new OracleLlamaServer(oracleFor(ids, texts))
    server.delayMs = 1_000
    await server.start()
    const book = makeChapterBook(texts, ids)
    const { model } = create()
    const slow = new GemmaDirectorModel({
      baseUrl: server.baseUrl,
      apiKey: API_KEY,
      confidenceThreshold: CONFIDENCE_THRESHOLD,
      contextProvider: {
        forChapter: async () => ({
          speakers: [{ id: 'mira', aliases: ['Mira'] }],
          narratorSpeakerId: 'narrator',
          fallbackSpeakerId: 'fallback-dialogue',
        }),
      },
      progressStore: { async append() {} },
      lifecycle: new FakeLifecycle(),
      gpuLeaseCoordinator: new FakeGpuLeaseCoordinator(),
      gpuLeaseLockFilePath: '/fixture/shared-gpu/exclusive.lock',
      requestTimeoutMs: 150,
    })
    models.push(slow)

    await expect(slow.directChapter(book, book.chapters[0] as Chapter)).rejects.toMatchObject({
      code: 'timeout',
    })
    expect(model.identity).toBe(slow.identity) // per-request timeout is operational, not identity
  })

  it('bounds the whole chapter at the deadline across sequential windows', async () => {
    const texts = ['First.', 'Second.', 'Third.', 'Fourth.']
    const ids = texts.map((_, index) => `passage-${String(index + 1).padStart(3, '0')}`)
    server = new OracleLlamaServer(oracleFor(ids, texts))
    server.delayMs = 250
    await server.start()
    const book = makeChapterBook(texts, ids)
    const { model, progress } = create({ windowPassageBudget: 1 })

    try {
      // Chapter deadline 600ms: window 1 (~250ms) succeeds; the remaining ~350ms caps window 2
      // below the per-request timeout and the chapter dies as a timeout, not after 4 x 15 min.
      await model.directChapter(book, book.chapters[0] as Chapter, { timeoutMs: 600 })
      throw new Error('Expected the chapter deadline to fire')
    } catch (error) {
      expect(error).toBeInstanceOf(DirectorError)
      expect((error as DirectorError).code).toBe('timeout')
    }
    expect(progress.events.at(-1)).toMatchObject({ state: 'failed' })
  })

  it('binds chunking settings into the director identity', async () => {
    server = new OracleLlamaServer(new Map())
    await server.start()
    const first = create()
    const second = create()
    const tuned = create({ windowCharBudget: 3_000 })
    expect(first.model.identity).toBe(second.model.identity)
    expect(tuned.model.identity).not.toBe(first.model.identity)
  })
})
