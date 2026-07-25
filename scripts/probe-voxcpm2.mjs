import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  characterizeInterruption,
  deriveDecision,
  deriveParameterEffects,
  deriveSourceIdentity,
  deriveStreamingCharacterization,
  loadLock,
  parseExactPortListeners,
  requireVoxCpm2PcmWav,
  sha256,
  sha256File,
  summarizeRequests,
  summarizeResourceCsv,
} from './voxcpm2/core.mjs'

const probePath = fileURLToPath(import.meta.url)
const repositoryRoot = resolve(dirname(probePath), '..')
const lockPath = join(repositoryRoot, 'config/voxcpm2-spike.lock.json')
const corePath = join(repositoryRoot, 'scripts/voxcpm2/core.mjs')
const shellPath = join(repositoryRoot, 'scripts/voxcpm2-spike.sh')
const lock = await loadLock(lockPath)
const outputFlag = process.argv.indexOf('--output')
const evidencePath =
  outputFlag >= 0
    ? resolve(process.argv[outputFlag + 1])
    : join(repositoryRoot, 'docs/evidence/issue-7-voxcpm2-wsl2.json')
const runtimeRoot = requiredEnvironment('VOXCPM2_RUNTIME_ROOT')
const modelRoot = requiredEnvironment('VOXCPM2_MODEL_ROOT')
const audioBase = requiredEnvironment('VOXCPM2_AUDIO_BASE')
const rawBase = requiredEnvironment('VOXCPM2_RAW_BASE')
const buildLogBase = requiredEnvironment('VOXCPM2_BUILD_LOG_BASE')
const expectedSourceIdentity = requiredEnvironment('VOXCPM2_SOURCE_IDENTITY')
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
const ownedServers = new Set()
const ownedMonitors = new Set()
let artifacts

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

function committedFileHash(commit, relativePath) {
  const result = spawnSync('git', ['-C', repositoryRoot, 'show', `${commit}:${relativePath}`], {
    env: runtimeEnvironment,
  })
  if (result.status !== 0) throw new Error(`harness file is not committed: ${relativePath}`)
  return createHash('sha256').update(result.stdout).digest('hex')
}

async function validateHarnessRevision() {
  const commit = command('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'])
  const sourceFiles = {
    config: { path: lockPath, relativePath: 'config/voxcpm2-spike.lock.json' },
    core: { path: corePath, relativePath: 'scripts/voxcpm2/core.mjs' },
    probe: { path: probePath, relativePath: 'scripts/probe-voxcpm2.mjs' },
    shell: { path: shellPath, relativePath: 'scripts/voxcpm2-spike.sh' },
  }
  const hashes = {}
  for (const [name, file] of Object.entries(sourceFiles)) {
    hashes[name] = await sha256File(file.path)
    if (committedFileHash(commit, file.relativePath) !== hashes[name]) {
      throw new Error(`harness file differs from committed revision: ${file.relativePath}`)
    }
  }
  const sourceIdentity = deriveSourceIdentity(hashes)
  if (sourceIdentity !== expectedSourceIdentity) throw new Error('source identity mismatch')
  return { commit, hashes, sourceIdentity }
}

async function existingAncestor(path) {
  let candidate = resolve(path)
  while (!(await exists(candidate))) {
    const parent = dirname(candidate)
    if (parent === candidate) throw new Error(`no existing ancestor for ${path}`)
    candidate = parent
  }
  return await realpath(candidate)
}

function isContained(parent, child) {
  const value = relative(parent, child)
  return value === '' || (!value.startsWith('..') && !value.startsWith('/'))
}

async function validateExternalRoots(paths) {
  const canonicalRepository = await realpath(repositoryRoot)
  for (const path of paths) {
    const ancestor = await existingAncestor(path)
    const canonicalTarget = command('realpath', ['-m', path])
    if (
      isContained(canonicalRepository, canonicalTarget) ||
      isContained(canonicalTarget, canonicalRepository)
    ) {
      throw new Error(`artifact root overlaps Git: ${path}`)
    }
    if (command('findmnt', ['-n', '-o', 'FSTYPE', '-T', ancestor]) !== 'ext4') {
      throw new Error(`artifact root is not on ext4: ${path}`)
    }
  }
}

function createRunId(sourceIdentity) {
  const timestamp = new Date().toISOString().replaceAll(/[-:.]/gu, '')
  return `probe-${sourceIdentity.slice(0, 16)}-${timestamp}-${randomBytes(6).toString('hex')}`
}

