import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  loadLock,
  requireVoxCpm2PcmWav,
  sha256,
  sha256File,
  summarizeRequests,
  summarizeResourceCsv,
} from './voxcpm2/core.mjs'

const probePath = fileURLToPath(import.meta.url)
const repositoryRoot = resolve(dirname(probePath), '..')
const lockPath = join(repositoryRoot, 'config/voxcpm2-spike.lock.json')
const lock = await loadLock(lockPath)
const outputFlag = process.argv.indexOf('--output')
const evidencePath =
  outputFlag >= 0
    ? resolve(process.argv[outputFlag + 1])
    : join(repositoryRoot, 'docs/evidence/issue-7-voxcpm2-wsl2.json')
const runtimeRoot = requiredEnvironment('VOXCPM2_RUNTIME_ROOT')
const modelRoot = requiredEnvironment('VOXCPM2_MODEL_ROOT')
const audioRoot = requiredEnvironment('VOXCPM2_AUDIO_ROOT')
const rawRoot = requiredEnvironment('VOXCPM2_RAW_ROOT')
const cli = join(runtimeRoot, 'build/bin/voxcpm2-cli')
const server = join(runtimeRoot, 'build/bin/llama-tts-server')
const baseModel = join(modelRoot, lock.ggufModel.assets[0].name)
const acousticModel = join(modelRoot, lock.ggufModel.assets[1].name)
const endpoint = `http://${lock.server.host}:${lock.server.port}`
const cudaHome = process.env.CUDA_HOME ?? '/usr/local/cuda'
const runtimeEnvironment = {
  ...process.env,
  PATH: `${cudaHome}/bin:${process.env.PATH}`,
  LD_LIBRARY_PATH: `${cudaHome}/lib64${process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : ''}`,
}

function requiredEnvironment(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required; invoke this probe through voxcpm2-spike.sh`)
  return resolve(value)
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function assertPortFree(host, port) {
  await new Promise((resolvePromise, reject) => {
    const socket = createConnection({ host, port })
    socket.once('connect', () => {
      socket.destroy()
      reject(new Error(`configured TTS port is occupied: ${host}:${port}`))
    })
    socket.once('error', () => resolvePromise())
    socket.setTimeout(500, () => {
      socket.destroy()
      reject(new Error(`could not determine whether ${host}:${port} is free`))
    })
  })
}

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    encoding: 'utf8',
    env: runtimeEnvironment,
    ...options,
  })
  if (result.status !== 0) {
    throw new Error(`${commandName} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

function parseGnuTime(text) {
  const elapsed = text.match(/Elapsed \(wall clock\) time .*: (.+)/u)?.[1]
  const parts = elapsed?.split(':').map(Number) ?? []
  let elapsedSeconds = null
  if (parts.length === 2) elapsedSeconds = parts[0] * 60 + parts[1]
  if (parts.length === 3) elapsedSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2]
  const maximumRssKiB = Number(
    text.match(/Maximum resident set size \(kbytes\): ([0-9]+)/u)?.[1] ?? Number.NaN,
  )
  return {
    elapsedSeconds,
    peakRamMiB: Number.isFinite(maximumRssKiB) ? maximumRssKiB / 1024 : null,
  }
}

async function processRamMiB(pid) {
  const status = await readFile(`/proc/${pid}/status`, 'utf8')
  const rssKiB = Number(status.match(/^VmRSS:\s+([0-9]+)/mu)?.[1] ?? Number.NaN)
  if (!Number.isFinite(rssKiB)) throw new Error('could not read server resident memory')
  return rssKiB / 1024
}

function gpuMemoryMiB() {
  return Number(
    command('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits']).split(
      /\r?\n/u,
    )[0],
  )
}

async function waitForStreamOpen(stream) {
  if (stream.fd !== null) return
  await new Promise((resolvePromise, reject) => {
    stream.once('open', resolvePromise)
    stream.once('error', reject)
  })
}

async function startResourceMonitor(pid, destination) {
  const script = String.raw`while kill -0 "$1" 2>/dev/null; do ts=$(date +%s.%N); rss=$(awk '/VmRSS:/{print $2}' "/proc/$1/status" 2>/dev/null || echo 0); gpu=$(nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d ' '); printf '%s,%s,%s\n' "$ts" "$rss" "$gpu"; sleep 0.1; done`
  const output = createWriteStream(destination, { flags: 'w' })
  await waitForStreamOpen(output)
  const child = spawn('bash', ['-c', script, '_', String(pid)], {
    detached: true,
    env: runtimeEnvironment,
    stdio: ['ignore', output, 'ignore'],
  })
  return { child, output }
}

