#!/usr/bin/env node
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'

const [mode, ...arguments_] = process.argv.slice(2)

function send(message) {
  if (process.send) process.send(message)
  else process.stdout.write(`${JSON.stringify(message)}\n`)
}

if (mode === 'server') {
  const [service = 'unknown'] = arguments_
  const colors = { audiobook: '#123456', brain: '#345612', tts: '#561234' }
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(
      `<!doctype html><html><body style="margin:0;background:${colors[service] ?? '#111111'};color:white"><h1>topology-service:${service}</h1><p>pid:${process.pid}</p></body></html>`,
    )
  })
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing server address')
    send({ type: 'ready', service, pid: process.pid, host: address.address, port: address.port })
  })

  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
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