async function allocateArtifacts(sourceIdentity) {
  await mkdir(audioBase, { recursive: true })
  await mkdir(rawBase, { recursive: true })
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const runId = createRunId(sourceIdentity)
    const audioRoot = join(audioBase, runId)
    const rawRoot = join(rawBase, runId)
    try {
      await mkdir(audioRoot)
      try {
        await mkdir(rawRoot)
      } catch (error) {
        await rm(audioRoot, { recursive: true, force: true })
        throw error
      }
      return { runId, sourceIdentity, audioRoot, rawRoot, startedAt: new Date().toISOString() }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  throw new Error('could not allocate collision-safe probe run directories')
}

async function writeNew(path, data) {
  await writeFile(path, data, { flag: 'wx' })
}

async function assertPortFree(host, port) {
  await new Promise((resolvePromise, reject) => {
    const socket = createConnection({ host, port })
    socket.once('connect', () => {
      socket.destroy()
      reject(new Error(`configured TTS port is occupied: ${host}:${port}`))
    })
    socket.once('error', (error) => {
      if (error.code === 'ECONNREFUSED') resolvePromise()
      else reject(new Error(`could not check configured TTS port: ${error.message}`))
    })
    socket.setTimeout(500, () => {
      socket.destroy()
      reject(new Error(`could not determine whether ${host}:${port} is free`))
    })
  })
}

async function processRamMiB(pid) {
  const status = await readFile(`/proc/${pid}/status`, 'utf8')
  const rssKiB = Number(status.match(/^VmRSS:\s+([0-9]+)/mu)?.[1] ?? Number.NaN)
  if (!Number.isFinite(rssKiB)) throw new Error('could not read server resident memory')
  return rssKiB / 1024
}

function gpuSample() {
  const [memory, utilization] = command('nvidia-smi', [
    '--query-gpu=memory.used,utilization.gpu',
    '--format=csv,noheader,nounits',
  ])
    .split(',')
    .map(Number)
  return { deviceVramMiB: memory, gpuUtilizationPercent: utilization }
}

async function waitForStreamOpen(stream) {
  if (stream.fd !== null) return
  await new Promise((resolvePromise, reject) => {
    stream.once('open', resolvePromise)
    stream.once('error', reject)
  })
}

async function closeStream(stream) {
  if (!stream || stream.closed) return
  await new Promise((resolvePromise) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      stream.removeListener('close', finish)
      stream.removeListener('error', finish)
      resolvePromise()
    }
    stream.once('close', finish)
    stream.once('error', finish)
    stream.end()
    if (stream.closed) finish()
  })
}

async function startResourceMonitor(pid) {
  const destination = join(artifacts.rawRoot, 'server-resource.csv')
  const script = String.raw`while kill -0 "$1" 2>/dev/null; do ts=$(date +%s.%N); rss=$(awk '/VmRSS:/{print $2}' "/proc/$1/status" 2>/dev/null || echo 0); gpu=$(nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d ' '); printf '%s,%s,%s\n' "$ts" "$rss" "$gpu"; sleep 0.1; done`
  const output = createWriteStream(destination, { flags: 'wx' })
  const monitor = { child: null, output, destination }
  ownedMonitors.add(monitor)
  await waitForStreamOpen(output)
  monitor.child = spawn('bash', ['-c', script, '_', String(pid)], {
    detached: true,
    env: runtimeEnvironment,
    stdio: ['ignore', output, 'ignore'],
  })
  return monitor
}

async function waitForExit(child, timeoutMilliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode }
  }
  return await new Promise((resolvePromise, reject) => {
    let settled = false
    const finish = (result, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      if (error) reject(error)
      else resolvePromise(result)
    }
    const onExit = (code, signal) => finish({ code, signal })
    const timer = setTimeout(
      () => finish(null, new Error('process did not stop before deadline')),
      timeoutMilliseconds,
    )
    child.once('exit', onExit)
    if (child.exitCode !== null || child.signalCode !== null) {
      finish({ code: child.exitCode, signal: child.signalCode })
    }
  })
}

async function stopMonitor(monitor) {
  if (!monitor || !ownedMonitors.has(monitor)) return
  if (monitor.child && monitor.child.exitCode === null && monitor.child.signalCode === null) {
    try {
      process.kill(-monitor.child.pid, 'SIGTERM')
    } catch {}
    try {
      await waitForExit(monitor.child, 5000)
    } catch {
      try {
        process.kill(-monitor.child.pid, 'SIGKILL')
      } catch {}
      await waitForExit(monitor.child, 5000).catch(() => undefined)
    }
  }
  await closeStream(monitor.output)
  ownedMonitors.delete(monitor)
}

