#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync, fork, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statfsSync,
} from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { homedir, networkInterfaces, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import {
  assertMountedWindowsRoot,
  assertWslExt4Root,
  atomicWriteJson,
  canonicalAbsoluteLinuxPath,
  canonicalWorkspacePath,
  inspectFilesystem,
  processRecordIsOwned,
  readProcessIdentity,
  resolveWorkspaceAsset,
} from './topology/core.mjs'
import { probeSqliteLocation } from './topology/sqlite-probe.mjs'

export const TOPOLOGY_PROBE_VERSION = 4
export const TOPOLOGY_EVIDENCE_SCHEMA_VERSION = 4
export const DEFAULT_ENDPOINTS = Object.freeze({
  review: Object.freeze({
    service: 'review',
    host: '127.0.0.1',
    port: 3000,
    listenUrl: 'http://127.0.0.1:3000',
    browserUrl: 'http://localhost:3000',
  }),
  brain: Object.freeze({
    service: 'brain',
    host: '127.0.0.1',
    port: 8080,
    listenUrl: 'http://127.0.0.1:8080',
    baseUrl: 'http://127.0.0.1:8080/v1',
  }),
  tts: Object.freeze({
    service: 'tts',
    host: '127.0.0.1',
    port: 8081,
    listenUrl: 'http://127.0.0.1:8081',
    baseUrl: 'http://127.0.0.1:8081',
  }),
})

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixturePath = join(repositoryRoot, 'scripts/topology/fixture-child.mjs')
const evidencePath = 'docs/evidence/issue-2-topology-wsl2.json'
const probeSourceFiles = [
  'scripts/probe-topology.mjs',
  'scripts/topology/core.mjs',
  'scripts/topology/fixture-child.mjs',
  'scripts/topology/sqlite-probe.mjs',
  'scripts/test/topology.test.mjs',
]

export function endpointSet({ reviewPort, brainPort, ttsPort }) {
  return {
    review: {
      service: 'review',
      host: '127.0.0.1',
      port: reviewPort,
      listenUrl: `http://127.0.0.1:${reviewPort}`,
      browserUrl: `http://localhost:${reviewPort}`,
    },
    brain: {
      service: 'brain',
      host: '127.0.0.1',
      port: brainPort,
      listenUrl: `http://127.0.0.1:${brainPort}`,
      baseUrl: `http://127.0.0.1:${brainPort}/v1`,
    },
    tts: {
      service: 'tts',
      host: '127.0.0.1',
      port: ttsPort,
      listenUrl: `http://127.0.0.1:${ttsPort}`,
      baseUrl: `http://127.0.0.1:${ttsPort}`,
    },
  }
}

function commandOutput(command, arguments_, options = {}) {
  return execFileSync(command, arguments_, { encoding: 'utf8', ...options }).trim()
}

export function currentProbeSourceHash() {
  const hash = createHash('sha256')
  for (const relativePath of [...probeSourceFiles].sort()) {
    hash.update(relativePath)
    hash.update('\0')
    hash.update(readFileSync(join(repositoryRoot, relativePath)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function waitForStartup(child, timeoutMilliseconds = 8_000) {
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('service child did not report startup state')),
      timeoutMilliseconds,
    )
    const onExit = (code, signal) => {
      clearTimeout(timeout)
      reject(new Error(`service child exited during startup: code=${code} signal=${signal}`))
    }
    child.once('exit', onExit)
    child.on('message', (message) => {
      if (message?.type === 'bind-error') {
        clearTimeout(timeout)
        child.off('exit', onExit)
        const error = new Error(
          `configured ${message.service} port is occupied; startup refused (${message.code})`,
        )
        error.code = message.code
        reject(error)
      }
      if (message?.type !== 'ready') return
      clearTimeout(timeout)
      child.off('exit', onExit)
      resolvePromise(message)
    })
  })
}

function waitForExit(child, timeoutMilliseconds = 5_000) {
  return new Promise((resolvePromise, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise({ code: child.exitCode, signal: child.signalCode })
      return
    }
    const timeout = setTimeout(
      () => reject(new Error('service child did not stop')),
      timeoutMilliseconds,
    )
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      resolvePromise({ code, signal })
    })
  })
}

