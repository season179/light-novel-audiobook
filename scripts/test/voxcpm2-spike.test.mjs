import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  createPcmWav,
  loadLock,
  parseWav,
  requireVoxCpm2PcmWav,
  summarizeRequests,
  summarizeResourceCsv,
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

test('the lock pins immutable revisions, checksums, licenses, endpoint, and two assets', async () => {
  const lock = await loadLock(join(root, 'config/voxcpm2-spike.lock.json'))
  assert.equal(lock.runtime.revision, '74699a53df6ca0f4947ff37066f851532c20b12d')
  assert.equal(lock.runtime.license, 'MIT')
  assert.equal(lock.officialModel.license, 'Apache-2.0')
  assert.deepEqual(
    lock.ggufModel.assets.map((asset) => asset.name),
    ['VoxCPM2-BaseLM-Q8_0.gguf', 'VoxCPM2-Acoustic-F16.gguf'],
  )
  assert.deepEqual(lock.server, { host: '127.0.0.1', port: 8081 })
})

test('WAV validation requires complete 48 kHz mono PCM data', () => {
  const wav = createPcmWav({ frames: 9600 })
  assert.deepEqual(requireVoxCpm2PcmWav(wav), {
    container: 'RIFF/WAVE',
    declaredRiffSize: 19236,
    encoding: 'PCM',
    channels: 1,
    sampleRateHz: 48000,
    bitsPerSample: 16,
    frames: 9600,
    durationSeconds: 0.2,
    bytes: 19244,
    dataDeclaredSize: 19200,
    sha256: requireVoxCpm2PcmWav(wav).sha256,
  })
  assert.throws(() => parseWav(wav.subarray(0, -1)), /truncated WAV data chunk/u)
  assert.throws(
    () => requireVoxCpm2PcmWav(createPcmWav({ sampleRateHz: 24000 })),
    /expected 48 kHz/u,
  )
})

test('streaming headers with unknown lengths are rejected unless explicitly inspected', () => {
  const wav = createPcmWav()
  wav.writeUInt32LE(0x7fffffff, 4)
  wav.writeUInt32LE(0x7fffffff, 40)
  assert.throws(() => parseWav(wav), /truncated WAV data chunk/u)
  const inspected = parseWav(wav, { allowUnknownStreamingLength: true })
  assert.equal(inspected.dataDeclaredSize, 0x7fffffff)
  assert.equal(inspected.frames, 4800)
})

test('portable resource fixtures report incremental RAM, VRAM, and GPU load', async () => {
  const summary = summarizeResourceCsv(await readFile(join(fixtures, 'resource.csv'), 'utf8'), 600)
  assert.deepEqual(summary, {
    sampleCount: 3,
    peakRamMiB: 1024,
    steadyRamMiB: 768,
    peakDeviceVramMiB: 5700,
    peakIncrementalVramMiB: 5100,
    steadyDeviceVramMiB: 5500,
    steadyIncrementalVramMiB: 4900,
    peakGpuUtilizationPercent: 100,
  })
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
  const summary = summarizeRequests(requests)
  assert.equal(summary.count, 20)
  assert.ok(summary.meanRtf >= 0)

  const invalid = await fetch(`${fixtureEndpoint}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(invalid.status, 500)
})

test('operational harness fails closed into external ext4 TTS paths', async () => {
  const shell = await readFile(join(root, 'scripts/voxcpm2-spike.sh'), 'utf8')
  const probe = await readFile(join(root, 'scripts/probe-voxcpm2.mjs'), 'utf8')
  assert.match(shell, /findmnt -n -o FSTYPE/u)
  assert.match(shell, /== ext4/u)
  assert.match(shell, /runtimes\/tts\/llama\.cpp-omni/u)
  assert.match(shell, /models\/tts\/voxcpm2/u)
  assert.match(shell, /TTS runtime overlaps the brain runtime/u)
  assert.match(probe, /configured TTS port is occupied/u)
  assert.doesNotMatch(`${shell}\n${probe}`, /0\.0\.0\.0/u)
})
