#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync, fork, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, networkInterfaces, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import {
  atomicWriteJson,
  canonicalAbsoluteLinuxPath,
  canonicalWorkspacePath,
  processRecordIsOwned,
  readProcessIdentity,
} from './topology/core.mjs'
import { probeSqliteLocation } from './topology/sqlite-probe.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixturePath = join(repositoryRoot, 'scripts/topology/fixture-child.mjs')
const portlessPath = join(repositoryRoot, 'node_modules/.bin/portless')

function commandOutput(command, arguments_, options = {}) {
  return execFileSync(command, arguments_, { encoding: 'utf8', ...options }).trim()
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
  const child = fork(fixturePath, ['server', service], {
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
  const identity = readProcessIdentity(ready.pid)
  assert.ok(identity)
  const record = {
    service,
    ownerToken,
    pid: ready.pid,
    startTimeTicks: identity.startTimeTicks,
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

function requestThroughLoopback(url) {
  const parsedUrl = new URL(url)
  const result = spawnSync(
    'curl',
    [
      '--silent',
      '--show-error',
      '--noproxy',
      '*',
      '--resolve',
      `${parsedUrl.hostname}:${parsedUrl.port}:127.0.0.1`,
      '--write-out',
      '\\n%{http_code}',
      url,
    ],
    { encoding: 'utf8', timeout: 5_000 },
  )
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  const separator = result.stdout.lastIndexOf('\n')
  return {
    status: Number(result.stdout.slice(separator + 1)),
    text: result.stdout.slice(0, separator),
  }
}

async function waitForRoutedResponse(url, timeoutMilliseconds = 3_000) {
  const deadline = Date.now() + timeoutMilliseconds
  let response
  do {
    response = requestThroughLoopback(url)
    if (response.status === 200) return response
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  } while (Date.now() < deadline)
  return response
}

function listenerLinesForPorts(ports) {
  const output = commandOutput('ss', ['-H', '-ltnp'])
  return output.split('\n').filter((line) => ports.some((port) => line.includes(`:${port} `)))
}

function windowsPathFromWsl(path) {
  const match = path.match(/^\/mnt\/([a-z])\/(.*)$/i)
  assert.ok(match, `Windows browser evidence path must be on /mnt/<drive>: ${path}`)
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
  const compressed = Buffer.concat(imageData)
  const filtered = inflateSync(compressed)
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
        const leftDistance = Math.abs(prediction - left)
        const aboveDistance = Math.abs(prediction - above)
        const upperLeftDistance = Math.abs(prediction - upperLeft)
        const predictor =
          leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
            ? left
            : aboveDistance <= upperLeftDistance
              ? above
              : upperLeft
        row[column] = (row[column] + predictor) & 0xff
      } else assert.equal(filter, 0)
    }
    rows.push(row)
  }
  const pixelOffset = x * bytesPerPixel
  return [...rows[y].subarray(pixelOffset, pixelOffset + 3)]
}

function probeWindowsBrowser(browserPath, urls) {
  if (!browserPath) {
    return {
      status: 'not-run',
      reason:
        'Set TOPOLOGY_WINDOWS_BROWSER to a Windows Chrome/Edge executable for this host-only check.',
    }
  }

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
      assert.ok(existsSync(screenshotPath), `Windows browser did not write ${screenshotPath}`)
      const centerPixel = pngPixel(screenshotPath, 160, 100)
      assert.deepEqual(centerPixel, expectedColors[expectedService])
      checks.push({ url, status: 'pass', executable: browserPath, centerPixel })
    }
    return { status: 'pass', method: 'headless screenshot color assertion', checks }
  } finally {
    rmSync(browserDirectory, { recursive: true, force: true })
  }
}

