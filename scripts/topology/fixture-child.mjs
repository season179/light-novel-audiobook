#!/usr/bin/env node
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'

const [mode, ...arguments_] = process.argv.slice(2)

function send(message) {
  if (process.send) process.send(message)
  else process.stdout.write(`${JSON.stringify(message)}\n`)
}

if (mode === 'server') {
  const [
    service = 'unknown',
    ownerToken = 'missing-owner-token',
    host = '127.0.0.1',
    portValue = '0',
  ] = arguments_
  const colors = { review: '#123456', brain: '#345612', tts: '#561234' }
  const allowedHosts =
    service === 'review'
      ? new Set([`${host}:${portValue}`, `localhost:${portValue}`])
      : new Set([`${host}:${portValue}`])
  const allowedOrigins = new Set([`http://localhost:${portValue}`, `http://${host}:${portValue}`])
  const server = createServer((request, response) => {
    const requestHost = request.headers.host?.toLowerCase() ?? ''
    const origin = request.headers.origin
    if (!allowedHosts.has(requestHost)) {
      response.writeHead(421).end('host rejected')
      return
    }
    if (service !== 'review' && (origin || request.headers['sec-fetch-site'])) {
      response.writeHead(403).end('browser origin rejected')
      return
    }
    if (service === 'review' && origin && !allowedOrigins.has(origin)) {
      response.writeHead(403).end('origin rejected')
      return
    }
    if (service === 'review' && origin) {
      response.setHeader('access-control-allow-origin', origin)
      response.setHeader('vary', 'Origin')
    }
    if (request.method === 'OPTIONS') {
      response.setHeader('access-control-allow-methods', 'GET, POST')
      response.setHeader('access-control-allow-headers', 'content-type, x-csrf-token')
      response.writeHead(204).end()
      return
    }
    if (
      service === 'review' &&
      request.method !== 'GET' &&
      (!origin || request.headers['x-csrf-token'] !== ownerToken)
    ) {
      response.writeHead(403).end('csrf rejected')
      return
    }
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.setHeader('x-topology-owner-token', ownerToken)
    response.end(
      `<!doctype html><html><body style="margin:0;background:${colors[service] ?? '#111111'};color:white"><h1>topology-service:${service}</h1></body></html>`,
    )
  })
  server.once('error', (error) => {
    send({
      type: 'bind-error',
      service,
      ownerToken,
      code: 'code' in error ? error.code : 'UNKNOWN',
    })
    setImmediate(() => process.exit(1))
  })
  server.listen(Number(portValue), host, () => {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing server address')
    send({
      type: 'ready',
      service,
      ownerToken,
      pid: process.pid,
      host: address.address,
      port: address.port,
    })
  })

  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    send({ type: 'stopping', service, ownerToken, pid: process.pid })
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(2), 2_000).unref()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
} else if (mode === 'busy-holder') {
  const [databasePath, holdMillisecondsValue = '300'] = arguments_
  const database = new DatabaseSync(databasePath)
  database.exec(
    "PRAGMA busy_timeout = 0; BEGIN IMMEDIATE; INSERT INTO events(value) VALUES ('holder');",
  )
  send({ type: 'locked', pid: process.pid })
  setTimeout(() => {
    database.exec('COMMIT')
    database.close()
    process.exit(0)
  }, Number(holdMillisecondsValue))
} else if (mode === 'crash-writer') {
  const [databasePath, journalMode = 'delete', outcome = 'uncommitted'] = arguments_
  const database = new DatabaseSync(databasePath)
  database.exec(`PRAGMA journal_mode = ${journalMode}`)
  database.exec('PRAGMA synchronous = FULL; PRAGMA wal_autocheckpoint = 0; BEGIN IMMEDIATE;')
  database.prepare('UPDATE recovery SET value = ? WHERE id = 1').run(outcome)
  if (outcome === 'committed') database.exec('COMMIT')
  send({ type: 'ready-to-crash', pid: process.pid, outcome })
  setInterval(() => undefined, 60_000)
} else {
  throw new Error(`unknown topology fixture mode: ${mode ?? '<missing>'}`)
}
