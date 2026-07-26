import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  characterizeInterruption,
  createPcmWav,
  deriveDecision,
  deriveParameterEffects,
  deriveSourceIdentity,
  deriveStreamingCharacterization,
  loadLock,
  parseExactPortListeners,
  parseWav,
  requireVoxCpm2PcmWav,
  sha256,
  summarizeRequests,
  summarizeResourceCsv,
  validateLifecycleTimeline,
} from '../voxcpm2/core.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const fixtures = join(root, 'tests/fixtures/voxcpm2')

let fixtureServer
let fixtureEndpoint

before(async () => {
  const health = await readFile(join(fixtures, 'health.json'))
  const models = await readFile(join(fixtures, 'models.json'))
  fixtureServer = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(health)
      return
    }
    if (request.method === 'GET' && request.url === '/v1/audio/speech/models') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(models)
      return
    }
    if (request.method === 'POST' && request.url === '/v1/audio/speech') {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => {
        body += chunk
      })
      request.on('end', () => {
        const input = JSON.parse(body).input
        if (typeof input !== 'string' || input.length === 0) {
          response.writeHead(500, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              error: { message: '"input" is required', type: 'invalid_request_error' },
            }),
          )
          return
        }
        response.writeHead(200, { 'content-type': 'audio/wav' }).end(createPcmWav())
      })
      return
    }
    response.writeHead(404).end()
  })
  await new Promise((resolvePromise) => fixtureServer.listen(0, '127.0.0.1', resolvePromise))
  const address = fixtureServer.address()
  fixtureEndpoint = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await new Promise((resolvePromise) => fixtureServer.close(resolvePromise))
})

test('the lock pins immutable inputs and lifecycle settings', async () => {
  const lock = await loadLock(join(root, 'config/voxcpm2-spike.lock.json'))
  assert.equal(lock.runtime.revision, '74699a53df6ca0f4947ff37066f851532c20b12d')
  assert.equal(lock.runtime.license, 'MIT')
  assert.equal(lock.officialModel.license, 'Apache-2.0')
  assert.deepEqual(
    lock.ggufModel.assets.map((asset) => asset.name),
    ['VoxCPM2-BaseLM-Q8_0.gguf', 'VoxCPM2-Acoustic-F16.gguf'],
  )
  assert.equal(lock.server.host, '127.0.0.1')
  assert.equal(lock.server.port, 8081)
  assert.ok(lock.server.timeoutTestSeconds < lock.server.timeoutSeconds)
  assert.ok(lock.probe.longRequest.maxSteps >= 100)
  assert.ok(lock.probe.maximumBaselineVramMiB <= 1024)
})

test('strict WAV validation accepts a complete canonical response', () => {
  const wav = createPcmWav({ frames: 9600 })
  const info = requireVoxCpm2PcmWav(wav)
  assert.deepEqual(info, {
    container: 'RIFF/WAVE',
    declaredRiffSize: 19236,
    encoding: 'PCM',
    channels: 1,
    sampleRateHz: 48000,
    byteRate: 96000,
    blockAlign: 2,
    bitsPerSample: 16,
    frames: 9600,
    durationSeconds: 0.2,
    bytes: 19244,
    dataOffset: 44,
    dataDeclaredSize: 19200,
    sha256: info.sha256,
  })
})

test('strict WAV validation rejects adversarial length and PCM metadata', () => {
  const mutate = (offset, value, method = 'writeUInt32LE') => {
    const wav = Buffer.from(createPcmWav())
    wav[method](value, offset)
    return wav
  }
  assert.throws(() => parseWav(createPcmWav().subarray(0, -1)), /RIFF length/u)
  assert.throws(() => parseWav(mutate(4, 1)), /RIFF length/u)
  assert.throws(() => parseWav(mutate(20, 3, 'writeUInt16LE')), /not PCM/u)
  assert.throws(() => parseWav(mutate(28, 1)), /byte rate/u)
  assert.throws(() => parseWav(mutate(32, 4, 'writeUInt16LE')), /block align/u)
  assert.throws(() => parseWav(mutate(40, 999999)), /truncated WAV data/u)

  const trailing = Buffer.concat([createPcmWav(), Buffer.from([0, 0])])
  trailing.writeUInt32LE(trailing.length - 8, 4)
  assert.throws(() => parseWav(trailing), /trailing bytes/u)

  const partial = createPcmWav({ frames: 1 }).subarray(0, 45)
  partial.writeUInt32LE(partial.length - 8, 4)
  partial.writeUInt32LE(1, 40)
  assert.throws(() => parseWav(partial), /partial frame/u)
})

test('streaming placeholder lengths require explicit inspection mode', () => {
  const wav = createPcmWav()
  wav.writeUInt32LE(0x7fffffff, 4)
  wav.writeUInt32LE(0x7fffffff, 40)
  assert.throws(() => parseWav(wav), /RIFF length/u)
  const inspected = parseWav(wav, { allowUnknownStreamingLength: true })
  assert.equal(inspected.dataDeclaredSize, 0x7fffffff)
  assert.equal(inspected.frames, 4800)
})

