import type { DirectedChapter, DirectorModel } from '@light-novel-audiobook/application'
import type { Book, Chapter, DirectedSegment } from '@light-novel-audiobook/domain'
import {
  canonicalSha256,
  type DirectedAnnotation,
  type DirectionChunkingSettings,
  type DirectionOptions,
  type DirectorContextProvider,
  DirectorError,
  DirectorFidelityError,
  type DirectorWarning,
  estimateWindowOutputChars,
  parseDirectionRequest,
  planChapterWindows,
  resolveChunkingSettings,
  windowBudgetError,
} from '@light-novel-audiobook/gemma-director'
import { sanitizeOpenAiCloudError } from './errors.js'
import { createOpenAiCloudDirectorIdentity } from './identity.js'
import {
  OPENAI_CLOUD_DIRECTOR_PROFILE,
  OPENAI_CLOUD_MODEL_IDENTITY,
  type OpenAiCloudModelIdentity,
} from './profile.js'
import { executeOpenAiCloudWindow, type OpenAiCloudWindowResult } from './request.js'
import type { NarrationTailCompletionRepair } from './tail-completion-repair.js'

const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 60_000
const DEFAULT_CHAPTER_TIMEOUT_MS = 60 * 60_000

/**
 * Bounded retry budget for a single direction window whose failure is a deterministic validation
 * of stochastic model output (issue #131). Three total attempts == two additional rerequests.
 */
const MAX_WINDOW_ATTEMPTS = 3

/**
 * A window attempt is retryable only when the failure is a deterministic check of stochastic model
 * output: a fidelity finding or unparseable structured output. Auth, rate-limit, transport,
 * timeout, schema-validation, model, stream, and cancellation failures propagate immediately —
 * the adapter's transport `maxRetries` stays 0, so this is the only retry surface.
 */
function isRetryableWindowFailure(error: unknown): boolean {
  if (error instanceof DirectorFidelityError) return true
  if (error instanceof DirectorError && error.code === 'malformed_output') return true
  return false
}

/**
 * Text-free retry notice for the progress sink. Surfaces only bounded values: the window ordinal,
 * the window count, the deterministic failure reason (fidelity finding codes or "malformed
 * output"), the attempt budget, and the passage COUNT. It deliberately interpolates no passage
 * IDs — a `SourcePassage` id is an otherwise-unconstrained string, so echoing it verbatim could
 * leak source text or credentials if a non-stable ID ever reached the adapter boundary.
 */
function windowRetryMessage(
  error: unknown,
  windowIndex: number,
  windowCount: number,
  windowPassageCount: number,
  attempt: number,
): string {
  const windowNumber = windowIndex + 1
  const reason =
    error instanceof DirectorFidelityError
      ? `fidelity findings (${[...new Set(error.findings.map((finding) => finding.code))].join(', ')})`
      : 'malformed output'
  return `Retrying window ${windowNumber} of ${windowCount} after ${reason} (attempt ${attempt} of ${MAX_WINDOW_ATTEMPTS}); window has ${windowPassageCount} passage(s)`
}

/** Text-free repair notice: bounded counts plus passage IDs, never immutable source text. */
function narrationTailRepairMessage(
  repairs: readonly NarrationTailCompletionRepair[],
  windowIndex: number,
  windowCount: number,
  attempt: number,
): string {
  const passageIds = repairs.map((repair) => repair.sourcePassageId).join(', ')
  const attachCount = repairs.filter((repair) => repair.mode === 'attach-to-previous').length
  const synthesizeCount = repairs.filter((repair) => repair.mode === 'synthesize-narration').length
  const whitespaceMergeCount = repairs.filter(
    (repair) => repair.mode === 'merge-whitespace-segment',
  ).length
  return `Repaired ${repairs.length} narration tail(s) in window ${windowIndex + 1} of ${windowCount} (attempt ${attempt} of ${MAX_WINDOW_ATTEMPTS}); modes: ${attachCount} attach-to-previous, ${synthesizeCount} synthesize-narration, ${whitespaceMergeCount} merge-whitespace-segment; passage IDs: ${passageIds}`
}

export interface OpenAiCloudDirectorModelOptions {
  /** Server-only credential. The adapter never includes it in identities, progress, or errors. */
  readonly apiKey: string
  readonly confidenceThreshold: number
  readonly contextProvider: DirectorContextProvider
  readonly fetch?: typeof globalThis.fetch
  readonly requestTimeoutMs?: number
  readonly chunking?: Partial<DirectionChunkingSettings>
}

