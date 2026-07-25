import { createHash } from 'node:crypto'

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
