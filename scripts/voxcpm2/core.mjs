import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'

const SHA256 = /^[0-9a-f]{64}$/u
const REVISION = /^[0-9a-f]{40}$/u

export async function loadLock(path) {
  const lock = JSON.parse(await readFile(path, 'utf8'))
  if (lock.schemaVersion !== 1) throw new Error('unsupported VoxCPM2 lock schema')
  for (const revision of [
    lock.runtime?.revision,
    lock.officialModel?.revision,
    lock.officialModel?.sourceRevision,
    lock.ggufModel?.revision,
  ]) {
    if (!REVISION.test(revision)) throw new Error(`invalid pinned revision: ${revision}`)
  }
  for (const checksum of [
    lock.runtime?.licenseSha256,
    lock.runtime?.voxcpmReadmeSha256,
    lock.officialModel?.modelCardSha256,
    lock.officialModel?.sourceLicenseSha256,
    lock.ggufModel?.modelCardSha256,
    ...(lock.ggufModel?.assets ?? []).map((asset) => asset.sha256),
  ]) {
    if (!SHA256.test(checksum)) throw new Error(`invalid SHA-256: ${checksum}`)
  }
  if (lock.runtime.license !== 'MIT' || lock.officialModel.license !== 'Apache-2.0') {
    throw new Error('unexpected upstream license')
  }
  if (lock.ggufModel.license !== 'Apache-2.0' || lock.ggufModel.assets.length !== 2) {
    throw new Error('unexpected GGUF license or asset set')
  }
  if (lock.server.host !== '127.0.0.1' || lock.server.port !== 8081) {
    throw new Error('VoxCPM2 endpoint must remain 127.0.0.1:8081')
  }
  return lock
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

export async function sha256File(path) {
  const hash = createHash('sha256')
  await new Promise((resolvePromise, reject) => {
    const input = createReadStream(path)
    input.on('data', (chunk) => hash.update(chunk))
    input.once('end', resolvePromise)
    input.once('error', reject)
  })
  return hash.digest('hex')
}

export function parseWav(data, { allowUnknownStreamingLength = false } = {}) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
  if (
    buffer.length < 44 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('not a RIFF/WAVE file')
  }
  const declaredRiffSize = buffer.readUInt32LE(4)
  let offset = 12
  let format
  let audio
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const start = offset + 8
    const unknownLength = allowUnknownStreamingLength && size === 0x7fffffff
    if (!unknownLength && start + size > buffer.length) throw new Error(`truncated WAV ${id} chunk`)
    if (id === 'fmt ') {
      if (size < 16 || start + 16 > buffer.length) throw new Error('invalid WAV fmt chunk')
      format = {
        encodingCode: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRateHz: buffer.readUInt32LE(start + 4),
        byteRate: buffer.readUInt32LE(start + 8),
        blockAlign: buffer.readUInt16LE(start + 12),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      }
    }
    if (id === 'data') {
      const actualSize = unknownLength ? buffer.length - start : size
      audio = { declaredSize: size, actualSize, offset: start }
      break
    }
    offset = start + size + (size % 2)
  }
  if (!format || !audio) throw new Error('WAV is missing fmt or data')
  if (audio.actualSize % format.blockAlign !== 0) throw new Error('WAV has a partial frame')
  const frames = audio.actualSize / format.blockAlign
  return {
    container: 'RIFF/WAVE',
    declaredRiffSize,
    encoding: format.encodingCode === 1 ? 'PCM' : `code-${format.encodingCode}`,
    channels: format.channels,
    sampleRateHz: format.sampleRateHz,
    bitsPerSample: format.bitsPerSample,
    frames,
    durationSeconds: frames / format.sampleRateHz,
    bytes: buffer.length,
    dataDeclaredSize: audio.declaredSize,
    sha256: sha256(buffer),
  }
}

export function requireVoxCpm2PcmWav(data) {
  const info = parseWav(data)
  if (
    info.encoding !== 'PCM' ||
    info.channels !== 1 ||
    info.sampleRateHz !== 48000 ||
    info.bitsPerSample !== 16
  ) {
    throw new Error('expected 48 kHz mono 16-bit PCM WAV')
  }
  return info
}

export function summarizeResourceCsv(text, baselineGpuMiB = 0) {
  const samples = text
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.split(',').map(Number))
    .filter((sample) => sample.length === 4 && sample.every(Number.isFinite) && sample[1] > 0)
  if (samples.length === 0) throw new Error('resource log has no valid samples')
  const peak = (index) => Math.max(...samples.map((sample) => sample[index]))
  const last = samples.at(-1)
  return {
    sampleCount: samples.length,
    peakRamMiB: peak(1) / 1024,
    steadyRamMiB: last[1] / 1024,
    peakDeviceVramMiB: peak(2),
    peakIncrementalVramMiB: Math.max(0, peak(2) - baselineGpuMiB),
    steadyDeviceVramMiB: last[2],
    steadyIncrementalVramMiB: Math.max(0, last[2] - baselineGpuMiB),
    peakGpuUtilizationPercent: peak(3),
  }
}

export function summarizeRequests(requests) {
  if (requests.length === 0) throw new Error('no requests to summarize')
  const seconds = requests.map((request) => request.elapsedSeconds)
  const rtfs = requests.map((request) => request.elapsedSeconds / request.audio.durationSeconds)
  const mean = (values) => values.reduce((total, value) => total + value, 0) / values.length
  return {
    count: requests.length,
    minimumSeconds: Math.min(...seconds),
    meanSeconds: mean(seconds),
    maximumSeconds: Math.max(...seconds),
    meanRtf: mean(rtfs),
  }
}

export function createPcmWav({ frames = 4800, sampleRateHz = 48000, sample = 0 } = {}) {
  const dataSize = frames * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRateHz, 24)
  buffer.writeUInt32LE(sampleRateHz * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  buffer.fill(sample, 44)
  return buffer
}