export async function probePortless({ browserPath } = {}) {
  assert.ok(existsSync(portlessPath), 'run pnpm install before the Portless probe')
  const temporaryRoot = await mkdtemp(join(homedir(), '.cache/topology-portless-'))
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
  const routeNames = {
    audiobook: 'audiobook',
    brain: 'brain.audiobook',
    tts: 'tts.audiobook',
  }

  try {
    runPortless(['proxy', 'start', '--no-tls', '-p', String(proxyPort)], environment)
    const proxyPid = Number(readFileSync(join(stateDirectory, 'proxy.pid'), 'utf8').trim())
    const proxyIdentity = readProcessIdentity(proxyPid)
    assert.ok(proxyIdentity, 'Portless proxy PID is not live')
    for (const service of ['audiobook', 'brain', 'tts']) {
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
      assert.ok((await directResponse.text()).includes(`topology-service:${service}`))
    }
    for (const [index, url] of aliasUrls.entries()) {
      const response = await waitForRoutedResponse(url)
      assert.equal(response.status, 200, response.text.slice(0, 500))
      assert.ok(response.text.includes(`topology-service:${[...services.keys()][index]}`))
    }

    const ports = [proxyPort, ...[...services.values()].map(({ record }) => record.port)]
    assert.equal(new Set(ports).size, ports.length)
    const listeners = listenerLinesForPorts(ports)
    assert.ok(listeners.length >= ports.length)
    const localAddresses = listeners.map((line) => line.trim().split(/\s+/)[3])
    assert.ok(
      localAddresses.every(
        (address) => address?.startsWith('127.0.0.1:') || address?.startsWith('[::1]:'),
      ),
      `non-loopback listener found: ${localAddresses.join(', ')}`,
    )
    for (const service of services.values()) assert.ok(service.record.host === '127.0.0.1')

    const lanChecks = []
    for (const address of globalIpv4Addresses()) {
      for (const port of ports) {
        const unavailable = await endpointIsUnavailable(`http://${address}:${port}`)
        assert.equal(unavailable, true, `${address}:${port} accepted a non-loopback connection`)
        lanChecks.push({ address, port, unavailable })
      }
    }
    assert.ok(lanChecks.length > 0, 'no WSL LAN address was available to test')

    const initialWeb = services.get('audiobook')
    assert.ok(initialWeb)
    const mismatchedRecord = { ...initialWeb.record, startTimeTicks: '0' }
    assert.equal(processRecordIsOwned(mismatchedRecord), false)
    await stopService(initialWeb)
    assert.equal(processRecordIsOwned(initialWeb.record), false)
    const restartedWeb = await startService('audiobook', ownerToken, runtimeDirectory)
    services.set('audiobook', restartedWeb)
    runPortless(
      ['alias', routeNames.audiobook, String(restartedWeb.record.port), '--force'],
      environment,
    )
    const restartedResponse = await waitForRoutedResponse(aliasUrls[0])
    assert.ok(restartedResponse.text.includes(`pid:${restartedWeb.record.pid}`))

    const routes = runPortless(['list'], environment)
    for (const service of [
      'audiobook.localhost',
      'brain.audiobook.localhost',
      'tts.audiobook.localhost',
    ]) {
      assert.ok(routes.includes(service), `Portless did not list ${service}`)
    }

    const browser = probeWindowsBrowser(browserPath, aliasUrls)
    return {
      portlessVersion: runPortless(['--version'], environment),
      proxy: {
        pid: proxyPid,
        startTimeTicks: proxyIdentity.startTimeTicks,
        port: proxyPort,
        tls: false,
        stateDirectory,
        listeners,
      },
      routes: Object.fromEntries(
        [...services].map(([name, { record }]) => [
          name,
          { ...record, route: aliasUrls[['audiobook', 'brain', 'tts'].indexOf(name)] },
        ]),
      ),
      routeListing: routes,
      dynamicPortsDistinct: true,
      directAndRoutedReachability: 'pass',
      loopbackOnly: 'pass',
      lanChecks,
      processOwnership: {
        ownerTokenRecorded: true,
        pidAndStartTimeRecorded: true,
        mismatchedIdentityRejected: true,
        gracefulStop: 'pass',
        staleRecordRejected: true,
        restartAndRouteReplacement: 'pass',
      },
      browser,
    }
  } finally {
    try {
      runPortless(['proxy', 'stop'], environment)
    } catch {}
    await Promise.all(
      [...services.values()].map(async (service) => {
        if (service.child.exitCode !== null || service.child.signalCode !== null) return
        service.child.kill('SIGTERM')
        await waitForExit(service.child, 2_000).catch(() => service.child.kill('SIGKILL'))
      }),
    )
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

function readOptional(path) {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return undefined
  }
}

function mountEvidence(path) {
  return commandOutput('findmnt', ['-T', path, '-n', '-o', 'TARGET,SOURCE,FSTYPE,OPTIONS'])
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
  const windowsUserMatch = repositoryRoot.match(/^(\/mnt\/[a-z]\/Users\/[^/]+)/i)
  const wslConfigPath = windowsUserMatch ? join(windowsUserMatch[1], '.wslconfig') : undefined

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
        : { status: 'unavailable', error: gpuResult.stderr.trim(), dxg: existsSync('/dev/dxg') },
    wslConfig: wslConfigPath
      ? { path: wslConfigPath, content: readOptional(wslConfigPath) ?? 'missing' }
      : { path: null, content: 'not-discovered' },
    workspace: {
      path: realpathSync(repositoryRoot),
      mount: mountEvidence(repositoryRoot),
      disk: commandOutput('df', ['-hT', repositoryRoot]).split('\n').at(-1),
    },
    ext4Home: {
      path: realpathSync(homedir()),
      mount: mountEvidence(homedir()),
      disk: commandOutput('df', ['-hT', homedir()]).split('\n').at(-1),
    },
  }
}

