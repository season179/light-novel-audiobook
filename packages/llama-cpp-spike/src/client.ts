import { chat } from '@tanstack/ai'
import { openaiCompatibleText } from '@tanstack/ai-openai/compatible'
import { LoopbackEndpoint } from './config'
import { classifyError, SpikeError } from './errors'
import {
  HealthResponseSchema,
  ModelsResponseSchema,
  PropsResponseSchema,
  type SyntheticStructuredOutput,
  SyntheticStructuredOutputSchema,
} from './schema'
import { SlotPool, type SlotPoolSnapshot } from './slot-pool'

export interface LlamaCppSpikeClientOptions {
  readonly endpoint?: string
  readonly model: string
  /** Server-side credential. Never expose this client or value to browser code. */
  readonly apiKey: string
  readonly maxConcurrency?: number
  readonly fetch?: typeof globalThis.fetch
}

export interface StructuredRequestOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly temperature?: number
  readonly seed?: number
  readonly maxTokens?: number
}

export interface LlamaCppCapabilities {
  readonly healthStatus: string
  readonly modelIds: Array<string>
  readonly totalSlots: number | undefined
  readonly endpoints: {
    readonly chatCompletions: true
    readonly health: true
    readonly models: true
    readonly props: true
  }
}

export class LlamaCppSpikeClient {
  readonly endpoint: LoopbackEndpoint
  readonly model: string
  private readonly apiKey: string
  private readonly fetchImplementation: typeof globalThis.fetch
  private readonly slots: SlotPool

  constructor(options: LlamaCppSpikeClientOptions) {
    this.endpoint = new LoopbackEndpoint(options.endpoint)
    if (options.model.trim() === '')
      throw new Error('A non-empty llama.cpp model identity is required')
    this.model = options.model
    if (options.apiKey.trim().length < 16) {
      throw new Error(
        'A random server-side llama.cpp API key of at least 16 characters is required',
      )
    }
    this.apiKey = options.apiKey
    this.fetchImplementation = options.fetch ?? globalThis.fetch
    this.slots = new SlotPool(options.maxConcurrency ?? 1)
  }

  slotSnapshot(): SlotPoolSnapshot {
    return this.slots.snapshot()
  }

  async health(timeoutMs = 2_000): Promise<string> {
    const value = await this.requestJson('/health', timeoutMs)
    const parsed = HealthResponseSchema.safeParse(value)
    if (!parsed.success) {
      throw new SpikeError('capability', 'llama.cpp health response did not match its API shape', {
        cause: parsed.error,
      })
    }
    return parsed.data.status
  }

  async capabilities(timeoutMs = 2_000): Promise<LlamaCppCapabilities> {
    const [healthValue, modelsValue, propsValue] = await Promise.all([
      this.requestJson('/health', timeoutMs),
      this.requestJson('/v1/models', timeoutMs),
      this.requestJson('/props', timeoutMs),
    ])
    const health = HealthResponseSchema.safeParse(healthValue)
    const models = ModelsResponseSchema.safeParse(modelsValue)
    const props = PropsResponseSchema.safeParse(propsValue)
    if (!health.success || !models.success || !props.success) {
      throw new SpikeError(
        'capability',
        'llama.cpp capability response did not match its API shape',
        {
          cause: !health.success ? health.error : !models.success ? models.error : props.error,
        },
      )
    }
    return {
      healthStatus: health.data.status,
      modelIds: models.data.data.map((entry) => entry.id),
      totalSlots: props.data.total_slots,
      endpoints: {
        chatCompletions: true,
        health: true,
        models: true,
        props: true,
      },
    }
  }

