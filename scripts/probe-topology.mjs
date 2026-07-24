#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync, fork, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statfsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
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

export const TOPOLOGY_PROBE_VERSION = 2
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixturePath = join(repositoryRoot, 'scripts/topology/fixture-child.mjs')
const portlessPath = join(repositoryRoot, 'node_modules/.bin/portless')
const evidencePath = 'docs/evidence/issue-2-topology-wsl2.json'
const exactHttpsUrls = [
  'https://audiobook.localhost',
  'https://brain.audiobook.localhost',
  'https://tts.audiobook.localhost',
]
const serviceNames = ['audiobook', 'brain', 'tts']
const routeNames = {
  audiobook: 'audiobook',
  brain: 'brain.audiobook',
  tts: 'tts.audiobook',
}
const probeSourceFiles = [
  'scripts/probe-topology.mjs',
  'scripts/topology/core.mjs',
  'scripts/topology/fixture-child.mjs',
  'scripts/topology/sqlite-probe.mjs',
  'scripts/test/topology.test.mjs',
]

function commandOutput(command, arguments_, options = {}) {
  return execFileSync(command, arguments_, { encoding: 'utf8', ...options }).trim()
}

function probeSourceHash() {
  const hash = createHash('sha256')
  for (const relativePath of [...probeSourceFiles].sort()) {
    hash.update(relativePath)
    hash.update('\0')
    hash.update(readFileSync(join(repositoryRoot, relativePath)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function waitForMessage(child, type, timeoutMilliseconds = 8_000) {
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`service child did not report ${type}`)),
      timeoutMilliseconds,
    )
    const onExit = (code, signal) => {
      clearTimeout(timeout)
      reject(new Error(`service child exited early: code=${code} signal=${signal}`))
    }
    child.once('exit', onExit)
    child.on('message', (message) => {
      if (message?.type !== type) return
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

async function freeLoopbackPort() {
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

async function startService(service, ownerToken, runtimeDirectory) {
  const child = fork(fixturePath, ['server', service, ownerToken], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    execArgv: [],
  })
  let standardError = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    standardError += chunk
  })
  const ready = await waitForMessage(child, 'ready').catch((error) => {
    throw new Error(`${error.message}; stderr=${standardError}`)
  })
  assert.equal(ready.ownerToken, ownerToken)
  const identity = readProcessIdentity(ready.pid)
  assert.ok(identity)
  const record = {
    service,
    ownerToken,
    ...identity,
    host: ready.host,
    port: ready.port,
    directUrl: `http://127.0.0.1:${ready.port}`,
  }
  await atomicWriteJson(join(runtimeDirectory, `${service}.json`), record)
  assert.equal(processRecordIsOwned(record), true)
  return { child, record }
}

async function stopService(service) {
  service.child.kill('SIGTERM')
  const exit = await waitForExit(service.child)
  assert.equal(exit.code, 0)
}

function runPortless(arguments_, environment) {
  const result = spawnSync(portlessPath, arguments_, {
    cwd: repositoryRoot,
    env: environment,
    encoding: 'utf8',
    timeout: 15_000,
  })
  if (result.status !== 0) {
    throw new Error(
      `portless ${arguments_.join(' ')} failed: ${result.stderr || result.stdout || result.error}`,
    )
  }
  return result.stdout.trim()
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

function curlRoute(url, { expectedOwnerToken, trustProxy = true } = {}) {
  const parsedUrl = new URL(url)
  const port = parsedUrl.port || (parsedUrl.protocol === 'https:' ? '443' : '80')
  const arguments_ = [
    '--silent',
    '--show-error',
    '--noproxy',
    '*',
    '--resolve',
    `${parsedUrl.hostname}:${port}:127.0.0.1`,
    '--include',
    '--write-out',
    '\n%{http_code}',
    url,
  ]
  if (!trustProxy) arguments_.splice(-2, 0, '--insecure')
  const result = spawnSync('curl', arguments_, { encoding: 'utf8', timeout: 5_000 })
  if (result.status !== 0) {
    return { status: 0, text: '', error: result.stderr || result.error?.message }
  }
  const separator = result.stdout.lastIndexOf('\n')
  const text = result.stdout.slice(0, separator)
  const status = Number(result.stdout.slice(separator + 1))
  if (expectedOwnerToken && status === 200) {
    assert.match(text.toLowerCase(), new RegExp(`x-topology-owner-token: ${expectedOwnerToken}`))
  }
  return { status, text }
}

async function waitForRoutedResponse(url, ownerToken, timeoutMilliseconds = 3_000) {
  const deadline = Date.now() + timeoutMilliseconds
  let response
  do {
    response = curlRoute(url, { expectedOwnerToken: ownerToken })
    if (response.status === 200) return response
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  } while (Date.now() < deadline)
  return response
}

function listenerLinesForPorts(ports) {
  const output = commandOutput('ss', ['-H', '-ltnp'])
  return output.split('\n').filter((line) => ports.some((port) => line.includes(`:${port} `)))
}

function assertFinalLoopbackListeners(endpoints) {
  const ports = endpoints.map(({ port }) => port)
  const listeners = listenerLinesForPorts(ports)
  for (const port of ports) {
    assert.ok(
      listeners.some((line) => line.includes(`:${port} `)),
      `missing listener for ${port}`,
    )
  }
  const localAddresses = listeners.map((line) => line.trim().split(/\s+/)[3])
  assert.ok(
    localAddresses.every(
      (address) => address?.startsWith('127.0.0.1:') || address?.startsWith('[::1]:'),
    ),
    `non-loopback listener found: ${localAddresses.join(', ')}`,
  )
  return listeners.map((line) => ({
    endpoint: endpoints.find(({ port }) => line.includes(`:${port} `))?.name,
    addressFamily: line.includes('[::1]:') ? 'ipv6' : 'ipv4',
    loopback: true,
  }))
}

async function assertFinalLanIsolation(endpoints) {
  const addresses = globalIpv4Addresses()
  assert.ok(addresses.length > 0, 'no WSL LAN address was available to test')
  let attempts = 0
  for (const address of addresses) {
    for (const { port } of endpoints) {
      const unavailable = await endpointIsUnavailable(`http://${address}:${port}`)
      assert.equal(unavailable, true, 'a final service accepted a non-loopback connection')
      attempts += 1
    }
  }
  return {
    addressCount: addresses.length,
    finalEndpoints: endpoints.map(({ name }) => name),
    attempts,
  }
}

function windowsPathFromWsl(path) {
  const match = path.match(/^\/mnt\/([a-z])\/(.*)$/i)
  assert.ok(match, 'Windows browser evidence path must be on /mnt/<drive>')
  return `${match[1].toUpperCase()}:\\${match[2].replaceAll('/', '\\')}`
}

function pngPixel(path, x, y) {
  const png = readFileSync(path)
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

function runWindowsBrowserTrustCheck(browserPath, browserVersion, urls) {
  assert.ok(browserPath && existsSync(browserPath))
  const browserDirectory = join(repositoryRoot, `.topology-browser-${process.pid}`)
  mkdirSync(browserDirectory, { recursive: true })
  const expectedColors = {
    audiobook: [0x12, 0x34, 0x56],
    brain: [0x34, 0x56, 0x12],
    tts: [0x56, 0x12, 0x34],
  }
  const checks = []
  try {
    for (const url of urls) {
      const expectedService = new URL(url).hostname.split('.')[0]
      const screenshotPath = join(browserDirectory, `${expectedService}.png`)
      const profilePath = join(browserDirectory, `${expectedService}-profile`)
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
          url,
        ],
        { encoding: 'utf8', timeout: 30_000 },
      )
      const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
      for (let attempt = 0; attempt < 100 && !existsSync(screenshotPath); attempt += 1) {
        Atomics.wait(waitBuffer, 0, 0, 50)
      }
      assert.equal(result.status, 0, result.error?.message ?? result.stderr)
      assert.ok(existsSync(screenshotPath), 'Windows browser did not write acceptance screenshot')
      const centerPixel = pngPixel(screenshotPath, 160, 100)
      assert.deepEqual(centerPixel, expectedColors[expectedService])
      checks.push({ url, trustedAndReachedExpectedService: true })
    }
    return {
      status: 'pass',
      browserVersion,
      method: 'Windows Chrome headless screenshot without TLS bypass',
      checks,
    }
  } finally {
    rmSync(browserDirectory, { recursive: true, force: true })
  }
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

export async function probePortless() {
  assert.ok(existsSync(portlessPath), 'run pnpm install before the Portless probe')
  const cacheRoot = join(homedir(), '.cache')
  await mkdir(cacheRoot, { recursive: true })
  const temporaryRoot = await mkdtemp(join(cacheRoot, 'topology-portless-'))
  const stateDirectory = join(temporaryRoot, 'portless')
  const runtimeDirectory = join(temporaryRoot, 'run')
  await mkdir(runtimeDirectory, { recursive: true })
  const proxyPort = await freeLoopbackPort()
  const ownerToken = randomUUID()
  const environment = {
    ...process.env,
    PORTLESS_STATE_DIR: stateDirectory,
    PORTLESS_PORT: String(proxyPort),
    PORTLESS_HTTPS: '0',
    PORTLESS_LAN: '0',
    PORTLESS_SYNC_HOSTS: '0',
    PORTLESS_TAILSCALE: '0',
    PORTLESS_FUNNEL: '0',
    PORTLESS_NGROK: '0',
  }
  const services = new Map()

  try {
    runPortless(['proxy', 'start', '--no-tls', '-p', String(proxyPort)], environment)
    const proxyPid = Number(readFileSync(join(stateDirectory, 'proxy.pid'), 'utf8').trim())
    const proxyIdentity = readProcessIdentity(proxyPid)
    assert.ok(proxyIdentity, 'Portless proxy PID is not live')
    for (const service of serviceNames) {
      const started = await startService(service, ownerToken, runtimeDirectory)
      services.set(service, started)
      runPortless(['alias', routeNames[service], String(started.record.port)], environment)
    }

    const aliasUrls = [
      `http://audiobook.localhost:${proxyPort}`,
      `http://brain.audiobook.localhost:${proxyPort}`,
      `http://tts.audiobook.localhost:${proxyPort}`,
    ]
    for (const [service, { record }] of services) {
      const directResponse = await fetch(record.directUrl)
      assert.equal(directResponse.status, 200)
      assert.equal(directResponse.headers.get('x-topology-owner-token'), ownerToken)
      assert.ok((await directResponse.text()).includes(`topology-service:${service}`))
    }
    for (const [index, url] of aliasUrls.entries()) {
      const response = await waitForRoutedResponse(url, ownerToken)
      assert.equal(response.status, 200, response.error ?? response.text.slice(0, 500))
      assert.ok(response.text.includes(`topology-service:${serviceNames[index]}`))
    }

    const initialWeb = services.get('audiobook')
    assert.ok(initialWeb)
    assert.equal(processRecordIsOwned({ ...initialWeb.record, executableInode: '0' }), false)
    assert.equal(processRecordIsOwned({ ...initialWeb.record, startTimeTicks: '0' }), false)
    await stopService(initialWeb)
    assert.equal(processRecordIsOwned(initialWeb.record), false)
    const restartedWeb = await startService('audiobook', ownerToken, runtimeDirectory)
    services.set('audiobook', restartedWeb)
    runPortless(
      ['alias', routeNames.audiobook, String(restartedWeb.record.port), '--force'],
      environment,
    )
    const restartedResponse = await waitForRoutedResponse(aliasUrls[0], ownerToken)
    assert.equal(restartedResponse.status, 200)

    const finalEndpoints = [
      { name: 'portless-proxy', port: proxyPort },
      ...[...services].map(([service, { record }]) => ({
        name: new URL(aliasUrls[serviceNames.indexOf(service)]).hostname,
        port: record.port,
      })),
    ]
    const finalPorts = finalEndpoints.map(({ port }) => port)
    assert.equal(new Set(finalPorts).size, finalPorts.length)
    const finalListeners = assertFinalLoopbackListeners(finalEndpoints)
    const finalLan = await assertFinalLanIsolation(finalEndpoints)
    for (const service of services.values()) {
      assert.equal(service.record.host, '127.0.0.1')
      assert.equal(processRecordIsOwned(service.record), true)
    }

    const routes = runPortless(['list'], environment)
    for (const hostname of exactHttpsUrls.map((url) => new URL(url).hostname)) {
      assert.ok(routes.includes(hostname), `Portless did not list ${hostname}`)
    }

    return {
      portlessVersion: runPortless(['--version'], environment),
      proxyIdentityVerified: processRecordIsOwned({ ...proxyIdentity }),
      finalListeners,
      finalLan,
      finalServices: [...services.keys()],
      dynamicPortsDistinct: true,
      directAndRoutedReachability: 'pass',
      loopbackOnlyAfterRestart: 'pass',
      processOwnership: {
        ownerTokenSignaledByIpcAndHttp: true,
        pidStartExecutableAndCommandIdentityRecorded: true,
        executableMismatchRejected: true,
        startTimeMismatchRejected: true,
        gracefulStop: 'pass',
        staleRecordRejected: true,
        restartAndRouteReplacement: 'pass',
      },
    }
  } finally {
    try {
      runPortless(['proxy', 'stop'], environment)
    } catch {}
    await stopAllServices(services)
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

function port443LoopbackStatus() {
  const result = spawnSync('ss', ['-H', '-ltn', 'sport = :443'], { encoding: 'utf8' })
  const lines = result.status === 0 ? result.stdout.trim().split('\n').filter(Boolean) : []
  const localAddresses = lines.map((line) => line.trim().split(/\s+/)[3])
  return {
    listening: localAddresses.length > 0,
    loopbackOnly:
      localAddresses.length > 0 &&
      localAddresses.every(
        (address) => address?.startsWith('127.0.0.1:') || address?.startsWith('[::1]:'),
      ),
  }
}

function exactHttpsConfigurationCheck() {
  const config = readFileSync(join(repositoryRoot, 'config/default.example.toml'), 'utf8')
  const portless = JSON.parse(readFileSync(join(repositoryRoot, 'portless.json'), 'utf8'))
  assert.match(config, /https:\/\/brain\.audiobook\.localhost\/v1/)
  assert.match(config, /https:\/\/tts\.audiobook\.localhost/)
  assert.equal(portless.name, 'audiobook')
  return { configuredUrls: exactHttpsUrls, status: 'pass' }
}

function defaultWindowsChromePath() {
  const candidate = '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe'
  return existsSync(candidate) ? candidate : null
}

export async function probeExactHttpsAcceptance({ requested, browserPath }) {
  const configured = exactHttpsConfigurationCheck()
  const chromePath = browserPath ?? defaultWindowsChromePath()
  const browserVersion = browserVersionFromInstall(chromePath)
  const port443 = port443LoopbackStatus()
  const sudoAvailable = spawnSync('sudo', ['-n', 'true']).status === 0
  const blockers = []
  if (!requested) blockers.push('exact HTTPS acceptance was not explicitly requested')
  if (!port443.listening) blockers.push('Portless HTTPS proxy is not listening on WSL port 443')
  if (port443.listening && !port443.loopbackOnly) blockers.push('port 443 is not loopback-only')
  if (!chromePath) blockers.push('Windows Chrome was not discovered or explicitly configured')
  const browserVersionObservation =
    'read from the installed Chrome version directory using native WSL filesystem access'
  if (blockers.length > 0) {
    return {
      status: 'blocked',
      configured,
      port443,
      nonInteractiveSudoAvailable: sudoAvailable,
      browserVersion,
      browserVersionObservation,
      browserInvoked: false,
      blockers,
    }
  }

  const environment = {
    ...process.env,
    PORTLESS_LAN: '0',
    PORTLESS_SYNC_HOSTS: '0',
    PORTLESS_TAILSCALE: '0',
    PORTLESS_FUNNEL: '0',
    PORTLESS_NGROK: '0',
  }
  const existingRoutes = runPortless(['list'], environment)
  if (exactHttpsUrls.some((url) => existingRoutes.includes(new URL(url).hostname))) {
    return {
      status: 'blocked',
      configured,
      port443,
      nonInteractiveSudoAvailable: sudoAvailable,
      browserVersion,
      browserVersionObservation,
      browserInvoked: false,
      blockers: ['one or more exact acceptance aliases are already registered'],
    }
  }

  const runtimeDirectory = await mkdtemp(join(homedir(), '.cache/topology-https-services-'))
  const ownerToken = randomUUID()
  const services = new Map()
  let acceptanceStage = 'service and alias startup'
  let browserInvoked = false
  try {
    try {
      for (const service of serviceNames) {
        const started = await startService(service, ownerToken, runtimeDirectory)
        services.set(service, started)
        runPortless(['alias', routeNames[service], String(started.record.port)], environment)
      }
      acceptanceStage = 'Linux HTTPS routing and CA trust'
      for (const [index, url] of exactHttpsUrls.entries()) {
        const response = await waitForRoutedResponse(url, ownerToken)
        assert.equal(response.status, 200, response.error)
        assert.ok(response.text.includes(`topology-service:${serviceNames[index]}`))
      }
      acceptanceStage = 'Windows Chrome HTTPS routing and CA trust'
      browserInvoked = true
      const browser = runWindowsBrowserTrustCheck(chromePath, browserVersion, exactHttpsUrls)
      return {
        status: 'pass',
        configured,
        port443,
        nonInteractiveSudoAvailable: sudoAvailable,
        browserVersionObservation,
        browserInvoked,
        browser,
      }
    } catch {
      return {
        status: 'blocked',
        configured,
        port443,
        nonInteractiveSudoAvailable: sudoAvailable,
        browserVersion,
        browserVersionObservation,
        browserInvoked,
        blockers: [`${acceptanceStage} did not pass`],
      }
    }
  } finally {
    for (const service of serviceNames) {
      try {
        runPortless(['alias', '--remove', routeNames[service]], environment)
      } catch {}
    }
    await stopAllServices(services)
    await rm(runtimeDirectory, { recursive: true, force: true })
  }
}

function readOptional(path) {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return undefined
  }
}

function parseWslConfig() {
  const windowsUserMatch = repositoryRoot.match(/^(\/mnt\/[a-z]\/Users\/[^/]+)/i)
  const path = windowsUserMatch ? join(windowsUserMatch[1], '.wslconfig') : undefined
  const content = path ? readOptional(path) : undefined
  const setting = (name) => content?.match(new RegExp(`^${name}\\s*=\\s*(.+)$`, 'im'))?.[1].trim()
  return {
    detected: Boolean(content),
    configuredMemory: setting('memory') ?? null,
    configuredSwap: setting('swap') ?? null,
  }
}

function filesystemCapacity(path) {
  const filesystem = inspectFilesystem(path)
  const stats = statfsSync(path, { bigint: true })
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

  const temporaryRoot = await mkdtemp(join(homedir(), '.cache/topology-path-root-'))
  const outsideRoot = await mkdtemp(join(homedir(), '.cache/topology-path-outside-'))
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
    WindowsSyntaxRejected: 'pass',
    canonicalRootResolved: 'pass',
    symlinkEscapeRejected: 'pass',
    nonexistentAssetAncestorContained: 'pass',
  }
}

function parseArguments(arguments_) {
  const options = { output: undefined, skipPortless: false, httpsAcceptance: false }
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--output') {
      options.output = arguments_[index + 1]
      index += 1
    } else if (argument === '--skip-portless') options.skipPortless = true
    else if (argument === '--https-acceptance') options.httpsAcceptance = true
    else if (argument?.startsWith('--')) throw new Error(`unknown option: ${argument}`)
  }
  return options
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

  let mountedWindows
  const configuredMountedRoot = process.env.TOPOLOGY_MNT_C_ROOT
  const repositoryIsMounted = /^\/mnt\/[a-z](?:\/|$)/i.test(repositoryRoot)
  const mountedRoot = configuredMountedRoot ?? (repositoryIsMounted ? repositoryRoot : undefined)
  if (!mountedRoot) {
    mountedWindows = {
      status: 'blocked',
      blocker: 'Set TOPOLOGY_MNT_C_ROOT to an explicit existing /mnt/<drive> directory.',
    }
  } else {
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

  const syntheticPortless = options.skipPortless ? { status: 'skipped' } : await probePortless()
  const httpsAcceptanceRequested =
    options.httpsAcceptance || process.env.TOPOLOGY_HTTPS_ACCEPTANCE === '1'
  const exactHttps = await probeExactHttpsAcceptance({
    requested: httpsAcceptanceRequested,
    browserPath: process.env.TOPOLOGY_WINDOWS_BROWSER,
  })
  return {
    evidenceSchemaVersion: 2,
    probeVersion: TOPOLOGY_PROBE_VERSION,
    capturedAt: new Date().toISOString(),
    provenance: {
      generatedFromCommit: commandOutput('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot }),
      probeSourceSha256: probeSourceHash(),
      nativeToolchain: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
      },
    },
    reproduction: {
      evidenceCommand: httpsAcceptanceRequested
        ? `pnpm probe:topology --https-acceptance --output ${evidencePath}`
        : `pnpm probe:topology --output ${evidencePath}`,
      exactHttpsAcceptanceCommand:
        `TOPOLOGY_WINDOWS_BROWSER='<mounted-windows-chrome.exe>' pnpm probe:topology ` +
        `--https-acceptance --output ${evidencePath}`,
    },
    acceptanceStatus: exactHttps.status === 'pass' ? 'pass' : 'blocked',
    resources: probeResources(),
    canonicalPaths: await canonicalPathChecks(),
    sqlite: {
      ext4: publicSqliteEvidence(ext4Result, ext4Filesystem),
      mountedWindows,
    },
    portless: {
      syntheticHttpHarness:
        syntheticPortless.status === 'skipped'
          ? syntheticPortless
          : {
              status: 'pass',
              portlessVersion: syntheticPortless.portlessVersion,
              finalRouteNames: exactHttpsUrls.map((url) => new URL(url).hostname),
              dynamicPortsDistinct: syntheticPortless.dynamicPortsDistinct,
              directAndRoutedReachability: syntheticPortless.directAndRoutedReachability,
              loopbackOnlyAfterRestart: syntheticPortless.loopbackOnlyAfterRestart,
              finalListeners: syntheticPortless.finalListeners,
              finalLan: syntheticPortless.finalLan,
              finalServices: syntheticPortless.finalServices,
              proxyIdentityVerified: syntheticPortless.proxyIdentityVerified,
              processOwnership: syntheticPortless.processOwnership,
              windowsBrowserInvoked: false,
            },
      exactHttpsAcceptance: exactHttps,
    },
    redaction: {
      userPaths: 'redacted',
      ipAddresses: 'redacted',
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
      console.log('Topology acceptance remains blocked; see exactHttpsAcceptance in the evidence.')
    }
  } else {
    process.stdout.write(serialized)
  }
}