export async function startFixtureService(endpoint, ownerToken, runtimeDirectory) {
  const child = fork(
    fixturePath,
    ['server', endpoint.service, ownerToken, endpoint.host, String(endpoint.port)],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] },
  )
  let standardError = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    standardError += chunk
  })
  try {
    const ready = await waitForStartup(child)
    assert.equal(ready.ownerToken, ownerToken)
    assert.equal(ready.host, endpoint.host)
    assert.equal(ready.port, endpoint.port)
    const identity = readProcessIdentity(ready.pid)
    assert.ok(identity)
    const record = {
      service: endpoint.service,
      ownerToken,
      ...identity,
      host: ready.host,
      port: ready.port,
      listenUrl: endpoint.listenUrl,
      browserUrl: endpoint.browserUrl,
      baseUrl: endpoint.baseUrl,
    }
    await atomicWriteJson(join(runtimeDirectory, `${endpoint.service}.json`), record)
    assert.equal(processRecordIsOwned(record), true)
    return { child, endpoint, record }
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await waitForExit(child).catch(() => child.kill('SIGKILL'))
    if (error.code === 'EADDRINUSE') throw error
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; stderr=${standardError}`,
    )
  }
}

async function stopService(service) {
  service.child.kill('SIGTERM')
  const exit = await waitForExit(service.child)
  assert.equal(exit.code, 0)
}

async function stopAllServices(services) {
  await Promise.all(
    [...services.values()].map(async (service) => {
      if (service.child.exitCode !== null || service.child.signalCode !== null) return
      service.child.kill('SIGTERM')
      await waitForExit(service.child, 2_000).catch(() => service.child.kill('SIGKILL'))
    }),
  )
}

async function writeRuntimeManifest(runtimeDirectory, ownerToken, services, generation) {
  const manifestPath = join(runtimeDirectory, 'runtime-manifest.json')
  const manifest = {
    schemaVersion: 1,
    generation,
    ownerToken,
    state: 'ready',
    endpoints: [...services.values()].map(({ endpoint, record }) => ({
      service: endpoint.service,
      listenUrl: endpoint.listenUrl,
      ...(endpoint.browserUrl ? { browserUrl: endpoint.browserUrl } : {}),
      ...(endpoint.baseUrl ? { baseUrl: endpoint.baseUrl } : {}),
      pid: record.pid,
      startTimeTicks: record.startTimeTicks,
      executablePath: record.executablePath,
      executableDevice: record.executableDevice,
      executableInode: record.executableInode,
      commandLineSha256: record.commandLineSha256,
    })),
  }
  await atomicWriteJson(manifestPath, manifest)
  return { manifestPath, manifest }
}

async function assertReachable(service, ownerToken) {
  const response = await fetch(service.endpoint.listenUrl)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-topology-owner-token'), ownerToken)
  assert.ok((await response.text()).includes(`topology-service:${service.endpoint.service}`))
}

function requestEndpoint(endpoint, { method = 'GET', host, origin, csrfToken, fetchSite } = {}) {
  return new Promise((resolvePromise, reject) => {
    const headers = { host: host ?? `127.0.0.1:${endpoint.port}` }
    if (origin) headers.origin = origin
    if (csrfToken) headers['x-csrf-token'] = csrfToken
    if (fetchSite) headers['sec-fetch-site'] = fetchSite
    const outgoing = request(
      {
        hostname: '127.0.0.1',
        port: endpoint.port,
        path: method === 'GET' ? '/' : '/state',
        method,
        headers,
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          resolvePromise({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    outgoing.once('error', reject)
    outgoing.end()
  })
}

async function assertHttpBoundarySecurity(endpoints, ownerToken) {
  const allowedBrowserOrigin = endpoints.review.browserUrl
  const badHost = await requestEndpoint(endpoints.review, { host: 'attacker.invalid' })
  assert.equal(badHost.status, 421)
  const badOrigin = await requestEndpoint(endpoints.review, {
    origin: 'http://attacker.invalid',
  })
  assert.equal(badOrigin.status, 403)
  const missingCsrf = await requestEndpoint(endpoints.review, {
    method: 'POST',
    origin: allowedBrowserOrigin,
  })
  assert.equal(missingCsrf.status, 403)
  const acceptedStateChange = await requestEndpoint(endpoints.review, {
    method: 'POST',
    origin: allowedBrowserOrigin,
    csrfToken: ownerToken,
  })
  assert.equal(acceptedStateChange.status, 200)
  assert.equal(acceptedStateChange.headers['access-control-allow-origin'], allowedBrowserOrigin)
  assert.notEqual(acceptedStateChange.headers['access-control-allow-origin'], '*')

  for (const endpoint of [endpoints.brain, endpoints.tts]) {
    const browserOrigin = await requestEndpoint(endpoint, { origin: allowedBrowserOrigin })
    assert.equal(browserOrigin.status, 403)
    assert.equal(browserOrigin.headers['access-control-allow-origin'], undefined)
    const browserFetchMetadata = await requestEndpoint(endpoint, { fetchSite: 'cross-site' })
    assert.equal(browserFetchMetadata.status, 403)
    const modelHostAlias = await requestEndpoint(endpoint, {
      host: `localhost:${endpoint.port}`,
    })
    assert.equal(modelHostAlias.status, 421)
  }
  return {
    exactHostAllowlist: 'pass',
    exactOriginAllowlist: 'pass',
    wildcardCorsAbsent: 'pass',
    csrfRequiredForStateChanges: 'pass',
    modelBrowserOriginsRejected: 'pass',
    modelCorsAbsent: 'pass',
  }
}

function globalIpv4Addresses() {
  return Object.values(networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .filter((address) => address.family === 'IPv4' && !address.internal)
    .map((address) => address.address)
}

async function endpointIsUnavailable(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(750) })
    return false
  } catch {
    return true
  }
}

function listenerLinesForPorts(ports) {
  const output = commandOutput('ss', ['-H', '-ltnp'])
  return output.split('\n').filter((line) => ports.some((port) => line.includes(`:${port} `)))
}

function assertFinalLoopbackListeners(endpoints) {
  const ports = endpoints.map(({ port }) => port)
  const listeners = listenerLinesForPorts(ports)
  for (const endpoint of endpoints) {
    const matching = listeners.filter((line) => line.includes(`:${endpoint.port} `))
    assert.ok(matching.length > 0, `missing listener for ${endpoint.service}`)
    assert.ok(
      matching.every((line) => line.trim().split(/\s+/)[3]?.startsWith('127.0.0.1:')),
      `${endpoint.service} is not IPv4-loopback-only`,
    )
  }
  return endpoints.map((endpoint) => ({
    service: endpoint.service,
    listenUrl: endpoint.listenUrl,
    loopbackOnly: true,
  }))
}

async function assertFinalLanIsolation(endpoints) {
  const addresses = globalIpv4Addresses()
  assert.ok(addresses.length > 0, 'no WSL LAN address was available to test')
  let attempts = 0
  for (const address of addresses) {
    for (const endpoint of endpoints) {
      const unavailable = await endpointIsUnavailable(`http://${address}:${endpoint.port}`)
      assert.equal(unavailable, true, 'a configured service accepted a LAN connection')
      attempts += 1
    }
  }
  return {
    addressCount: addresses.length,
    services: endpoints.map(({ service }) => service),
    attempts,
    allUnavailable: true,
  }
}

