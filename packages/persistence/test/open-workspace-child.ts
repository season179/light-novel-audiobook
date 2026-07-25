// Child process for the simultaneous-fresh-open regression test (F2). Spawned with
// `node --import tsx`. Waits on a filesystem barrier so every child races the migration at the
// same moment, then reports whether openWorkspace survived.
import { existsSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { layoutFor, openWorkspace } from '../src/index.js'

const [, , root, barrier] = process.argv
if (root === undefined || barrier === undefined) {
  throw new Error('usage: open-workspace-child.ts <root> <barrier>')
}

try {
  const deadline = Date.now() + 10_000
  while (!existsSync(barrier)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for the migration race barrier: ${barrier}`)
    }
    await delay(10)
  }

  const db = openWorkspace(layoutFor(root))
  const version = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {
    v: number | null
  }
  const journal = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
  db.close()
  process.stdout.write(
    `${JSON.stringify({ ok: true, schemaVersion: version.v, journal: journal.journal_mode })}\n`,
  )
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, message: (error as Error).message })}\n`)
}