  async generateStructured(
    options: StructuredRequestOptions = {},
  ): Promise<SyntheticStructuredOutput> {
    const controller = new AbortController()
    let timedOut = false
    let abortedByCaller = false
    const timeoutMs = options.timeoutMs ?? 10_000
    const onCallerAbort = (): void => {
      abortedByCaller = true
      controller.abort(options.signal?.reason)
    }
    options.signal?.addEventListener('abort', onCallerAbort, { once: true })
    if (options.signal?.aborted) onCallerAbort()
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new DOMException('llama.cpp spike timeout', 'TimeoutError'))
    }, timeoutMs)

    try {
      return await this.slots.withSlot(controller.signal, async () => {
        const adapter = openaiCompatibleText(this.model, {
          name: 'llama.cpp',
          baseURL: this.endpoint.openAiBaseUrl,
          apiKey: this.apiKey,
          maxRetries: 0,
          fetch: this.fetchImplementation,
        })
        const stream = chat({
          adapter,
          messages: [
            {
              role: 'user',
              content:
                'Synthetic compatibility probe: return verdict "pass" and a short non-empty summary.',
            },
          ],
          outputSchema: SyntheticStructuredOutputSchema,
          stream: true,
          abortController: controller,
          debug: false,
          modelOptions: {
            temperature: options.temperature ?? 0,
            seed: options.seed ?? 5,
            max_tokens: options.maxTokens ?? 64,
          },
        })
        let result: SyntheticStructuredOutput | undefined
        let receivedText = false
        for await (const event of stream) {
          if (event.type === 'TEXT_MESSAGE_CONTENT') receivedText = true
          if (event.type === 'RUN_ERROR') {
            if (event.code === 'structured-output-parse-failed') {
              throw new SpikeError('malformed_response', 'structured response was not valid JSON', {
                cause: event,
              })
            }
            if (event.code === 'structured-output-validation-failed') {
              throw new SpikeError(
                'schema_validation',
                'structured response failed the requested schema',
                { cause: event },
              )
            }
            if (receivedText) {
              throw new SpikeError('stream', 'structured response stream failed', { cause: event })
            }
            throw event
          }
          if (event.type === 'CUSTOM' && event.name === 'structured-output.complete') {
            result = SyntheticStructuredOutputSchema.parse(event.value.object)
          }
        }
        if (controller.signal.aborted) {
          throw controller.signal.reason ?? new DOMException('Aborted', 'AbortError')
        }
        if (result === undefined) {
          throw new SpikeError('malformed_response', 'structured response did not complete')
        }
        return result
      })
    } catch (error: unknown) {
      throw classifyError(error, {
        abortedByCaller,
        timedOut,
        operation: 'structured generation',
      })
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onCallerAbort)
    }
  }

  async runCancellationProbe(signal: AbortSignal, timeoutMs = 5_000): Promise<void> {
    const controller = new AbortController()
    let timedOut = false
    let abortedByCaller = false
    const onCallerAbort = (): void => {
      abortedByCaller = true
      controller.abort(signal.reason)
    }
    signal.addEventListener('abort', onCallerAbort, { once: true })
    if (signal.aborted) onCallerAbort()
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new DOMException('llama.cpp cancellation probe timeout', 'TimeoutError'))
    }, timeoutMs)

    try {
      await this.slots.withSlot(controller.signal, async () => {
        const adapter = openaiCompatibleText(this.model, {
          name: 'llama.cpp',
          baseURL: this.endpoint.openAiBaseUrl,
          apiKey: this.apiKey,
          maxRetries: 0,
          fetch: this.fetchImplementation,
        })
        const stream = chat({
          adapter,
          messages: [
            {
              role: 'user',
              content:
                'Synthetic cancellation probe: emit the word probe repeatedly until stopped.',
            },
          ],
          abortController: controller,
          debug: false,
          modelOptions: {
            temperature: 0,
            seed: 5,
            max_tokens: 4_096,
            ignore_eos: true,
          },
        })
        for await (const event of stream) {
          if (event.type === 'RUN_ERROR') throw event
          if (controller.signal.aborted) break
        }
        if (controller.signal.aborted) {
          throw controller.signal.reason ?? new DOMException('Aborted', 'AbortError')
        }
      })
    } catch (error: unknown) {
      throw classifyError(error, {
        abortedByCaller,
        timedOut,
        operation: 'cancellation probe',
      })
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onCallerAbort)
    }
  }

  private async requestJson(path: string, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await this.fetchImplementation(`${this.endpoint.origin}${path}`, {
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new SpikeError('http', `llama.cpp ${path} returned HTTP ${response.status}`, {
          retryable: response.status >= 500,
          status: response.status,
        })
      }
      try {
        return await response.json()
      } catch (error: unknown) {
        throw new SpikeError('malformed_response', `llama.cpp ${path} returned malformed JSON`, {
          cause: error,
        })
      }
    } catch (error: unknown) {
      throw classifyError(error, {
        timedOut: controller.signal.aborted,
        operation: `capability probe ${path}`,
      })
    } finally {
      clearTimeout(timer)
    }
  }
}
