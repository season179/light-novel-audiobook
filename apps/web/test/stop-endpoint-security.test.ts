import { describe, expect, it } from 'vitest'
import { Route, STOP_ENDPOINT_METHOD } from '../src/routes/api.stop.js'
import { csrfAllows, originRejection, requestNeedsCsrf } from '../src/start.js'

const stopRequest = (headers: Record<string, string> = {}, method = STOP_ENDPOINT_METHOD) =>
  new Request('http://127.0.0.1:3000/api/stop', {
    method,
    headers: { host: '127.0.0.1:3000', ...headers },
  })

describe('the unauthenticated local stop boundary', () => {
  it('is POST-only, so it remains inside the existing state-changing CSRF cover', async () => {
    // This assertion is deliberately first: a GET mutation must fail because safe methods bypass
    // CSRF, not merely because a constant changed spelling.
    expect(requestNeedsCsrf(stopRequest())).toBe(true)
    expect(await csrfAllows(stopRequest())).toBe(false)
    expect(STOP_ENDPOINT_METHOD).toBe('POST')
    expect(await csrfAllows(stopRequest({ origin: 'http://127.0.0.1:3000' }))).toBe(true)

    const handlers = Route.options.server?.handlers
    expect(handlers).toHaveProperty('POST')
    expect(handlers).not.toHaveProperty('GET')
  })

  it('refuses the stop endpoint for a disallowed Host before its handler can run', () => {
    const request = stopRequest({
      host: 'evil.example',
      origin: 'http://evil.example',
      'sec-fetch-site': 'same-origin',
    })

    const rejection = originRejection(request)
    expect(rejection?.status).toBe(403)
  })
})