function windowsPathFromWsl(value) {
  const match = value.match(/^\/mnt\/([a-z])\/(.*)$/i)
  assert.ok(match, 'Windows browser evidence path must be on /mnt/<drive>')
  return `${match[1].toUpperCase()}:\\${match[2].replaceAll('/', '\\')}`
}

function pngPixel(value, x, y) {
  const png = readFileSync(value)
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG')
  let offset = 8
  let width
  let height
  let bytesPerPixel
  const imageData = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.subarray(offset + 4, offset + 8).toString('ascii')
    const data = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      assert.equal(data[8], 8)
      bytesPerPixel = data[9] === 6 ? 4 : 3
      assert.ok(data[9] === 2 || data[9] === 6)
      assert.equal(data[12], 0)
    }
    if (type === 'IDAT') imageData.push(data)
    offset += length + 12
  }
  assert.ok(width && height && bytesPerPixel && x < width && y < height)
  const filtered = inflateSync(Buffer.concat(imageData))
  const stride = width * bytesPerPixel
  const rows = []
  let inputOffset = 0
  for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
    const filter = filtered[inputOffset]
    inputOffset += 1
    const row = Buffer.from(filtered.subarray(inputOffset, inputOffset + stride))
    inputOffset += stride
    const previous = rows[rowIndex - 1]
    for (let column = 0; column < stride; column += 1) {
      const left = column >= bytesPerPixel ? row[column - bytesPerPixel] : 0
      const above = previous?.[column] ?? 0
      const upperLeft = column >= bytesPerPixel ? (previous?.[column - bytesPerPixel] ?? 0) : 0
      if (filter === 1) row[column] = (row[column] + left) & 0xff
      else if (filter === 2) row[column] = (row[column] + above) & 0xff
      else if (filter === 3) row[column] = (row[column] + Math.floor((left + above) / 2)) & 0xff
      else if (filter === 4) {
        const prediction = left + above - upperLeft
        const distances = [
          Math.abs(prediction - left),
          Math.abs(prediction - above),
          Math.abs(prediction - upperLeft),
        ]
        const predictor = [left, above, upperLeft][distances.indexOf(Math.min(...distances))]
        row[column] = (row[column] + predictor) & 0xff
      } else assert.equal(filter, 0)
    }
    rows.push(row)
  }
  const pixelOffset = x * bytesPerPixel
  return [...rows[y].subarray(pixelOffset, pixelOffset + 3)]
}

