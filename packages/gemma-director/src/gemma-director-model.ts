import { resolve } from 'node:path'
import type { DirectorModel as ApplicationDirectorModel } from '@light-novel-audiobook/application'
import type {
  Book,
  Chapter,
  DirectedSegment as DomainDirectedSegment,
} from '@light-novel-audiobook/domain'
import {
  type ExclusiveGpuLeaseCoordinator,
  type GpuLease,
  GpuLeaseError,
} from '@light-novel-audiobook/gpu-lease'
import { chat } from '@tanstack/ai'
import { openaiCompatibleText } from '@tanstack/ai-openai/compatible'
import { canonicalSha256 } from './canonical-json.js'
import { GemmaDirectorEndpoint } from './config.js'
import { classifyDirectorError, DirectorError } from './errors.js'
import { createGemmaDirectorIdentity } from './identity.js'
import type {
  DirectionOptions,
  DirectionRequest,
  DirectorContextProvider,
  DirectorHealth,
  DirectorParameters,
  DirectorProgressEvent,
  DirectorProgressStore,
  DirectorRunState,
  DirectorRuntimeLifecycle,
  GemmaDirectedChapter,
} from './port.js'
import {
  GEMMA_DIRECTOR_MODEL_IDENTITY,
  GEMMA_DIRECTOR_SYSTEM_PROMPT,
  SELECTED_GEMMA_PROFILE,
} from './profile.js'
import {
  type DirectionWireOutput,
  directionWireOutputSchema,
  parseDirectionRequest,
} from './schema.js'
import { validateDirectionOutput } from './validation.js'

export interface GemmaDirectorModelOptions {
  readonly baseUrl?: string
  /** Server-side credential. Never expose this adapter or key to browser code. */
  readonly apiKey: string
  readonly confidenceThreshold: number
  readonly contextProvider: DirectorContextProvider
  readonly progressStore: DirectorProgressStore
  /**
   * Must start and unload/stop the runtime owned by the caller or launcher. The adapter drives the
   * order: the exclusive GPU lease is always acquired before `start()` puts weights in VRAM.
   */
  readonly lifecycle: DirectorRuntimeLifecycle
  readonly gpuLeaseCoordinator: ExclusiveGpuLeaseCoordinator
  /** Must be the same stable file used by Qwen3-TTS (normally .../gpu/exclusive.lock). */
  readonly gpuLeaseLockFilePath: string
  readonly fetch?: typeof globalThis.fetch
}

interface ModelsResponse {
  readonly data?: readonly { readonly id?: unknown }[]
}

/** Longest source passage ID the request schema accepts; used to bridge stream chunk boundaries. */
const MAX_PASSAGE_ID_LENGTH = 256

/**
 * The chapter is one request, so intra-chapter progress can only be inferred from the stream:
 * a passage is complete once fragments for the next ordered passage begin arriving.
 */
class StreamedPassageProgress {
  #completedPassages = 0
  #tail = ''
  readonly #pending: string[]

  constructor(passageIds: readonly string[]) {
    this.#pending = [...passageIds]
  }

  get completedPassages(): number {
    return this.#completedPassages
  }

  /** Returns true when the completed count advanced. */
  observe(delta: string): boolean {
    const before = this.#completedPassages
    const window = `${this.#tail}${delta}`
    while (this.#pending.length > 1) {
      const started = this.#pending[1]
      if (started === undefined || !window.includes(started)) break
      this.#pending.shift()
      this.#completedPassages += 1
    }
    this.#tail = window.slice(-MAX_PASSAGE_ID_LENGTH)
    return this.#completedPassages > before
  }
}

export class GemmaDirectorModel implements ApplicationDirectorModel {
  readonly modelIdentity = GEMMA_DIRECTOR_MODEL_IDENTITY
  readonly identity: string
  readonly endpoint: GemmaDirectorEndpoint
  private readonly apiKey: string
  private readonly confidenceThreshold: number
  private readonly contextProvider: DirectorContextProvider
  private readonly progressStore: DirectorProgressStore
  private readonly lifecycle: DirectorRuntimeLifecycle
  private readonly gpuLeaseCoordinator: ExclusiveGpuLeaseCoordinator
  private readonly gpuLeaseLockFilePath: string
  private readonly fetchImplementation: typeof globalThis.fetch
  private readonly shutdownController = new AbortController()
  private readonly activeOperations = new Set<Promise<unknown>>()
  private gpuLease: GpuLease | undefined
  private gpuLeaseAcquisition: Promise<GpuLease> | undefined
  private runtimeReady: Promise<void> | undefined
  private releasePromise: Promise<void> | undefined
  private released = false

