import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  analyzePcm16Wav,
  createManualReview,
  deriveObjectiveReview,
  directoryTreeHash,
  loadBootstrapLock,
  stableJsonHash,
} from './synthetic-voices/core.mjs'
import {
  deriveSourceIdentity,
  loadLock as loadVoxLock,
  parseExactPortListeners,
  requireVoxCpm2PcmWav,
  sha256,
  sha256File,
} from './voxcpm2/core.mjs'

const probePath = fileURLToPath(import.meta.url)
const repositoryRoot = resolve(dirname(probePath), '..')
const lockPath = join(repositoryRoot, 'config/synthetic-voice-bootstrap.lock.json')
const voxLockPath = join(repositoryRoot, 'config/voxcpm2-spike.lock.json')
const corePath = join(repositoryRoot, 'scripts/synthetic-voices/core.mjs')
const voxCorePath = join(repositoryRoot, 'scripts/voxcpm2/core.mjs')
const shellPath = join(repositoryRoot, 'scripts/synthetic-voice-bootstrap.sh')
const lock = await loadBootstrapLock(lockPath)
const voxLock = await loadVoxLock(voxLockPath)
const outputIndex = process.argv.indexOf('--output')
const evidencePath =
  outputIndex >= 0
    ? resolve(process.argv[outputIndex + 1])
    : join(repositoryRoot, 'docs/evidence/issue-8-synthetic-voices-wsl2.json')
const espeakInstallRoot = requiredPath('SYNTH_VOICE_ESPEAK_INSTALL_ROOT')
const espeakSourceRoot = requiredPath('SYNTH_VOICE_ESPEAK_SOURCE_ROOT')
const audioBase = requiredPath('SYNTH_VOICE_AUDIO_BASE')
const rawBase = requiredPath('SYNTH_VOICE_RAW_BASE')
const expectedSourceIdentity = requiredValue('SYNTH_VOICE_SOURCE_IDENTITY')
const runtimeRoot = requiredPath('VOXCPM2_RUNTIME_ROOT')
const modelRoot = requiredPath('VOXCPM2_MODEL_ROOT')
const espeak = join(espeakInstallRoot, 'bin/espeak-ng')
const server = join(runtimeRoot, 'build/bin/llama-tts-server')
const baseModel = join(modelRoot, voxLock.ggufModel.assets[0].name)
const acousticModel = join(modelRoot, voxLock.ggufModel.assets[1].name)
const endpoint = `http://${voxLock.server.host}:${voxLock.server.port}`
const cudaHome = process.env.CUDA_HOME ?? '/usr/local/cuda'
const runtimeEnvironment = {
  ...process.env,
  PATH: `${cudaHome}/bin:${process.env.PATH}`,
  LD_LIBRARY_PATH: `${cudaHome}/lib64${process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : ''}`,
}
let artifacts
let serverInstance
let inFlight = 0
let maximumInFlight = 0
let requestSequence = 0

