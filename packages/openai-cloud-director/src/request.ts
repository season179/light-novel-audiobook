import {
  canonicalSha256,
  type DirectionRequest,
  type DirectionWireOutput,
  DirectorError,
  DirectorFidelityError,
  directionWireOutputSchemaFor,
  repairMechanicalSourceEcho,
  type ValidatedDirection,
  validateDirectionOutput,
} from '@light-novel-audiobook/gemma-director'
import { chat } from '@tanstack/ai'
import { openaiCompatibleText } from '@tanstack/ai-openai/compatible'
import { cloudFidelityError, sanitizeOpenAiCloudError } from './errors.js'
import { OPENAI_CLOUD_DIRECTOR_PROFILE } from './profile.js'

export interface OpenAiCloudRequestClientOptions {
  readonly apiKey: string
  readonly confidenceThreshold: number
  readonly directorIdentity: string
  readonly fetch: typeof globalThis.fetch
  readonly shutdownSignal: AbortSignal
}

export interface OpenAiCloudWindowResult {
  readonly validated: ValidatedDirection
  readonly requestSha256: string
  readonly outputIdentity: unknown
}

export function directionRequestPayload(request: DirectionRequest): {
  readonly systemPrompts: readonly string[]
  readonly messages: readonly [{ readonly role: 'user'; readonly content: string }]
} {
  const input = {
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
    systemPrompts: [OPENAI_CLOUD_DIRECTOR_PROFILE.systemPrompt],
    messages: [{ role: 'user', content: JSON.stringify(input) }],
  }
}

function abortControl(
  callerSignal: AbortSignal | undefined,
  shutdownSignal: AbortSignal,
  timeoutMs: number,
) {
  const controller = new AbortController()
  let timedOut = false
  let cancelled = false
  const abortFrom = (source: AbortSignal): void => {
    cancelled = true
    controller.abort(source.reason)
  }
  const onCallerAbort = (): void => abortFrom(callerSignal as AbortSignal)
  const onShutdown = (): void => abortFrom(shutdownSignal)
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
  shutdownSignal.addEventListener('abort', onShutdown, { once: true })
  if (callerSignal?.aborted) onCallerAbort()
  if (shutdownSignal.aborted) onShutdown()
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return
    timedOut = true
    controller.abort(new DOMException('OpenAI cloud director request timed out', 'TimeoutError'))
  }, timeoutMs)
  return {
    controller,
    timedOut: () => timedOut,
    cancelled: () => cancelled,
    dispose: () => {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onCallerAbort)
      shutdownSignal.removeEventListener('abort', onShutdown)
    },
  }
}

export async function executeOpenAiCloudWindow(
  client: OpenAiCloudRequestClientOptions,
  request: DirectionRequest,
  options: {
    readonly signal?: AbortSignal
    readonly timeoutMs: number
    readonly onTextDelta?: ((delta: string) => void | Promise<void>) | undefined
  },
): Promise<OpenAiCloudWindowResult> {
  const payload = directionRequestPayload(request)
  const requestSha256 = canonicalSha256({
    directorIdentity: client.directorIdentity,
    request: payload,
    modelOptions: {
      reasoning: OPENAI_CLOUD_DIRECTOR_PROFILE.reasoning,
      max_output_tokens: OPENAI_CLOUD_DIRECTOR_PROFILE.maxOutputTokens,
      store: OPENAI_CLOUD_DIRECTOR_PROFILE.store,
    },
  })
  const control = abortControl(options.signal, client.shutdownSignal, options.timeoutMs)
  try {
    const adapter = openaiCompatibleText(OPENAI_CLOUD_DIRECTOR_PROFILE.modelId, {
      api: 'responses',
      baseURL: OPENAI_CLOUD_DIRECTOR_PROFILE.baseUrl,
      apiKey: client.apiKey,
      name: 'openai',
      maxRetries: 0,
      logLevel: 'off',
      fetch: client.fetch,
    })
    const outputSchema = directionWireOutputSchemaFor(request)
    const stream = chat({
      adapter,
      messages: [...payload.messages],
      systemPrompts: [...payload.systemPrompts],
      outputSchema,
      stream: true,
      abortController: control.controller,
      debug: false,
      modelOptions: {
        reasoning: { effort: 'low' },
        max_output_tokens: OPENAI_CLOUD_DIRECTOR_PROFILE.maxOutputTokens,
        store: false,
      },
    })
    let output: DirectionWireOutput | undefined
    for await (const event of stream) {
      if (event.type === 'TEXT_MESSAGE_CONTENT') await options.onTextDelta?.(event.delta)
      if (event.type === 'RUN_ERROR') {
        if (event.code === 'parse-error' || event.code === 'empty-response') {
          throw new DirectorError(
            'malformed_output',
            'OpenAI cloud director returned malformed JSON',
          )
        }
        if (event.code === 'refusal' || event.code === 'structured-output-missing-result') {
          throw new DirectorError(
            'model',
            'OpenAI cloud director did not provide a structured direction result',
          )
        }
        throw event
      }
      if (event.type === 'CUSTOM' && event.name === 'structured-output.complete') {
        output = outputSchema.parse(event.value.object) as DirectionWireOutput
      }
    }
    if (control.controller.signal.aborted) {
      throw control.controller.signal.reason ?? new DOMException('Aborted', 'AbortError')
    }
    if (output === undefined) {
      throw new DirectorError('malformed_output', 'OpenAI cloud director response did not complete')
    }

    const repaired = repairMechanicalSourceEcho(output, request)
    let validated: ValidatedDirection
    try {
      validated = validateDirectionOutput(repaired.output, request, client.confidenceThreshold)
    } catch (error: unknown) {
      if (error instanceof DirectorFidelityError) throw cloudFidelityError(error)
      throw error
    }
    return {
      validated,
      requestSha256,
      outputIdentity: Object.freeze({
        outputSha256: canonicalSha256(repaired.output),
        repairs: repaired.repairs,
      }),
    }
  } catch (error: unknown) {
    throw sanitizeOpenAiCloudError(error, {
      timedOut: control.timedOut(),
      callerCancelled: control.cancelled(),
      operation: 'OpenAI cloud director request',
    })
  } finally {
    control.dispose()
  }
}
