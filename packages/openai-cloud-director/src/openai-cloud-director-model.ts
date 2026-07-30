import type { DirectedChapter, DirectorModel } from '@light-novel-audiobook/application'
import type { Book, Chapter, DirectedSegment } from '@light-novel-audiobook/domain'
import {
  canonicalSha256,
  type DirectedAnnotation,
  type DirectionChunkingSettings,
  type DirectionOptions,
  type DirectorContextProvider,
  DirectorError,
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
import { executeOpenAiCloudWindow } from './request.js'

const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 60_000
const DEFAULT_CHAPTER_TIMEOUT_MS = 60 * 60_000

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
        const requestRemaining = remaining()
        if (requestRemaining < 1) {
          throw new DirectorError(
            'timeout',
            `OpenAI cloud director chapter direction timed out after ${timeoutMs} ms`,
            true,
          )
        }
        await emit('requesting', 'Waiting for the OpenAI cloud director')
        let responseStarted = false
        const result = await executeOpenAiCloudWindow(
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
          },
        )
        await emit('validating', 'Validating exact source ranges and speaker semantics')
        annotations.push(...result.validated.annotations)
        warnings.push(...result.validated.warnings)
        requestHashes.push(result.requestSha256)
        outputIdentities.push(result.outputIdentity)
        completedPassages = window.end
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
