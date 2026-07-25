/** The single SQLite transaction helper, shared by the repository and the migrator. */

import type { DatabaseSync } from 'node:sqlite'

/** Primary SQLite result codes. node:sqlite reports the *extended* code on `errcode`. */
const SQLITE_BUSY = 5
const SQLITE_LOCKED = 6
const SQLITE_CONSTRAINT = 19

/** Open transaction depth per connection, so a nested call nests instead of failing. */
const transactionDepth = new WeakMap<DatabaseSync, number>()

/**
 * Run `work` inside a SQLite transaction. node:sqlite's DatabaseSync exposes no `transaction()`
 * helper, so BEGIN/COMMIT/ROLLBACK are issued explicitly here. A nested call uses a savepoint:
 * `BEGIN` inside a transaction is an error, and rolling the outer transaction back on the inner
 * unit's behalf would silently discard work the caller still owns.
 */
export function withTransaction<T>(db: DatabaseSync, work: () => T): T {
  const depth = transactionDepth.get(db) ?? 0
  const savepoint = depth > 0 ? `lna_sp_${depth}` : null

  // BEGIN IMMEDIATE, not a deferred BEGIN: every unit of work here writes, and several read
  // before writing. A deferred transaction takes a read snapshot first, so once another process
  // commits, the write fails with SQLITE_BUSY_SNAPSHOT -- which busy_timeout does NOT wait out.
  // Taking the write lock up front is what makes busy_timeout actually apply.
  //
  // The opening statement stays outside the try. If it fails there is no transaction or
  // savepoint belonging to *this* call, and issuing ROLLBACK would destroy the caller's. That
  // also means a busy BEGIN IMMEDIATE, and a busy COMMIT, surface to the caller -- callers that
  // retry must classify around the whole withTransaction call, not just around their own work.
  db.exec(savepoint === null ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`)
  transactionDepth.set(db, depth + 1)
  try {
    const result = work()
    // Inside the try, so a failed commit/release still unwinds below.
    db.exec(savepoint === null ? 'COMMIT' : `RELEASE ${savepoint}`)
    transactionDepth.set(db, depth)
    return result
  } catch (error) {
    transactionDepth.set(db, depth)
    try {
      if (savepoint === null) {
        db.exec('ROLLBACK')
      } else {
        // ROLLBACK TO rewinds but leaves the savepoint active; RELEASE pops it.
        db.exec(`ROLLBACK TO ${savepoint}`)
        db.exec(`RELEASE ${savepoint}`)
      }
    } catch {
      // Preserve the causative error; a failed rollback should not mask it.
    }
    throw error
  }
}

/** Map a node:sqlite failure onto the two outcomes a caller can legitimately retry. */
export function classifySqliteFailure(error: unknown): 'busy' | 'constraint' | null {
  if (typeof error !== 'object' || error === null) return null
  const { errcode } = error as { errcode?: unknown }
  if (typeof errcode !== 'number') return null
  switch (errcode & 0xff) {
    case SQLITE_BUSY:
    case SQLITE_LOCKED:
      return 'busy'
    case SQLITE_CONSTRAINT:
      return 'constraint'
    default:
      return null
  }
}