  constructor(options: GemmaDirectorModelOptions) {
    this.endpoint = new GemmaDirectorEndpoint(options.baseUrl)
    if (options.apiKey.trim().length < 16) {
      throw new Error('A server-side llama.cpp API key of at least 16 characters is required')
    }
    if (
      !Number.isFinite(options.confidenceThreshold) ||
      options.confidenceThreshold < 0 ||
      options.confidenceThreshold > 1
    ) {
      throw new Error('Gemma Director confidence threshold must be between zero and one')
    }
    this.apiKey = options.apiKey
    this.confidenceThreshold = options.confidenceThreshold
    this.contextProvider = options.contextProvider
    this.progressStore = options.progressStore
    this.lifecycle = options.lifecycle
    this.gpuLeaseCoordinator = options.gpuLeaseCoordinator
    this.gpuLeaseLockFilePath = resolve(options.gpuLeaseLockFilePath)
    if (options.gpuLeaseLockFilePath.trim().length === 0) {
      throw new Error('Gemma Director GPU lease lock file path is required')
    }
    this.fetchImplementation = options.fetch ?? globalThis.fetch
    this.identity = createGemmaDirectorIdentity({
      baseUrl: this.endpoint.baseUrl,
      confidenceThreshold: this.confidenceThreshold,
      gpuLeaseLockFilePath: this.gpuLeaseLockFilePath,
    })
  }

