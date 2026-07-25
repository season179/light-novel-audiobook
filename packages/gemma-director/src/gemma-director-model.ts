import { chat } from '@tanstack/ai'
import { openaiCompatibleText } from '@tanstack/ai-openai/compatible'
import { canonicalSha256 } from './canonical-json.js'
import { GemmaDirectorEndpoint } from './config.js'
import { classifyDirectorError, DirectorError } from './errors.js'
import type {
  DirectionOptions,
  DirectionRequest,
  DirectionResult,
  DirectorHealth,
  DirectorModel,
  DirectorModelIdentity,
  DirectorProgressEvent,
  DirectorProgressStore,
  DirectorRunState,
} from './port.js'
import {
  GEMMA_DIRECTOR_IDENTITY,
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
  readonly progressStore: DirectorProgressStore
  readonly fetch?: typeof globalThis.fetch
}

interface ModelsResponse {
  readonly data?: readonly { readonly id?: unknown }[]
}

export class GemmaDirectorModel implements DirectorModel {
  readonly identity: DirectorModelIdentity = GEMMA_DIRECTOR_IDENTITY
  readonly endpoint: GemmaDirectorEndpoint
  private readonly apiKey: string
  private readonly progressStore: DirectorProgressStore
  private readonly fetchImplementation: typeof globalThis.fetch

  constructor(options: GemmaDirectorModelOptions) {
    this.endpoint = new GemmaDirectorEndpoint(options.baseUrl)
    if (options.apiKey.trim().length < 16) {
      throw new Error('A server-side llama.cpp API key of at least 16 characters is required')
    }
    this.apiKey = options.apiKey
    this.progressStore = options.progressStore
    this.fetchImplementation = options.fetch ?? globalThis.fetch
  }

  async health(
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<DirectorHealth> {
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
        selectedModelAvailable: modelIds.includes(this.identity.modelId),
        modelIds,
      }
    } catch (error: unknown) {
      throw classifyDirectorError(error, {
        timedOut: control.timedOut(),
        callerCancelled: control.callerCancelled(),
        operation: 'Gemma Director health check',
      })
    } finally {
      control.dispose()
    }
  }

  async direct(input: DirectionRequest, options: DirectionOptions = {}): Promise<DirectionResult> {
    const request = parseDirectionRequest(input)
    const maxTokens = options.maxTokens ?? SELECTED_GEMMA_PROFILE.maxTokens
    if (
      !Number.isSafeInteger(maxTokens) ||
      maxTokens < 1 ||
      maxTokens > SELECTED_GEMMA_PROFILE.maxTokens
    ) {
      throw new Error(
        `Gemma Director maxTokens must be from 1 through ${SELECTED_GEMMA_PROFILE.maxTokens}`,
      )
    }
    const parameters = Object.freeze({
      seed: SELECTED_GEMMA_PROFILE.seed,
      temperature: SELECTED_GEMMA_PROFILE.temperature,
      topP: SELECTED_GEMMA_PROFILE.topP,
      maxTokens,
    })
    const requestPayload = this.requestPayload(request)
    const requestSha256 = canonicalSha256({
      identity: this.identity,
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

    const control = this.abortControl(
      options.signal,
      options.timeoutMs ?? 15 * 60_000,
      'direction request',
    )
    try {
      await emit('started', 0, `Direction started for ${totalPassages} passages`)
      await emit('requesting', 0, 'Waiting for the local Gemma director')
      const adapter = openaiCompatibleText(this.identity.modelId, {
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
          temperature: SELECTED_GEMMA_PROFILE.temperature,
          seed: SELECTED_GEMMA_PROFILE.seed,
          top_p: SELECTED_GEMMA_PROFILE.topP,
          max_tokens: parameters.maxTokens,
        },
      })
      let output: DirectionWireOutput | undefined
      let responseStarted = false
      for await (const event of stream) {
        if (event.type === 'TEXT_MESSAGE_CONTENT' && !responseStarted) {
          responseStarted = true
          await emit('response_started', 0, 'Gemma response streaming started')
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

      await emit('validating', 0, 'Validating exact source coverage and speaker semantics')
      const validated = validateDirectionOutput(output, request)
      const result: DirectionResult = {
        requestId: request.requestId,
        chapterId: request.chapterId,
        requestSha256,
        outputSha256: canonicalSha256(output),
        identity: this.identity,
        parameters,
        segments: validated.segments,
        warnings: validated.warnings,
      }
      await emit('completed', totalPassages, `Directed ${totalPassages} passages`)
      return Object.freeze(result)
    } catch (error: unknown) {
      const classified = classifyDirectorError(error, {
        timedOut: control.timedOut(),
        callerCancelled: control.callerCancelled(),
        operation: 'Gemma Director direction request',
      })
      try {
        await emit(
          classified.code === 'cancelled' ? 'cancelled' : 'failed',
          0,
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
      chapter_id: request.chapterId,
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

  private abortControl(signal: AbortSignal | undefined, timeoutMs: number, label: string) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error('Gemma Director timeout must be a positive integer')
    }
    const controller = new AbortController()
    let timedOut = false
    let callerCancelled = false
    const onCallerAbort = (): void => {
      callerCancelled = true
      controller.abort(signal?.reason)
    }
    signal?.addEventListener('abort', onCallerAbort, { once: true })
    if (signal?.aborted) onCallerAbort()
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new DOMException(`Gemma Director ${label} timed out`, 'TimeoutError'))
    }, timeoutMs)
    return {
      controller,
      timedOut: () => timedOut,
      callerCancelled: () => callerCancelled,
      dispose: () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onCallerAbort)
      },
    }
  }
}
