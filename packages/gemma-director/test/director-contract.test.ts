import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DirectorModel as ApplicationDirectorModel } from '@light-novel-audiobook/application'
import {
  Book,
  Chapter,
  ExactSourceCoverage,
  SourcePassage,
  VoiceCast,
  VoiceProfile,
  type VoiceRole,
} from '@light-novel-audiobook/domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createGemmaDirectorIdentity,
  type DirectionRequest,
  DirectorError,
  DirectorFidelityError,
  type DirectorProgressEvent,
  type DirectorProgressStore,
  type DirectorRuntimeLifecycle,
  type ExclusiveGpuLeaseCoordinator,
  FileGpuLeaseCoordinator,
  GemmaDirectorEndpoint,
  GemmaDirectorModel,
  type GpuLease,
  GpuLeaseError,
  type GpuOwner,
  gemmaDirectorIdentityMaterial,
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

interface CountingLifecycle extends DirectorRuntimeLifecycle {
  startCalls: number
  releaseCalls: number
}

class FakeLifecycle implements DirectorRuntimeLifecycle {
  startCalls = 0
  releaseCalls = 0

  constructor(private readonly events: string[] = []) {}

  async start(): Promise<void> {
    this.startCalls += 1
    this.events.push('runtime-started')
  }

  async release(): Promise<void> {
    this.releaseCalls += 1
    this.events.push('runtime-released')
  }
}

/** A runtime that refuses to exit, as llama-server can when a request is wedged. */
class UnstoppableLifecycle implements DirectorRuntimeLifecycle {
  startCalls = 0
  releaseCalls = 0

  async start(): Promise<void> {
    this.startCalls += 1
  }

  async release(): Promise<void> {
    this.releaseCalls += 1
    throw new Error('llama-server refused to exit')
  }
}

class FakeGpuLeaseCoordinator implements ExclusiveGpuLeaseCoordinator {
  acquireCalls = 0
  quarantineCalls = 0
  releaseCalls = 0
  quarantined = false

  constructor(
    readonly lockFilePath = '/fixture/shared-gpu/exclusive.lock',
    private readonly events: string[] = [],
  ) {}

