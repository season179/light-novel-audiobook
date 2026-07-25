// Child process for repository busy-retry tests. It owns SQLite's writer lock independently of
// the test process, whose synchronous DatabaseSync call would otherwise prevent an in-process
// timer from releasing the lock.
import { writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'

const [, , dbPath, readyPath, holdMsText] = process.argv
if (dbPath === undefined || readyPath === undefined || holdMsText === undefined) {
  throw new Error('usage: hold-write-lock-child.ts <db-path> <ready-path> <hold-ms>')
}

const holdMs = Number.parseInt(holdMsText, 10)
if (!Number.isSafeInteger(holdMs) || holdMs < 0) {
  throw new Error(`hold-ms must be a non-negative safe integer: ${holdMsText}`)
}

const db = new DatabaseSync(dbPath)
try {
  db.exec('BEGIN IMMEDIATE')
  writeFileSync(readyPath, 'locked')
  await delay(holdMs)
  db.exec('COMMIT')
} finally {
  db.close()
}
