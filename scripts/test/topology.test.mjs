import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  configuredEndpointCheck,
  currentProbeSourceHash,
  endpointSet,
  probeDirectEndpoints,
  runTopologyProbe,
  startFixtureService,
  TOPOLOGY_EVIDENCE_SCHEMA_VERSION,
  TOPOLOGY_PROBE_VERSION,
  topologyProbeExitCode,
} from '../probe-topology.mjs'
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

async function availablePort() {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise((resolvePromise) => server.close(resolvePromise))
  return address.port
}

async function availablePortAt(port) {
  const server = createServer()
  try {
    await new Promise((resolvePromise, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolvePromise)
    })
    return true
  } catch {
    return false
  } finally {
    if (server.listening) await new Promise((resolvePromise) => server.close(resolvePromise))
  }
}

async function testEndpoints() {
  const ports = new Set()
  while (ports.size < 3) ports.add(await availablePort())
  const [reviewPort, brainPort, ttsPort] = ports
  return endpointSet({ reviewPort, brainPort, ttsPort })
}

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
  assert.throws(() => canonicalWorkspacePath('C:/Audiobooks/book.epub'))
  assert.throws(() => canonicalWorkspacePath('C:relative.epub'))
  assert.throws(() => canonicalWorkspacePath('z:'))

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
    await assert.rejects(atomicWriteJson(path, { invalid: 1n }))
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { state: 'ready', pid: process.pid })
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => atomicWriteJson(path, { generation: index })),
    )
    const concurrentResult = JSON.parse(await readFile(path, 'utf8'))
    assert.ok(Number.isInteger(concurrentResult.generation))
    assert.equal((await readdir(directory)).filter((entry) => entry.includes('.tmp-')).length, 0)

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

const mountedRoot = process.env.TOPOLOGY_MNT_C_ROOT ?? '/mnt/c/Temp'
const mountedRootAvailable = existsSync('/mnt/c')

test('mounted-Windows roots reject an ext4 substitution', () => {
  assert.throws(() => assertMountedWindowsRoot(tmpdir()))
})

test('SQLite safety behavior passes only after mounted-Windows filesystem verification', {
  skip: !mountedRootAvailable,
}, async () => {
  await mkdir(mountedRoot, { recursive: true })
  const filesystem = assertMountedWindowsRoot(mountedRoot)
  assert.notEqual(filesystem.fstype, 'ext4')
  const result = await probeSqliteLocation({ label: 'test-mnt-c', root: mountedRoot })
  assert.equal(result.journalMode, 'wal')
  assert.ok(Object.values(result.checks).every((status) => status === 'pass'))
})

test('configured defaults are direct, fixed, loopback-only, and strict-port', () => {
  const result = configuredEndpointCheck()
  assert.equal(result.status, 'pass')
  assert.equal(result.reviewBrowserUrl, 'http://localhost:3000')
  assert.equal(result.brainBaseUrl, 'http://127.0.0.1:8080/v1')
  assert.equal(result.ttsBaseUrl, 'http://127.0.0.1:8081')
  assert.equal(result.occupiedPortPolicy, 'fail-closed')
})

test('direct fixed endpoints fail on collision and survive restart on the same port', async () => {
  const result = await probeDirectEndpoints({ endpoints: await testEndpoints() })
  assert.equal(result.status, 'pass')
  assert.equal(result.fixedPorts, true)
  assert.equal(result.collisionFailedClosed, true)
  assert.equal(result.restartReusedConfiguredReviewPort, true)
  assert.equal(result.runtimeManifest.atomicReadBack, 'pass')
  assert.equal(result.runtimeManifest.effectiveEndpointsRecorded, true)
  assert.equal(result.processOwnership.ownerTokenSignaledByIpcAndHttp, true)
  assert.equal(result.httpBoundarySecurity.exactHostAllowlist, 'pass')
  assert.equal(result.httpBoundarySecurity.csrfRequiredForStateChanges, 'pass')
  assert.equal(result.httpBoundarySecurity.modelBrowserOriginsRejected, 'pass')
  assert.ok(result.finalListeners.every(({ loopbackOnly }) => loopbackOnly))
  assert.equal(result.finalLan.allUnavailable, true)
  assert.equal(result.browser.status, 'not-run')
})

