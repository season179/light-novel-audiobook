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
  for (const value of [
    lock.server.threadsHttp,
    lock.server.timeoutSeconds,
    lock.server.timeoutTestSeconds,
    lock.probe.longRequest.maxSteps,
    lock.probe.longRequest.inferenceTimesteps,
    lock.probe.interruptAfterMilliseconds,
    lock.probe.lifecyclePollMilliseconds,
    lock.probe.lifecycleIdleSamples,
    lock.probe.lifecycleMaximumSeconds,
    lock.probe.maximumBaselineVramMiB,
  ]) {
    if (!Number.isInteger(value) || value <= 0) throw new Error('invalid probe numeric setting')
  }
  if (lock.server.timeoutTestSeconds >= lock.server.timeoutSeconds) {
    throw new Error('timeout test must be shorter than the normal server timeout')
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

export function deriveSourceIdentity(sourceHashes) {
  const entries = Object.entries(sourceHashes).sort(([left], [right]) => left.localeCompare(right))
  for (const [name, hash] of entries) {
    if (!name || !SHA256.test(hash)) throw new Error(`invalid source hash: ${name}`)
  }
  return sha256(entries.map(([name, hash]) => `${name}:${hash}\n`).join(''))
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
  const unknownRiffLength = allowUnknownStreamingLength && declaredRiffSize === 0x7fffffff
  if (!unknownRiffLength && declaredRiffSize + 8 !== buffer.length) {
    throw new Error('RIFF length does not match file length')
  }

  let offset = 12
  let format
  let audio
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const start = offset + 8
    const unknownChunkLength = allowUnknownStreamingLength && size === 0x7fffffff
    if (!unknownChunkLength && start + size > buffer.length) {
      throw new Error(`truncated WAV ${id} chunk`)
    }
    if (id === 'fmt ') {
      if (format) throw new Error('duplicate WAV fmt chunk')
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
      if (audio) throw new Error('duplicate WAV data chunk')
      const actualSize = unknownChunkLength ? buffer.length - start : size
      audio = { declaredSize: size, actualSize, offset: start }
      const dataEnd = start + actualSize
      if (dataEnd !== buffer.length) throw new Error('WAV has trailing bytes after audio data')
      offset = dataEnd
      break
    }
    if (unknownChunkLength) throw new Error(`unknown length is unsupported for WAV ${id} chunk`)
    offset = start + size + (size % 2)
  }
  if (!format || !audio) throw new Error('WAV is missing fmt or data')
  if (offset !== buffer.length) throw new Error('WAV chunk bounds do not consume the complete file')
  if (format.encodingCode !== 1) throw new Error('WAV is not PCM')
  if (format.channels <= 0 || format.sampleRateHz <= 0 || format.bitsPerSample <= 0) {
    throw new Error('WAV has invalid PCM dimensions')
  }
  if (format.bitsPerSample % 8 !== 0) throw new Error('WAV bits per sample is not byte aligned')
  const expectedBlockAlign = format.channels * (format.bitsPerSample / 8)
  if (format.blockAlign !== expectedBlockAlign) throw new Error('WAV block align is inconsistent')
  if (format.byteRate !== format.sampleRateHz * format.blockAlign) {
    throw new Error('WAV byte rate is inconsistent')
  }
  if (audio.actualSize % format.blockAlign !== 0) throw new Error('WAV has a partial frame')
  const frames = audio.actualSize / format.blockAlign
  return {
    container: 'RIFF/WAVE',
    declaredRiffSize,
    encoding: 'PCM',
    channels: format.channels,
    sampleRateHz: format.sampleRateHz,
    byteRate: format.byteRate,
    blockAlign: format.blockAlign,
    bitsPerSample: format.bitsPerSample,
    frames,
    durationSeconds: frames / format.sampleRateHz,
    bytes: buffer.length,
    dataOffset: audio.offset,
    dataDeclaredSize: audio.declaredSize,
    sha256: sha256(buffer),
  }
}

export function requireVoxCpm2PcmWav(data) {
  const info = parseWav(data)
  if (info.channels !== 1 || info.sampleRateHz !== 48000 || info.bitsPerSample !== 16) {
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
    lastObservedRamMiB: last[1] / 1024,
    peakDeviceVramMiB: peak(2),
    peakIncrementalVramMiB: Math.max(0, peak(2) - baselineGpuMiB),
    lastObservedDeviceVramMiB: last[2],
    peakGpuUtilizationPercent: peak(3),
  }
}

export function summarizeRequests(requests) {
  if (requests.length === 0) throw new Error('no requests to summarize')
  if (
    requests.some(
      (request) =>
        !Number.isFinite(request.elapsedSeconds) ||
        request.elapsedSeconds < 0 ||
        !Number.isFinite(request.audio?.durationSeconds) ||
        request.audio.durationSeconds <= 0,
    )
  ) {
    throw new Error(
      'request measurements must have finite elapsed time and positive audio duration',
    )
  }
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

export function parseExactPortListeners(ssOutput, port) {
  const suffix = `:${port}`
  return ssOutput
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/u))
    .filter((columns) => columns.length >= 5 && columns[3].endsWith(suffix))
    .map((columns) => ({
      state: columns[0],
      localEndpoint: columns[3],
      peerEndpoint: columns[4],
    }))
}