function browserVersionFromInstall(browserPath) {
  if (!browserPath || !existsSync(browserPath)) return null
  const versions = readdirSync(dirname(browserPath), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+(?:\.\d+)+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
  return versions.at(-1) ?? 'installed-version-undiscovered'
}

function probeWindowsHostForwarding(reviewEndpoint, ownerToken) {
  const ipconfigPath = '/mnt/c/Windows/System32/ipconfig.exe'
  const curlPath = '/mnt/c/Windows/System32/curl.exe'
  assert.ok(existsSync(ipconfigPath), 'Windows ipconfig.exe was not found')
  assert.ok(existsSync(curlPath), 'Windows curl.exe was not found')
  const ipconfig = spawnSync(ipconfigPath, [], { encoding: 'utf8', timeout: 15_000 })
  assert.equal(ipconfig.status, 0, ipconfig.error?.message ?? ipconfig.stderr)
  const addresses = [
    ...new Set(
      [...ipconfig.stdout.matchAll(/IPv4 Address[^:]*:\s*(\d{1,3}(?:\.\d{1,3}){3})/gi)]
        .map((match) => match[1])
        .filter((address) => address && !address.startsWith('127.')),
    ),
  ]
  assert.ok(addresses.length > 0, 'ipconfig.exe reported no non-loopback Windows IPv4 addresses')

  const curlArguments = [
    '--silent',
    '--show-error',
    '--noproxy',
    '*',
    '--connect-timeout',
    '1',
    '--max-time',
    '3',
  ]
  const localhost = spawnSync(curlPath, [...curlArguments, reviewEndpoint.browserUrl], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.equal(localhost.status, 0, localhost.error?.message ?? localhost.stderr)
  assert.ok(localhost.stdout.includes('topology-service:review'))

  for (const address of addresses) {
    const lanAttempt = spawnSync(
      curlPath,
      [...curlArguments, `http://${address}:${reviewEndpoint.port}`],
      { encoding: 'utf8', timeout: 10_000 },
    )
    assert.notEqual(
      lanAttempt.status,
      0,
      'review endpoint was reachable through a Windows LAN IPv4',
    )
  }
  const version = spawnSync(curlPath, ['--version'], { encoding: 'utf8', timeout: 10_000 })
  return {
    status: 'pass',
    toolsInvokedDirectlyWithoutShellWrapper: true,
    localhostSucceeded: true,
    nonLoopbackAddressCount: addresses.length,
    failedLanAddressCount: addresses.length,
    allWindowsLanAddressesUnavailable: true,
    windowsCurlVersion: version.stdout.split('\n')[0]?.trim() ?? 'unknown',
    ownerTokenObservedOnlyInRuntime: Boolean(ownerToken),
  }
}

function probeWindowsBrowser(browserPath, browserUrl) {
  if (!browserPath) {
    return {
      status: 'not-run',
      browserInvoked: false,
      reason: 'Set TOPOLOGY_WINDOWS_BROWSER for the explicit Windows-browser host check.',
    }
  }
  assert.ok(existsSync(browserPath), 'configured Windows browser does not exist')
  const windowsTempRoot = process.env.TOPOLOGY_WINDOWS_TEMP_ROOT ?? '/mnt/c/Temp'
  mkdirSync(windowsTempRoot, { recursive: true })
  assertMountedWindowsRoot(windowsTempRoot)
  const browserDirectory = mkdtempSync(join(windowsTempRoot, 'audiobook-topology-browser-'))
  const screenshotPath = join(browserDirectory, 'review.png')
  const profilePath = join(browserDirectory, 'profile')
  try {
    const result = spawnSync(
      browserPath,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--hide-scrollbars',
        '--window-size=320,200',
        `--user-data-dir=${windowsPathFromWsl(profilePath)}`,
        `--screenshot=${windowsPathFromWsl(screenshotPath)}`,
        browserUrl,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    )
    const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
    for (let attempt = 0; attempt < 100 && !existsSync(screenshotPath); attempt += 1) {
      Atomics.wait(waitBuffer, 0, 0, 50)
    }
    assert.equal(result.status, 0, result.error?.message ?? result.stderr)
    assert.ok(existsSync(screenshotPath), 'Windows browser did not write host-check screenshot')
    assert.deepEqual(pngPixel(screenshotPath, 160, 100), [0x12, 0x34, 0x56])
    return {
      status: 'pass',
      browserInvoked: true,
      browserVersion: browserVersionFromInstall(browserPath),
      browserUrl,
      method: 'direct Windows Chrome headless screenshot; no shell wrapper',
    }
  } finally {
    rmSync(browserDirectory, { recursive: true, force: true })
  }
}

export function configuredEndpointCheck() {
  const config = readFileSync(join(repositoryRoot, 'config/default.example.toml'), 'utf8')
  const webPackage = JSON.parse(readFileSync(join(repositoryRoot, 'apps/web/package.json'), 'utf8'))
  const viteConfig = readFileSync(join(repositoryRoot, 'apps/web/vite.config.ts'), 'utf8')
  assert.match(config, /listen_url = "http:\/\/127\.0\.0\.1:3000"/)
  assert.match(config, /browser_url = "http:\/\/localhost:3000"/)
  assert.match(config, /base_url = "http:\/\/127\.0\.0\.1:8080\/v1"/)
  assert.match(config, /base_url = "http:\/\/127\.0\.0\.1:8081"/)
  assert.match(config, /require_csrf_for_state_changes = true/)
  assert.match(config, /allow_browser_origins_on_model_endpoints = false/)
  assert.match(webPackage.scripts.dev, /--host 127\.0\.0\.1 --port 3000 --strictPort/)
  assert.match(viteConfig, /host: '127\.0\.0\.1'/)
  assert.match(viteConfig, /port: 3000/)
  assert.match(viteConfig, /strictPort: true/)
  assert.match(viteConfig, /allowedHosts: \['localhost', '127\.0\.0\.1'\]/)
  assert.match(viteConfig, /origin: \['http:\/\/localhost:3000', 'http:\/\/127\.0\.0\.1:3000'\]/)
  assert.match(viteConfig, /credentials: false/)
  return {
    status: 'pass',
    reviewListenUrl: DEFAULT_ENDPOINTS.review.listenUrl,
    reviewBrowserUrl: DEFAULT_ENDPOINTS.review.browserUrl,
    brainBaseUrl: DEFAULT_ENDPOINTS.brain.baseUrl,
    ttsBaseUrl: DEFAULT_ENDPOINTS.tts.baseUrl,
    occupiedPortPolicy: 'fail-closed',
  }
}

export async function probeDirectEndpoints({
  endpoints = DEFAULT_ENDPOINTS,
  browserPath,
  manifestWriter = writeRuntimeManifest,
} = {}) {
  const endpointList = Object.values(endpoints)
  assert.equal(new Set(endpointList.map(({ port }) => port)).size, endpointList.length)
  assert.ok(endpointList.every(({ host }) => host === '127.0.0.1'))
  const cacheRoot = join(homedir(), '.cache')
  await mkdir(cacheRoot, { recursive: true })
  const runtimeDirectory = await mkdtemp(join(cacheRoot, 'topology-direct-'))
  const ownerToken = randomUUID()
  const services = new Map()

  try {
    for (const endpoint of endpointList) {
      const started = await startFixtureService(endpoint, ownerToken, runtimeDirectory)
      services.set(endpoint.service, started)
    }
    for (const service of services.values()) await assertReachable(service, ownerToken)
    const initialManifest = await manifestWriter(runtimeDirectory, ownerToken, services, 1)

    let collisionFailedClosed = false
    try {
      await startFixtureService(endpoints.review, ownerToken, runtimeDirectory)
    } catch (error) {
      assert.equal(error.code, 'EADDRINUSE')
      collisionFailedClosed = true
    }
    assert.equal(collisionFailedClosed, true)

    const initialReview = services.get('review')
    assert.ok(initialReview)
    assert.equal(processRecordIsOwned({ ...initialReview.record, executableInode: '0' }), false)
    await stopService(initialReview)
    assert.equal(processRecordIsOwned(initialReview.record), false)
    const restartedReview = await startFixtureService(
      endpoints.review,
      ownerToken,
      runtimeDirectory,
    )
    services.set('review', restartedReview)
    await assertReachable(restartedReview, ownerToken)
    const finalManifest = await manifestWriter(runtimeDirectory, ownerToken, services, 2)

    const finalListeners = assertFinalLoopbackListeners(endpointList)
    const finalLan = await assertFinalLanIsolation(endpointList)
    for (const service of services.values()) {
      assert.equal(processRecordIsOwned(service.record), true)
      await assertReachable(service, ownerToken)
    }
    const httpBoundarySecurity = await assertHttpBoundarySecurity(endpoints, ownerToken)

    const readBack = JSON.parse(await readFile(finalManifest.manifestPath, 'utf8'))
    assert.deepEqual(readBack, finalManifest.manifest)
    assert.equal(readBack.generation, 2)
    assert.deepEqual(
      readBack.endpoints.map(({ service, listenUrl }) => ({ service, listenUrl })),
      [...services.values()].map(({ endpoint }) => ({
        service: endpoint.service,
        listenUrl: endpoint.listenUrl,
      })),
    )
    assert.notEqual(initialManifest.manifest.endpoints[0]?.pid, readBack.endpoints[0]?.pid)

    const browser = probeWindowsBrowser(browserPath, endpoints.review.browserUrl)
    const windowsHostNetwork = browserPath
      ? probeWindowsHostForwarding(endpoints.review, ownerToken)
      : {
          status: 'not-run',
          reason: 'Windows host checks run only during the explicit browser host probe.',
        }
    return {
      status:
        !browserPath || (browser.status === 'pass' && windowsHostNetwork.status === 'pass')
          ? 'pass'
          : 'blocked',
      mode: browserPath ? 'host-acceptance' : 'synthetic-test',
      configuredEndpoints: endpointList.map(({ service, listenUrl, browserUrl, baseUrl }) => ({
        service,
        listenUrl,
        browserUrl,
        baseUrl,
      })),
      fixedPorts: true,
      collisionFailedClosed,
      restartReusedConfiguredReviewPort: true,
      finalListeners,
      finalLan,
      runtimeManifest: {
        atomicReadBack: 'pass',
        generationAdvancedOnRestart: true,
        effectiveEndpointsRecorded: true,
        ownerTokenRecordedAtRuntimeOnly: true,
        processIdentityRecorded: true,
      },
      httpBoundarySecurity,
      processOwnership: {
        ownerTokenSignaledByIpcAndHttp: true,
        pidStartExecutableAndCommandIdentityRecorded: true,
        executableMismatchRejected: true,
        gracefulStop: 'pass',
        staleRecordRejected: true,
      },
      browser,
      windowsHostNetwork,
    }
  } finally {
    await stopAllServices(services)
    await rm(runtimeDirectory, { recursive: true, force: true })
  }
}

function readOptional(value) {
  try {
    return readFileSync(value, 'utf8').trim()
  } catch {
    return undefined
  }
}

function parseWslConfig() {
  const windowsUserMatch = repositoryRoot.match(/^(\/mnt\/[a-z]\/Users\/[^/]+)/i)
  const configPath = windowsUserMatch ? join(windowsUserMatch[1], '.wslconfig') : undefined
  const content = configPath ? readOptional(configPath) : undefined
  const setting = (name) => content?.match(new RegExp(`^${name}\\s*=\\s*(.+)$`, 'im'))?.[1].trim()
  return {
    detected: Boolean(content),
    configuredMemory: setting('memory') ?? null,
    configuredSwap: setting('swap') ?? null,
  }
}

function filesystemCapacity(value) {
  const filesystem = inspectFilesystem(value)
  const stats = statfsSync(value, { bigint: true })
  return {
    fstype: filesystem.fstype,
    freeBytes: Number(stats.bavail * stats.bsize),
  }
}

export function probeResources() {
  const memoryInformation = Object.fromEntries(
    readFileSync('/proc/meminfo', 'utf8')
      .split('\n')
      .filter((line) => /^(MemTotal|SwapTotal):/.test(line))
      .map((line) => {
        const [key, value] = line.split(':')
        return [key, value.trim()]
      }),
  )
  const gpuResult = spawnSync(
    'nvidia-smi',
    ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'],
    { encoding: 'utf8' },
  )
  return {
    kernel: commandOutput('uname', ['-srvmo']),
    distro: process.env.WSL_DISTRO_NAME ?? null,
    effectiveMemory: memoryInformation.MemTotal,
    nodeVisibleMemoryBytes: totalmem(),
    effectiveSwap: memoryInformation.SwapTotal,
    cpuCount: Number(commandOutput('nproc', [])),
    cgroupMemoryMax: readOptional('/sys/fs/cgroup/memory.max') ?? 'not-set',
    cgroupSwapMax: readOptional('/sys/fs/cgroup/memory.swap.max') ?? 'not-set',
    gpu:
      gpuResult.status === 0
        ? { status: 'visible', query: gpuResult.stdout.trim(), dxg: existsSync('/dev/dxg') }
        : { status: 'unavailable', dxg: existsSync('/dev/dxg') },
    wslConfig: parseWslConfig(),
    workspaceFilesystem: filesystemCapacity(repositoryRoot),
    ext4HomeFilesystem: filesystemCapacity(homedir()),
  }
}

export async function canonicalPathChecks() {
  assert.equal(
    canonicalAbsoluteLinuxPath('/mnt/c/Users/example/Audiobooks'),
    '/mnt/c/Users/example/Audiobooks',
  )
  assert.equal(canonicalWorkspacePath('books/book-1/source.epub'), 'books/book-1/source.epub')
  assert.throws(() => canonicalWorkspacePath('../escape'))
  assert.throws(() => canonicalWorkspacePath('C:\\Audiobooks\\book.epub'))
  const cacheRoot = join(homedir(), '.cache')
  await mkdir(cacheRoot, { recursive: true })
  const temporaryRoot = await mkdtemp(join(cacheRoot, 'topology-path-root-'))
  const outsideRoot = await mkdtemp(join(cacheRoot, 'topology-path-outside-'))
  try {
    await mkdir(join(temporaryRoot, 'books'), { recursive: true })
    await symlink(outsideRoot, join(temporaryRoot, 'escape-link'))
    assert.equal(
      resolveWorkspaceAsset(temporaryRoot, 'books/future.epub'),
      join(temporaryRoot, 'books/future.epub'),
    )
    assert.throws(() => resolveWorkspaceAsset(temporaryRoot, 'escape-link/escaped.epub'))
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
    await rm(outsideRoot, { recursive: true, force: true })
  }
  return {
    absoluteLinuxConfigurationPaths: 'pass',
    relativePosixDatabaseAssetPaths: 'pass',
    traversalRejected: 'pass',
    windowsSyntaxRejected: 'pass',
    canonicalRootResolved: 'pass',
    symlinkEscapeRejected: 'pass',
    nonexistentAssetAncestorContained: 'pass',
  }
}

function parseArguments(arguments_) {
  const options = { output: undefined, skipNetwork: false }
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--output') {
      options.output = arguments_[index + 1]
      index += 1
    } else if (argument === '--skip-network') options.skipNetwork = true
    else if (argument?.startsWith('--')) throw new Error(`unknown option: ${argument}`)
  }
  return options
}