function requiredValue(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required; use synthetic-voice-bootstrap.sh`)
  return value
}

function requiredPath(name) {
  return resolve(requiredValue(name))
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function command(name, args, options = {}) {
  const result = spawnSync(name, args, { encoding: 'utf8', env: runtimeEnvironment, ...options })
  if (result.status !== 0) throw new Error(`${name} failed: ${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

async function writeNew(path, data) {
  await writeFile(path, data, { flag: 'wx' })
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

function containsPath(parent, child) {
  const value = relative(parent, child)
  return value === '' || (!value.startsWith('..') && !value.startsWith('/'))
}

async function validateExternalRoots(paths) {
  const canonicalRepository = await realpath(repositoryRoot)
  const canonical = []
  for (const path of paths) {
    const target = command('realpath', ['-m', path])
    const ancestor = await existingAncestor(path)
    if (containsPath(canonicalRepository, target) || containsPath(target, canonicalRepository)) {
      throw new Error('external artifact root overlaps Git')
    }
    if (command('findmnt', ['-n', '-o', 'FSTYPE', '-T', ancestor]) !== 'ext4') {
      throw new Error('external artifact root is not ext4')
    }
    canonical.push(target)
  }
  for (let left = 0; left < canonical.length; left += 1) {
    for (let right = left + 1; right < canonical.length; right += 1) {
      if (
        containsPath(canonical[left], canonical[right]) ||
        containsPath(canonical[right], canonical[left])
      ) {
        throw new Error('external artifact roots overlap')
      }
    }
  }
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
    config: [lockPath, 'config/synthetic-voice-bootstrap.lock.json'],
    core: [corePath, 'scripts/synthetic-voices/core.mjs'],
    probe: [probePath, 'scripts/probe-synthetic-voices.mjs'],
    shell: [shellPath, 'scripts/synthetic-voice-bootstrap.sh'],
    voxConfig: [voxLockPath, 'config/voxcpm2-spike.lock.json'],
    voxCore: [voxCorePath, 'scripts/voxcpm2/core.mjs'],
  }
  const sourceHashes = {}
  for (const [name, [path, relativePath]] of Object.entries(sourceFiles)) {
    sourceHashes[name] = await sha256File(path)
    if (sourceHashes[name] !== committedFileHash(commit, relativePath)) {
      throw new Error(`harness file differs from HEAD: ${relativePath}`)
    }
  }
  const sourceIdentity = deriveSourceIdentity(sourceHashes)
  if (sourceIdentity !== expectedSourceIdentity) throw new Error('harness source identity mismatch')
  return { generatedFromCommit: commit, sourceHashes, sourceIdentity }
}

function createRunId(sourceIdentity) {
  const timestamp = new Date().toISOString().replaceAll(/[-:.]/gu, '')
  return `bootstrap-${sourceIdentity.slice(0, 16)}-${timestamp}-${randomBytes(6).toString('hex')}`
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
        await writeNew(join(audioRoot, 'allocation-failed.txt'), `${error.message}\n`)
        continue
      }
      return { runId, audioRoot, rawRoot }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  throw new Error('could not allocate immutable experiment directories')
}

async function validateInstall() {
  const manifestPath = join(espeakInstallRoot, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const configHash = stableJsonHash(lock.espeakNg.build)
  if (
    manifest.source.revision !== lock.espeakNg.revision ||
    manifest.source.tree !== lock.espeakNg.sourceTree ||
    manifest.configuration.sha256 !== configHash ||
    manifest.voiceData.selectionSha256 !== stableJsonHash(lock.espeakNg.voiceSources)
  ) {
    throw new Error('eSpeak NG install provenance mismatch')
  }
  if ((await sha256File(espeak)) !== manifest.binary.sha256) {
    throw new Error('eSpeak NG binary hash mismatch')
  }
  if (
    (await directoryTreeHash(join(espeakInstallRoot, 'share/espeak-ng-data'))) !==
    manifest.voiceData.treeSha256
  ) {
    throw new Error('eSpeak NG installed voice-data hash mismatch')
  }
  for (const source of lock.espeakNg.voiceSources) {
    if ((await sha256File(join(espeakSourceRoot, source.path))) !== source.sha256) {
      throw new Error(`eSpeak NG voice source mismatch: ${source.path}`)
    }
  }
  const versionOutput = command(espeak, [`--path=${join(espeakInstallRoot, 'share')}`, '--version'])
  const version = versionOutput.split(/\s+Data at:/u)[0]
  if (version !== 'eSpeak NG text-to-speech: 1.52.0') {
    throw new Error('unexpected eSpeak NG version output')
  }
  return {
    manifest,
    manifestSha256: await sha256File(manifestPath),
    binarySha256: await sha256File(espeak),
    version,
  }
}

async function validateVoxAssets() {
  if ((await sha256File(voxLockPath)) !== lock.voxcpm2.lockSha256) {
    throw new Error('issue #7 VoxCPM2 lock changed')
  }
  for (const asset of voxLock.ggufModel.assets) {
    const path = join(modelRoot, asset.name)
    if ((await stat(path)).size !== asset.size || (await sha256File(path)) !== asset.sha256) {
      throw new Error(`VoxCPM2 model mismatch: ${asset.name}`)
    }
  }
  return {
    serverBinarySha256: await sha256File(server),
    modelAssets: voxLock.ggufModel.assets,
  }
}

function sampleGpu() {
  const output = command('nvidia-smi', [
    '--query-gpu=memory.used,utilization.gpu',
    '--format=csv,noheader,nounits',
  ])
  const [memoryUsedMiB, utilizationPercent] = output.split(',').map((value) => Number(value.trim()))
  if (!Number.isFinite(memoryUsedMiB) || !Number.isFinite(utilizationPercent)) {
    throw new Error('invalid GPU sample')
  }
  return { memoryUsedMiB, utilizationPercent }
}

async function generateReferences() {
  const referencesRoot = join(artifacts.audioRoot, 'references')
  await mkdir(referencesRoot)
  const files = ['reference.wav', 'reference-repeat.wav']
  const invocationFor = (candidate) => [
    `--path=${join(espeakInstallRoot, 'share')}`,
    '-v',
    candidate.voice,
    '-s',
    String(candidate.parameters.rateWordsPerMinute),
    '-p',
    String(candidate.parameters.pitch),
    '-a',
    String(candidate.parameters.amplitude),
  ]
  for (const candidate of lock.candidates) {
    await mkdir(join(referencesRoot, candidate.id))
  }
  // Separate complete passes catch variants whose process-level state changes
  // only after other voices have been generated.
  for (const file of files) {
    for (const candidate of lock.candidates) {
      const target = join(referencesRoot, candidate.id, file)
      if (Buffer.byteLength(target) >= 150) {
        throw new Error('eSpeak NG output path exceeds the safe upstream fixed-buffer limit')
      }
      const result = spawnSync(
        espeak,
        [...invocationFor(candidate), '-w', target, candidate.transcript],
        { encoding: 'utf8', env: runtimeEnvironment },
      )
      if (result.status !== 0)
        throw new Error(`eSpeak NG reference generation failed: ${candidate.id}`)
      if (!(await exists(target)))
        throw new Error(`eSpeak NG did not create reference: ${candidate.id}`)
    }
  }
  const references = []
  for (const candidate of lock.candidates) {
    const candidateRoot = join(referencesRoot, candidate.id)
    const primary = await readFile(join(candidateRoot, files[0]))
    const repeated = await readFile(join(candidateRoot, files[1]))
    const invocation = invocationFor(candidate)
    references.push({
      candidateId: candidate.id,
      role: candidate.role,
      voice: candidate.voice,
      transcript: candidate.transcript,
      transcriptSha256: candidate.transcriptSha256,
      seed: candidate.seed,
      parameters: candidate.parameters,
      invocation: [
        'espeak-ng',
        '--path=<external-espeak-data-parent>',
        ...invocation.slice(1),
        '-w',
        '<new-output>',
        '<exact-transcript>',
      ],
      repeatMethod: 'two process-isolated, candidate-separated generation passes',
      file: `references/${candidate.id}/${files[0]}`,
      repeatFile: `references/${candidate.id}/${files[1]}`,
      sha256: sha256(primary),
      repeatSha256: sha256(repeated),
      analysis: analyzePcm16Wav(primary),
    })
  }
  return references
}

async function portIsFree(host, port) {
  return await new Promise((resolvePromise) => {
    const socket = createConnection({ host, port })
    socket.once('connect', () => {
      socket.destroy()
      resolvePromise(false)
    })
    socket.once('error', () => resolvePromise(true))
    socket.setTimeout(500, () => {
      socket.destroy()
      resolvePromise(true)
    })
  })
}

async function waitForExit(child, milliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode }
  }
  return await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error('process stop deadline exceeded')),
      milliseconds,
    )
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolvePromise({ code, signal })
    })
  })
}