async function stopChild(child) {
  if (!child) return null
  if (child.exitCode !== null || child.signalCode !== null) return await waitForExit(child, 1)
  child.kill('SIGTERM')
  try {
    return await waitForExit(child, 10_000)
  } catch (error) {
    child.kill('SIGKILL')
    await waitForExit(child, 5000)
    throw error
  }
}

function serverArguments(timeoutSeconds) {
  return [
    '--host',
    lock.server.host,
    '--port',
    String(lock.server.port),
    '--threads-http',
    String(lock.server.threadsHttp),
    '--timeout',
    String(timeoutSeconds),
    '--voxcpm2-base-lm',
    baseModel,
    '--voxcpm2-acoustic',
    acousticModel,
    '--voxcpm2-n-gpu-layers',
    '-1',
  ]
}

async function cleanupServer(instance) {
  if (!instance || !ownedServers.has(instance)) return
  try {
    instance.exit ??= await stopChild(instance.child)
  } finally {
    await Promise.all([closeStream(instance.stdout), closeStream(instance.stderr)])
    ownedServers.delete(instance)
  }
}

async function startServer(label, timeoutSeconds = lock.server.timeoutSeconds) {
  await assertPortFree(lock.server.host, lock.server.port)
  const instance = {
    label,
    child: null,
    stdout: null,
    stderr: null,
    stdoutPath: join(artifacts.rawRoot, `${label}.stdout.log`),
    stderrPath: join(artifacts.rawRoot, `${label}.stderr.log`),
    timeoutSeconds,
    exit: null,
  }
  ownedServers.add(instance)
  try {
    instance.stdout = createWriteStream(instance.stdoutPath, { flags: 'wx' })
    instance.stderr = createWriteStream(instance.stderrPath, { flags: 'wx' })
    await Promise.all([waitForStreamOpen(instance.stdout), waitForStreamOpen(instance.stderr)])
    const started = performance.now()
    instance.child = spawn(server, serverArguments(timeoutSeconds), {
      env: runtimeEnvironment,
      stdio: ['ignore', instance.stdout, instance.stderr],
    })
    let spawnError
    instance.child.once('error', (error) => {
      spawnError = error
    })
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (spawnError) throw spawnError
      if (instance.child.exitCode !== null || instance.child.signalCode !== null) {
        throw new Error('TTS server exited during model load')
      }
      try {
        const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(500) })
        if (response.ok) {
          instance.health = await response.json()
          instance.loadSeconds = (performance.now() - started) / 1000
          instance.startTimeTicks = (
            await readFile(`/proc/${instance.child.pid}/stat`, 'utf8')
          ).split(' ')[21]
          return instance
        }
      } catch {}
      await delay(100)
    }
    throw new Error('TTS server did not become healthy')
  } catch (error) {
    await cleanupServer(instance)
    throw error
  }
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

