import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  assertBrowserTempRootOutsideRepository,
  configuredEndpointCheck,
  currentProbeSourceHash,
  endpointSet,
  parseWindowsHostAddresses,
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

test('Windows address parsing includes non-loopback IPv4 and routable IPv6 addresses', () => {
  const addresses = parseWindowsHostAddresses(`
    IPv4 Address. . . . . . . . . . . : 192.168.10.20(Preferred)
    IPv4 Address. . . . . . . . . . . : 127.0.0.1(Preferred)
    IPv4 Address. . . . . . . . . . . : 169.254.4.5(Preferred)
    IPv6 Address. . . . . . . . . . . : 2001:db8::20(Preferred)
    Temporary IPv6 Address. . . . . . : fd00::30(Preferred)
    Link-local IPv6 Address . . . . . : fe80::1%12(Preferred)
    IPv6 Address. . . . . . . . . . . : ::1(Preferred)
  `)
  assert.deepEqual(addresses.ipv4, ['192.168.10.20', '169.254.4.5'])
  assert.deepEqual(addresses.ipv6, ['2001:db8::20', 'fd00::30'])
})

test('browser temp roots are external and the exact artifact prefix is ignored', async () => {
  assert.throws(() =>
    assertBrowserTempRootOutsideRepository(join(process.cwd(), 'browser-temp-test')),
  )
  assert.doesNotThrow(() => assertBrowserTempRootOutsideRepository(tmpdir()))
  const externalRoot = await mkdtemp(join(tmpdir(), 'browser-temp-root-'))
  try {
    const linkIntoRepository = join(externalRoot, 'repository-link')
    await symlink(process.cwd(), linkIntoRepository)
    assert.throws(() =>
      assertBrowserTempRootOutsideRepository(join(linkIntoRepository, 'not-created')),
    )
    assert.equal(existsSync(join(process.cwd(), 'not-created')), false)
  } finally {
    await rm(externalRoot, { recursive: true, force: true })
  }
  const gitignore = await readFile(join(process.cwd(), '.gitignore'), 'utf8')
  assert.match(gitignore, /^audiobook-topology-browser-\*\/$/m)
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
  const windowsNetwork = evidence.directLoopback.windowsHostNetwork
  assert.equal(windowsNetwork.status, 'pass')
  assert.equal(windowsNetwork.allConfiguredServicesLocalhostSucceeded, true)
  assert.equal(windowsNetwork.configuredServiceCount, 3)
  assert.equal(windowsNetwork.localhostSucceededServiceCount, 3)
  assert.equal(windowsNetwork.allConfiguredServicesUnavailableOnAllWindowsHostAddresses, true)
  assert.ok(windowsNetwork.addressFamilies.ipv4.nonLoopbackAddressCount > 0)
  assert.match(windowsNetwork.addressFamilies.ipv6.status, /^(?:tested|unavailable)$/)
  if (windowsNetwork.addressFamilies.ipv6.status === 'unavailable') {
    assert.equal(windowsNetwork.addressFamilies.ipv6.routableNonLoopbackAddressCount, 0)
    assert.match(windowsNetwork.addressFamilies.ipv6.reason, /no routable non-loopback IPv6/i)
  }
  assert.deepEqual(
    windowsNetwork.serviceMatrix.map(({ service, configuredPort }) => ({
      service,
      configuredPort,
    })),
    [
      { service: 'review', configuredPort: 3000 },
      { service: 'brain', configuredPort: 8080 },
      { service: 'tts', configuredPort: 8081 },
    ],
  )
  const totalAddressCount =
    windowsNetwork.addressFamilies.ipv4.nonLoopbackAddressCount +
    windowsNetwork.addressFamilies.ipv6.routableNonLoopbackAddressCount
  assert.equal(windowsNetwork.totalMatrixAttemptCount, totalAddressCount * 3)
  assert.equal(windowsNetwork.failedMatrixAttemptCount, windowsNetwork.totalMatrixAttemptCount)
  for (const row of windowsNetwork.serviceMatrix) {
    assert.equal(row.ipv4AddressCount, windowsNetwork.addressFamilies.ipv4.nonLoopbackAddressCount)
    assert.equal(row.ipv4FailedAttemptCount, row.ipv4AddressCount)
    assert.equal(
      row.ipv6AddressCount,
      windowsNetwork.addressFamilies.ipv6.routableNonLoopbackAddressCount,
    )
    assert.equal(row.ipv6FailedAttemptCount, row.ipv6AddressCount)
    assert.equal(row.allAddressAttemptsUnavailable, true)
  }
  assert.equal(evidence.redaction.userPaths, 'redacted')
  assert.doesNotMatch(serialized, /\/mnt\/[a-z]\/Users\//i)
  assert.doesNotMatch(serialized, /"(?:pid|ownerToken|runtimeDirectory|executablePath)"/)
  assert.doesNotMatch(serialized, /(?:172|192)\.\d+\.\d+\.\d+/)
})