async function waitForStreamOpen(stream) {
  if (typeof stream.fd === 'number') return
  await new Promise((resolvePromise, reject) => {
    stream.once('open', resolvePromise)
    stream.once('error', reject)
  })
}

async function closeStream(stream) {
  if (!stream || stream.closed) return
  await new Promise((resolvePromise) => stream.end(resolvePromise))
}

async function stopServer() {
  if (!serverInstance) return null
  const instance = serverInstance
  serverInstance = null
  let exit
  if (instance.child.exitCode === null && instance.child.signalCode === null) {
    instance.child.kill('SIGTERM')
    try {
      exit = await waitForExit(instance.child, 10_000)
    } catch (error) {
      instance.child.kill('SIGKILL')
      await waitForExit(instance.child, 5_000)
      throw error
    }
  } else {
    exit = await waitForExit(instance.child, 1)
  }
  await Promise.all([closeStream(instance.stdout), closeStream(instance.stderr)])
  return exit
}

async function startServer() {
  if (!(await portIsFree(voxLock.server.host, voxLock.server.port))) {
    throw new Error('configured VoxCPM2 port is occupied')
  }
  const stdoutPath = join(artifacts.rawRoot, 'server.stdout.log')
  const stderrPath = join(artifacts.rawRoot, 'server.stderr.log')
  const stdout = createWriteStream(stdoutPath, { flags: 'wx' })
  const stderr = createWriteStream(stderrPath, { flags: 'wx' })
  await Promise.all([waitForStreamOpen(stdout), waitForStreamOpen(stderr)])
  const args = [
    '--host',
    voxLock.server.host,
    '--port',
    String(voxLock.server.port),
    '--threads-http',
    String(voxLock.server.threadsHttp),
    '--timeout',
    String(voxLock.server.timeoutSeconds),
    '--voxcpm2-base-lm',
    baseModel,
    '--voxcpm2-acoustic',
    acousticModel,
    '--voxcpm2-n-gpu-layers',
    '-1',
  ]
  const started = performance.now()
  const child = spawn(server, args, { env: runtimeEnvironment, stdio: ['ignore', stdout, stderr] })
  serverInstance = { child, stdout, stderr, stdoutPath, stderrPath }
  let spawnError
  child.once('error', (error) => {
    spawnError = error
  })
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (spawnError) throw spawnError
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error('VoxCPM2 server exited during load')
    try {
      const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(500) })
      if (response.ok) {
        const health = await response.json()
        const startTimeTicks = (await readFile(`/proc/${child.pid}/stat`, 'utf8')).split(' ')[21]
        return { health, loadSeconds: (performance.now() - started) / 1000, startTimeTicks }
      }
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  throw new Error('VoxCPM2 server did not become healthy')
}