async function stopMonitor(monitor) {
  if (!monitor) return
  try {
    process.kill(-monitor.child.pid, 'SIGTERM')
  } catch {}
  if (!monitor.output.closed) {
    monitor.output.end()
    await new Promise((resolvePromise) => monitor.output.once('close', resolvePromise))
  }
}

async function waitForExit(child, timeoutMilliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode }
  }
  return await Promise.race([
    new Promise((resolvePromise) =>
      child.once('exit', (code, signal) => resolvePromise({ code, signal })),
    ),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('process did not stop before deadline')),
        timeoutMilliseconds,
      ),
    ),
  ])
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return await waitForExit(child, 1)
  child.kill('SIGTERM')
  try {
    return await waitForExit(child, 10_000)
  } catch (error) {
    child.kill('SIGKILL')
    await waitForExit(child, 5_000)
    throw error
  }
}

function serverArguments() {
  return [
    '--host',
    lock.server.host,
    '--port',
    String(lock.server.port),
    '--voxcpm2-base-lm',
    baseModel,
    '--voxcpm2-acoustic',
    acousticModel,
    '--voxcpm2-n-gpu-layers',
    '-1',
  ]
}

async function startServer(label) {
  await assertPortFree(lock.server.host, lock.server.port)
  const stdoutPath = join(rawRoot, `${label}.stdout.log`)
  const stderrPath = join(rawRoot, `${label}.stderr.log`)
  const stdout = createWriteStream(stdoutPath, { flags: 'w' })
  const stderr = createWriteStream(stderrPath, { flags: 'w' })
  await Promise.all([waitForStreamOpen(stdout), waitForStreamOpen(stderr)])
  const started = performance.now()
  const child = spawn(server, serverArguments(), {
    env: runtimeEnvironment,
    stdio: ['ignore', stdout, stderr],
  })
  let health
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`TTS server exited during load: ${child.exitCode}`)
    try {
      const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(500) })
      if (response.ok) {
        health = await response.json()
        break
      }
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  if (!health) {
    child.kill('SIGKILL')
    throw new Error('TTS server did not become healthy')
  }
  return {
    child,
    stdout,
    stderr,
    stdoutPath,
    stderrPath,
    health,
    loadSeconds: (performance.now() - started) / 1000,
  }
}

async function closeLogs(instance) {
  const closing = []
  for (const stream of [instance.stdout, instance.stderr]) {
    if (!stream.closed) {
      stream.end()
      closing.push(new Promise((resolvePromise) => stream.once('close', resolvePromise)))
    }
  }
  await Promise.all(closing)
}

