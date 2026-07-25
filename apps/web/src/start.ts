import { createCsrfMiddleware, createMiddleware, createStart } from '@tanstack/react-start'
import { createRequestOriginPolicy } from './server/request-origin-policy.js'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const originPolicy = createRequestOriginPolicy()

/**
 * Exact Host/Origin allowlist, enforced before CSRF validation and on every method. This is the DNS
 * rebinding defence docs/PLAN.md asks for: `Sec-Fetch-Site: same-origin` is browser-relative and a
 * rebound `evil.example` satisfies it, so the configured Host is what actually has to match.
 */
const originAllowlistMiddleware = createMiddleware({ type: 'request' }).server(
  ({ request, next }) => {
    if (!originPolicy.isAllowed(request)) {
      return new Response('Forbidden', {
        status: 403,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    }
    return next()
  },
)

/**
 * Local-only request boundary. Anti-CSRF covers every state-changing request; safe requests are
 * exempt from *CSRF* only, because a top-level browser navigation legitimately arrives with
 * `Sec-Fetch-Site: none` and rejecting those would make the app unreachable. They are still subject
 * to the Host allowlist above.
 */
export const startInstance = createStart(() => ({
  requestMiddleware: [
    originAllowlistMiddleware,
    createCsrfMiddleware({
      filter: ({ request }) => !SAFE_METHODS.has(request.method.toUpperCase()),
      origin: [...originPolicy.allowedOrigins],
    }),
  ],
}))