async function serverIdentityMatches(instance) {
  if (!instance.child || instance.child.exitCode !== null || instance.child.signalCode !== null) {
    return false
  }
  try {
    const ticks = (await readFile(`/proc/${instance.child.pid}/stat`, 'utf8')).split(' ')[21]
    return ticks === instance.startTimeTicks
  } catch {
    return false
  }
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

async function independentWavValidation(path) {
  const script = `import json,sys,wave\nwith wave.open(sys.argv[1], 'rb') as w:\n print(json.dumps({'channels':w.getnchannels(),'sampleRateHz':w.getframerate(),'sampleWidthBytes':w.getsampwidth(),'frames':w.getnframes(),'compression':w.getcomptype()}))`
  const result = JSON.parse(command('python3', ['-c', script, path]))
  if (
    result.channels !== 1 ||
    result.sampleRateHz !== 48000 ||
    result.sampleWidthBytes !== 2 ||
    result.compression !== 'NONE'
  ) {
    throw new Error('independent Python WAV validation failed')
  }
  return { tool: 'Python stdlib wave', ...result }
}

async function runCli() {
  const output = join(artifacts.audioRoot, 'cli-basic.wav')
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
  await writeNew(join(artifacts.rawRoot, 'cli-basic.stdout.log'), result.stdout)
  await writeNew(join(artifacts.rawRoot, 'cli-basic.stderr-time.log'), result.stderr)
  if (result.status !== 0) throw new Error(`voxcpm2-cli failed with ${result.status}`)
  const buffer = await readFile(output)
  const generation = result.stderr.match(/Elapsed: ([0-9.]+)s, RTF=([0-9.]+)/u)
  const maxRss = result.stderr.match(/Maximum resident set size \(kbytes\): ([0-9]+)/u)
  return {
    status: 'pass',
    wallSeconds: (performance.now() - started) / 1000,
    generationSeconds: generation ? Number(generation[1]) : null,
    rtf: generation ? Number(generation[2]) : null,
    peakRamMiB: maxRss ? Number(maxRss[1]) / 1024 : null,
    audio: requireVoxCpm2PcmWav(buffer),
    independentValidation: await independentWavValidation(output),
  }
}

async function observeClientInterruption(instance, mode) {
  const long = lock.probe.longRequest
  const body = {
    input: `A deliberately long synthetic ${mode} lifecycle measurement.`,
    max_steps: long.maxSteps,
    inference_timesteps: long.inferenceTimesteps,
    seed: mode === 'manual-abort' ? 7001 : 7002,
  }
  const logBefore = await stat(instance.stderrPath)
  const startedEpoch = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException(mode, mode === 'client-deadline' ? 'TimeoutError' : 'AbortError'),
      ),
    lock.probe.interruptAfterMilliseconds,
  )
  let clientResult
  try {
    await speech(body, { signal: controller.signal })
    clientResult = 'completed'
  } catch (error) {
    clientResult = error.name
  } finally {
    clearTimeout(timer)
  }
  const clientSettledAt = Date.now()
  const samples = []
  let observedActive = false
  let idleSamples = 0
  const observationDeadline = startedEpoch + lock.probe.lifecycleMaximumSeconds * 1000
  while (Date.now() < observationDeadline) {
    const sample = {
      elapsedMilliseconds: Date.now() - startedEpoch,
      ...gpuSample(),
      processAlive: await serverIdentityMatches(instance),
      settledWindow: false,
    }
    if (sample.gpuUtilizationPercent >= 10) {
      observedActive = true
      idleSamples = 0
    } else if (observedActive && sample.gpuUtilizationPercent <= 5) {
      idleSamples += 1
    } else if (observedActive) {
      idleSamples = 0
    }
    if (observedActive && idleSamples >= lock.probe.lifecycleIdleSamples) {
      sample.settledWindow = true
      samples.push(sample)
      break
    }
    samples.push(sample)
    await delay(lock.probe.lifecyclePollMilliseconds)
  }
  const logAfter = await stat(instance.stderrPath)
  const logText = await readFile(instance.stderrPath, 'utf8')
  const characterization = characterizeInterruption({
    clientResult,
    processSurvived: await serverIdentityMatches(instance),
    samples,
    interruptedAtMilliseconds: clientSettledAt - startedEpoch,
  })
  if (
    characterization.inferenceAfterClientInterruption !== 'continued' ||
    !characterization.gpuReturnedToIdleWindow ||
    characterization.activeObservationSpanMilliseconds < 500
  ) {
    throw new Error(`${mode} lifecycle assumptions changed; refusing to emit evidence`)
  }
  return {
    mode,
    configuredLongRequest: long,
    clientSettledMilliseconds: clientSettledAt - startedEpoch,
    observationMilliseconds: samples.at(-1).elapsedMilliseconds,
    sampleCount: samples.length,
    peakGpuUtilizationPercent: Math.max(...samples.map((sample) => sample.gpuUtilizationPercent)),
    logLifecycle: {
      bytesBefore: logBefore.size,
      bytesAfter: logAfter.size,
      handlerLogOccurrences: logText.match(/handle_audio_speech/gu)?.length ?? 0,
      completionMarkerAvailable: false,
    },
    ...characterization,
  }
}