test('request summaries reject invalid audio durations', () => {
  assert.throws(
    () => summarizeRequests([{ elapsedSeconds: 1, audio: { durationSeconds: 0 } }]),
    /positive audio duration/u,
  )
})

test('portable resource fixtures report peak and last observations', async () => {
  const summary = summarizeResourceCsv(await readFile(join(fixtures, 'resource.csv'), 'utf8'), 600)
  assert.deepEqual(summary, {
    sampleCount: 3,
    peakRamMiB: 1024,
    lastObservedRamMiB: 768,
    peakDeviceVramMiB: 5700,
    peakIncrementalVramMiB: 5100,
    lastObservedDeviceVramMiB: 5500,
    peakGpuUtilizationPercent: 100,
  })
})

test('source identity is stable, ordered, and changes with a source hash', () => {
  const one = '1'.repeat(64)
  const two = '2'.repeat(64)
  assert.equal(
    deriveSourceIdentity({ shell: two, config: one }),
    deriveSourceIdentity({ config: one, shell: two }),
  )
  assert.notEqual(
    deriveSourceIdentity({ config: one, shell: two }),
    deriveSourceIdentity({ config: one, shell: '3'.repeat(64) }),
  )
})

test('source identity orders names by code point, not locale (#63)', () => {
  const hyphen = 'a'.repeat(64)
  const underscore = 'b'.repeat(64)
  // 'typing-inspection' (- U+002D) < 'typing_extensions' (_ U+005F) by code point; on this Node
  // 'typing-inspection'.localeCompare('typing_extensions') === 1, so localeCompare reverses them.
  // A locale-dependent identity would hash these in the wrong order; assert the code-point order.
  const expected = sha256(`typing-inspection:${hyphen}\ntyping_extensions:${underscore}\n`)
  assert.equal(
    deriveSourceIdentity({ 'typing-inspection': hyphen, typing_extensions: underscore }),
    expected,
  )
})

test('exact-port listener parsing exposes every matching listener', () => {
  const output = [
    'LISTEN 0 5 127.0.0.1:8081 0.0.0.0:* users:(("fixture",pid=1,fd=2))',
    'LISTEN 0 5 0.0.0.0:8080 0.0.0.0:* users:(("other",pid=2,fd=3))',
    'LISTEN 0 5 [::1]:8081 [::]:* users:(("fixture",pid=1,fd=4))',
  ].join('\n')
  assert.deepEqual(parseExactPortListeners(output, 8081), [
    { state: 'LISTEN', localEndpoint: '127.0.0.1:8081', peerEndpoint: '0.0.0.0:*' },
    { state: 'LISTEN', localEndpoint: '[::1]:8081', peerEndpoint: '[::]:*' },
  ])
})

test('monotonic lifecycle timelines enforce order and the complete sampled idle window', () => {
  const timeline = validateLifecycleTimeline(
    [
      { elapsedMilliseconds: 100, gpuUtilizationPercent: 80 },
      { elapsedMilliseconds: 320, gpuUtilizationPercent: 0 },
      { elapsedMilliseconds: 540, gpuUtilizationPercent: 0 },
      { elapsedMilliseconds: 760, gpuUtilizationPercent: 0, settledWindow: true },
    ],
    { idleSamples: 4, pollMilliseconds: 200 },
  )
  assert.equal(timeline.clock, 'performance.now monotonic')
  assert.equal(timeline.observedIdleWindowMilliseconds, 660)
  assert.equal(timeline.minimumIdleWindowMilliseconds, 600)

  for (const secondElapsed of [100, 99]) {
    assert.throws(
      () =>
        validateLifecycleTimeline(
          [
            { elapsedMilliseconds: 100, gpuUtilizationPercent: 80 },
            {
              elapsedMilliseconds: secondElapsed,
              gpuUtilizationPercent: 0,
              settledWindow: true,
            },
          ],
          { idleSamples: 2, pollMilliseconds: 1 },
        ),
      /not strictly increasing/u,
    )
  }
  assert.throws(
    () =>
      validateLifecycleTimeline(
        [
          { elapsedMilliseconds: 100, gpuUtilizationPercent: 80 },
          { elapsedMilliseconds: 250, gpuUtilizationPercent: 0, settledWindow: true },
        ],
        { idleSamples: 2, pollMilliseconds: 200 },
      ),
    /idle window is shorter/u,
  )
})

