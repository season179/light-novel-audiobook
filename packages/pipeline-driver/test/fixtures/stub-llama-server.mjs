/**
 * Stands in for the owned `llama-server` process, without weights or a GPU.
 *
 * It exists so `OwnedLlamaLifecycle` can be tested against a *real* child process: it answers
 * `GET /health` the way llama.cpp does, holds the configured port for as long as it lives, and
 * forwards everything else to the in-process narration-echo endpoint. Forwarding rather than
 * answering directly is the point — the director's traffic genuinely flows through this process, so
 * when the lifecycle reaps it, direction becomes impossible exactly as it would in real mode.
 *
 * Usage: node stub-llama-server.mjs <port> <upstream base url> [--ignore-sigterm]
 */
import { createServer, request as httpRequest } from 'node:http'

const port = Number(process.argv[2])
const upstream = new URL(process.argv[3])
const ignoreSigterm = process.argv.includes('--ignore-sigterm')

if (!Number.isSafeInteger(port) || port < 1) {
  process.stderr.write('stub-llama-server: a positive integer port is required\n')
  process.exit(2)
}

// Exercises the lifecycle's SIGTERM-then-SIGKILL escalation when asked for.
if (ignoreSigterm) process.on('SIGTERM', () => {})

const server = createServer((incoming, outgoing) => {
  if (incoming.method === 'GET' && incoming.url === '/health') {
    outgoing.writeHead(200, { 'content-type': 'application/json' })
    outgoing.end(JSON.stringify({ status: 'ok' }))
    return
  }
  const proxied = httpRequest(
    {
      hostname: upstream.hostname,
      port: upstream.port,
      path: incoming.url,
      method: incoming.method,
      headers: { ...incoming.headers, host: `${upstream.hostname}:${upstream.port}` },
    },
    (upstreamResponse) => {
      outgoing.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(outgoing)
    },
  )
  proxied.on('error', () => {
    if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'application/json' })
    outgoing.end(JSON.stringify({ error: { message: 'stub upstream unreachable' } }))
  })
  incoming.pipe(proxied)
})

server.listen(port, '127.0.0.1', () => {
  process.stderr.write(`stub-llama-server listening on ${port}\n`)
})
