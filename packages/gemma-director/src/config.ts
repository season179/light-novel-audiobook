export const DEFAULT_GEMMA_DIRECTOR_BASE_URL = 'http://127.0.0.1:8080/v1'

/** Server-side-only loopback endpoint. Browser code must never receive its API key. */
export class GemmaDirectorEndpoint {
  readonly baseUrl: string
  readonly origin: string
  readonly host = '127.0.0.1'
  readonly port: number

  constructor(value = DEFAULT_GEMMA_DIRECTOR_BASE_URL) {
    const url = new URL(value)
    const pathname = url.pathname.replace(/\/$/, '')
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.username !== '' ||
      url.password !== '' ||
      pathname !== '/v1' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      throw new Error(
        `Gemma Director requires an HTTP numeric-loopback /v1 URL such as ${DEFAULT_GEMMA_DIRECTOR_BASE_URL}`,
      )
    }
    const port = url.port === '' ? 80 : Number(url.port)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`Invalid Gemma Director port: ${url.port}`)
    }
    this.port = port
    this.origin = `http://${this.host}:${this.port}`
    this.baseUrl = `${this.origin}/v1`
  }
}