export function canonicalPathChecks() {
  assert.equal(
    canonicalAbsoluteLinuxPath('/mnt/c/Users/example/Audiobooks'),
    '/mnt/c/Users/example/Audiobooks',
  )
  assert.equal(canonicalWorkspacePath('books/book-1/source.epub'), 'books/book-1/source.epub')
  assert.throws(() => canonicalWorkspacePath('../escape'))
  assert.throws(() => canonicalWorkspacePath('C:\\Audiobooks\\book.epub'))
  return {
    absoluteLinuxConfigurationPaths: 'pass',
    relativePosixDatabaseAssetPaths: 'pass',
    traversalRejected: 'pass',
    WindowsSyntaxRejected: 'pass',
  }
}

function parseArguments(arguments_) {
  const options = { output: undefined, skipPortless: false }
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--output') options.output = arguments_[index + 1]
    if (argument === '--output') index += 1
    else if (argument === '--skip-portless') options.skipPortless = true
    else if (argument?.startsWith('--')) throw new Error(`unknown option: ${argument}`)
  }
  return options
}

export async function runTopologyProbe(options = {}) {
  const ext4Root =
    process.env.TOPOLOGY_EXT4_ROOT ?? join(homedir(), '.cache/light-novel-audiobook/probes')
  const mountedWindowsRoot = process.env.TOPOLOGY_MNT_C_ROOT ?? repositoryRoot
  await mkdir(ext4Root, { recursive: true })
  const sqlite = [await probeSqliteLocation({ label: 'wsl-ext4', root: ext4Root })]
  if (existsSync('/mnt/c') && existsSync(mountedWindowsRoot)) {
    sqlite.push(
      await probeSqliteLocation({ label: 'mounted-windows-volume', root: mountedWindowsRoot }),
    )
  }

  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    command: 'pnpm probe:topology',
    nativeToolchain: {
      node: process.version,
      executable: process.execPath,
      platform: process.platform,
      architecture: process.arch,
    },
    resources: probeResources(),
    canonicalPaths: canonicalPathChecks(),
    sqlite,
    portless: options.skipPortless
      ? { status: 'skipped' }
      : await probePortless({ browserPath: process.env.TOPOLOGY_WINDOWS_BROWSER }),
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
  } else {
    process.stdout.write(serialized)
  }
}
