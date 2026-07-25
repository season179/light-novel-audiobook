import { DomainError } from '@light-novel-audiobook/domain'

/**
 * Serializable failure vocabulary for the local web API. Every boundary failure the browser can act
 * on gets a stable code, so a caller switches on `code` and never parses error prose.
 */
export const WEB_API_ERROR_CODES = [
  'invalid_request',
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

/**
 * The one shape every operation returns. `ok: true` always carries `value`; `ok: false` always
 * carries a `WebApiFailure`. Reads that legitimately have "no such thing" answers use
 * `{ ok: true, value: null }` so a caller can tell absence from failure.
 */
export type WebApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: WebApiFailure }

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

const UNEXPECTED_MESSAGE =
  'The local server hit an unexpected error. Check the server log for details.'

/**
 * Only messages this codebase authored reach the browser. `WebApiError` and `DomainError` are ours
 * by construction and stay intact; anything else — a SQLite path, a model key, an FFmpeg stack — is
 * logged here and replaced, because the browser is not the place to publish infrastructure internals.
 */
export const toPublicFailure = (error: unknown, context: string): WebApiFailure => {
  if (error instanceof WebApiError) return error.failure
  if (error instanceof DomainError) return { code: 'generation_rejected', message: error.message }
  console.error(`[audiobook-web-api] unexpected failure in ${context}:`, error)
  return { code: 'internal', message: UNEXPECTED_MESSAGE }
}

/**
 * The message an adapter failure is allowed to carry once it leaves this boundary. Used before a
 * failure can be persisted into job state, since job state is read straight back by the browser.
 */
export const toPublicFailureMessage = (error: unknown, context: string): string =>
  toPublicFailure(error, context).message

/** Normalizes one operation into `WebApiResult`. Used at every boundary, with no exceptions. */
export const toWebApiResult = async <T>(
  context: string,
  operation: () => Promise<T>,
): Promise<WebApiResult<T>> => {
  try {
    return { ok: true, value: await operation() }
  } catch (error) {
    return { ok: false, error: toPublicFailure(error, context) }
  }
}

export const requireIdInput = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WebApiError('invalid_request', `${label} is required.`)
  }
  return value
}
