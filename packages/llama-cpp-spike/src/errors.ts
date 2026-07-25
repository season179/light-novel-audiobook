export type SpikeErrorCode =
  | 'cancelled'
  | 'timeout'
  | 'unavailable'
  | 'http'
  | 'model'
  | 'stream'
  | 'malformed_response'
  | 'schema_validation'
  | 'capability'
  | 'unexpected'

export interface ErrorContext {
  readonly abortedByCaller?: boolean
  readonly timedOut?: boolean
  readonly operation?: string
}

export class SpikeError extends Error {
  override readonly name = 'SpikeError'
  readonly code: SpikeErrorCode
  readonly retryable: boolean
  readonly status: number | undefined
  readonly providerCode: string | undefined

  constructor(
    code: SpikeErrorCode,
    message: string,
    options: {
      cause?: unknown
      retryable?: boolean
      status?: number
      providerCode?: string
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    this.retryable = options.retryable ?? false
    this.status = options.status
    this.providerCode = options.providerCode
  }
}

interface ErrorFacts {
  readonly messages: Array<string>
  readonly names: Array<string>
  readonly codes: Array<string>
  readonly statuses: Array<number>
}

function collectErrorFacts(value: unknown): ErrorFacts {
  const facts: {
    messages: Array<string>
    names: Array<string>
    codes: Array<string>
    statuses: Array<number>
  } = { messages: [], names: [], codes: [], statuses: [] }
  const seen = new Set<unknown>()

  const visit = (candidate: unknown): void => {
    if (candidate === null || candidate === undefined || seen.has(candidate)) return
    seen.add(candidate)
    if (typeof candidate === 'string') {
      facts.messages.push(candidate)
      return
    }
    if (typeof candidate !== 'object') return

    const record = candidate as Record<string, unknown>
    if (typeof record.message === 'string') {
      facts.messages.push(record.message)
      const statusMatch = /(?:^|\s)([45][0-9]{2})(?:\s|$)/.exec(record.message)
      if (statusMatch?.[1]) facts.statuses.push(Number(statusMatch[1]))
    }
    if (typeof record.name === 'string') facts.names.push(record.name)
    if (typeof record.code === 'string') facts.codes.push(record.code)
    if (typeof record.type === 'string') facts.codes.push(record.type)
    if (typeof record.status === 'number') facts.statuses.push(record.status)
    visit(record.cause)
    visit(record.error)
    visit(record.rawEvent)
  }

  visit(value)
  return facts
}

function publicMessage(context: ErrorContext, fallback: string): string {
  return `${context.operation ?? 'llama.cpp request'}: ${fallback}`
}

export function classifyError(error: unknown, context: ErrorContext = {}): SpikeError {
  if (error instanceof SpikeError) return error
  if (context.timedOut) {
    return new SpikeError('timeout', publicMessage(context, 'timed out'), {
      cause: error,
      retryable: true,
    })
  }
  if (context.abortedByCaller) {
    return new SpikeError('cancelled', publicMessage(context, 'was cancelled'), { cause: error })
  }

  const facts = collectErrorFacts(error)
  const text = [...facts.names, ...facts.codes, ...facts.messages].join(' ').toLowerCase()
  const status = facts.statuses[0]
  const providerCode = facts.codes[0]

  if (/aborterror|aborted|cancelled|canceled/.test(text)) {
    return new SpikeError('cancelled', publicMessage(context, 'was cancelled'), { cause: error })
  }
  if (
    /econnrefused|enotfound|ehostunreach|connection error|fetch failed|connect timeout/.test(text)
  ) {
    return new SpikeError('unavailable', publicMessage(context, 'endpoint is unavailable'), {
      cause: error,
      retryable: true,
    })
  }
  if (/standardschemavalidationerror|zoderror|validation failed|schema validation/.test(text)) {
    return new SpikeError(
      'schema_validation',
      publicMessage(context, 'response failed schema validation'),
      { cause: error },
    )
  }
  if (/unexpected end of json|json parse|invalid json|unterminated json|malformed/.test(text)) {
    return new SpikeError('malformed_response', publicMessage(context, 'response was malformed'), {
      cause: error,
    })
  }
  if (
    /model_not_found|model not found|context_length|context window|model_error|model error/.test(
      text,
    )
  ) {
    return new SpikeError('model', publicMessage(context, 'model rejected the request'), {
      cause: error,
      ...(status === undefined ? {} : { status }),
      ...(providerCode === undefined ? {} : { providerCode }),
    })
  }
  if (
    status !== undefined ||
    /status code|http [45][0-9][0-9]|apierror|rate_limit|rate limit/.test(text)
  ) {
    return new SpikeError('http', publicMessage(context, 'endpoint returned an HTTP error'), {
      cause: error,
      retryable: status === 429 || (status !== undefined && status >= 500),
      ...(status === undefined ? {} : { status }),
      ...(providerCode === undefined ? {} : { providerCode }),
    })
  }
  if (/stream|sse|terminated|premature close|socket|parse error/.test(text)) {
    return new SpikeError('stream', publicMessage(context, 'response stream failed'), {
      cause: error,
      retryable: true,
    })
  }
  return new SpikeError('unexpected', publicMessage(context, 'failed unexpectedly'), {
    cause: error,
  })
}
