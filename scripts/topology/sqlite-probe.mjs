import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { durableRename } from './core.mjs'

const fixturePath = fileURLToPath(new URL('./fixture-child.mjs', import.meta.url))

function scalar(database, sql) {
  const row = database.prepare(sql).get()
  return row ? Object.values(row)[0] : undefined
}

function openDatabase(path) {
  const database = new DatabaseSync(path)
  database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;')
  return database
}

function waitForMessage(child, expectedType, timeoutMilliseconds = 5_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`child did not report ${expectedType}`)),
      timeoutMilliseconds,
    )
    const onExit = (code, signal) => {
      clearTimeout(timeout)
      reject(new Error(`child exited before ${expectedType}: code=${code} signal=${signal}`))
    }
    child.once('exit', onExit)
    child.on('message', (message) => {
      if (message?.type !== expectedType) return
      clearTimeout(timeout)
      child.off('exit', onExit)
      resolve(message)
    })
  })
}

function waitForExit(child, timeoutMilliseconds = 5_000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode })
      return
    }
    const timeout = setTimeout(() => reject(new Error('child did not exit')), timeoutMilliseconds)
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      resolve({ code, signal })
    })
  })
}

function spawnFixture(arguments_) {
  return fork(fixturePath, arguments_, {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    execArgv: [],
  })
}

function createRecoveryDatabase(path, journalMode) {
  const database = openDatabase(path)
  const selectedMode = scalar(database, `PRAGMA journal_mode = ${journalMode}`)
  database.exec(
    'PRAGMA synchronous = FULL; CREATE TABLE recovery(id INTEGER PRIMARY KEY, value TEXT NOT NULL);',
  )
  database.prepare('INSERT INTO recovery(id, value) VALUES (1, ?)').run('original')
  database.close()
  return selectedMode
}

async function killAfterReady(child) {
  await waitForMessage(child, 'ready-to-crash')
  child.kill('SIGKILL')
  const exit = await waitForExit(child)
  assert.equal(exit.signal, 'SIGKILL')
}

export async function probeSqliteLocation({ label, root }) {
  const probeDirectory = join(root, `sqlite-topology-${process.pid}-${Date.now()}`)
  await mkdir(probeDirectory, { recursive: true })
  const startedAt = performance.now()

  try {
    const databasePath = join(probeDirectory, 'state.sqlite3')
    const database = openDatabase(databasePath)
    const journalMode = scalar(database, 'PRAGMA journal_mode = WAL')
    assert.equal(String(journalMode).toLowerCase(), 'wal')
    database.exec(
      "PRAGMA synchronous = FULL; CREATE TABLE events(id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO events(value) VALUES ('initial');",
    )

    const contender = openDatabase(databasePath)
    assert.equal(String(scalar(contender, 'PRAGMA journal_mode')).toLowerCase(), 'wal')
    database.exec("BEGIN IMMEDIATE; INSERT INTO events(value) VALUES ('owner');")
    assert.throws(
      () => contender.exec("INSERT INTO events(value) VALUES ('blocked')"),
      (error) => error?.code === 'ERR_SQLITE_ERROR' && /locked/i.test(error.message),
    )
    database.exec('ROLLBACK')
    contender.close()

    const busyHolder = spawnFixture(['busy-holder', databasePath, '300'])
    await waitForMessage(busyHolder, 'locked')
    const waitingContender = openDatabase(databasePath)
    waitingContender.exec('PRAGMA busy_timeout = 2000')
    const busyStartedAt = performance.now()
    waitingContender.exec("INSERT INTO events(value) VALUES ('waited')")
    const busyWaitMilliseconds = Math.round(performance.now() - busyStartedAt)
    assert.ok(busyWaitMilliseconds >= 150, `busy wait was only ${busyWaitMilliseconds} ms`)
    waitingContender.close()
    const busyExit = await waitForExit(busyHolder)
    assert.equal(busyExit.code, 0)

    const backupPath = join(probeDirectory, 'backup.sqlite3')
    await backup(database, backupPath)
    const backupDatabase = openDatabase(backupPath)
    assert.equal(scalar(backupDatabase, 'PRAGMA quick_check'), 'ok')
    assert.equal(scalar(backupDatabase, 'SELECT count(*) FROM events'), 3)
    backupDatabase.close()
    database.close()

    const atomicPath = join(probeDirectory, 'atomic.sqlite3')
    const oldDatabase = openDatabase(atomicPath)
    oldDatabase.exec(
      "PRAGMA journal_mode = DELETE; CREATE TABLE marker(value TEXT NOT NULL); INSERT INTO marker VALUES ('old')",
    )
    oldDatabase.close()
    const replacementPath = join(probeDirectory, 'atomic.sqlite3.next')
    const replacementDatabase = openDatabase(replacementPath)
    replacementDatabase.exec(
      "PRAGMA journal_mode = DELETE; CREATE TABLE marker(value TEXT NOT NULL); INSERT INTO marker VALUES ('new')",
    )
    replacementDatabase.close()
    await durableRename(replacementPath, atomicPath)
    const replacedDatabase = openDatabase(atomicPath)
    assert.equal(scalar(replacedDatabase, 'SELECT value FROM marker'), 'new')
    assert.equal(scalar(replacedDatabase, 'PRAGMA integrity_check'), 'ok')
    replacedDatabase.close()

    const rollbackPath = join(probeDirectory, 'rollback-crash.sqlite3')
    const rollbackJournalMode = createRecoveryDatabase(rollbackPath, 'delete')
    await killAfterReady(spawnFixture(['crash-writer', rollbackPath, 'delete', 'uncommitted']))
    const rolledBackDatabase = openDatabase(rollbackPath)
    assert.equal(scalar(rolledBackDatabase, 'SELECT value FROM recovery WHERE id = 1'), 'original')
    assert.equal(scalar(rolledBackDatabase, 'PRAGMA integrity_check'), 'ok')
    rolledBackDatabase.close()

    const walCrashPath = join(probeDirectory, 'wal-crash.sqlite3')
    const walJournalMode = createRecoveryDatabase(walCrashPath, 'wal')
    await killAfterReady(spawnFixture(['crash-writer', walCrashPath, 'wal', 'committed']))
    const recoveredWalDatabase = openDatabase(walCrashPath)
    assert.equal(
      scalar(recoveredWalDatabase, 'SELECT value FROM recovery WHERE id = 1'),
      'committed',
    )
    assert.equal(scalar(recoveredWalDatabase, 'PRAGMA integrity_check'), 'ok')
    recoveredWalDatabase.close()

    return {
      label,
      root,
      journalMode,
      rollbackJournalMode,
      walJournalMode,
      busyWaitMilliseconds,
      durationMilliseconds: Math.round(performance.now() - startedAt),
      checks: {
        locking: 'pass',
        journalPersistence: 'pass',
        busyTimeout: 'pass',
        onlineBackup: 'pass',
        closedDatabaseAtomicReplacement: 'pass',
        uncommittedRollbackJournalCrash: 'pass',
        committedWalCrashRecovery: 'pass',
        integrityChecks: 'pass',
      },
    }
  } finally {
    await rm(probeDirectory, { recursive: true, force: true })
  }
}
