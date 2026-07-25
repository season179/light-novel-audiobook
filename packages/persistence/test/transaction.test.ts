import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { classifySqliteFailure, withTransaction } from '../src/transaction.js'

const fresh = (): DatabaseSync => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE t (v TEXT PRIMARY KEY)')
  return db
}

const put = (db: DatabaseSync, v: string) => db.prepare('INSERT INTO t VALUES (?)').run(v)

const rows = (db: DatabaseSync): readonly string[] =>
  (db.prepare('SELECT v FROM t ORDER BY v').all() as unknown as { v: string }[]).map((r) => r.v)

/** Probe for a dangling transaction: BEGIN only fails when one is already open. */
const inTransaction = (db: DatabaseSync): boolean => {
  try {
    db.exec('BEGIN')
    db.exec('ROLLBACK')
    return false
  } catch {
    return true
  }
}

describe('withTransaction', () => {
  it('commits a single unit of work', () => {
    const db = fresh()
    withTransaction(db, () => put(db, 'one'))
    expect(rows(db)).toEqual(['one'])
    expect(inTransaction(db)).toBe(false)
  })

  it('rolls back and rethrows when the work throws', () => {
    const db = fresh()
    expect(() =>
      withTransaction(db, () => {
        put(db, 'doomed')
        throw new Error('work boom')
      }),
    ).toThrow('work boom')
    expect(rows(db)).toEqual([])
    expect(inTransaction(db)).toBe(false)
  })

  it('commits nested units together', () => {
    const db = fresh()
    withTransaction(db, () => {
      put(db, 'outer')
      withTransaction(db, () => put(db, 'inner'))
    })
    expect(rows(db)).toEqual(['inner', 'outer'])
    expect(inTransaction(db)).toBe(false)
  })

  // The reentrancy defect: `BEGIN` inside a transaction throws, and the inner unit's writes
  // used to stay in the outer transaction instead of rolling back with it.
  it('rolls back only the inner unit when the outer catches its failure', () => {
    const db = fresh()
    withTransaction(db, () => {
      put(db, 'outer')
      expect(() =>
        withTransaction(db, () => {
          put(db, 'inner')
          throw new Error('inner boom')
        }),
      ).toThrow('inner boom')
      put(db, 'after')
    })
    expect(rows(db)).toEqual(['after', 'outer'])
    expect(inTransaction(db)).toBe(false)
  })

  it('rolls back everything when an inner failure propagates', () => {
    const db = fresh()
    expect(() =>
      withTransaction(db, () => {
        put(db, 'outer')
        withTransaction(db, () => {
          put(db, 'inner')
          throw new Error('propagating boom')
        })
      }),
    ).toThrow('propagating boom')
    expect(rows(db)).toEqual([])
    expect(inTransaction(db)).toBe(false)
  })

  it('nests three levels deep and returns the innermost value', () => {
    const db = fresh()
    const value = withTransaction(db, () =>
      withTransaction(db, () =>
        withTransaction(db, () => {
          put(db, 'deep')
          return 'returned'
        }),
      ),
    )
    expect(value).toBe('returned')
    expect(rows(db)).toEqual(['deep'])
    expect(inTransaction(db)).toBe(false)
  })

  // A failed opening statement must not roll back a transaction this call does not own -- which
  // is why BEGIN is deliberately outside the helper's try.
  it('does not roll back a transaction it did not open', () => {
    const db = fresh()
    db.exec('BEGIN')
    put(db, 'not-mine')

    expect(() => withTransaction(db, () => put(db, 'never'))).toThrow()

    // Their transaction is still open and still committable.
    expect(inTransaction(db)).toBe(true)
    db.exec('COMMIT')
    expect(rows(db)).toEqual(['not-mine'])
  })

  it('rolls back and leaves no open transaction when COMMIT itself fails', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('CREATE TABLE parent (id TEXT PRIMARY KEY)')
    db.exec(
      'CREATE TABLE child (id TEXT PRIMARY KEY, pid TEXT REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)',
    )

    // A deferred foreign key is only enforced at COMMIT, so the commit is what throws.
    expect(() =>
      withTransaction(db, () => {
        db.prepare('INSERT INTO child VALUES (?, ?)').run('c1', 'missing-parent')
      }),
    ).toThrow()

    expect(inTransaction(db)).toBe(false)
    expect((db.prepare('SELECT COUNT(*) AS n FROM child').get() as { n: number }).n).toBe(0)
  })

  it('restores depth after a failure so the connection stays usable', () => {
    const db = fresh()
    expect(() =>
      withTransaction(db, () => {
        throw new Error('boom')
      }),
    ).toThrow('boom')

    // If depth had leaked, this would try SAVEPOINT with no transaction open.
    withTransaction(db, () => put(db, 'after-failure'))
    expect(rows(db)).toEqual(['after-failure'])
  })

  // BEGIN IMMEDIATE is what makes busy_timeout apply: a deferred BEGIN takes a read snapshot
  // first and the later write fails SQLITE_BUSY_SNAPSHOT, which no timeout waits out.
  it('opens the outermost transaction as a writer', () => {
    const db = fresh()
    withTransaction(db, () => {
      // A write lock is already held, so the connection is mid-transaction.
      expect(inTransaction(db)).toBe(true)
    })
  })
})

describe('classifySqliteFailure', () => {
  it('classifies a constraint violation', () => {
    const db = fresh()
    put(db, 'dup')
    try {
      put(db, 'dup')
      expect.unreachable('duplicate insert should have thrown')
    } catch (error) {
      expect(classifySqliteFailure(error)).toBe('constraint')
    }
  })

  it('reads the primary code out of an extended code', () => {
    // 1555 = SQLITE_CONSTRAINT_PRIMARYKEY, 517 = SQLITE_BUSY_SNAPSHOT, 261 = SQLITE_BUSY_RECOVERY.
    expect(classifySqliteFailure({ errcode: 1555 })).toBe('constraint')
    expect(classifySqliteFailure({ errcode: 517 })).toBe('busy')
    expect(classifySqliteFailure({ errcode: 261 })).toBe('busy')
    expect(classifySqliteFailure({ errcode: 5 })).toBe('busy')
    expect(classifySqliteFailure({ errcode: 6 })).toBe('busy')
  })

  it('does not classify unrelated failures as retryable', () => {
    expect(classifySqliteFailure({ errcode: 1 })).toBeNull()
    expect(classifySqliteFailure(new Error('plain'))).toBeNull()
    expect(classifySqliteFailure(undefined)).toBeNull()
    expect(classifySqliteFailure(null)).toBeNull()
  })
})