export function characterizeInterruption({
  clientResult,
  processSurvived,
  samples,
  interruptedAtMilliseconds,
  activeUtilizationPercent = 10,
}) {
  const postInterruption = samples.filter(
    (sample) => sample.elapsedMilliseconds >= interruptedAtMilliseconds,
  )
  const active = postInterruption.filter(
    (sample) => sample.gpuUtilizationPercent >= activeUtilizationPercent,
  )
  let inferenceAfterClientInterruption = 'unknown'
  if (!processSurvived) inferenceAfterClientInterruption = 'server-exited'
  else if (active.length > 0) inferenceAfterClientInterruption = 'continued'
  const firstActive = active.at(0)
  const lastActive = active.at(-1)
  return {
    clientResult,
    processSurvived,
    inferenceAfterClientInterruption,
    observedActiveAfterInterruption: active.length > 0,
    firstActiveAfterMilliseconds: firstActive?.elapsedMilliseconds ?? null,
    lastActiveAfterMilliseconds: lastActive?.elapsedMilliseconds ?? null,
    activeObservationSpanMilliseconds:
      firstActive && lastActive
        ? lastActive.elapsedMilliseconds - firstActive.elapsedMilliseconds
        : 0,
    gpuReturnedToIdleWindow: samples.at(-1)?.settledWindow === true,
    eventualInferenceOutcome:
      active.length > 0
        ? 'GPU activity later stopped; normal completion versus internal early stop is not observable'
        : 'not observable from available process, GPU, and log signals',
  }
}

export function deriveParameterEffects(parameters) {
  const byName = new Map(parameters.map((item) => [item.name, item]))
  const required = (name) => {
    const item = byName.get(name)
    if (item?.status !== 200) throw new Error(`parameter check failed: ${name}`)
    return item
  }
  const baseline = required('explicit-defaults')
  const effects = {
    maxStepsChangesDuration:
      required('max-steps-10').audio.durationSeconds >
      required('max-steps-5').audio.durationSeconds,
    seedChangesOutput: required('seed-43').sha256 !== baseline.sha256,
    cfgChangesOutput: required('cfg-1.5').sha256 !== baseline.sha256,
    temperatureChangesOutput: required('temperature-0.8').sha256 !== baseline.sha256,
    timestepsChangesOutput: required('timesteps-4').sha256 !== baseline.sha256,
    modelAliasPreservesOutput: required('model-alias').sha256 === baseline.sha256,
    unknownFieldIgnored: required('unknown-field').sha256 === baseline.sha256,
    wrongTypesUseDefaults:
      required('wrong-types-defaulted').sha256 === required('server-defaults').sha256,
    pcmReturned: required('pcm').contentType === 'audio/pcm',
    syntheticReferenceAccepted: required('synthetic-reference-audio').audio.durationSeconds > 0,
  }
  const failed = Object.entries(effects).filter(([, value]) => !value)
  if (failed.length > 0)
    throw new Error(`parameter assumptions changed: ${failed.map(([key]) => key)}`)
  return effects
}

export function deriveStreamingCharacterization({ clientError, processExit, logText }) {
  const assertion = logText.match(/GGML_ASSERT\(([^\n]+)\) failed/u)?.[0] ?? null
  const result = {
    clientError: clientError ?? null,
    processExit,
    processSurvived: processExit === null,
    assertion,
    crashedWithSigabrt: processExit?.signal === 'SIGABRT',
  }
  if (!result.crashedWithSigabrt || result.processSurvived || !result.assertion) {
    throw new Error('streaming crash assumptions changed; refusing to emit evidence')
  }
  return result
}

export function deriveDecision({ persistencePassed, streaming, interruptions, configuredTimeout }) {
  const blockers = []
  if (streaming.crashedWithSigabrt) blockers.push('measured streaming request process crash')
  if (interruptions.some((item) => item.inferenceAfterClientInterruption === 'continued')) {
    blockers.push('measured inference activity after client cancellation/deadline')
  }
  if (configuredTimeout.generationExceededConfiguredTimeout) {
    blockers.push('configured server read/write timeout did not bound generation duration')
  }
  const result = blockers.length > 0 ? 'NO-GO for production SpeechEngine/M2' : 'GO'
  const experimentalMode = persistencePassed
    ? 'Issue #8 may proceed only in serialized, non-streaming experimental mode'
    : 'Issue #8 is blocked'
  if (result !== 'NO-GO for production SpeechEngine/M2' || blockers.length === 0) {
    throw new Error('NO-GO assumptions changed; refusing to emit evidence')
  }
  return { result, experimentalMode, blockers }
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
