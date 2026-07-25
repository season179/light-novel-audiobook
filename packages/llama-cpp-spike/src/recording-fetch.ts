import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { Readable } from 'node:stream'

export interface SanitizedRequestCapture {
  readonly method: string
  readonly path: string
  readonly bodyBytes: number
  readonly bodySha256: string
  readonly forwardedBodySha256: string
  readonly authorization: {
    readonly present: boolean
    readonly scheme: string | undefined
    readonly redacted: true
  }
  readonly contentType: string | null
  readonly assertedFields: Record<string, unknown>
  backendStatus: number | undefined
}

export interface LoopbackRecordingFetchOptions {
  readonly fetch?: typeof globalThis.fetch
  readonly inspectBody: (body: Uint8Array) => Record<string, unknown>
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Node HTTP transport with a fresh loopback socket per request. This prevents an aborted SSE
 * connection from blocking a later request in a shared connection pool.
 */
export const loopbackHttpFetch: typeof globalThis.fetch = async (input, init) => {
  const webRequest = new Request(input, init)
  const url = new URL(webRequest.url)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
    throw new Error(`Loopback HTTP transport refused ${url.origin}`)
  }
  const body = webRequest.body === null ? undefined : Buffer.from(await webRequest.arrayBuffer())

  return await new Promise<Response>((resolve, reject) => {
    let responseStarted = false
    const request = httpRequest(
      url,
      {
        method: webRequest.method,
        headers: Object.fromEntries(webRequest.headers.entries()),
        agent: false,
      },
      (response) => {
        responseStarted = true
        const headers = new Headers()
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) headers.append(name, item)
          } else if (value !== undefined) {
            headers.set(name, value)
          }
        }
        resolve(
          new Response(Readable.toWeb(response) as ReadableStream, {
            status: response.statusCode ?? 500,
            ...(response.statusMessage === undefined ? {} : { statusText: response.statusMessage }),
            headers,
          }),
        )
      },
    )
    const abort = (): void => {
      const reason =
        webRequest.signal.reason instanceof Error
          ? webRequest.signal.reason
          : new DOMException('Request aborted', 'AbortError')
      request.destroy(reason)
    }
    webRequest.signal.addEventListener('abort', abort, { once: true })
    request.once('close', () => webRequest.signal.removeEventListener('abort', abort))
    request.once('error', (error) => {
      if (!responseStarted) reject(error)
    })
    if (webRequest.signal.aborted) {
      abort()
      return
    }
    request.end(body)
  })
}

/**
 * Captures sanitized metadata at the final fetch boundary, then forwards the same Request object.
 * Raw bodies and Authorization values are never retained.
 */
export class LoopbackRecordingFetch {
  readonly captures: Array<SanitizedRequestCapture> = []
  readonly fetch: typeof globalThis.fetch

  constructor(options: LoopbackRecordingFetchOptions) {
    const underlyingFetch = options.fetch ?? globalThis.fetch
    this.fetch = async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.hostname !== '127.0.0.1') {
        throw new Error(`Recording boundary refused non-loopback target: ${url.hostname}`)
      }

      let capture: SanitizedRequestCapture | undefined
      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = new Uint8Array(await request.clone().arrayBuffer())
        const authorization = request.headers.get('authorization')
        const bodyHash = sha256(body)
        capture = {
          method: request.method,
          path: url.pathname,
          bodyBytes: body.byteLength,
          bodySha256: bodyHash,
          forwardedBodySha256: bodyHash,
          authorization: {
            present: authorization !== null,
            scheme: authorization?.split(/\s+/, 1)[0],
            redacted: true,
          },
          contentType: request.headers.get('content-type'),
          assertedFields: options.inspectBody(body),
          backendStatus: undefined,
        }
        this.captures.push(capture)
      }

      const response = await underlyingFetch(request)
      if (capture) capture.backendStatus = response.status
      return response
    }
  }
}