  health(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<DirectorHealth> {
    this.assertAvailable()
    return this.trackOperation(this.healthInternal(options))
  }

  private async healthInternal(options: {
    signal?: AbortSignal
    timeoutMs?: number
  }): Promise<DirectorHealth> {
    const control = this.abortControl(options.signal, options.timeoutMs ?? 2_000, 'health check')
    try {
      const headers = {
        accept: 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      }
      const [healthResponse, modelsResponse] = await Promise.all([
        this.fetchImplementation(`${this.endpoint.origin}/health`, {
          headers,
          signal: control.controller.signal,
        }),
        this.fetchImplementation(`${this.endpoint.baseUrl}/models`, {
          headers,
          signal: control.controller.signal,
        }),
      ])
      if (!healthResponse.ok || !modelsResponse.ok) {
        const status = !healthResponse.ok ? healthResponse.status : modelsResponse.status
        throw new DirectorError(
          'http',
          `Gemma Director health check returned HTTP ${status}`,
          status === 429 || status >= 500,
          { status },
        )
      }
      const healthValue = (await healthResponse.json()) as { status?: unknown }
      const modelsValue = (await modelsResponse.json()) as ModelsResponse
      if (
        typeof healthValue.status !== 'string' ||
        !Array.isArray(modelsValue.data) ||
        modelsValue.data.some((item) => typeof item.id !== 'string')
      ) {
        throw new DirectorError('malformed_output', 'Gemma Director health response was malformed')
      }
      const modelIds = modelsValue.data.map((item) => item.id as string)
      return {
        status: healthValue.status,
        selectedModelAvailable: modelIds.includes(this.modelIdentity.modelId),
        modelIds,
      }
    } catch (error: unknown) {
      throw classifyDirectorError(error, {
        timedOut: control.timedOut(),
        callerCancelled: control.cancelled(),
        operation: 'Gemma Director health check',
      })
    } finally {
      control.dispose()
    }
  }

  directChapter(
    book: Book,
    chapter: Chapter,
    options: DirectionOptions = {},
  ): Promise<GemmaDirectedChapter> {
    this.assertAvailable()
    if (
      chapter.bookId !== book.id ||
      book.chapters.find((candidate) => candidate.id === chapter.id) !== chapter
    ) {
      return Promise.reject(
        new Error('Director chapter must be the exact chapter owned by the book'),
      )
    }
    return this.trackOperation(this.directChapterInternal(book, chapter, options))
  }

  /**
   * Acquires the exclusive GPU lease and only then starts the runtime. Direction calls do this
   * automatically; composition roots can call it explicitly to fail fast before any work.
   */
  prepare(options: { signal?: AbortSignal } = {}): Promise<void> {
    this.assertAvailable()
    return this.trackOperation(this.ensureRuntimeReady(options.signal))
  }

  release(): Promise<void> {
    if (this.releasePromise !== undefined) return this.releasePromise
    this.released = true
    this.shutdownController.abort(new DOMException('Gemma Director released', 'AbortError'))
    const active = [...this.activeOperations]
    this.releasePromise = (async () => {
      await Promise.allSettled(active)
      // A runtime that refuses to exit must never strand the cross-process lease: both steps
      // always run, and the runtime failure stays the reported cause.
      let failure: unknown
      try {
        await this.lifecycle.release()
      } catch (error: unknown) {
        failure = error
      }
      try {
        await this.gpuLease?.release()
      } catch (error: unknown) {
        failure ??= error
      }
      if (failure !== undefined) throw failure
    })()
    return this.releasePromise
  }

  private async directChapterInternal(
    book: Book,
    chapter: Chapter,
    options: DirectionOptions,
  ): Promise<GemmaDirectedChapter> {
    await this.ensureRuntimeReady(options.signal)
    const context = await this.contextProvider.forChapter(book, chapter)
    const requestId = `direction-${canonicalSha256({
      bookId: book.id,
      bookSourceSha256: book.source.sha256,
      chapterId: chapter.id,
      identity: this.identity,
    }).slice(0, 32)}`
    const request = parseDirectionRequest({
      requestId,
      bookId: book.id,
      bookTitle: book.title,
      bookAuthor: book.author,
      bookSourceSha256: book.source.sha256,
      chapterId: chapter.id,
      chapterPosition: chapter.position,
      chapterTitle: chapter.title,
      passages: chapter.sourcePassages.map((passage) => ({
        id: passage.id,
        text: passage.sourceText,
      })),
      speakers: context.speakers,
      narratorSpeakerId: context.narratorSpeakerId,
      fallbackSpeakerId: context.fallbackSpeakerId,
      ...(context.storyContext === undefined ? {} : { storyContext: context.storyContext }),
    })
    return await this.executeDirection(request, options)
  }

  private async executeDirection(
    request: DirectionRequest,
    options: DirectionOptions,
  ): Promise<GemmaDirectedChapter> {
    const parameters: DirectorParameters = Object.freeze({
      seed: SELECTED_GEMMA_PROFILE.seed,
      temperature: SELECTED_GEMMA_PROFILE.temperature,
      topP: SELECTED_GEMMA_PROFILE.topP,
      maxTokens: SELECTED_GEMMA_PROFILE.maxTokens,
      confidenceThreshold: this.confidenceThreshold,
    })
    const requestPayload = this.requestPayload(request)
    const requestSha256 = canonicalSha256({
      directorIdentity: this.identity,
      parameters,
      request: requestPayload,
    })
    const totalPassages = request.passages.length
    let sequence = 0
    const emit = async (
      state: DirectorRunState,
      completedPassages: number,
      message: string,
      error?: DirectorProgressEvent['error'],
      warningCount?: number,
    ): Promise<void> => {
      sequence += 1
      const event: DirectorProgressEvent = {
        requestId: request.requestId,
        chapterId: request.chapterId,
        requestSha256,
        sequence,
        occurredAt: new Date().toISOString(),
        state,
        completedPassages,
        totalPassages,
        message,
        ...(warningCount === undefined ? {} : { warningCount }),
        ...(error === undefined ? {} : { error }),
      }
      try {
        await this.progressStore.append(Object.freeze(event))
      } catch (cause: unknown) {
        throw new DirectorError('progress', 'Gemma Director could not persist run progress', true, {
          cause,
        })
      }
    }

    const progress = new StreamedPassageProgress(request.passages.map((passage) => passage.id))
    const control = this.abortControl(
      options.signal,
      options.timeoutMs ?? 15 * 60_000,
      'direction request',
    )
    try {
      await emit('started', 0, `Direction started for ${totalPassages} passages`)
      await emit('requesting', 0, 'Waiting for the local Gemma director')
      const adapter = openaiCompatibleText(this.modelIdentity.modelId, {
        name: 'llama.cpp-gemma-director',
        baseURL: this.endpoint.baseUrl,
        apiKey: this.apiKey,
        maxRetries: 0,
        defaultHeaders: { connection: 'close' },
        fetch: this.fetchImplementation,
      })
      const stream = chat({
        adapter,
        messages: requestPayload.messages,
        systemPrompts: requestPayload.systemPrompts,
        outputSchema: directionWireOutputSchema,
        stream: true,
        abortController: control.controller,
        debug: false,
        modelOptions: {
          temperature: parameters.temperature,
          seed: parameters.seed,
          top_p: parameters.topP,
          max_tokens: parameters.maxTokens,
        },
      })
      let output: DirectionWireOutput | undefined
      let responseStarted = false
      for await (const event of stream) {
        if (event.type === 'TEXT_MESSAGE_CONTENT') {
          if (!responseStarted) {
            responseStarted = true
            await emit(
              'response_started',
              progress.completedPassages,
              'Gemma response streaming started',
            )
          }
          if (progress.observe(event.delta)) {
            await emit(
              'streaming',
              progress.completedPassages,
              `Directed ${progress.completedPassages} of ${totalPassages} passages`,
            )
          }
        }
        if (event.type === 'RUN_ERROR') {
          if (event.code === 'structured-output-parse-failed') {
            throw new DirectorError(
              'malformed_output',
              'Gemma Director returned malformed JSON',
              false,
              { cause: event },
            )
          }
          if (event.code === 'structured-output-validation-failed') {
            throw new DirectorError(
              'schema_validation',
              'Gemma Director output failed schema validation',
              false,
              { cause: event },
            )
          }
          if (responseStarted) {
            throw new DirectorError('stream', 'Gemma Director response stream failed', true, {
              cause: event,
            })
          }
          throw event
        }
        if (event.type === 'CUSTOM' && event.name === 'structured-output.complete') {
          output = directionWireOutputSchema.parse(event.value.object)
        }
      }
      if (control.controller.signal.aborted) {
        throw control.controller.signal.reason ?? new DOMException('Aborted', 'AbortError')
      }
      if (output === undefined) {
        throw new DirectorError('malformed_output', 'Gemma Director response did not complete')
      }

      await emit(
        'validating',
        progress.completedPassages,
        'Validating exact source ranges and speaker semantics',
      )
      const validated = validateDirectionOutput(output, request, this.confidenceThreshold)
      // Only fallback-bearing warnings drop the speaker; review-only warnings keep the voice.
      const warningRanges = new Set(
        validated.warnings
          .filter((warning) => warning.usesFallback)
          .map(
            (warning) =>
              `${warning.sourcePassageId}\u0000${warning.sourceStart}\u0000${warning.sourceEnd}`,
          ),
      )
      const segments = validated.annotations.map((annotation): DomainDirectedSegment => {
        const rangeKey = `${annotation.sourcePassageId}\u0000${annotation.sourceStart}\u0000${annotation.sourceEnd}`
        const useNarrator = annotation.kind === 'narration' || annotation.kind === 'sound_cue'
        return Object.freeze({
          sourcePassageId: annotation.sourcePassageId,
          sourceText: annotation.sourceText,
          kind: annotation.kind,
          speakerId: useNarrator || warningRanges.has(rangeKey) ? null : annotation.speakerId,
          confidence: annotation.confidence,
          delivery: annotation.delivery,
        })
      })
      const result: GemmaDirectedChapter = {
        chapterId: request.chapterId,
        requestId: request.requestId,
        requestSha256,
        outputSha256: canonicalSha256(output),
        directorIdentity: this.identity,
        modelIdentity: this.modelIdentity,
        parameters,
        segments: Object.freeze(segments),
        warnings: validated.warnings,
      }
      await emit(
        'completed',
        totalPassages,
        `Directed ${segments.length} fragments from ${totalPassages} passages`,
        undefined,
        validated.warnings.length,
      )
      return Object.freeze(result)
    } catch (error: unknown) {
      const classified = classifyDirectorError(error, {
        timedOut: control.timedOut(),
        callerCancelled: control.cancelled(),
        operation: 'Gemma Director direction request',
      })
      try {
        await emit(
          classified.code === 'cancelled' ? 'cancelled' : 'failed',
          progress.completedPassages,
          classified.message,
          {
            code: classified.code,
            message: classified.message,
            retryable: classified.retryable,
          },
        )
      } catch {
        // Preserve the original classified failure when terminal progress cannot be persisted.
      }
      throw classified
    } finally {
      control.dispose()
    }
  }

  private requestPayload(request: DirectionRequest): {
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
      narrator_speaker_id: request.narratorSpeakerId,
      fallback_speaker_id: request.fallbackSpeakerId,
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
      systemPrompts: [GEMMA_DIRECTOR_SYSTEM_PROMPT],
      messages: [{ role: 'user', content: JSON.stringify(userInput) }],
    }
  }

