export type DirectorErrorCode =
  | 'cancelled'
  | 'configuration'
  | 'timeout'
  | 'unavailable'
  | 'http'
  | 'model'
  | 'stream'
  | 'malformed_output'
  | 'schema_validation'
  | 'fidelity'
  | 'gpu_busy'
  | 'progress'
  | 'released'
  | 'unexpected'

export class DirectorError extends Error {
  override readonly name: string = 'DirectorError'

  constructor(
    readonly code: DirectorErrorCode,
    message: string,
    readonly retryable = false,
    options: { cause?: unknown; status?: number; providerCode?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.status = options.status
    this.providerCode = options.providerCode
  }

  readonly status: number | undefined
  readonly providerCode: string | undefined
}

interface ErrorFacts {
  readonly text: string
  readonly status: number | undefined
  readonly providerCode: string | undefined
}

function errorFacts(error: unknown): ErrorFacts {
  const words: string[] = []
  const statuses: number[] = []
  const codes: string[] = []
  const seen = new Set<unknown>()
  const visit = (value: unknown): void => {
    if (value === null || value === undefined || seen.has(value)) return
    seen.add(value)
    if (typeof value === 'string') {
      words.push(value)
      return
    }
    if (typeof value !== 'object') return
    const record = value as Record<string, unknown>
    if (typeof record.name === 'string') words.push(record.name)
    if (typeof record.message === 'string') {
      words.push(record.message)
      const statusMatch = /(?:^|\s)([45][0-9]{2})(?:\s|$)/.exec(record.message)
      if (statusMatch?.[1]) statuses.push(Number(statusMatch[1]))
    }
    for (const key of ['code', 'type'] as const) {
      if (typeof record[key] === 'string') {
        words.push(record[key])
        codes.push(record[key])
      }
    }
    if (typeof record.status === 'number') statuses.push(record.status)
    visit(record.cause)
    visit(record.error)
    visit(record.rawEvent)
  }
  visit(error)
  return {
    text: words.join(' ').toLowerCase(),
    status: statuses[0],
    providerCode: codes[0],
  }
}

export function classifyDirectorError(
  error: unknown,
  context: { timedOut?: boolean; callerCancelled?: boolean; operation?: string } = {},
): DirectorError {
  const operation = context.operation ?? 'Gemma Director request'
  if (context.timedOut) {
    return new DirectorError('timeout', `${operation} timed out`, true, { cause: error })
  }
  if (context.callerCancelled) {
    return new DirectorError('cancelled', `${operation} was cancelled`, false, { cause: error })
  }
  if (error instanceof DirectorError) return error

  const facts = errorFacts(error)
  const options = {
    cause: error,
    ...(facts.status === undefined ? {} : { status: facts.status }),
    ...(facts.providerCode === undefined ? {} : { providerCode: facts.providerCode }),
  }
  if (/aborterror|aborted|cancelled|canceled/.test(facts.text)) {
    return new DirectorError('cancelled', `${operation} was cancelled`, false, options)
  }
  if (/econnrefused|enotfound|ehostunreach|connection error|fetch failed/.test(facts.text)) {
    return new DirectorError('unavailable', `${operation} endpoint is unavailable`, true, options)
  }
  if (
    /structured-output-parse-failed|unexpected end of json|invalid json|malformed/.test(facts.text)
  ) {
    return new DirectorError(
      'malformed_output',
      `${operation} returned malformed JSON`,
      false,
      options,
    )
  }
  if (
    /structured-output-validation-failed|standardschemavalidationerror|zoderror|schema validation|validation failed/.test(
      facts.text,
    )
  ) {
    return new DirectorError(
      'schema_validation',
      `${operation} output failed schema validation`,
      false,
      options,
    )
  }
  if (
    /model_not_found|model not found|context_length|context window|model error/.test(facts.text)
  ) {
    return new DirectorError('model', `${operation} was rejected by the model`, false, options)
  }
  if (
    facts.status !== undefined ||
    /apierror|server_error|status code|rate.limit|http [45][0-9]{2}/.test(facts.text)
  ) {
    const retryable = facts.status === 429 || (facts.status !== undefined && facts.status >= 500)
    return new DirectorError('http', `${operation} returned an HTTP error`, retryable, options)
  }
  if (/stream|sse|terminated|premature close|socket/.test(facts.text)) {
    return new DirectorError('stream', `${operation} response stream failed`, true, options)
  }
  return new DirectorError('unexpected', `${operation} failed unexpectedly`, false, options)
}
