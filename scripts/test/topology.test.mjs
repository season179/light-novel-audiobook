import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { probeExactHttpsAcceptance, probePortless, runTopologyProbe } from '../probe-topology.mjs'
import {
  assertMountedWindowsRoot,
  atomicWriteJson,
  canonicalAbsoluteLinuxPath,
  canonicalWorkspacePath,
  processRecordIsOwned,
  readProcessIdentity,
  resolveWorkspaceAsset,
} from '../topology/core.mjs'
import { probeSqliteLocation } from '../topology/sqlite-probe.mjs'

test('canonical paths reject traversal and symlink escapes', async () => {
  assert.equal(
    canonicalAbsoluteLinuxPath('/mnt/c/Users/example/Audiobooks'),
    '/mnt/c/Users/example/Audiobooks',
  )
  assert.equal(canonicalWorkspacePath('books/id/source/book.epub'), 'books/id/source/book.epub')
  assert.throws(() => canonicalWorkspacePath('books/id/../cover.png'))
  assert.throws(() => canonicalWorkspacePath('/absolute/book.epub'))
  assert.throws(() => canonicalWorkspacePath('../outside.epub'))
  assert.throws(() => canonicalWorkspacePath('C:\\Audiobooks\\book.epub'))

  const root = await mkdtemp(join(tmpdir(), 'topology-root-'))
  const outside = await mkdtemp(join(tmpdir(), 'topology-outside-'))
  try {
    await mkdir(join(root, 'books'))
    await symlink(outside, join(root, 'escape'))
    assert.equal(resolveWorkspaceAsset(root, 'books/future.epub'), join(root, 'books/future.epub'))
    assert.throws(() => resolveWorkspaceAsset(root, 'escape/future.epub'))
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('atomic records bind PID, start time, executable, and command identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'topology-core-'))
  try {
    const path = join(directory, 'state.json')
    await atomicWriteJson(path, { state: 'ready', pid: process.pid })
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { state: 'ready', pid: process.pid })

    const identity = readProcessIdentity(process.pid)
    assert.ok(identity)
    assert.equal(processRecordIsOwned(identity), true)
    assert.equal(processRecordIsOwned({ ...identity, startTimeTicks: '0' }), false)
    assert.equal(processRecordIsOwned({ ...identity, executableInode: '0' }), false)
    assert.equal(processRecordIsOwned({ ...identity, commandLineSha256: '0' }), false)
    assert.equal(processRecordIsOwned({ pid: 2_147_483_647 }), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('SQLite safety behavior passes on WSL ext4 with backup integrity_check', async () => {
  const result = await probeSqliteLocation({ label: 'test-native', root: tmpdir() })
  assert.equal(result.journalMode, 'wal')
  assert.equal(result.checks.onlineBackupWithIntegrityCheck, 'pass')
  assert.ok(Object.values(result.checks).every((status) => status === 'pass'))
})

const mountedRoot = process.env.TOPOLOGY_MNT_C_ROOT ?? process.cwd()
const mountedRootAvailable = existsSync(mountedRoot) && /^\/mnt\/[a-z](?:\/|$)/i.test(mountedRoot)

test('mounted-Windows roots reject an ext4 substitution', () => {
  assert.throws(() => assertMountedWindowsRoot(tmpdir()))
})

test('SQLite safety behavior passes only after mounted-Windows filesystem verification', {
  skip: !mountedRootAvailable,
}, async () => {
  const filesystem = assertMountedWindowsRoot(mountedRoot)
  assert.notEqual(filesystem.fstype, 'ext4')
  const result = await probeSqliteLocation({ label: 'test-mnt-c', root: mountedRoot })
  assert.equal(result.journalMode, 'wal')
  assert.ok(Object.values(result.checks).every((status) => status === 'pass'))
})

test('Portless checks final restarted routes and owner-token process identity', async () => {
  const result = await probePortless()
  assert.equal(result.dynamicPortsDistinct, true)
  assert.equal(result.loopbackOnlyAfterRestart, 'pass')
  assert.ok(result.finalLan.attempts > 0)
  assert.equal(result.processOwnership.ownerTokenSignaledByIpcAndHttp, true)
  assert.equal(result.processOwnership.restartAndRouteReplacement, 'pass')
})

test('exact HTTPS acceptance remains blocked unless explicitly requested and proven', async () => {
  const result = await probeExactHttpsAcceptance({ requested: false })
  assert.equal(result.status, 'blocked')
  assert.equal(result.browserInvoked, false)
  assert.ok(result.blockers.includes('exact HTTPS acceptance was not explicitly requested'))
})

test('committed evidence shape redacts host-specific paths and process data', async () => {
  const evidence = await runTopologyProbe({ skipPortless: true })
  const serialized = JSON.stringify(evidence)
  assert.equal(evidence.acceptanceStatus, 'blocked')
  assert.equal(evidence.redaction.userPaths, 'redacted')
  assert.doesNotMatch(serialized, /\/mnt\/[a-z]\/Users\//i)
  assert.doesNotMatch(serialized, /"(?:pid|ownerToken|stateDirectory|executablePath)"/)
  assert.doesNotMatch(serialized, /172\.\d+\.\d+\.\d+/)
  assert.doesNotMatch(serialized, /\[wsl2\]/i)
})
