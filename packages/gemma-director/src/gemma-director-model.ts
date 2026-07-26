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
import {
  type DirectionChunkingSettings,
  estimateWindowOutputChars,
  estimateWindowPrompt,
  planWindow,
  resolveChunkingSettings,
  shrinkSettings,
  windowBudgetError,
} from './chunking.js'
import { GemmaDirectorEndpoint } from './config.js'
import { classifyDirectorError, DirectorError, directorErrorChainText } from './errors.js'
import { createGemmaDirectorIdentity } from './identity.js'
import type {
  DirectedAnnotation,
  DirectionOptions,
  DirectionRequest,
  DirectorContextProvider,
  DirectorHealth,
  DirectorParameters,
  DirectorProgressEvent,
  DirectorProgressStore,
  DirectorRunState,
  DirectorRuntimeLifecycle,
  DirectorWarning,
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
import { type ValidatedDirection, validateDirectionOutput } from './validation.js'

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
  /**
   * Per-request timeout for each underlying window request, in milliseconds. Defaults to 15
   * minutes. This bounds a single model call; the whole-chapter deadline is the `timeoutMs`
   * option on `directChapter` (60 minutes by default, per PLAN). Operational only — it cannot
   * change direction output, so it is not part of the adapter identity.
   */
  readonly requestTimeoutMs?: number
  /**
   * Issue #53 passage-window budgets. Window boundaries can change fragmentation, so the resolved
   * values are bound into this adapter's identity.
   */
  readonly chunking?: Partial<DirectionChunkingSettings>
}

interface ModelsResponse {
  readonly data?: readonly { readonly id?: unknown }[]
}

/** Longest source passage ID the request schema accepts; used to bridge stream chunk boundaries. */
const MAX_PASSAGE_ID_LENGTH = 256

/** Default per-window-request timeout. */
const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 60_000

/** PLAN locks 60 minutes per representative chapter; that is the default whole-chapter deadline. */
const DEFAULT_CHAPTER_TIMEOUT_MS = 60 * 60_000

/**
 * Provider wording for a prompt that cannot fit the context, matched against the whole causal
 * chain (classification replaces the message, so the original wording only survives there).
 */