async function processIdentityMatches(startTimeTicks) {
  if (
    !serverInstance ||
    serverInstance.child.exitCode !== null ||
    serverInstance.child.signalCode !== null
  )
    return false
  try {
    return (
      (await readFile(`/proc/${serverInstance.child.pid}/stat`, 'utf8')).split(' ')[21] ===
      startTimeTicks
    )
  } catch {
    return false
  }
}

async function exactLoopbackListener() {
  const listeners = parseExactPortListeners(command('ss', ['-H', '-ltnp']), voxLock.server.port)
  if (
    listeners.length !== 1 ||
    listeners[0].state !== 'LISTEN' ||
    listeners[0].localEndpoint !== `${voxLock.server.host}:${voxLock.server.port}`
  ) {
    throw new Error('VoxCPM2 listener is not exactly one IPv4 loopback socket')
  }
  return listeners.map(({ state, localEndpoint, peerEndpoint }) => ({
    state,
    localEndpoint,
    peerEndpoint,
  }))
}

async function speech(body) {
  if (lock.voxcpm2.endpointPath !== '/v1/audio/speech')
    throw new Error('non-streaming endpoint lock changed')
  if (inFlight !== 0) throw new Error('serialized request invariant violated')
  inFlight += 1
  maximumInFlight = Math.max(maximumInFlight, inFlight)
  requestSequence += 1
  const sequence = requestSequence
  const started = performance.now()
  try {
    const response = await fetch(`${endpoint}${lock.voxcpm2.endpointPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const buffer = Buffer.from(await response.arrayBuffer())
    if (response.status !== 200)
      throw new Error(
        `VoxCPM2 request failed with HTTP ${response.status}: ${buffer.toString('utf8').slice(0, 200)}`,
      )
    return {
      sequence,
      status: response.status,
      contentType: response.headers.get('content-type'),
      elapsedSeconds: (performance.now() - started) / 1000,
      buffer,
    }
  } finally {
    inFlight -= 1
  }
}

async function generateVoxLines(references, startTimeTicks) {
  const outputsRoot = join(artifacts.audioRoot, 'outputs')
  await mkdir(outputsRoot)
  const outputs = []
  for (const reference of references) {
    const candidateRoot = join(outputsRoot, reference.candidateId)
    await mkdir(candidateRoot)
    const referenceBase64 = (await readFile(join(artifacts.audioRoot, reference.file))).toString(
      'base64',
    )
    const cases = [
      ...lock.lines.map((line) => ({ line, repetition: 0 })),
      {
        line: lock.lines.find(({ id }) => id === lock.generation.repeatLineId),
        repetition: 1,
      },
    ]
    for (const { line, repetition } of cases) {
      const body = {
        model: lock.generation.model,
        input: line.text,
        response_format: lock.generation.responseFormat,
        reference_audio: referenceBase64,
        seed: line.seed,
        cfg_value: lock.generation.cfgValue,
        temperature: lock.generation.temperature,
        inference_timesteps: lock.generation.inferenceTimesteps,
        max_steps: lock.generation.maxSteps,
      }
      const result = await speech(body)
      requireVoxCpm2PcmWav(result.buffer)
      const analysis = analyzePcm16Wav(result.buffer)
      const suffix = repetition === 0 ? '' : '-repeat'
      const file = `outputs/${reference.candidateId}/${line.id}${suffix}.wav`
      await writeNew(join(artifacts.audioRoot, file), result.buffer)
      outputs.push({
        sequence: result.sequence,
        candidateId: reference.candidateId,
        lineId: line.id,
        repetition,
        text: line.text,
        textSha256: line.textSha256,
        seed: line.seed,
        parameters: {
          model: lock.generation.model,
          responseFormat: lock.generation.responseFormat,
          cfgValue: lock.generation.cfgValue,
          temperature: lock.generation.temperature,
          inferenceTimesteps: lock.generation.inferenceTimesteps,
          maxSteps: lock.generation.maxSteps,
        },
        referenceSha256: reference.sha256,
        file,
        status: result.status,
        contentType: result.contentType,
        elapsedSeconds: result.elapsedSeconds,
        sha256: sha256(result.buffer),
        processIdentityPreserved: await processIdentityMatches(startTimeTicks),
        analysis,
      })
    }
  }
  if (maximumInFlight !== 1 || inFlight !== 0)
    throw new Error('request serialization was not preserved')
  if (outputs.some(({ processIdentityPreserved }) => !processIdentityPreserved)) {
    throw new Error('VoxCPM2 process identity changed')
  }
  return outputs
}

async function artifactFileHashes(references, outputs, manualReviewSha256) {
  return {
    references: references.flatMap((reference) => [
      { file: reference.file, sha256: reference.sha256 },
      { file: reference.repeatFile, sha256: reference.repeatSha256 },
    ]),
    outputs: outputs.map(({ file, sha256: outputSha256 }) => ({ file, sha256: outputSha256 })),
    manualReview: { file: 'manual-review.json', sha256: manualReviewSha256 },
  }
}

function sanitizedError(error) {
  return String(error?.stack ?? error)
    .replaceAll(repositoryRoot, '<repository>')
    .replaceAll(process.env.HOME ?? '', '<home>')
    .slice(0, 4000)
}

async function main() {
  if (await exists(evidencePath))
    throw new Error('evidence output already exists; overwrites are forbidden')
  await validateExternalRoots([
    espeakInstallRoot,
    espeakSourceRoot,
    audioBase,
    rawBase,
    runtimeRoot,
    modelRoot,
  ])
  const harness = await validateHarnessRevision()
  artifacts = await allocateArtifacts(harness.sourceIdentity)
  const capturedAt = new Date().toISOString()
  try {
    const espeakProvenance = await validateInstall()
    const voxProvenance = await validateVoxAssets()
    const baselineGpu = sampleGpu()
    if (
      baselineGpu.memoryUsedMiB > voxLock.probe.maximumBaselineVramMiB ||
      baselineGpu.utilizationPercent > 5
    ) {
      throw new Error('GPU is not idle and unloaded')
    }
    const references = await generateReferences()
    const startedServer = await startServer()
    const listeners = await exactLoopbackListener()
    const outputs = await generateVoxLines(references, startedServer.startTimeTicks)
    const objectiveReview = deriveObjectiveReview(lock, references, outputs)
    if (!objectiveReview.decision.result.startsWith('GO')) {
      throw new Error(`objective review failed: ${JSON.stringify(objectiveReview.checks)}`)
    }
    const manualReview = createManualReview(lock, outputs, objectiveReview)
    await writeNew(
      join(artifacts.audioRoot, 'manual-review.json'),
      `${JSON.stringify(manualReview, null, 2)}\n`,
    )
    const manualReviewSha256 = await sha256File(join(artifacts.audioRoot, 'manual-review.json'))
    const gracefulExit = await stopServer()
    if (gracefulExit.code !== 0 || gracefulExit.signal !== null)
      throw new Error('VoxCPM2 server did not stop gracefully')
    if (!(await portIsFree(voxLock.server.host, voxLock.server.port)))
      throw new Error('VoxCPM2 port remained occupied after cleanup')
    const artifactManifest = {
      schemaVersion: 1,
      runId: artifacts.runId,
      sourceIdentity: harness.sourceIdentity,
      immutable: true,
      generatedAt: capturedAt,
      files: await artifactFileHashes(references, outputs, manualReviewSha256),
    }
    await writeNew(
      join(artifacts.audioRoot, 'artifact-manifest.json'),
      `${JSON.stringify(artifactManifest, null, 2)}\n`,
    )
    const rawManifest = {
      schemaVersion: 1,
      runId: artifacts.runId,
      sourceIdentity: harness.sourceIdentity,
      immutable: true,
      logs: {
        serverStdoutSha256: await sha256File(join(artifacts.rawRoot, 'server.stdout.log')),
        serverStderrSha256: await sha256File(join(artifacts.rawRoot, 'server.stderr.log')),
      },
      serverExit: gracefulExit,
    }
    await writeNew(
      join(artifacts.rawRoot, 'manifest.json'),
      `${JSON.stringify(rawManifest, null, 2)}\n`,
    )
    const evidence = {
      evidenceSchemaVersion: 1,
      capturedAt,
      issue: 8,
      run: {
        runId: artifacts.runId,
        sourceIdentity: harness.sourceIdentity,
        immutableExternalAssetsAndManifests: true,
        artifactManifestSha256: await sha256File(
          join(artifacts.audioRoot, 'artifact-manifest.json'),
        ),
        rawManifestSha256: await sha256File(join(artifacts.rawRoot, 'manifest.json')),
      },
      provenance: {
        ...harness,
        configurationSha256: await sha256File(lockPath),
        projectAuthoredTranscriptsOnly: true,
        humanOrCopyrightedReferenceAudioUsed: false,
        espeakNg: {
          repository: lock.espeakNg.repository,
          tag: lock.espeakNg.tag,
          revision: lock.espeakNg.revision,
          sourceTree: lock.espeakNg.sourceTree,
          license: lock.espeakNg.license,
          licenseSha256: lock.espeakNg.licenseSha256,
          readmeSha256: lock.espeakNg.readmeSha256,
          voiceDocumentationSha256: lock.espeakNg.voiceDocumentationSha256,
          selectedVoiceSources: lock.espeakNg.voiceSources,
          buildConfiguration: lock.espeakNg.build,
          buildConfigurationSha256: stableJsonHash(lock.espeakNg.build),
          cmakeCacheSha256: espeakProvenance.manifest.configuration.cmakeCacheSha256,
          configureArguments: espeakProvenance.manifest.configuration.configureArguments,
          toolchain: espeakProvenance.manifest.toolchain,
          binarySha256: espeakProvenance.binarySha256,
          installManifestSha256: espeakProvenance.manifestSha256,
          installedVoiceDataTreeSha256: espeakProvenance.manifest.voiceData.treeSha256,
          selectedVoiceSourcesSha256: espeakProvenance.manifest.voiceData.selectionSha256,
          version: espeakProvenance.version,
          stochasticSeed: null,
          seedExplanation:
            'eSpeak NG formant synthesis is deterministic and exposes no seed parameter',
          mbrolaOrSampledVoiceUsed: false,
        },
        voxcpm2: {
          issue7LockSha256: lock.voxcpm2.lockSha256,
          runtimeRevision: voxLock.runtime.revision,
          serverBinarySha256: voxProvenance.serverBinarySha256,
          ggufRepository: voxLock.ggufModel.repository,
          ggufRevision: voxLock.ggufModel.revision,
          modelAssets: voxProvenance.modelAssets,
          mode: lock.voxcpm2.mode,
          endpointPath: lock.voxcpm2.endpointPath,
        },
      },
      isolation: {
        environment: 'WSL2',
        externalArtifactsOnExt4: true,
        artifactsOutsideGit: true,
        endpoint: `${voxLock.server.host}:${voxLock.server.port}`,
        exactListenerCount: listeners.length,
        listeners,
        maximumInFlightRequests: maximumInFlight,
        requestCount: outputs.length,
        allRequestsNonStreaming: true,
        gracefulServerExit: gracefulExit,
        portFreeAfterCleanup: true,
        baselineGpu,
      },
      candidates: references,
      voxcpm2Outputs: outputs,
      review: {
        objective: objectiveReview,
        manualReady: {
          status: manualReview.status,
          sha256: manualReviewSha256,
          audioAndTranscriptEntries: outputs.filter(({ repetition }) => repetition === 0).length,
          absolutePath: 'omitted',
        },
      },
      decision: objectiveReview.decision,
      limitations: [
        'Objective speech-activity, clipping, duration, pitch, and byte-repeatability checks do not establish word-level intelligibility.',
        'Transcript-aligned manual listening approval remains pending.',
        'The experiment is serialized and non-streaming only because issue #7 remains NO-GO for production SpeechEngine/M2.',
        'Synthetic formant references demonstrate technical bootstrapping, not production voice quality.',
      ],
      redaction: {
        absolutePaths: 'omitted',
        processIds: 'omitted',
        logs: 'external only',
        audio: 'external only',
        privateOrCopyrightedText: 'not used',
        humanReferenceAudio: 'not used',
      },
    }
    await mkdir(dirname(evidencePath), { recursive: true })
    await writeNew(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
    process.stdout.write(`Synthetic voice run: ${artifacts.runId}\n`)
    process.stdout.write(`Decision: ${evidence.decision.result}\n`)
  } catch (error) {
    await stopServer().catch(() => undefined)
    if (artifacts) {
      await writeNew(
        join(artifacts.rawRoot, 'failure-manifest.json'),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            runId: artifacts.runId,
            sourceIdentity: harness.sourceIdentity,
            failedAt: new Date().toISOString(),
            error: sanitizedError(error),
          },
          null,
          2,
        )}\n`,
      ).catch(() => undefined)
    }
    throw error
  }
}

await main()