async function probeLoopbackOnly() {
  const listeners = parseExactPortListeners(command('ss', ['-H', '-ltnp']), lock.server.port)
  if (
    listeners.length === 0 ||
    listeners.some(
      (listener) =>
        listener.state !== 'LISTEN' ||
        listener.localEndpoint !== `${lock.server.host}:${lock.server.port}`,
    )
  ) {
    throw new Error('configured port has a non-loopback or unexpected listener')
  }
  const addresses = JSON.parse(command('ip', ['-j', 'address', 'show', 'scope', 'global']))
    .flatMap((item) => item.addr_info ?? [])
    .filter((item) => item.local && item.local !== '127.0.0.1' && item.local !== '::1')
  if (addresses.length === 0)
    throw new Error('no non-loopback address is available for isolation proof')
  const attempts = []
  for (const address of addresses) {
    const connected = await canConnect(address.local, lock.server.port)
    attempts.push({ family: address.family, connected })
    if (connected) throw new Error('TTS listener was reachable through a non-loopback address')
  }
  return {
    exactPortListenerCount: listeners.length,
    exactPortListeners: listeners,
    nonLoopbackAttemptCount: attempts.length,
    addressFamilies: [...new Set(attempts.map((attempt) => attempt.family))],
    allNonLoopbackConnectionsFailed: attempts.every((attempt) => !attempt.connected),
  }
}

async function canConnect(host, port) {
  return await new Promise((resolvePromise) => {
    const socket = createConnection({ host, port })
    let settled = false
    const finish = (connected) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolvePromise(connected)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(750, () => finish(false))
  })
}

async function loadBuildManifest(sourceIdentity) {
  const entries = (await readdir(buildLogBase, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse()
  for (const entry of entries) {
    const directory = join(buildLogBase, entry)
    const path = join(directory, 'manifest.json')
    if (!(await exists(path))) continue
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    if (manifest.sourceIdentity === sourceIdentity) return { directory, manifest }
  }
  throw new Error('no build manifest exists for the committed harness source identity')
}

async function validateBuildProvenance(sourceIdentity) {
  const loaded = await loadBuildManifest(sourceIdentity)
  const { directory, manifest } = loaded
  const source = join(runtimeRoot, 'source')
  const expectedRemote = lock.runtime.repository
  const sourceRevision = command('git', ['-C', source, 'rev-parse', 'HEAD'])
  const sourceTree = command('git', ['-C', source, 'rev-parse', 'HEAD^{tree}'])
  const sourceRemote = command('git', ['-C', source, 'remote', 'get-url', 'origin'])
  const sourceStatus = command('git', ['-C', source, 'status', '--porcelain'])
  const currentBinaryHashes = {
    'voxcpm2-cli': await sha256File(cli),
    'llama-tts-server': await sha256File(server),
  }
  const cmakeCacheSha256 = await sha256File(join(runtimeRoot, 'build/CMakeCache.txt'))
  const buildMetadataSha256 = await sha256File(join(directory, 'build-metadata.txt'))
  if (
    manifest.schemaVersion !== 2 ||
    !manifest.cleanBuild ||
    manifest.sourceIdentity !== sourceIdentity ||
    manifest.runtimeSource?.revision !== lock.runtime.revision ||
    manifest.runtimeSource?.tree !== sourceTree ||
    sourceRevision !== lock.runtime.revision ||
    sourceRemote !== expectedRemote ||
    sourceStatus !== '' ||
    manifest.configuration?.cuda !== true ||
    manifest.configuration?.cudaArchitecture !== lock.build.cudaArchitecture ||
    manifest.configuration?.cmakeCacheSha256 !== cmakeCacheSha256 ||
    manifest.configuration?.buildMetadataSha256 !== buildMetadataSha256 ||
    manifest.binaries?.['voxcpm2-cli'] !== currentBinaryHashes['voxcpm2-cli'] ||
    manifest.binaries?.['llama-tts-server'] !== currentBinaryHashes['llama-tts-server']
  ) {
    throw new Error('runtime source, clean build manifest, or current binaries do not match')
  }
  return { manifest, currentBinaryHashes }
}

async function listArtifactHashes(root) {
  const output = {}
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else output[relative(root, path)] = await sha256File(path)
    }
  }
  await walk(root)
  return output
}