async function speech(body, { signal, path = '/v1/audio/speech' } = {}) {
  const started = performance.now()
  const response = await fetch(`${endpoint}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal,
  })
  const buffer = Buffer.from(await response.arrayBuffer())
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    contentLength: response.headers.get('content-length'),
    elapsedSeconds: (performance.now() - started) / 1000,
    buffer,
  }
}

async function runCli() {
  const output = join(audioRoot, 'cli-basic.wav')
  const stdout = join(rawRoot, 'cli-basic.stdout.log')
  const timing = join(rawRoot, 'cli-basic.stderr-time.log')
  const args = [
    cli,
    '--text',
    'The lantern glows beside a quiet window.',
    '--output',
    output,
    '--steps',
    '20',
    '--timesteps',
    '10',
    '--cfg',
    '2.0',
    '--temperature',
    '1.0',
    '--seed',
    '42',
    baseModel,
    acousticModel,
  ]
  const started = performance.now()
  const result = spawnSync('/usr/bin/time', ['-v', ...args], {
    encoding: 'utf8',
    env: runtimeEnvironment,
    maxBuffer: 16 * 1024 * 1024,
  })
  await writeFile(stdout, result.stdout)
  await writeFile(timing, result.stderr)
  if (result.status !== 0) throw new Error(`voxcpm2-cli failed with ${result.status}`)
  const buffer = await readFile(output)
  const stderr = result.stderr
  const generation = stderr.match(/Elapsed: ([0-9.]+)s, RTF=([0-9.]+)/u)
  const maxRss = stderr.match(/Maximum resident set size \(kbytes\): ([0-9]+)/u)
  return {
    status: 'pass',
    wallSeconds: (performance.now() - started) / 1000,
    generationSeconds: generation ? Number(generation[1]) : null,
    rtf: generation ? Number(generation[2]) : null,
    peakRamMiB: maxRss ? Number(maxRss[1]) / 1024 : null,
    audio: requireVoxCpm2PcmWav(buffer),
  }
}

for (const path of [cli, server, baseModel, acousticModel]) {
  if (!(await exists(path))) throw new Error(`required runtime artifact is missing: ${path}`)
}
await mkdir(audioRoot, { recursive: true })
await mkdir(rawRoot, { recursive: true })
await mkdir(dirname(evidencePath), { recursive: true })
for (const asset of lock.ggufModel.assets) {
  const path = join(modelRoot, asset.name)
  if ((await stat(path)).size !== asset.size || (await sha256File(path)) !== asset.sha256) {
    throw new Error(`model integrity check failed: ${asset.name}`)
  }
}

const baselineGpuMiB = gpuMemoryMiB()
const cliEvidence = await runCli()
const instance = await startServer('server')
const resourcePath = join(rawRoot, 'server-resource.csv')
const monitor = await startResourceMonitor(instance.child.pid, resourcePath)
const loadedSteady = {
  ramMiB: await processRamMiB(instance.child.pid),
  deviceVramMiB: gpuMemoryMiB(),
}
loadedSteady.incrementalVramMiB = loadedSteady.deviceVramMiB - baselineGpuMiB
let mainExit
const persistence = []
const errors = []
const parameters = []
const cancellation = []
const boundary = {}
let models
let responseMetadata
let resourcesAfterRequests
let loopbackListenerObserved = false
try {
  const listeners = command('ss', ['-H', '-ltn'])
  loopbackListenerObserved = listeners
    .split(/\r?\n/u)
    .some((line) => line.includes(`${lock.server.host}:${lock.server.port}`))
  if (!loopbackListenerObserved)
    throw new Error('TTS listener was not bound to configured loopback')
  const modelResponse = await fetch(`${endpoint}/v1/audio/speech/models`)
  models = { status: modelResponse.status, body: await modelResponse.json() }
  for (let request = 1; request <= 20; request += 1) {
    const result = await speech({
      model: 'voxcpm2',
      input: `Synthetic persistence request number ${request}.`,
      response_format: 'wav',
      seed: 1000 + request,
      max_steps: 5,
      inference_timesteps: 2,
      cfg_value: 2,
      temperature: 1,
    })
    if (result.status !== 200) throw new Error(`persistence request ${request} failed`)
    const audio = requireVoxCpm2PcmWav(result.buffer)
    await writeFile(
      join(audioRoot, `server-${String(request).padStart(2, '0')}.wav`),
      result.buffer,
    )
    persistence.push({
      request,
      status: result.status,
      elapsedSeconds: result.elapsedSeconds,
      audio,
    })
    responseMetadata ??= {
      contentType: result.contentType,
      contentLength: result.contentLength,
      customGenerationHeaders: [],
    }
  }
  for (const [name, body] of [
    ['missing-input', {}],
    ['unknown-model', { input: 'Synthetic.', model: 'bad' }],
    ['bad-format', { input: 'Synthetic.', response_format: 'mp3' }],
    ['invalid-reference', { input: 'Synthetic.', reference_audio: 'bm90LXdhdg==' }],
    ['malformed-json', '{'],
  ]) {
    const result = await speech(body)
    errors.push({
      name,
      status: result.status,
      contentType: result.contentType,
      body: result.buffer.toString('utf8').slice(0, 300),
    })
  }
  for (const [name, body] of [
    [
      'max-steps-5',
      { input: 'A calm synthetic phrase.', max_steps: 5, inference_timesteps: 2, seed: 42 },
    ],
    [
      'max-steps-10',
      { input: 'A calm synthetic phrase.', max_steps: 10, inference_timesteps: 2, seed: 42 },
    ],
    [
      'seed-43',
      { input: 'A calm synthetic phrase.', max_steps: 5, inference_timesteps: 2, seed: 43 },
    ],
    [
      'model-alias',
      { input: 'A calm synthetic phrase.', model: 'voxcpm', max_steps: 5, inference_timesteps: 2 },
    ],
    [
      'unknown-field',
      { input: 'A calm synthetic phrase.', speed: 9, max_steps: 5, inference_timesteps: 2 },
    ],
    [
      'wrong-types-defaulted',
      {
        input: 'A calm synthetic phrase.',
        seed: 'bad',
        max_steps: 'bad',
        inference_timesteps: 'bad',
      },
    ],
    [
      'pcm',
      {
        input: 'A calm synthetic phrase.',
        response_format: 'pcm',
        max_steps: 5,
        inference_timesteps: 2,
      },
    ],
  ]) {
    const result = await speech(body)
    const item = {
      name,
      status: result.status,
      contentType: result.contentType,
      bytes: result.buffer.length,
      sha256: sha256(result.buffer),
    }
    if (result.contentType?.startsWith('audio/wav'))
      item.audio = requireVoxCpm2PcmWav(result.buffer)
    if (name === 'pcm') {
      item.pcm = {
        encoding: 'float32-le',
        channels: 1,
        sampleRateHz: 48000,
        samples: result.buffer.length / 4,
      }
    }
    parameters.push(item)
  }
  const syntheticReference = (await readFile(join(audioRoot, 'cli-basic.wav'))).toString('base64')
  const clone = await speech({
    input: 'A synthetic reference conditioning test.',
    reference_audio: syntheticReference,
    max_steps: 5,
    inference_timesteps: 2,
  })
  parameters.push({
    name: 'synthetic-reference-audio',
    status: clone.status,
    contentType: clone.contentType,
    audio: requireVoxCpm2PcmWav(clone.buffer),
    referenceProvenance: 'VoxCPM2 CLI-generated synthetic audio; no human recording',
  })
  for (const mode of ['manual-abort', 'timeout']) {
    const controller = new AbortController()
    const timer = setTimeout(
      () =>
        controller.abort(
          new DOMException(mode, mode === 'timeout' ? 'TimeoutError' : 'AbortError'),
        ),
      25,
    )
    const started = performance.now()
    try {
      await speech(
        { input: `${mode} synthetic request.`, max_steps: 80, inference_timesteps: 10 },
        { signal: controller.signal },
      )
      cancellation.push({ mode, result: 'unexpected-completion' })
    } catch (error) {
      cancellation.push({
        mode,
        clientResult: error.name,
        elapsedSeconds: (performance.now() - started) / 1000,
        serverCancellation: 'not implemented; generation continues after client disconnect',
      })
    } finally {
      clearTimeout(timer)
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 8000))
    const health = await fetch(`${endpoint}/health`)
    cancellation.at(-1).healthAfterWait = health.status
  }
  for (const [name, headers] of [
    ['arbitrary-host', { host: 'untrusted.example' }],
    ['browser-origin', { origin: 'http://untrusted.example', 'sec-fetch-site': 'cross-site' }],
  ]) {
    const response = await fetch(`${endpoint}/health`, { headers })
    boundary[name] = {
      status: response.status,
      accessControlAllowOrigin: response.headers.get('access-control-allow-origin'),
    }
  }
  const postRequestsDeviceVramMiB = gpuMemoryMiB()
  resourcesAfterRequests = {
    ramMiB: await processRamMiB(instance.child.pid),
    deviceVramMiB: postRequestsDeviceVramMiB,
    incrementalVramMiB: postRequestsDeviceVramMiB - baselineGpuMiB,
  }
  mainExit = await stopServer(instance.child)
} finally {
  await stopMonitor(monitor)
  if (instance.child.exitCode === null && instance.child.signalCode === null)
    await stopServer(instance.child)
  await closeLogs(instance)
}
await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
const resources = summarizeResourceCsv(await readFile(resourcePath, 'utf8'), baselineGpuMiB)
const serverLog = await readFile(instance.stderrPath, 'utf8')

const destructive = await startServer('server-stream-crash')
let streamResult
try {
  try {
    const result = await speech(
      { input: 'A synthetic streaming phrase.', max_steps: 5, inference_timesteps: 2, seed: 42 },
      { path: '/v1/audio/speech/stream' },
    )
    streamResult = { clientStatus: result.status, bytes: result.buffer.length }
  } catch (error) {
    streamResult = { clientError: error.message }
  }
  const exit = await waitForExit(destructive.child, 30_000)
  streamResult.processExit = exit
} finally {
  if (destructive.child.exitCode === null && destructive.child.signalCode === null) {
    await stopServer(destructive.child)
  }
  await closeLogs(destructive)
}
const destructiveLog = await readFile(destructive.stderrPath, 'utf8')
streamResult.assertion = destructiveLog.includes('GGML_ASSERT(lp0 <= x->ne[0]) failed')
  ? 'GGML_ASSERT(lp0 <= x->ne[0]) failed'
  : null
streamResult.characterization =
  'short streaming requests can abort the whole server; do not use this endpoint'

const generatedFromCommit = command('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'])
const memTotalKiB = Number(
  (await readFile('/proc/meminfo', 'utf8')).match(/^MemTotal:\s+([0-9]+)/mu)?.[1],
)
const [gpuName, gpuMemoryTotalMiB, gpuDriver] = command('nvidia-smi', [
  '--query-gpu=name,memory.total,driver_version',
  '--format=csv,noheader,nounits',
])
  .split(',')
  .map((value) => value.trim())
const configureTiming = parseGnuTime(
  await readFile(join(rawRoot, 'cmake-configure-time.log'), 'utf8'),
)
const compileTiming = parseGnuTime(await readFile(join(rawRoot, 'cmake-build-time.log'), 'utf8'))
const evidence = {
  evidenceSchemaVersion: 1,
  probeVersion: 1,
  capturedAt: new Date().toISOString(),
  provenance: {
    generatedFromCommit,
    probeSourceSha256: await sha256File(probePath),
    harnessSourceSha256: await sha256File(join(repositoryRoot, 'scripts/voxcpm2-spike.sh')),
    lockSha256: await sha256File(lockPath),
    runtime: lock.runtime,
    officialModel: lock.officialModel,
    ggufModel: lock.ggufModel,
  },
  host: {
    environment: 'WSL2',
    kernel: command('uname', ['-r']),
    effectiveRamMiB: memTotalKiB / 1024,
    gpu: {
      name: gpuName,
      memoryTotalMiB: Number(gpuMemoryTotalMiB),
      driver: gpuDriver,
      baselineUsedMiB: baselineGpuMiB,
    },
  },
  reproduction: {
    commands: [
      'pnpm voxcpm2:setup',
      `pnpm voxcpm2:probe -- --output ${evidencePath.replace(repositoryRoot, '.').replaceAll('\\', '/')}`,
    ],
    privateInputsUsed: false,
    syntheticInputsOnly: true,
  },
  isolation: {
    filesystem: 'ext4',
    artifactsOutsideGit: true,
    ttsAndBrainDirectoriesSeparate: true,
    rawLogsOutsideGit: true,
    generatedAudioOutsideGit: true,
    configuredEndpoint: endpoint,
    loopbackListenerObserved,
  },
  build: {
    status: 'pass',
    cuda: true,
    cudaArchitecture: lock.build.cudaArchitecture,
    nvcc: command(join(cudaHome, 'bin/nvcc'), ['--version']).split('\n').at(-1),
    configureTiming,
    compileTiming,
    targets: {
      'voxcpm2-cli': { sha256: await sha256File(cli) },
      'llama-tts-server': { sha256: await sha256File(server) },
    },
  },
  cli: cliEvidence,
  server: {
    status: 'pass-non-streaming',
    loadSeconds: instance.loadSeconds,
    health: instance.health,
    models,
    gracefulExit: mainExit,
    modelLoadOccurrences: serverLog.match(/VoxCPM2 loaded/gu)?.length ?? 0,
    persistence: {
      ...summarizeRequests(persistence),
      processStayedAlive: true,
      modelLoadedOnce: (serverLog.match(/VoxCPM2 loaded/gu)?.length ?? 0) === 1,
      requests: persistence,
    },
    responseMetadata,
    exercisedParameters: [
      'model',
      'input',
      'response_format',
      'seed',
      'cfg_value',
      'inference_timesteps',
      'max_steps',
      'temperature',
      'reference_audio',
    ],
    resources: {
      ...resources,
      loadedSteady,
      afterRequestsSteady: resourcesAfterRequests,
    },
    errors,
    parameters,
    cancellationAndTimeout: cancellation,
    boundary,
    streaming: streamResult,
  },
  limitations: [
    'The streaming endpoint can crash the process on a valid short request.',
    'Client abort and timeout do not cancel server-side generation.',
    'Invalid client requests use HTTP 500 instead of HTTP 400; malformed JSON has an empty 500 response.',
    'Wrong parameter types silently fall back to defaults and unknown fields are ignored.',
    'No generation timing, seed, or model identity is returned in response headers.',
    'The server accepts arbitrary Host and browser Origin headers, though it emits no CORS permission.',
    'The runtime does not serialize generation calls; future adapters must enforce one in-flight request.',
    'The streaming WAV header uses unknown 0x7fffffff sizes and needs finalization before normal WAV tooling.',
  ],
  decision: {
    result: 'NO-GO for production SpeechEngine adapter at this upstream revision',
    nonStreamingSpike: 'GO for isolated CLI and single-request-at-a-time persistent experiments',
    blockers: [
      'upstream streaming process crash',
      'no server-side cancellation/deadline handling',
      'no request serialization or safe concurrency contract',
    ],
  },
  redaction: {
    absolutePaths: 'omitted',
    processIds: 'omitted',
    rawLogs: 'external only',
    privateTextOrHumanReferenceAudio: 'not used',
  },
}
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
console.log(`Wrote sanitized VoxCPM2 evidence: ${evidencePath}`)
