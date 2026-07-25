/**
 * Serializable failure vocabulary for the local web API. Every boundary failure the browser can
 * act on gets a stable code so the UI never has to parse error prose.
 */
export const WEB_API_ERROR_CODES = [
  'invalid_upload',
  'unknown_upload',
  'unknown_job',
  'generation_rejected',
  'output_unavailable',
  'internal',
] as const

export type WebApiErrorCode = (typeof WEB_API_ERROR_CODES)[number]

export interface WebApiFailure {
  readonly code: WebApiErrorCode
  readonly message: string
}

export class WebApiError extends Error {
  readonly code: WebApiErrorCode

  constructor(code: WebApiErrorCode, message: string) {
    super(message)
    this.name = 'WebApiError'
    this.code = code
  }

  get failure(): WebApiFailure {
    return { code: this.code, message: this.message }
  }
}

/** Never leaks a stack trace or adapter internals to the browser. */
export const toWebApiFailure = (error: unknown): WebApiFailure => {
  if (error instanceof WebApiError) return error.failure
  return {
    code: 'internal',
    message: error instanceof Error ? error.message : String(error),
  }
}
