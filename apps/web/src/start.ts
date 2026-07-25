import { createCsrfMiddleware, createStart } from '@tanstack/react-start'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Local-only request boundary. docs/PLAN.md requires an anti-CSRF check on every state-changing
 * request at the review HTTP boundary, so any non-safe request that does not come from this app's
 * own origin is refused. Safe requests are exempt: a top-level browser navigation legitimately
 * arrives with `Sec-Fetch-Site: none`, and rejecting those would make the app unreachable.
 */
export const startInstance = createStart(() => ({
  requestMiddleware: [
    createCsrfMiddleware({
      filter: ({ request }) => !SAFE_METHODS.has(request.method.toUpperCase()),
    }),
  ],
}))