export function topologyProbeExitCode(evidence, options = {}) {
  return evidence.acceptanceStatus === 'pass' || options.skipNetwork ? 0 : 1
}

function publicSqliteEvidence(result, filesystem) {
  return {
    label: result.label,
    filesystem: {
      expectedPlacement: result.label === 'wsl-ext4' ? 'WSL ext4' : 'mounted Windows DrvFS',
      verifiedFstype: filesystem.fstype,
    },
    journalMode: result.journalMode,
    rollbackJournalMode: result.rollbackJournalMode,
    walJournalMode: result.walJournalMode,
    busyWaitMilliseconds: result.busyWaitMilliseconds,
    durationMilliseconds: result.durationMilliseconds,
    checks: result.checks,
  }
}

export async function runTopologyProbe(options = {}) {
  const ext4Root =
    process.env.TOPOLOGY_EXT4_ROOT ?? join(homedir(), '.cache/light-novel-audiobook/probes')
  await mkdir(ext4Root, { recursive: true })
  const ext4Filesystem = assertWslExt4Root(ext4Root)
  const ext4Result = await probeSqliteLocation({ label: 'wsl-ext4', root: ext4Root })

  const configuredMountedRoot = process.env.TOPOLOGY_MNT_C_ROOT
  const mountedRoot = configuredMountedRoot ?? (existsSync('/mnt/c') ? '/mnt/c/Temp' : undefined)
  let mountedWindows
  if (!mountedRoot) {
    mountedWindows = {
      status: 'blocked',
      blocker: 'Set TOPOLOGY_MNT_C_ROOT to an explicit existing /mnt/<drive> directory.',
    }
  } else {
    await mkdir(mountedRoot, { recursive: true })
    const mountedFilesystem = assertMountedWindowsRoot(mountedRoot)
    const mountedResult = await probeSqliteLocation({
      label: 'mounted-windows-volume',
      root: mountedRoot,
    })
    mountedWindows = {
      status: 'pass',
      result: publicSqliteEvidence(mountedResult, mountedFilesystem),
    }
  }

  const configured = configuredEndpointCheck()
  const network = options.skipNetwork
    ? {
        status: 'skipped-non-acceptance',
        mode: 'ci-synthetic-skip',
        browser: { status: 'not-run', browserInvoked: false },
        windowsHostNetwork: { status: 'not-run' },
      }
    : await probeDirectEndpoints({ browserPath: process.env.TOPOLOGY_WINDOWS_BROWSER })
  const accepted =
    mountedWindows.status === 'pass' &&
    network.status === 'pass' &&
    network.browser.status === 'pass' &&
    network.windowsHostNetwork.status === 'pass'

  return {
    evidenceSchemaVersion: TOPOLOGY_EVIDENCE_SCHEMA_VERSION,
    probeVersion: TOPOLOGY_PROBE_VERSION,
    capturedAt: new Date().toISOString(),
    provenance: {
      generatedFromCommit: commandOutput('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot }),
      probeSourceSha256: currentProbeSourceHash(),
      nativeToolchain: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
      },
    },
    reproduction: {
      evidenceCommand:
        `TOPOLOGY_WINDOWS_BROWSER='<mounted-windows-chrome.exe>' pnpm probe:topology ` +
        `--output ${evidencePath}`,
    },
    acceptanceStatus: accepted
      ? 'pass'
      : options.skipNetwork
        ? 'non-acceptance-ci-synthetic-skip'
        : 'blocked',
    configuredEndpoints: configured,
    resources: probeResources(),
    canonicalPaths: await canonicalPathChecks(),
    sqlite: {
      ext4: publicSqliteEvidence(ext4Result, ext4Filesystem),
      mountedWindows,
    },
    directLoopback: network,
    deferredOption: {
      note: 'Portless may be reconsidered after the core runtime is stable.',
      currentDependency: false,
      currentAcceptanceRequirement: false,
    },
    redaction: {
      userPaths: 'redacted',
      hostSpecificIpAddresses: 'redacted; configured loopback endpoints retained',
      processIds: 'redacted',
      ownerTokens: 'redacted',
      temporaryPaths: 'redacted',
      fullWslConfig: 'redacted',
    },
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2))
  const evidence = await runTopologyProbe(options)
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`
  if (options.output) {
    const outputPath = resolve(options.output)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, serialized, 'utf8')
    console.log(`Topology evidence written to ${outputPath}`)
    if (evidence.acceptanceStatus !== 'pass') {
      console.log(`Topology acceptance status: ${evidence.acceptanceStatus}`)
    }
  } else {
    process.stdout.write(serialized)
  }
  process.exitCode = topologyProbeExitCode(evidence, options)
}
