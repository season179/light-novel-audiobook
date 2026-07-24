import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { probePortless } from '../probe-topology.mjs'
import {
  atomicWriteJson,
  canonicalAbsoluteLinuxPath,
  canonicalWorkspacePath,
  processRecordIsOwned,
  readProcessIdentity,
} from '../topology/core.mjs'
import { probeSqliteLocation } from '../topology/sqlite-probe.mjs'

test('canonical paths use Linux configuration paths and workspace-relative POSIX records', () => {
  assert.equal(
    canonicalAbsoluteLinuxPath('/mnt/c/Users/example/Audiobooks'),
    '/mnt/c/Users/example/Audiobooks',
  )
  assert.equal(canonicalWorkspacePath('books/id/source/book.epub'), 'books/id/source/book.epub')
  assert.throws(() => canonicalWorkspacePath('books/id/../cover.png'))
  assert.throws(() => canonicalWorkspacePath('/absolute/book.epub'))
  assert.throws(() => canonicalWorkspacePath('../outside.epub'))
  assert.throws(() => canonicalWorkspacePath('C:\\Audiobooks\\book.epub'))
})

test('atomic JSON records are complete and owner checks reject stale process identities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'topology-core-'))
  try {
    const path = join(directory, 'state.json')
    await atomicWriteJson(path, { state: 'ready', pid: process.pid })
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { state: 'ready', pid: process.pid })

    const identity = readProcessIdentity(process.pid)
    assert.ok(identity)
    assert.equal(processRecordIsOwned(identity), true)
    assert.equal(processRecordIsOwned({ ...identity, startTimeTicks: '0' }), false)
    assert.equal(processRecordIsOwned({ pid: 2_147_483_647, startTimeTicks: '0' }), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('SQLite safety behavior passes on the native Linux temporary filesystem', async () => {
  const result = await probeSqliteLocation({ label: 'test-native', root: tmpdir() })
  assert.equal(result.journalMode, 'wal')
  assert.ok(Object.values(result.checks).every((status) => status === 'pass'))
})

test('SQLite safety behavior also passes on the mounted Windows volume when WSL exposes it', {
  skip: !existsSync('/mnt/c'),
}, async () => {
  const result = await probeSqliteLocation({ label: 'test-mnt-c', root: process.cwd() })
  assert.equal(result.journalMode, 'wal')
  assert.ok(Object.values(result.checks).every((status) => status === 'pass'))
})

test('Portless aliases dynamic loopback services and rejects stale ownership', async () => {
  const result = await probePortless()
  assert.equal(result.dynamicPortsDistinct, true)
  assert.equal(result.loopbackOnly, 'pass')
  assert.equal(result.processOwnership.restartAndRouteReplacement, 'pass')
})