test('interruption, parameters, streaming, and decision are derived from checks', () => {
  const interruption = characterizeInterruption({
    clientResult: 'AbortError',
    processSurvived: true,
    interruptedAtMilliseconds: 250,
    samples: [
      { elapsedMilliseconds: 300, gpuUtilizationPercent: 80 },
      { elapsedMilliseconds: 1000, gpuUtilizationPercent: 70 },
      { elapsedMilliseconds: 2000, gpuUtilizationPercent: 0, settledWindow: true },
    ],
  })
  assert.equal(interruption.inferenceAfterClientInterruption, 'continued')
  assert.match(interruption.eventualInferenceOutcome, /not observable/u)

  const wav = (durationSeconds, hash) => ({ durationSeconds, sha256: hash })
  const baseline = { status: 200, sha256: 'a', audio: wav(0.8, 'a') }
  const parameters = [
    ['explicit-defaults', baseline],
    ['max-steps-5', baseline],
    ['max-steps-10', { status: 200, sha256: 'b', audio: wav(1.6, 'b') }],
    ['seed-43', { status: 200, sha256: 'c', audio: wav(0.8, 'c') }],
    ['cfg-1.5', { status: 200, sha256: 'd', audio: wav(0.8, 'd') }],
    ['temperature-0.8', { status: 200, sha256: 'e', audio: wav(0.8, 'e') }],
    ['timesteps-4', { status: 200, sha256: 'f', audio: wav(0.8, 'f') }],
    ['model-alias', baseline],
    ['unknown-field', baseline],
    ['server-defaults', { status: 200, sha256: 'g', audio: wav(2.4, 'g') }],
    ['wrong-types-defaulted', { status: 200, sha256: 'g', audio: wav(2.4, 'g') }],
    ['pcm', { status: 200, contentType: 'audio/pcm', sha256: 'h' }],
    ['synthetic-reference-audio', { status: 200, sha256: 'i', audio: wav(0.8, 'i') }],
  ].map(([name, value]) => ({ name, ...value }))
  assert.ok(Object.values(deriveParameterEffects(parameters)).every(Boolean))

  const streaming = deriveStreamingCharacterization({
    clientError: 'terminated',
    processExit: { code: null, signal: 'SIGABRT' },
    logText: 'GGML_ASSERT(lp0 <= x->ne[0]) failed',
  })
  assert.equal(streaming.processSurvived, false)
  const decision = deriveDecision({
    persistencePassed: true,
    streaming,
    interruptions: [interruption],
    configuredTimeout: { generationExceededConfiguredTimeout: true },
  })
  assert.equal(decision.result, 'NO-GO for production SpeechEngine/M2')
  assert.match(decision.experimentalMode, /Issue #8 may proceed only/u)
})

test('derivation refuses changed measured assumptions', () => {
  assert.throws(
    () =>
      deriveStreamingCharacterization({
        clientError: null,
        processExit: null,
        logText: '',
      }),
    /assumptions changed/u,
  )
  assert.throws(
    () =>
      deriveDecision({
        persistencePassed: true,
        streaming: { crashedWithSigabrt: false },
        interruptions: [],
        configuredTimeout: { generationExceededConfiguredTimeout: false },
      }),
    /NO-GO assumptions changed/u,
  )
})

test('portable HTTP fixture handles 20 requests without models or private inputs', async () => {
  const health = await fetch(`${fixtureEndpoint}/health`)
  assert.deepEqual(await health.json(), { engine: 'voxcpm2', status: 'ok' })
  const requests = []
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now()
    const response = await fetch(`${fixtureEndpoint}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: `Public synthetic fixture ${index}.` }),
    })
    assert.equal(response.status, 200)
    requests.push({
      elapsedSeconds: (performance.now() - started) / 1000,
      audio: requireVoxCpm2PcmWav(Buffer.from(await response.arrayBuffer())),
    })
  }
  assert.equal(summarizeRequests(requests).count, 20)
})

test('operational harness validates roots before creating them and uses immutable run paths', async () => {
  const shell = await readFile(join(root, 'scripts/voxcpm2-spike.sh'), 'utf8')
  const probe = await readFile(join(root, 'scripts/probe-voxcpm2.mjs'), 'utf8')
  const validation = shell.indexOf('validate_isolated_ext4_paths')
  const firstCreation = shell.indexOf('mkdir -p -- "$base"')
  assert.ok(validation >= 0 && firstCreation > validation)
  assert.match(shell, /existing_ancestor/u)
  assert.match(shell, /TTS artifact roots overlap/u)
  assert.match(shell, /runs\/\$source_identity/u)
  assert.match(shell, /VOXCPM2_CLEAN_BUILD/u)
  assert.match(shell, /CMAKE_CUDA_COMPILER/u)
  assert.match(shell, /server is not linked to the CUDA backend/u)
  assert.match(probe, /flag: 'wx'/u)
  assert.match(probe, /sourceIdentity/u)
  assert.match(probe, /validateBuildProvenance/u)
  assert.match(probe, /maximumBaselineVramMiB/u)
  assert.match(probe, /failure-manifest\.json/u)
  assert.doesNotMatch(`${shell}\n${probe}`, /0\.0\.0\.0.*--host/u)
})