test('startup and manifest failures clean up children and release fixed ports', async () => {
  const endpoints = await testEndpoints()
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'topology-failure-'))
  try {
    await assert.rejects(
      startFixtureService(endpoints.review, randomUUID(), join(temporaryRoot, 'missing')),
    )
    assert.equal(await availablePortAt(endpoints.review.port), true)

    await assert.rejects(
      probeDirectEndpoints({
        endpoints,
        manifestWriter: async () => {
          throw new Error('injected manifest failure')
        },
      }),
    )
    for (const endpoint of Object.values(endpoints)) {
      assert.equal(await availablePortAt(endpoint.port), true)
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('blocked probes fail while the explicit CI network skip is non-acceptance', () => {
  assert.equal(topologyProbeExitCode({ acceptanceStatus: 'blocked' }), 1)
  assert.equal(topologyProbeExitCode({ acceptanceStatus: 'pass' }), 0)
  assert.equal(
    topologyProbeExitCode(
      { acceptanceStatus: 'non-acceptance-ci-synthetic-skip' },
      { skipNetwork: true },
    ),
    0,
  )
})

test('explicit network skip is labeled as CI-only non-acceptance', async () => {
  const evidence = await runTopologyProbe({ skipNetwork: true })
  const serialized = JSON.stringify(evidence)
  assert.equal(evidence.acceptanceStatus, 'non-acceptance-ci-synthetic-skip')
  assert.equal(evidence.directLoopback.mode, 'ci-synthetic-skip')
  assert.equal(evidence.redaction.userPaths, 'redacted')
  assert.doesNotMatch(serialized, /\/mnt\/[a-z]\/Users\//i)
  assert.doesNotMatch(serialized, /"(?:pid|ownerToken|runtimeDirectory|executablePath)"/)
  assert.doesNotMatch(serialized, /172\.\d+\.\d+\.\d+/)
  assert.doesNotMatch(serialized, /\[wsl2\]/i)
})

test('committed host evidence is current, accepted, and redacted', async () => {
  const evidence = JSON.parse(
    await readFile(join(process.cwd(), 'docs/evidence/issue-2-topology-wsl2.json'), 'utf8'),
  )
  const serialized = JSON.stringify(evidence)
  assert.equal(evidence.evidenceSchemaVersion, TOPOLOGY_EVIDENCE_SCHEMA_VERSION)
  assert.equal(evidence.probeVersion, TOPOLOGY_PROBE_VERSION)
  assert.equal(evidence.provenance.probeSourceSha256, currentProbeSourceHash())
  assert.equal(evidence.acceptanceStatus, 'pass')
  assert.equal(evidence.directLoopback.browser.status, 'pass')
  assert.equal(evidence.directLoopback.browser.browserInvoked, true)
  assert.equal(evidence.directLoopback.windowsHostNetwork.status, 'pass')
  assert.equal(evidence.directLoopback.windowsHostNetwork.localhostSucceeded, true)
  assert.equal(evidence.directLoopback.windowsHostNetwork.allWindowsLanAddressesUnavailable, true)
  assert.ok(evidence.directLoopback.windowsHostNetwork.nonLoopbackAddressCount > 0)
  assert.equal(
    evidence.directLoopback.windowsHostNetwork.failedLanAddressCount,
    evidence.directLoopback.windowsHostNetwork.nonLoopbackAddressCount,
  )
  assert.equal(evidence.redaction.userPaths, 'redacted')
  assert.doesNotMatch(serialized, /\/mnt\/[a-z]\/Users\//i)
  assert.doesNotMatch(serialized, /"(?:pid|ownerToken|runtimeDirectory|executablePath)"/)
  assert.doesNotMatch(serialized, /(?:172|192)\.\d+\.\d+\.\d+/)
})