  /**
   * The only ordering that makes the lease meaningful: exclusive GPU ownership first, model
   * weights second. Nothing in this adapter can load the runtime without holding the lease.
   */
  private ensureRuntimeReady(signal?: AbortSignal): Promise<void> {
    if (this.runtimeReady !== undefined) return this.runtimeReady
    const attempt = (async (): Promise<void> => {
      await this.ensureGpuLease(signal)
      try {
        await this.lifecycle.start()
      } catch (error: unknown) {
        if (error instanceof DirectorError) throw error
        throw new DirectorError(
          'unavailable',
          'Gemma Director runtime failed to start while holding the GPU lease',
          true,
          { cause: error },
        )
      }
    })()
    // The lease is deliberately retained on a failed start; release() is the only way it is freed.
    const ready = attempt.catch((error: unknown) => {
      this.runtimeReady = undefined
      throw error
    })
    this.runtimeReady = ready
    return ready
  }

  private async ensureGpuLease(signal?: AbortSignal): Promise<GpuLease> {
    if (this.gpuLease !== undefined) return this.gpuLease
    if (this.gpuLeaseAcquisition !== undefined) return await this.gpuLeaseAcquisition
    const leaseSignal =
      signal === undefined
        ? this.shutdownController.signal
        : AbortSignal.any([signal, this.shutdownController.signal])
    const acquisition = this.gpuLeaseCoordinator
      .acquire('gemma', leaseSignal)
      .then(async (lease) => {
        if (lease.owner !== 'gemma' || resolve(lease.lockFilePath) !== this.gpuLeaseLockFilePath) {
          await lease.release()
          throw new DirectorError(
            'gpu_busy',
            'GPU lease coordinator returned a mismatched lock contract',
          )
        }
        this.gpuLease = lease
        return lease
      })
      .catch((error: unknown) => {
        if (error instanceof DirectorError) throw error
        if (error instanceof GpuLeaseError) {
          if (error.code === 'cancelled') {
            throw new DirectorError(
              'cancelled',
              'Gemma GPU lease acquisition was cancelled',
              false,
              {
                cause: error,
              },
            )
          }
          // A held lease, a failed holder spawn, and another process on the GPU all clear with
          // time; only an unrecognised failure is treated as permanent.
          throw new DirectorError(
            'gpu_busy',
            'Cannot acquire the shared cross-process GPU lease for Gemma',
            error.code === 'busy' || error.code === 'unavailable' || error.code === 'diagnostic',
            { cause: error },
          )
        }
        throw new DirectorError(
          'gpu_busy',
          'Cannot acquire the shared cross-process GPU lease for Gemma',
          false,
          { cause: error },
        )
      })
      .finally(() => {
        if (this.gpuLeaseAcquisition === acquisition) this.gpuLeaseAcquisition = undefined
      })
    this.gpuLeaseAcquisition = acquisition
    return await acquisition
  }