const CONTEXT_OVERFLOW_WORDING =
  /context[_ -]length|context[_ -]window|context[_ -]size|n_ctx|too many (tokens|prompt)|prompt (is )?too long|exceed\w* (the )?(available )?context|context.{0,24}exceed/i

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
  private readonly chunking: DirectionChunkingSettings
  private readonly requestTimeoutMs: number
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
    if (
      options.requestTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1)
    ) {
      throw new Error('Gemma Director request timeout must be a positive integer')
    }
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.chunking = resolveChunkingSettings(options.chunking)
    this.identity = createGemmaDirectorIdentity({
      baseUrl: this.endpoint.baseUrl,
      confidenceThreshold: this.confidenceThreshold,
      gpuLeaseLockFilePath: this.gpuLeaseLockFilePath,
      chunking: this.chunking,
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
    // The chapter deadline clock starts here, at entry: lease acquisition, runtime startup,
    // and context loading all consume the same budget as the window requests that follow.
    const chapterStartedAt = performance.now()
    this.assertAvailable()
    if (
      chapter.bookId !== book.id ||
      book.chapters.find((candidate) => candidate.id === chapter.id) !== chapter
    ) {
      return Promise.reject(
        new Error('Director chapter must be the exact chapter owned by the book'),
      )
    }
    return this.trackOperation(this.directChapterInternal(book, chapter, options, chapterStartedAt))
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
      // Begin lifecycle release before waiting for adapter operations. A compliant lifecycle sets
      // its no-future-spawn barrier synchronously, reaps current work, and bounds startup settlement;
      // waiting on `runtimeReady` or `active` first would make that bound unreachable during a hung
      // pre-spawn filesystem operation.
      //
      // A failed lifecycle cleanup means runtime state is unknown. Never hand the lease to Qwen in
      // that state: quarantine keeps this process's kernel lock and leaves a durable marker that
      // blocks acquisition after process exit. Recovery therefore requires an explicit proof that
      // no runtime, GPU residency, pending spawn, or occupied endpoint remains.
      try {
        await this.lifecycle.release()
      } catch (runtimeFailure: unknown) {
        try {
          await this.gpuLease?.quarantine('Gemma runtime cleanup did not complete')
        } catch (quarantineFailure: unknown) {
          throw new AggregateError(
            [runtimeFailure, quarantineFailure],
            'Gemma runtime cleanup failed and the GPU lease could not be quarantined',
          )
        }
        throw runtimeFailure
      }
      // Shutdown abort plus runtime exit settles request operations before lease handoff. This wait
      // is deliberately after lifecycle cleanup so it cannot hide the lifecycle's startup bound.
      await Promise.allSettled(active)
      await this.gpuLease?.release()
    })()
    return this.releasePromise
  }

  /**
   * Issue #53: a chapter is directed as an ordered sequence of contiguous passage windows,
   * because one request per chapter cannot fit the pinned context once the wire schema's
   * verbatim source-text echo is accounted for. Each window is validated by the same
   * deterministic fidelity proof as a whole chapter was, and the stitched annotations are
   * concatenated in window order; `ExactSourceCoverage` at the application boundary re-proves
   * the whole chapter independently.
   */
  private async directChapterInternal(
    book: Book,
    chapter: Chapter,
    options: DirectionOptions,
    chapterStartedAt: number,
  ): Promise<GemmaDirectedChapter> {
    if (
      options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
    ) {
      throw new Error('Gemma Director chapter timeout must be a positive integer')
    }
    // The whole-chapter deadline starts at directChapter() entry, so GPU lease acquisition,
    // runtime startup, and the context provider all consume the same budget as the window
    // requests — the slowest, least predictable phase is exactly what the deadline must cover.
    const chapterTimeoutMs = options.timeoutMs ?? DEFAULT_CHAPTER_TIMEOUT_MS
    const chapterRemaining = (): number =>
      Math.floor(chapterTimeoutMs - (performance.now() - chapterStartedAt))
    await this.withChapterDeadline(
      chapterRemaining(),
      chapterTimeoutMs,
      'runtime startup',
      this.ensureRuntimeReady(options.signal),
    )
    const context = await this.withChapterDeadline(
      chapterRemaining(),
      chapterTimeoutMs,
      'chapter context loading',
      this.contextProvider.forChapter(book, chapter),
    )
    const baseRequestId = `direction-${canonicalSha256({
      bookId: book.id,
      bookSourceSha256: book.source.sha256,
      chapterId: chapter.id,
      identity: this.identity,
    }).slice(0, 32)}`
    const passages = chapter.sourcePassages.map((passage) => ({
      id: passage.id,
      text: passage.sourceText,
    }))
    const totalPassages = passages.length

    const parameters: DirectorParameters = Object.freeze({
      seed: SELECTED_GEMMA_PROFILE.seed,
      temperature: SELECTED_GEMMA_PROFILE.temperature,
      topP: SELECTED_GEMMA_PROFILE.topP,
      maxTokens: SELECTED_GEMMA_PROFILE.maxTokens,
      confidenceThreshold: this.confidenceThreshold,
    })

    let sequence = 0
    const emit = async (
      state: DirectorRunState,
      completedPassages: number,
      message: string,
      error?: DirectorProgressEvent['error'],
      warningCount?: number,
      eventRequestId?: string,
      eventRequestSha256?: string,
    ): Promise<void> => {
      sequence += 1
      const event: DirectorProgressEvent = {
        requestId: eventRequestId ?? baseRequestId,
        chapterId: chapter.id,
        requestSha256: eventRequestSha256 ?? chapterEventSha256,
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
    // Chapter-level progress events carry this deterministic stand-in; per-window events carry
    // their own window request hash.
    const chapterEventSha256 = canonicalSha256({ requestId: baseRequestId })

    // Shared by every window request: the system prompt plus the request envelope without the
    // passage payload. Measured once so each window's prompt pre-flight uses real sizes.
    const fixedPromptChars =
      GEMMA_DIRECTOR_SYSTEM_PROMPT.length +
      JSON.stringify(
        this.requestPayload({
          requestId: baseRequestId,
          bookId: book.id,
          bookTitle: book.title,
          bookAuthor: book.author,
          bookSourceSha256: book.source.sha256,
          chapterId: chapter.id,
          chapterPosition: chapter.position,
          chapterTitle: chapter.title,
          passages: [],
          speakers: context.speakers,
          narratorSpeakerId: context.narratorSpeakerId,
          fallbackSpeakerId: context.fallbackSpeakerId,
          ...(context.storyContext === undefined ? {} : { storyContext: context.storyContext }),
        }).messages,
      ).length

    const annotations: DirectedAnnotation[] = []
    const warnings: DirectorWarning[] = []
    const windowRequestSha256s: string[] = []
    const windowOutputs: DirectionWireOutput[] = []
    const sentWindows: Array<{ readonly start: number; readonly end: number }> = []
    let settings = this.chunking
    let shrinks = 0
    let nextIndex = 0
    let windowIndex = 0

    await emit('started', 0, `Direction started for ${totalPassages} passages`)
    try {
      while (nextIndex < totalPassages) {
        windowIndex += 1
        const chapterRemainingMs = chapterRemaining()
        if (chapterRemainingMs < 1) {
          throw new DirectorError(
            'timeout',
            `Gemma Director chapter direction timed out after ${chapterTimeoutMs} ms`,
            true,
          )
        }
        const windowOptions: DirectionOptions = {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          timeoutMs: Math.min(this.requestTimeoutMs, chapterRemainingMs),
        }
        let window = planWindow(passages, nextIndex, settings)
        // Pre-flight the prompt budget with measured sizes. A window that cannot fit is shrunk
        // before any request is sent; a single passage that still cannot fit is an explicit
        // configuration failure, never a silent truncation. Only shrinks that actually reduce
        // the window count against the budget: halving from a large configured budget can take
        // several steps before the plan moves, and those steps are free of model calls.
        let request: DirectionRequest | undefined
        while (request === undefined) {
          const candidate = parseDirectionRequest({
            requestId: `${baseRequestId}-w${String(windowIndex).padStart(3, '0')}`,
            bookId: book.id,
            bookTitle: book.title,
            bookAuthor: book.author,
            bookSourceSha256: book.source.sha256,
            chapterId: chapter.id,
            chapterPosition: chapter.position,
            chapterTitle: chapter.title,
            passages: passages.slice(window.start, window.end),
            speakers: context.speakers,
            narratorSpeakerId: context.narratorSpeakerId,
            fallbackSpeakerId: context.fallbackSpeakerId,
            ...(context.storyContext === undefined ? {} : { storyContext: context.storyContext }),
          })
          const estimate = estimateWindowPrompt(
            fixedPromptChars,
            candidate,
            SELECTED_GEMMA_PROFILE.contextSize,
            parameters.maxTokens,
            settings,
          )
          if (estimate.estimatedPromptTokens <= estimate.promptTokenBudget) {
            // planWindow only emits an over-budget window when it is a single passage, so this
            // is the solo-passage output guard: a passage whose response estimate is already
            // unaffordable fails explicitly here instead of being sent and truncating.
            const windowChars = passages
              .slice(window.start, window.end)
              .reduce((total, passage) => total + passage.text.length, 0)
            const outputEstimate = estimateWindowOutputChars(
              windowChars,
              window.end - window.start,
              settings,
            )
            if (outputEstimate > settings.outputCharsBudget) {
              throw windowBudgetError(
                `A single source passage estimates ${outputEstimate} response characters against an output budget of ${settings.outputCharsBudget}`,
                passages.slice(window.start, window.end).map((passage) => passage.id),
              )
            }
            request = candidate
            break
          }
          if (window.end - window.start <= 1) {
            throw windowBudgetError(
              `A single source passage with the current roster and story context estimates ${estimate.estimatedPromptTokens} prompt tokens against a budget of ${estimate.promptTokenBudget}`,
              passages.slice(window.start, window.end).map((passage) => passage.id),
            )
          }
          shrinks += 1
          if (shrinks > this.chunking.maxWindowShrinks) {
            throw windowBudgetError(
              'Direction windows could not be shrunk into the prompt budget',
              passages.slice(window.start, window.end).map((passage) => passage.id),
            )
          }
          let reduced = window
          do {
            settings = shrinkSettings(settings)
            reduced = planWindow(passages, nextIndex, settings)
          } while (
            reduced.end === window.end &&
            (settings.windowCharBudget > 500 || settings.windowPassageBudget > 1)
          )
          window = reduced
        }

        try {
          const result = await this.executeWindowDirection(
            request,
            parameters,
            { completed: nextIndex, total: totalPassages },
            emit,
            windowOptions,
          )
          annotations.push(...result.validated.annotations)
          warnings.push(...result.validated.warnings)
          windowRequestSha256s.push(result.requestSha256)
          windowOutputs.push(result.output)
          sentWindows.push(window)
          nextIndex = window.end
        } catch (error: unknown) {
          // A truncated response on a single-passage window cannot be fixed by shrinking.
          if (
            this.isTruncationSignature(error) &&
            window.end - window.start > 1 &&
            shrinks < this.chunking.maxWindowShrinks
          ) {
            // The response was cut off (or the prompt overflowed despite the estimate): halve
            // the window and retry the same chapter position. Shrinks persist for the chapter,
            // so one oversized window tightens every later window instead of re-failing.
            shrinks += 1
            const previousEnd = window.end
            let reduced = window
            do {
              settings = shrinkSettings(settings)
              reduced = planWindow(passages, nextIndex, settings)
            } while (
              reduced.end === previousEnd &&
              (settings.windowCharBudget > 500 || settings.windowPassageBudget > 1)
            )
            window = reduced
            windowIndex -= 1
            continue
          }
          throw error
        }
      }
    } catch (error: unknown) {
      const classified =
        error instanceof DirectorError
          ? error
          : classifyDirectorError(error, { operation: 'Gemma Director direction request' })
      try {
        await emit(
          classified.code === 'cancelled' ? 'cancelled' : 'failed',
          nextIndex,
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
    }

    // The sent windows must tile the chapter exactly. planWindow guarantees this by
    // construction; the assertion exists so a future change to planning or adaptive shrinking
    // cannot silently break stitching. ExactSourceCoverage independently re-proves coverage
    // from the fragments themselves at the application boundary.
    const tiledCorrectly =
      sentWindows.length === windowOutputs.length &&
      sentWindows.length > 0 &&
      sentWindows[0]?.start === 0 &&
      sentWindows[sentWindows.length - 1]?.end === totalPassages &&
      sentWindows.every(
        (window, index) => index === 0 || sentWindows[index - 1]?.end === window.start,
      )
    if (!tiledCorrectly) {
      throw new DirectorError(
        'fidelity',
        'Gemma Director window plan does not tile the chapter; refusing to stitch',
      )
    }

    // Only fallback-bearing warnings drop the speaker; review-only warnings keep the voice.
    const warningRanges = new Set(
      warnings
        .filter((warning) => warning.usesFallback)
        .map(
          (warning) =>
            `${warning.sourcePassageId}\u0000${warning.sourceStart}\u0000${warning.sourceEnd}`,
        ),
    )
    const segments = annotations.map((annotation): DomainDirectedSegment => {
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
      chapterId: chapter.id,
      requestId: baseRequestId,
      requestSha256: canonicalSha256({ requestId: baseRequestId, windows: windowRequestSha256s }),
      outputSha256: canonicalSha256(
        windowOutputs.length === 1 ? windowOutputs[0] : { windows: windowOutputs },
      ),
      directorIdentity: this.identity,
      modelIdentity: this.modelIdentity,
      parameters,
      segments: Object.freeze(segments),
      warnings: Object.freeze(warnings),
    }
    await emit(
      'completed',
      totalPassages,
      `Directed ${segments.length} fragments from ${totalPassages} passages`,
      undefined,
      warnings.length,
    )
    return Object.freeze(result)
  }

  /**
   * Bounds one setup phase by the chapter deadline. The loser of the race is not cancelled — the
   * chapter merely stops waiting for it. A raced-away runtime start is settled and unloaded by
   * `release()` before the GPU lease is freed (runtime exit precedes lease release, always).
   */
  private async withChapterDeadline<T>(
    remainingMs: number,
    chapterTimeoutMs: number,
    label: string,
    operation: Promise<T>,
  ): Promise<T> {
    if (remainingMs < 1) {
      throw new DirectorError(
        'timeout',
        `Gemma Director chapter direction timed out after ${chapterTimeoutMs} ms before ${label}`,
        true,
      )
    }
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new DirectorError(
                'timeout',
                `Gemma Director chapter direction timed out after ${chapterTimeoutMs} ms during ${label}`,
                true,
              ),
            )
          }, remainingMs)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * A response cut at max_tokens surfaces as unparseable structured output; a prompt that
   * overflowed the context surfaces as a model/HTTP rejection whose PROVIDER wording only
   * survives in the causal chain (classification normalizes the message). Both mean exactly one
   * thing here: the window was too large.
   */
  private isTruncationSignature(error: unknown): boolean {
    if (!(error instanceof DirectorError)) return false
    if (error.code === 'malformed_output') return true
    if (error.code !== 'model' && error.code !== 'http') return false
    return CONTEXT_OVERFLOW_WORDING.test(directorErrorChainText(error))
  }

  private async executeWindowDirection(
    request: DirectionRequest,
    parameters: DirectorParameters,
    progressBase: { readonly completed: number; readonly total: number },
    emit: (
      state: DirectorRunState,
      completedPassages: number,
      message: string,
      error?: DirectorProgressEvent['error'],
      warningCount?: number,
      eventRequestId?: string,
      eventRequestSha256?: string,
    ) => Promise<void>,
    options: DirectionOptions,
  ): Promise<{
    validated: ValidatedDirection
    output: DirectionWireOutput
    requestSha256: string
  }> {
    const requestPayload = this.requestPayload(request)
    const requestSha256 = canonicalSha256({
      directorIdentity: this.identity,
      parameters,
      request: requestPayload,
    })
    const emitWindow = (
      state: DirectorRunState,
      windowCompletedPassages: number,
      message: string,
    ): Promise<void> =>
      emit(
        state,
        progressBase.completed + windowCompletedPassages,
        message,
        undefined,
        undefined,
        request.requestId,
        requestSha256,
      )

    const progress = new StreamedPassageProgress(request.passages.map((passage) => passage.id))
    const control = this.abortControl(
      options.signal,
      options.timeoutMs ?? this.requestTimeoutMs,
      'direction request',
    )
    try {
      await emitWindow('requesting', 0, 'Waiting for the local Gemma director')
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
            await emitWindow(
              'response_started',
              progress.completedPassages,
              'Gemma response streaming started',
            )
          }
          if (progress.observe(event.delta)) {
            await emitWindow(
              'streaming',
              progress.completedPassages,
              `Directed ${progressBase.completed + progress.completedPassages} of ${progressBase.total} passages`,
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

      await emitWindow(
        'validating',
        progress.completedPassages,
        'Validating exact source ranges and speaker semantics',
      )
      const validated = validateDirectionOutput(output, request, this.confidenceThreshold)
      return { validated, output, requestSha256 }
    } catch (error: unknown) {
      throw classifyDirectorError(error, {
        timedOut: control.timedOut(),
        callerCancelled: control.cancelled(),
        operation: 'Gemma Director direction request',
      })
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