export interface OpenAiCloudDirectedChapter extends DirectedChapter {
  readonly directorIdentity: string
  readonly modelIdentity: OpenAiCloudModelIdentity
  readonly requestSha256: string
  readonly outputSha256: string
  readonly warnings: readonly DirectorWarning[]
  readonly parameters: {
    readonly reasoning: { readonly effort: 'low' }
    readonly reasoningSummary: false
    readonly maxOutputTokens: number
    readonly store: false
    readonly confidenceThreshold: number
  }
}

export class OpenAiCloudDirectorModel implements DirectorModel {
  readonly identity: string
  readonly modelIdentity = OPENAI_CLOUD_MODEL_IDENTITY
  private readonly apiKey: string
  private readonly confidenceThreshold: number
  private readonly contextProvider: DirectorContextProvider
  private readonly fetchImplementation: typeof globalThis.fetch
  private readonly requestTimeoutMs: number
  private readonly chunking: DirectionChunkingSettings
  private readonly shutdownController = new AbortController()
  private readonly activeOperations = new Set<Promise<unknown>>()
  private releasePromise: Promise<void> | undefined
  private released = false

  constructor(options: OpenAiCloudDirectorModelOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new Error('A server-side OPENAI_API_KEY is required for cloud direction')
    }
    if (
      !Number.isFinite(options.confidenceThreshold) ||
      options.confidenceThreshold < 0 ||
      options.confidenceThreshold > 1
    ) {
      throw new Error('OpenAI cloud director confidence threshold must be between zero and one')
    }
    if (
      options.requestTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1)
    ) {
      throw new Error('OpenAI cloud director request timeout must be a positive integer')
    }
    this.apiKey = options.apiKey
    this.confidenceThreshold = options.confidenceThreshold
    this.contextProvider = options.contextProvider
    this.fetchImplementation = options.fetch ?? globalThis.fetch
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.chunking = resolveChunkingSettings(options.chunking)
    this.identity = createOpenAiCloudDirectorIdentity({
      confidenceThreshold: this.confidenceThreshold,
      chunking: this.chunking,
    })
  }

  directChapter(
    book: Book,
    chapter: Chapter,
    options: DirectionOptions = {},
  ): Promise<OpenAiCloudDirectedChapter> {
    this.assertAvailable()
    if (
      chapter.bookId !== book.id ||
      book.chapters.find((candidate) => candidate.id === chapter.id) !== chapter
    ) {
      return Promise.reject(
        new Error('Director chapter must be the exact chapter owned by the book'),
      )
    }
    const startedAt = performance.now()
    return this.track(this.directChapterInternal(book, chapter, options, startedAt))
  }

  release(): Promise<void> {
    if (this.releasePromise !== undefined) return this.releasePromise
    this.released = true
    this.shutdownController.abort(new DOMException('OpenAI cloud director released', 'AbortError'))
    const active = [...this.activeOperations]
    this.releasePromise = Promise.allSettled(active).then(() => undefined)
    return this.releasePromise
  }

  private async directChapterInternal(
    book: Book,
    chapter: Chapter,
    options: DirectionOptions,
    startedAt: number,
  ): Promise<OpenAiCloudDirectedChapter> {
    if (
      options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
    ) {
      throw new Error('OpenAI cloud director chapter timeout must be a positive integer')
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_CHAPTER_TIMEOUT_MS
    const remaining = (): number => Math.floor(timeoutMs - (performance.now() - startedAt))
    const passages = chapter.sourcePassages.map((passage) => ({
      id: passage.id,
      text: passage.sourceText,
    }))
    const totalPassages = passages.length
    let completedPassages = 0
    const emit = async (
      state:
        | 'started'
        | 'requesting'
        | 'response_started'
        | 'streaming'
        | 'validating'
        | 'completed'
        | 'failed'
        | 'cancelled',
      message: string,
    ): Promise<void> => {
      await options.onProgress?.({
        chapterId: chapter.id,
        state,
        completedPassages,
        totalPassages,
        message,
      })
    }

    await emit('started', `Direction started for ${totalPassages} passages`)
    try {
      const context = await this.withChapterDeadline(
        this.contextProvider.forChapter(book, chapter),
        remaining(),
        timeoutMs,
        options.signal,
      )
      const baseRequestId = `direction-${canonicalSha256({
        bookId: book.id,
        bookSourceSha256: book.source.sha256,
        chapterId: chapter.id,
        identity: this.identity,
      }).slice(0, 32)}`
      const windows = planChapterWindows(passages, this.chunking)
      const annotations: DirectedAnnotation[] = []
      const warnings: DirectorWarning[] = []
      const requestHashes: string[] = []
      const outputIdentities: unknown[] = []

      for (const [windowIndex, window] of windows.entries()) {
        const windowPassages = passages.slice(window.start, window.end)
        const outputEstimate = estimateWindowOutputChars(
          windowPassages.reduce((sum, passage) => sum + passage.text.length, 0),
          windowPassages.length,
          this.chunking,
        )
        if (outputEstimate > this.chunking.outputCharsBudget) {
          throw windowBudgetError(
            `A source passage window estimates ${outputEstimate} response characters against an output budget of ${this.chunking.outputCharsBudget}`,
            windowPassages.map((passage) => passage.id),
          )
        }
        const request = parseDirectionRequest({
          requestId: `${baseRequestId}-w${String(windowIndex + 1).padStart(3, '0')}`,
          bookId: book.id,
          bookTitle: book.title,
          bookAuthor: book.author,
          bookSourceSha256: book.source.sha256,
          chapterId: chapter.id,
          chapterPosition: chapter.position,
          chapterTitle: chapter.title,
          passages: windowPassages,
          speakers: context.speakers,
          narratorSpeakerId: context.narratorSpeakerId,
          fallbackSpeakerId: context.fallbackSpeakerId,
          ...(context.storyContext === undefined ? {} : { storyContext: context.storyContext }),
        })
        // Bounded fail-closed retry (issue #131): a single stochastic fidelity/malformed-output
        // failure no longer kills the whole job. Each attempt is a fresh request with its own
        // `abortControl` lifecycle inside `executeOpenAiCloudWindow`; the deterministic validator
        // is unchanged, so output is only ever accepted by passing the same gate as before.
        let lastAttemptError: unknown
        for (let attempt = 1; attempt <= MAX_WINDOW_ATTEMPTS; attempt += 1) {
          await emit(
            'requesting',
            attempt === 1
              ? 'Waiting for the OpenAI cloud director'
              : windowRetryMessage(
                  lastAttemptError,
                  windowIndex,
                  windows.length,
                  windowPassages.length,
                  attempt,
                ),
          )
          // Sample the chapter deadline AFTER the (possibly slow) progress sink, immediately
          // before the request, so a retry cannot start — or succeed — with a stale positive
          // budget once that callback has exhausted it (review MAJOR 1).
          const requestRemaining = remaining()
          if (requestRemaining < 1) {
            throw new DirectorError(
              'timeout',
              `OpenAI cloud director chapter direction timed out after ${timeoutMs} ms`,
              true,
            )
          }
          let responseStarted = false
          let attemptResult: OpenAiCloudWindowResult
          try {
            attemptResult = await executeOpenAiCloudWindow(
              {
                apiKey: this.apiKey,
                confidenceThreshold: this.confidenceThreshold,
                directorIdentity: this.identity,
                fetch: this.fetchImplementation,
                shutdownSignal: this.shutdownController.signal,
              },
              request,
              {
                ...(options.signal === undefined ? {} : { signal: options.signal }),
                timeoutMs: Math.min(this.requestTimeoutMs, requestRemaining),
                onTextDelta: async () => {
                  if (!responseStarted) {
                    responseStarted = true
                    await emit('response_started', 'OpenAI response streaming started')
                  } else {
                    await emit(
                      'streaming',
                      `Directing ${completedPassages} of ${totalPassages} passages`,
                    )
                  }
                },
                onTailCompletionRepair: async (repairs) => {
                  await emit(
                    'validating',
                    narrationTailRepairMessage(repairs, windowIndex, windows.length, attempt),
                  )
                },
              },
            )
          } catch (error: unknown) {
            // Exhausted budget, non-retryable failure, or an aborted signal: propagate the
            // original error so its class/shape is identical to the pre-retry adapter.
            if (attempt === MAX_WINDOW_ATTEMPTS) throw error
            if (!isRetryableWindowFailure(error)) throw error
            if (options.signal?.aborted === true || this.shutdownController.signal.aborted) {
              throw error
            }
            lastAttemptError = error
            continue
          }
          // Success: accumulate outside the retry catch so a downstream progress-sink failure
          // cannot trigger a spurious retry of an already-validated window.
          await emit('validating', 'Validating exact source ranges and speaker semantics')
          annotations.push(...attemptResult.validated.annotations)
          warnings.push(...attemptResult.validated.warnings)
          requestHashes.push(attemptResult.requestSha256)
          outputIdentities.push(attemptResult.outputIdentity)
          completedPassages = window.end
          break
        }
      }

      const fallbackWarningByRange = new Map<string, DirectorWarning>(
        warnings
          .filter((warning) => warning.usesFallback)
          .map(
            (warning) =>
              [
                `${warning.sourcePassageId}\0${warning.sourceStart}\0${warning.sourceEnd}`,
                warning,
              ] as const,
          ),
      )
      const segments = annotations.map((annotation): DirectedSegment => {
        const key = `${annotation.sourcePassageId}\0${annotation.sourceStart}\0${annotation.sourceEnd}`
        const fallback = fallbackWarningByRange.get(key)
        const narratorOwned = annotation.kind === 'narration' || annotation.kind === 'sound_cue'
        return Object.freeze({
          sourcePassageId: annotation.sourcePassageId,
          sourceText: annotation.sourceText,
          kind: annotation.kind,
          speakerId: narratorOwned || fallback !== undefined ? null : annotation.speakerId,
          speakerReason: fallback?.message ?? null,
          confidence: annotation.confidence,
          delivery: annotation.delivery,
        })
      })
      const result: OpenAiCloudDirectedChapter = {
        chapterId: chapter.id,
        directorIdentity: this.identity,
        modelIdentity: this.modelIdentity,
        requestSha256: canonicalSha256({ requestId: baseRequestId, windows: requestHashes }),
        outputSha256: canonicalSha256({ windows: outputIdentities }),
        warnings: Object.freeze(warnings),
        parameters: Object.freeze({
          reasoning: OPENAI_CLOUD_DIRECTOR_PROFILE.reasoning,
          reasoningSummary: false,
          maxOutputTokens: OPENAI_CLOUD_DIRECTOR_PROFILE.maxOutputTokens,
          store: false,
          confidenceThreshold: this.confidenceThreshold,
        }),
        segments: Object.freeze(segments),
      }
      await emit(
        'completed',
        `Directed ${segments.length} fragments from ${totalPassages} passages`,
      )
      return Object.freeze(result)
    } catch (error: unknown) {
      const classified = sanitizeOpenAiCloudError(error, {
        callerCancelled: options.signal?.aborted === true || this.shutdownController.signal.aborted,
        operation: 'OpenAI cloud chapter direction',
      })
      try {
        await emit(classified.code === 'cancelled' ? 'cancelled' : 'failed', classified.message)
      } catch {
        // Preserve the classified failure if a progress sink is unavailable.
      }
      throw classified
    }
  }

  private async withChapterDeadline<T>(
    operation: Promise<T>,
    remainingMs: number,
    timeoutMs: number,
    callerSignal: AbortSignal | undefined,
  ): Promise<T> {
    if (remainingMs < 1) {
      throw new DirectorError(
        'timeout',
        `OpenAI cloud director chapter direction timed out after ${timeoutMs} ms`,
        true,
      )
    }
    const signal =
      callerSignal === undefined
        ? this.shutdownController.signal
        : AbortSignal.any([callerSignal, this.shutdownController.signal])
    let timer: NodeJS.Timeout | undefined
    let onAbort: (() => void) | undefined
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new DirectorError(
                  'timeout',
                  `OpenAI cloud director chapter direction timed out after ${timeoutMs} ms`,
                  true,
                ),
              ),
            remainingMs,
          )
          onAbort = () =>
            reject(new DirectorError('cancelled', 'OpenAI cloud direction was cancelled'))
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) onAbort()
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.activeOperations.add(operation)
    void operation.finally(() => this.activeOperations.delete(operation)).catch(() => undefined)
    return operation
  }

  private assertAvailable(): void {
    if (this.released)
      throw new DirectorError('released', 'OpenAI cloud director has been released')
  }
}