async function writeRunManifest(status, details = {}) {
  if (!artifacts) return
  const name = status === 'pass' ? 'manifest.json' : 'failure-manifest.json'
  const path = join(artifacts.rawRoot, name)
  if (await exists(path)) return
  const manifest = {
    schemaVersion: 1,
    runId: artifacts.runId,
    sourceIdentity: artifacts.sourceIdentity,
    status,
    startedAt: artifacts.startedAt,
    finishedAt: new Date().toISOString(),
    audioArtifacts: await listArtifactHashes(artifacts.audioRoot),
    rawArtifacts: await listArtifactHashes(artifacts.rawRoot),
    ...details,
  }
  await writeNew(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

async function cleanupAll() {
  await Promise.allSettled([...ownedMonitors].map((monitor) => stopMonitor(monitor)))
  await Promise.allSettled([...ownedServers].map((instance) => cleanupServer(instance)))
}

async function main() {
  if (await exists(evidencePath)) throw new Error(`evidence output already exists: ${evidencePath}`)
  const harness = await validateHarnessRevision()
  await validateExternalRoots([runtimeRoot, modelRoot, audioBase, rawBase, buildLogBase])
  for (const path of [cli, server, baseModel, acousticModel]) {
    if (!(await exists(path))) throw new Error(`required runtime artifact is missing: ${path}`)
  }
  artifacts = await allocateArtifacts(harness.sourceIdentity)

  for (const asset of lock.ggufModel.assets) {
    const path = join(modelRoot, asset.name)
    if ((await stat(path)).size !== asset.size || (await sha256File(path)) !== asset.sha256) {
      throw new Error(`model integrity check failed: ${asset.name}`)
    }
  }
  const buildProvenance = await validateBuildProvenance(harness.sourceIdentity)
  const baselineGpu = gpuSample()
  if (baselineGpu.gpuUtilizationPercent > 5) {
    throw new Error('GPU is not idle enough for lifecycle measurements')
  }
  const cliEvidence = await runCli()

  const instance = await startServer('server')
  const monitor = await startResourceMonitor(instance.child.pid)
  const loadedSteady = {
    ramMiB: await processRamMiB(instance.child.pid),
    ...gpuSample(),
  }
  const loopback = await probeLoopbackOnly()
  const persistence = []
  const errors = []
  const parameters = []
  let responseMetadata
  const modelResponse = await fetch(`${endpoint}/v1/audio/speech/models`)
  const models = { status: modelResponse.status, body: await modelResponse.json() }

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
    const output = join(artifacts.audioRoot, `server-${String(request).padStart(2, '0')}.wav`)
    await writeNew(output, result.buffer)
    persistence.push({
      request,
      status: result.status,
      elapsedSeconds: result.elapsedSeconds,
      processIdentityPreserved: await serverIdentityMatches(instance),
      audio,
    })
    responseMetadata ??= {
      contentType: result.contentType,
      contentLength: result.contentLength,
      customGenerationHeaders: [],
      independentValidation: await independentWavValidation(output),
    }
  }
  const persistencePassed =
    persistence.length === 20 && persistence.every((item) => item.processIdentityPreserved)
  if (!persistencePassed) throw new Error('persistent process assumptions changed')

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

  const parameterCases = [
    [
      'explicit-defaults',
      { seed: 42, cfg_value: 2, temperature: 1, max_steps: 5, inference_timesteps: 2 },
    ],
    [
      'max-steps-5',
      { seed: 42, cfg_value: 2, temperature: 1, max_steps: 5, inference_timesteps: 2 },
    ],
    [
      'max-steps-10',
      { seed: 42, cfg_value: 2, temperature: 1, max_steps: 10, inference_timesteps: 2 },
    ],
    ['seed-43', { seed: 43, cfg_value: 2, temperature: 1, max_steps: 5, inference_timesteps: 2 }],
    ['cfg-1.5', { seed: 42, cfg_value: 1.5, temperature: 1, max_steps: 5, inference_timesteps: 2 }],
    [
      'temperature-0.8',
      { seed: 42, cfg_value: 2, temperature: 0.8, max_steps: 5, inference_timesteps: 2 },
    ],
    [
      'timesteps-4',
      { seed: 42, cfg_value: 2, temperature: 1, max_steps: 5, inference_timesteps: 4 },
    ],
    [
      'model-alias',
      {
        model: 'voxcpm',
        seed: 42,
        cfg_value: 2,
        temperature: 1,
        max_steps: 5,
        inference_timesteps: 2,
      },
    ],
    [
      'unknown-field',
      { speed: 9, seed: 42, cfg_value: 2, temperature: 1, max_steps: 5, inference_timesteps: 2 },
    ],
    ['server-defaults', {}],
    [
      'wrong-types-defaulted',
      {
        seed: 'bad',
        cfg_value: 'bad',
        temperature: 'bad',
        max_steps: 'bad',
        inference_timesteps: 'bad',
      },
    ],
    ['pcm', { response_format: 'pcm', seed: 42, max_steps: 5, inference_timesteps: 2 }],
  ]
  for (const [name, fields] of parameterCases) {
    const result = await speech({ input: 'A calm synthetic phrase.', ...fields })
    const item = {
      name,
      status: result.status,
      contentType: result.contentType,
      bytes: result.buffer.length,
      sha256: sha256(result.buffer),
    }
    if (result.contentType?.startsWith('audio/wav')) {
      item.audio = requireVoxCpm2PcmWav(result.buffer)
    }
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
  const syntheticReference = (await readFile(join(artifacts.audioRoot, 'cli-basic.wav'))).toString(
    'base64',
  )
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
    sha256: sha256(clone.buffer),
    audio: requireVoxCpm2PcmWav(clone.buffer),
    referenceProvenance: 'VoxCPM2 CLI-generated synthetic audio; no human recording',
  })
  const parameterEffects = deriveParameterEffects(parameters)

  const longControl = await speech({
    input: 'A deliberately long synthetic control lifecycle measurement.',
    max_steps: lock.probe.longRequest.maxSteps,
    inference_timesteps: lock.probe.longRequest.inferenceTimesteps,
    seed: 7000,
  })
  const longControlAudio = requireVoxCpm2PcmWav(longControl.buffer)
  if (longControl.elapsedSeconds <= 1 || longControlAudio.durationSeconds < 10) {
    throw new Error('long control request was not long enough for lifecycle measurement')
  }
  const interruptions = [
    await observeClientInterruption(instance, 'manual-abort'),
    await observeClientInterruption(instance, 'client-deadline'),
  ]

  const boundary = {}
  for (const [name, headers] of [
    ['alternate-host-header', { host: 'local.invalid' }],
    ['browser-origin-header', { origin: 'http://local.invalid', 'sec-fetch-site': 'cross-site' }],
  ]) {
    const response = await fetch(`${endpoint}/health`, { headers })
    boundary[name] = {
      status: response.status,
      accessControlAllowOrigin: response.headers.get('access-control-allow-origin'),
    }
  }
  const afterRequestsSteady = {
    ramMiB: await processRamMiB(instance.child.pid),
    ...gpuSample(),
  }
  const modelLoadOccurrences = (await readFile(instance.stderrPath, 'utf8')).match(
    /VoxCPM2 loaded/gu,
  )?.length
  instance.exit = await stopChild(instance.child)
  await stopMonitor(monitor)
  await cleanupServer(instance)
  const resources = summarizeResourceCsv(
    await readFile(join(artifacts.rawRoot, 'server-resource.csv'), 'utf8'),
    baselineGpu.deviceVramMiB,
  )

  const timeoutInstance = await startServer('server-timeout', lock.server.timeoutTestSeconds)
  const timeoutStarted = performance.now()
  let timeoutRequest
  try {
    const result = await speech(
      {
        input: 'A deliberately long synthetic configured timeout measurement.',
        max_steps: lock.probe.longRequest.maxSteps,
        inference_timesteps: lock.probe.longRequest.inferenceTimesteps,
        seed: 7100,
      },
      { signal: AbortSignal.timeout(lock.probe.lifecycleMaximumSeconds * 1000) },
    )
    timeoutRequest = {
      clientResult: `HTTP ${result.status}`,
      elapsedSeconds: (performance.now() - timeoutStarted) / 1000,
      audio: requireVoxCpm2PcmWav(result.buffer),
    }
  } catch (error) {
    timeoutRequest = {
      clientResult: error.name,
      elapsedSeconds: (performance.now() - timeoutStarted) / 1000,
    }
  }
  const configuredTimeout = {
    configuredReadWriteTimeoutSeconds: lock.server.timeoutTestSeconds,
    ...timeoutRequest,
    processSurvived: await serverIdentityMatches(timeoutInstance),
    generationExceededConfiguredTimeout:
      timeoutRequest.elapsedSeconds > lock.server.timeoutTestSeconds + 0.5,
  }
  if (
    !configuredTimeout.processSurvived ||
    configuredTimeout.clientResult !== 'HTTP 200' ||
    !configuredTimeout.generationExceededConfiguredTimeout
  ) {
    throw new Error('configured timeout assumptions changed; refusing to emit evidence')
  }
  timeoutInstance.exit = await stopChild(timeoutInstance.child)
  await cleanupServer(timeoutInstance)

  const streamInstance = await startServer('server-stream')
  let streamClientError
  try {
    await speech(
      {
        input: 'A synthetic streaming phrase.',
        max_steps: 5,
        inference_timesteps: 2,
        seed: 42,
      },
      { path: '/v1/audio/speech/stream' },
    )
  } catch (error) {
    streamClientError = error.message
  }
  let streamExit = null
  try {
    streamExit = await waitForExit(streamInstance.child, 30_000)
  } catch {}
  const streaming = deriveStreamingCharacterization({
    clientError: streamClientError,
    processExit: streamExit,
    logText: await readFile(streamInstance.stderrPath, 'utf8'),
  })
  streamInstance.exit = streamExit
  await cleanupServer(streamInstance)

  const persistenceSummary = {
    ...summarizeRequests(persistence),
    processIdentityPreservedForEveryRequest: persistencePassed,
    modelLoadedOnce: modelLoadOccurrences === 1,
    requests: persistence,
  }
  if (!persistenceSummary.modelLoadedOnce) throw new Error('model reload assumptions changed')
  const decision = deriveDecision({
    persistencePassed,
    streaming,
    interruptions,
    configuredTimeout,
  })

  const memTotalKiB = Number(
    (await readFile('/proc/meminfo', 'utf8')).match(/^MemTotal:\s+([0-9]+)/mu)?.[1],
  )
  const [gpuName, gpuMemoryTotalMiB, gpuDriver] = command('nvidia-smi', [
    '--query-gpu=name,memory.total,driver_version',
    '--format=csv,noheader,nounits',
  ])
    .split(',')
    .map((value) => value.trim())
  const evidence = {
    evidenceSchemaVersion: 2,
    probeVersion: 2,
    capturedAt: new Date().toISOString(),
    run: {
      runId: artifacts.runId,
      sourceIdentity: harness.sourceIdentity,
      immutableExternalRunDirectories: true,
    },
    provenance: {
      generatedFromCommit: harness.commit,
      sourceHashes: harness.hashes,
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
        baselineUsedMiB: baselineGpu.deviceVramMiB,
      },
    },
    reproduction: {
      commands: [
        'VOXCPM2_CLEAN_BUILD=1 pnpm voxcpm2:setup',
        `pnpm voxcpm2:probe -- --output ${evidencePath.replace(repositoryRoot, '.').replaceAll('\\', '/')}`,
      ],
      privateInputsUsed: false,
      syntheticInputsOnly: true,
    },
    isolation: {
      filesystem: 'ext4',
      artifactsOutsideGit: true,
      ttsAndBrainDirectoriesSeparate: true,
      configuredEndpoint: endpoint,
      ...loopback,
    },
    build: {
      status: 'pass',
      cuda: true,
      cudaArchitecture: lock.build.cudaArchitecture,
      nvcc: command(join(cudaHome, 'bin/nvcc'), ['--version']).split('\n').at(-1),
      manifest: buildProvenance.manifest,
      currentBinaryHashes: buildProvenance.currentBinaryHashes,
    },
    cli: cliEvidence,
    server: {
      status: 'pass-non-streaming',
      configuredTimeoutSeconds: lock.server.timeoutSeconds,
      loadSeconds: instance.loadSeconds,
      health: instance.health,
      models,
      gracefulExit: instance.exit,
      persistence: persistenceSummary,
      responseMetadata,
      resources: { ...resources, loadedSteady, afterRequestsSteady },
      errors,
      parameters,
      parameterEffects,
      longControl: {
        elapsedSeconds: longControl.elapsedSeconds,
        audio: longControlAudio,
      },
      interruptionLifecycle: interruptions,
      configuredTimeout,
      boundary,
      streaming,
    },
    limitations: [
      'Measured streaming request aborted the process.',
      'Measured GPU activity continued after client cancellation and deadline; eventual completion versus internal stop was not observable.',
      'Configured server read/write timeout did not act as a total generation deadline.',
      'Invalid client requests use HTTP 500 and parameter type errors fall back silently.',
      'The caller must serialize this experimental non-streaming endpoint.',
    ],
    decision,
    issue8Gate: decision.experimentalMode,
    productionMilestoneUnblocked: false,
    redaction: {
      absolutePaths: 'omitted',
      processIds: 'omitted',
      privateTextOrHumanReferenceAudio: 'not used',
    },
  }

  await writeRunManifest('pass', {
    evidenceSummary: {
      decision: decision.result,
      evidenceSchemaVersion: evidence.evidenceSchemaVersion,
    },
  })
  await writeNew(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(`Wrote sanitized VoxCPM2 evidence for run ${artifacts.runId}`)
}

try {
  await main()
} catch (error) {
  await cleanupAll()
  try {
    await writeRunManifest('failed', { error: error.message })
  } catch {}
  throw error
} finally {
  await cleanupAll()
}
