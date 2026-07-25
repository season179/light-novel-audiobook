export const DEFAULT_BRAIN_HOST = '127.0.0.1'
export const DEFAULT_BRAIN_PORT = 8080
export const DEFAULT_BRAIN_ENDPOINT = `http://${DEFAULT_BRAIN_HOST}:${DEFAULT_BRAIN_PORT}`

export class LoopbackEndpoint {
  readonly origin: string
  readonly openAiBaseUrl: string
  readonly host: string
  readonly port: number

  constructor(value = DEFAULT_BRAIN_ENDPOINT) {
    const url = new URL(value)
    if (
      url.protocol !== 'http:' ||
      url.hostname !== DEFAULT_BRAIN_HOST ||
      url.username !== '' ||
      url.password !== '' ||
      (url.pathname !== '/' && url.pathname !== '') ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      throw new Error(
        `The llama.cpp spike requires an explicit HTTP loopback origin such as ${DEFAULT_BRAIN_ENDPOINT}`,
      )
    }

    const port = url.port === '' ? 80 : Number(url.port)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`Invalid llama.cpp port: ${url.port}`)
    }

    this.host = DEFAULT_BRAIN_HOST
    this.port = port
    this.origin = `http://${this.host}:${this.port}`
    this.openAiBaseUrl = `${this.origin}/v1`
  }
}
