/**
 * Exact Host and Origin allowlists for the review HTTP boundary, as docs/PLAN.md requires.
 *
 * Same-origin CSRF checking alone is not enough: a page on `evil.example` that resolves to
 * 127.0.0.1 reaches this server with `Host: evil.example` and a *same-origin* fetch, because the
 * browser considers `evil.example` the origin of both. Rejecting unknown Host values is what stops
 * DNS rebinding. `vite.server.allowedHosts` only covers the dev server, so the check has to live in
 * request middleware that the built handler runs too.
 */
export const WEB_ORIGINS_ENV_VAR = 'AUDIOBOOK_WEB_ORIGINS'

const DEFAULT_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'] as const

export interface RequestOriginPolicy {
  readonly allowedHosts: readonly string[]
  readonly allowedOrigins: readonly string[]
  isAllowed(request: { readonly headers: Headers; readonly url: string }): boolean
}

const hostOf = (origin: string): string | undefined => {
  try {
    return new URL(origin).host
  } catch {
    return undefined
  }
}

/**
 * @param configured Comma-separated absolute origins. Defaults to the two loopback forms of the
 * configured review port; set `AUDIOBOOK_WEB_ORIGINS` when the app is served on another port.
 */
export const createRequestOriginPolicy = (configured?: string | undefined): RequestOriginPolicy => {
  const requested = configured ?? process.env[WEB_ORIGINS_ENV_VAR]
  const origins = (
    requested === undefined || requested.trim().length === 0
      ? [...DEFAULT_ORIGINS]
      : requested
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
  ).filter((origin) => hostOf(origin) !== undefined)

  const allowedOrigins = [...new Set(origins)]
  const allowedHosts = [
    ...new Set(allowedOrigins.map((origin) => hostOf(origin)).filter((host) => host !== undefined)),
  ]

  return {
    allowedHosts,
    allowedOrigins,
    isAllowed(request) {
      // Host is checked on every method, including safe ones: a rebinding attack reads with GET.
      const host = request.headers.get('host')
      if (host === null || !allowedHosts.includes(host)) return false
      const origin = request.headers.get('origin')
      if (origin !== null && origin !== 'null' && !allowedOrigins.includes(origin)) return false
      return true
    },
  }
}