  async acquire(owner: GpuOwner, signal?: AbortSignal): Promise<GpuLease> {
    this.acquireCalls += 1
    if (signal?.aborted) throw new GpuLeaseError('cancelled', 'Fixture lease cancelled')
    if (this.quarantined) throw new GpuLeaseError('quarantined', 'Fixture lease quarantined')
    this.events.push(`lease-acquired:${owner}`)
    let released = false
    return {
      owner,
      lockFilePath: this.lockFilePath,
      quarantine: async () => {
        this.quarantineCalls += 1
        this.quarantined = true
        this.events.push('lease-quarantined')
      },
      release: async () => {
        if (released) return
        released = true
        this.releaseCalls += 1
        this.events.push('lease-released')
      },
    }
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

function voiceProfile(id: string, role: VoiceRole, speakerId: string | null): VoiceProfile {
  return new VoiceProfile({
    id,
    displayName: id,
    role,
    speakerId,
    syntheticSpeaker: `${id}-synthetic`,
    instruction: `Read as ${id}`,
    seed: 7,
    revision: 1,
  })
}

/** The issue #29 cast the mapped segments are actually rendered with. */
function voiceCast(): VoiceCast {
  return new VoiceCast(
    voiceProfile('narrator-voice', 'narrator', null),
    voiceProfile('fallback-voice', 'fallback', null),
    [voiceProfile('mira-voice', 'character', 'mira')],
  )
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
  _start: number,
  _end: number,
  text: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const item: Record<string, unknown> = {
    source_passage_id: id,
    source_text: text,
    kind: 'narration',
    confidence: 0.98,
    delivery: {
      emotion: 'calm',
      pace: 'normal',
      volume: 'normal',
      pause_after_ms: 250,
    },
    ...overrides,
  }
  const kind = item.kind
  if (kind === 'narration' || kind === 'sound_cue') {
    delete item.speaker_id
    delete item.speaker_reason
  } else {
    if (item.unresolved_speaker === true) item.speaker_id = null
    if (!('speaker_reason' in item)) item.speaker_reason = null
  }
  delete item.unresolved_speaker
  return item
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

  const create = (
    overrides: {
      confidenceThreshold?: number
      gpuLeaseCoordinator?: ExclusiveGpuLeaseCoordinator
      gpuLeaseLockFilePath?: string
      lifecycleEvents?: string[]
      lifecycle?: CountingLifecycle
    } = {},
  ): {
    model: GemmaDirectorModel
    progress: MemoryProgressStore
    lifecycle: CountingLifecycle
    gpuLeaseCoordinator: ExclusiveGpuLeaseCoordinator
  } => {
    const progress = new MemoryProgressStore()
    const lifecycle = overrides.lifecycle ?? new FakeLifecycle(overrides.lifecycleEvents)
    const gpuLeaseCoordinator =
      overrides.gpuLeaseCoordinator ??
      new FakeGpuLeaseCoordinator(overrides.gpuLeaseLockFilePath, overrides.lifecycleEvents)
    const gpuLeaseLockFilePath =
      overrides.gpuLeaseLockFilePath ??
      (gpuLeaseCoordinator instanceof FakeGpuLeaseCoordinator
        ? gpuLeaseCoordinator.lockFilePath
        : '/fixture/shared-gpu/exclusive.lock')
    const model = new GemmaDirectorModel({
      baseUrl: server.baseUrl,
      apiKey: API_KEY,
      confidenceThreshold: overrides.confidenceThreshold ?? CONFIDENCE_THRESHOLD,
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
      gpuLeaseCoordinator,
      gpuLeaseLockFilePath,
    })
    models.push(model)
    return { model, progress, lifecycle, gpuLeaseCoordinator }
  }

  it('implements directChapter(Book, Chapter) with exact issue #29 DirectedChapter mapping', async () => {
    const book = makeBook()
    const { model, progress } = create()
    const contract: ApplicationDirectorModel = model
    expect(contract.identity).toMatch(/^[a-f0-9]{64}$/)
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
    expect(concrete.directorIdentity).toBe(model.identity)
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

  it('binds adapter, model, prompt, schema, runtime, generation, and GPU lease settings in identity', () => {
    const first = create().model
    const second = create().model
    const changedThreshold = create({ confidenceThreshold: 0.7 }).model
    const changedLease = create({
      gpuLeaseLockFilePath: '/fixture/other-gpu/exclusive.lock',
    }).model

    expect(first.identity).toBe(second.identity)
    expect(changedThreshold.identity).not.toBe(first.identity)
    expect(changedLease.identity).not.toBe(first.identity)
    expect(
      createGemmaDirectorIdentity({
        baseUrl: 'http://127.0.0.1:18080/v1',
        confidenceThreshold: CONFIDENCE_THRESHOLD,
        gpuLeaseLockFilePath: '/fixture/shared-gpu/exclusive.lock',
      }),
    ).not.toBe(first.identity)
    const material = gemmaDirectorIdentityMaterial({
      baseUrl: server.baseUrl,
      confidenceThreshold: CONFIDENCE_THRESHOLD,
      gpuLeaseLockFilePath: '/fixture/shared-gpu/exclusive.lock',
    })
    expect(material).toMatchObject({
      adapter: {
        id: 'tanstack-ai-openai-compatible',
        tanstackAiVersion: '0.42.0',
        tanstackOpenAiVersion: '0.17.1',
      },
      model: {
        profileId: SELECTED_GEMMA_PROFILE.id,
        revision: SELECTED_GEMMA_PROFILE.revision,
        sha256: SELECTED_GEMMA_PROFILE.sha256,
      },
      prompt: { version: 'gemma-director@4', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      outputSchema: {
        version: 'gemma-direction-output@4',
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      runtime: {
        commit: SELECTED_GEMMA_PROFILE.llamaCppCommit,
        baseUrl: server.baseUrl,
        contextSize: 32768,
        gpuLayers: 35,
        gpuLease: {
          protocol: 'flock-exclusive-nonblock@1',
          lockFilePath: '/fixture/shared-gpu/exclusive.lock',
          releaseOrder: 'runtime-exit-before-lease-release',
        },
      },
      generation: { confidenceThreshold: 0.8, seed: 42, maxTokens: 8192 },
    })
  })

  it('sends exact source passages, fragment schema, fixed parameters, and system prompt', async () => {
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
      captured.body.response_format as { json_schema: { schema: Record<string, unknown> } }
    ).json_schema.schema
    const schemaText = JSON.stringify(schema)
    expect(schemaText).toContain('source_passage_id')
    expect(schemaText).toContain('source_text')
    expect(schemaText).not.toContain('source_start')
    expect(schemaText).not.toContain('source_end')
    expect(schemaText).not.toContain('unresolved_speaker')
    expect(schemaText).not.toContain(validationRequest.narratorSpeakerId)
    expect(schemaText).not.toContain(validationRequest.fallbackSpeakerId)
    const messages = captured.body.messages as Array<{ role: string; content: string }>
    const userInput = JSON.parse(
      messages.find((message) => message.role === 'user')?.content ?? '{}',
    ) as Record<string, unknown>
    expect(userInput.passages).toEqual([
      { source_passage_id: 'passage-001', source_text: 'Rain. “Run!”' },
      { source_passage_id: 'passage-002', source_text: '“Who?”' },
    ])
    expect(userInput).not.toHaveProperty('narrator_speaker_id')
    expect(userInput).not.toHaveProperty('fallback_speaker_id')
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

  it('cannot race a Qwen process holding the shared cross-process lease', async () => {
    const root = join(tmpdir(), `gemma-qwen-contention-${crypto.randomUUID()}`)
    const lockFilePath = join(root, 'exclusive.lock')
    const qwenCoordinator = new FileGpuLeaseCoordinator({
      lockFilePath,
      inspectExistingComputeProcesses: false,
    })
    const gemmaCoordinator = new FileGpuLeaseCoordinator({
      lockFilePath,
      inspectExistingComputeProcesses: false,
    })
    const qwenLease = await qwenCoordinator.acquire('qwen3-tts')
    try {
      const book = makeBook()
      const { model } = create({
        gpuLeaseCoordinator: gemmaCoordinator,
        gpuLeaseLockFilePath: lockFilePath,
      })
      await expect(model.directChapter(book, book.chapters[0] as Chapter)).rejects.toMatchObject({
        code: 'gpu_busy',
        retryable: true,
      })
      expect(server.requests).toHaveLength(0)
    } finally {
      await qwenLease.release()
      await rm(root, { force: true, recursive: true })
    }
  })

  it('cancels before acquiring the shared GPU lease or reaching llama.cpp', async () => {
    const root = join(tmpdir(), `gemma-lease-cancel-${crypto.randomUUID()}`)
    const lockFilePath = join(root, 'exclusive.lock')
    try {
      const book = makeBook()
      const { model } = create({
        gpuLeaseCoordinator: new FileGpuLeaseCoordinator({
          lockFilePath,
          inspectExistingComputeProcesses: false,
        }),
        gpuLeaseLockFilePath: lockFilePath,
      })
      const controller = new AbortController()
      controller.abort(new DOMException('lease cancellation', 'AbortError'))
      await expect(
        model.directChapter(book, book.chapters[0] as Chapter, { signal: controller.signal }),
      ).rejects.toMatchObject({ code: 'cancelled' })
      expect(server.requests).toHaveLength(0)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('release cancels work and releases the lease only after runtime exit, exactly once', async () => {
    server.setMode('delay')
    const book = makeBook()
    const events: string[] = []
    const gpuLeaseCoordinator = new FakeGpuLeaseCoordinator(
      '/fixture/shared-gpu/exclusive.lock',
      events,
    )
    const { model, lifecycle } = create({
      lifecycleEvents: events,
      gpuLeaseCoordinator,
    })
    const direction = model.directChapter(book, book.chapters[0] as Chapter)
    await waitFor(() => server.requests.length > 0)

    expect(gpuLeaseCoordinator.acquireCalls).toBe(1)
    expect(gpuLeaseCoordinator.releaseCalls).toBe(0)
    const firstRelease = model.release()
    const secondRelease = model.release()
    expect(secondRelease).toBe(firstRelease)
    await expect(direction).rejects.toMatchObject({ code: 'cancelled' })
    await firstRelease
    expect(lifecycle.releaseCalls).toBe(1)
    expect(gpuLeaseCoordinator.releaseCalls).toBe(1)
    expect(events).toEqual([
      'lease-acquired:gemma',
      'runtime-started',
      'runtime-released',
      'lease-released',
    ])
    await waitFor(() => server.abortedRequests > 0)
    expect(() => model.directChapter(book, book.chapters[0] as Chapter)).toThrow(/released/)
    await model.release()
    expect(lifecycle.releaseCalls).toBe(1)
  })

  it('acquires the exclusive GPU lease before the runtime may occupy any VRAM', async () => {
    const events: string[] = []
    const gpuLeaseCoordinator = new FakeGpuLeaseCoordinator(
      '/fixture/shared-gpu/exclusive.lock',
      events,
    )
    const book = makeBook()
    const { model, lifecycle } = create({ lifecycleEvents: events, gpuLeaseCoordinator })

    expect(lifecycle.startCalls).toBe(0)
    await model.prepare()
    expect(events).toEqual(['lease-acquired:gemma', 'runtime-started'])

    await model.directChapter(book, book.chapters[0] as Chapter)
    await model.directChapter(book, book.chapters[0] as Chapter)
    expect(lifecycle.startCalls).toBe(1)
    expect(gpuLeaseCoordinator.acquireCalls).toBe(1)
  })

  it('never starts the runtime when the shared GPU lease cannot be acquired', async () => {
    const root = join(tmpdir(), `gemma-lease-before-start-${crypto.randomUUID()}`)
    const lockFilePath = join(root, 'exclusive.lock')
    const holder = new FileGpuLeaseCoordinator({
      lockFilePath,
      inspectExistingComputeProcesses: false,
    })
    const held = await holder.acquire('qwen3-tts')
    try {
      const book = makeBook()
      const { model, lifecycle } = create({
        gpuLeaseCoordinator: new FileGpuLeaseCoordinator({
          lockFilePath,
          inspectExistingComputeProcesses: false,
        }),
        gpuLeaseLockFilePath: lockFilePath,
      })
      await expect(model.directChapter(book, book.chapters[0] as Chapter)).rejects.toMatchObject({
        code: 'gpu_busy',
      })
      expect(lifecycle.startCalls).toBe(0)
      expect(server.requests).toHaveLength(0)
    } finally {
      await held.release()
      await rm(root, { force: true, recursive: true })
    }
  })

  it('quarantines rather than releasing the GPU lease when runtime cleanup fails', async () => {
    const gpuLeaseCoordinator = new FakeGpuLeaseCoordinator()
    const lifecycle = new UnstoppableLifecycle()
    const book = makeBook()
    const { model } = create({ gpuLeaseCoordinator, lifecycle })
    await model.directChapter(book, book.chapters[0] as Chapter)

    await expect(model.release()).rejects.toThrow('llama-server refused to exit')
    expect(lifecycle.releaseCalls).toBe(1)
    expect(gpuLeaseCoordinator.quarantineCalls).toBe(1)
    expect(gpuLeaseCoordinator.releaseCalls).toBe(0)
    await expect(gpuLeaseCoordinator.acquire('qwen3-tts')).rejects.toMatchObject({
      code: 'quarantined',
    })

    // A memoised rejected release neither repeats quarantine nor converts it to a normal release.
    await expect(model.release()).rejects.toThrow('llama-server refused to exit')
    expect(gpuLeaseCoordinator.quarantineCalls).toBe(1)
    expect(gpuLeaseCoordinator.releaseCalls).toBe(0)
  })

  it('classifies transient lease failures as retryable and unknown failures as permanent', async () => {
    const book = makeBook()
    const failing = (error: unknown): ExclusiveGpuLeaseCoordinator => ({
      acquire: async () => {
        throw error
      },
    })
    const unavailable = create({
      gpuLeaseCoordinator: failing(new GpuLeaseError('unavailable', 'flock could not be spawned')),
    })
    await expect(
      unavailable.model.directChapter(book, book.chapters[0] as Chapter),
    ).rejects.toMatchObject({ code: 'gpu_busy', retryable: true })

    const diagnostic = create({
      gpuLeaseCoordinator: failing(new GpuLeaseError('diagnostic', 'another process is resident')),
    })
    await expect(
      diagnostic.model.directChapter(book, book.chapters[0] as Chapter),
    ).rejects.toMatchObject({ code: 'gpu_busy', retryable: true })

    const unknown = create({ gpuLeaseCoordinator: failing(new Error('unrecognised')) })
    await expect(
      unknown.model.directChapter(book, book.chapters[0] as Chapter),
    ).rejects.toMatchObject({ code: 'gpu_busy', retryable: false })
  })

  it('keeps the narrator voice for sound cues instead of an unresolved-speaker fallback', async () => {
    const output = validWireOutput()
    const cue = output.segments[0]
    if (cue === undefined) throw new Error('Missing fixture narration')
    cue.kind = 'sound_cue'
    server.respondWith(output)
    const book = makeBook()
    const { model } = create()
    const result = await model.directChapter(book, book.chapters[0] as Chapter)

    expect(result.segments[0]).toMatchObject({ kind: 'sound_cue', speakerId: null })
    expect(
      result.warnings.filter(
        (warning) => warning.sourcePassageId === 'passage-001' && warning.sourceStart === 0,
      ),
    ).toEqual([])
    const segments = ExactSourceCoverage.createSegments(
      book.chapters[0] as Chapter,
      result.segments,
    )
    const cast = voiceCast()
    const soundCue = segments[0]
    if (soundCue === undefined) throw new Error('Missing mapped sound cue segment')
    expect(cast.resolve(soundCue).assignment).toEqual({
      voiceProfileId: 'narrator-voice',
      usesFallback: false,
      fallbackReason: null,
    })
  })

  it('applies the confidence threshold to narrator-owned kinds without rerouting the voice', async () => {
    const output = validWireOutput()
    const narration = output.segments[0]
    const cue = output.segments[2]
    if (narration === undefined || cue === undefined) throw new Error('Missing fixture segments')
    narration.confidence = 0
    cue.kind = 'sound_cue'
    delete cue.speaker_id
    cue.confidence = 0.1
    delete cue.unresolved_speaker
    delete cue.speaker_reason
    server.respondWith(output)
    const book = makeBook()
    const { model } = create()
    const result = await model.directChapter(book, book.chapters[0] as Chapter)

    expect(result.warnings.map((warning) => warning.code)).toEqual([
      'low_confidence_kind',
      'low_confidence_kind',
    ])
    expect(result.warnings[0]).toMatchObject({
      sourcePassageId: 'passage-001',
      confidence: 0,
      confidenceThreshold: 0.8,
      reviewRequired: true,
      usesFallback: false,
    })
    const segments = ExactSourceCoverage.createSegments(
      book.chapters[0] as Chapter,
      result.segments,
    )
    const cast = voiceCast()
    for (const segment of segments.filter((candidate) => candidate.kind !== 'dialogue')) {
      expect(cast.resolve(segment).assignment.usesFallback).toBe(false)
    }
  })

  it('reports intra-chapter passage progress while the response streams', async () => {
    const book = makeBook()
    const { model, progress } = create()
    await model.directChapter(book, book.chapters[0] as Chapter)

    const streaming = progress.events.filter((event) => event.state === 'streaming')
    expect(streaming.map((event) => event.completedPassages)).toEqual([1])
    expect(progress.events.at(-1)).toMatchObject({
      state: 'completed',
      completedPassages: 2,
      totalPassages: 2,
    })
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
      name: 'text omission',
      mutate: (output: ReturnType<typeof validWireOutput>) => {
        output.segments[1] = wireSegment('passage-001', 7, 12, 'Run!”', {
          kind: 'dialogue',
          speaker_id: 'mira',
        })
      },
      code: 'text_omission',
    },
    {
      name: 'text duplication',
      mutate: (output: ReturnType<typeof validWireOutput>) => {
        output.segments[1] = wireSegment('passage-001', 5, 12, ' “Run!”', {
          kind: 'dialogue',
          speaker_id: 'mira',
        })
      },
      code: 'text_duplication',
    },
    {
      name: 'duplicate fragment',
      mutate: (output: ReturnType<typeof validWireOutput>) => {
        output.segments.splice(1, 0, wireSegment('passage-001', 0, 6, 'Rain. '))
      },
      code: 'text_duplication',
    },
    {
      name: 'passage reorder',
      mutate: (output: ReturnType<typeof validWireOutput>) => {
        const final = output.segments.pop()
        if (final === undefined) throw new Error('Missing final fixture segment')
        output.segments.unshift(final)
      },
      code: 'passage_reorder',
    },
    {
      name: 'unknown passage',
      mutate: (output: ReturnType<typeof validWireOutput>) => {
        output.segments[2] = wireSegment('passage-invented', 0, 6, 'Made up')
      },
      code: 'unknown_passage',
    },
    {
      name: 'omitted passage',
      mutate: (output: ReturnType<typeof validWireOutput>) => {
        output.segments.pop()
      },
      code: 'text_omission',
    },
    {
      name: 'rewritten fragment',
      mutate: (output: ReturnType<typeof validWireOutput>) => {
        output.segments[0] = wireSegment('passage-001', 0, 6, 'Storm ')
      },
      code: 'text_substitution',
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

  it('rejects invented and special-role dialogue speakers at the schema boundary', () => {
    const output = validWireOutput()
    output.segments[1] = wireSegment('passage-001', 6, 12, '“Run!”', {
      kind: 'dialogue',
      speaker_id: 'invented-character',
    })
    expect(() => validateDirectionOutput(output, validationRequest, CONFIDENCE_THRESHOLD)).toThrow(
      DirectorError,
    )

    output.segments[1] = wireSegment('passage-001', 6, 12, '“Run!”', {
      kind: 'dialogue',
      speaker_id: 'fallback-dialogue',
    })
    expect(() => validateDirectionOutput(output, validationRequest, CONFIDENCE_THRESHOLD)).toThrow(
      DirectorError,
    )

    output.segments[1] = wireSegment('passage-001', 6, 12, '“Run!”', {
      kind: 'dialogue',
      speaker_id: 'narrator',
    })
    expect(() => validateDirectionOutput(output, validationRequest, CONFIDENCE_THRESHOLD)).toThrow(
      DirectorError,
    )
  })

  it('rejects a fragment boundary that splits a UTF-16 surrogate pair', () => {
    const passageText = 'Ah \u{1F600} ok'
    const astralRequest: DirectionRequest = {
      ...validationRequest,
      passages: [{ id: 'passage-001', text: passageText }],
    }
    const split = {
      segments: [
        wireSegment('passage-001', 0, 4, passageText.slice(0, 4)),
        wireSegment('passage-001', 4, passageText.length, passageText.slice(4)),
      ],
    }
    try {
      validateDirectionOutput(split, astralRequest, CONFIDENCE_THRESHOLD)
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(DirectorFidelityError)
      expect((error as DirectorFidelityError).findings.map((finding) => finding.code)).toContain(
        'split_grapheme',
      )
      const whole = {
        segments: [wireSegment('passage-001', 0, passageText.length, passageText)],
      }
      expect(
        validateDirectionOutput(whole, astralRequest, CONFIDENCE_THRESHOLD).annotations[0]
          ?.sourceText,
      ).toBe(passageText)
      return
    }
    throw new Error('Expected a split surrogate pair to fail validation')
  })

  it('applies the confidence threshold to every kind, not only known character speakers', () => {
    const output = validWireOutput()
    const narration = output.segments[0]
    if (narration === undefined) throw new Error('Missing fixture narration')
    narration.confidence = 0
    const validated = validateDirectionOutput(output, validationRequest, CONFIDENCE_THRESHOLD)

    expect(validated.warnings).toContainEqual(
      expect.objectContaining({
        code: 'low_confidence_kind',
        sourcePassageId: 'passage-001',
        sourceStart: 0,
        candidateSpeakerId: 'narrator',
        confidence: 0,
        reviewRequired: true,
        usesFallback: false,
      }),
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