  private trackOperation<T>(operation: Promise<T>): Promise<T> {
    this.activeOperations.add(operation)
    void operation.finally(() => this.activeOperations.delete(operation)).catch(() => undefined)
    return operation
  }

  private assertAvailable(): void {
    if (this.released) {
      throw new DirectorError('released', 'Gemma Director has been released')
    }
  }

  private abortControl(signal: AbortSignal | undefined, timeoutMs: number, label: string) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error('Gemma Director timeout must be a positive integer')
    }
    const controller = new AbortController()
    let timedOut = false
    let cancelled = false
    const abortFrom = (source: AbortSignal): void => {
      cancelled = true
      controller.abort(source.reason)
    }
    const onCallerAbort = (): void => abortFrom(signal as AbortSignal)
    const onShutdown = (): void => abortFrom(this.shutdownController.signal)
    signal?.addEventListener('abort', onCallerAbort, { once: true })
    this.shutdownController.signal.addEventListener('abort', onShutdown, { once: true })
    if (signal?.aborted) onCallerAbort()
    if (this.shutdownController.signal.aborted) onShutdown()
    const timer = setTimeout(() => {
      timedOut = true
      cancelled = false
      controller.abort(new DOMException(`Gemma Director ${label} timed out`, 'TimeoutError'))
    }, timeoutMs)
    return {
      controller,
      timedOut: () => timedOut,
      cancelled: () => cancelled,
      dispose: () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onCallerAbort)
        this.shutdownController.signal.removeEventListener('abort', onShutdown)
      },
    }
  }
}
