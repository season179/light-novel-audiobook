import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { WavRequirements } from './config.js'
import type { SpeechAudioIdentity } from './types.js'
import { SpeechEngineError } from './types.js'

export interface ValidatedWav {
  readonly audio: SpeechAudioIdentity
  readonly clippedSampleFraction: number
  readonly activeFrameFraction: number
}

/** Shape of a canonical WAV, derived entirely from the file's own header and data chunk. */
export interface CanonicalWavHeader {
  readonly channels: number
  readonly sampleRateHz: number
  readonly bitsPerSample: number
  readonly frames: number
  readonly durationSeconds: number
}

function invalid(message: string, segmentId: string): never {
  throw new SpeechEngineError('audio-validation', `Invalid WAV for ${segmentId}: ${message}`, {
    segmentId,
  })
}

/**
 * Constant-cost canonical RIFF/WAVE gate. Returns the header, or the reason it is not canonical.
 * `frames` is derived from the declared data chunk and cross-checked against the real file length,
 * so a caller never has to take an external record's word for the audio's shape.
 */
export function readCanonicalWavHeader(
  bytes: Buffer,
  requirements: WavRequirements,
): CanonicalWavHeader | string {
  if (bytes.length < 46) return 'file is empty or shorter than a PCM header'
  if (
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE' ||
    bytes.toString('ascii', 12, 16) !== 'fmt ' ||
    bytes.toString('ascii', 36, 40) !== 'data'
  ) {
    return 'expected canonical RIFF/WAVE fmt/data layout'
  }
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) return 'RIFF length does not match file length'
  if (bytes.readUInt32LE(16) !== 16 || bytes.readUInt16LE(20) !== 1)
    return 'expected canonical PCM fmt chunk'

  const channels = bytes.readUInt16LE(22)
  const sampleRateHz = bytes.readUInt32LE(24)
  const byteRate = bytes.readUInt32LE(28)
  const blockAlign = bytes.readUInt16LE(32)
  const bitsPerSample = bytes.readUInt16LE(34)
  const dataBytes = bytes.readUInt32LE(40)
  if (44 + dataBytes !== bytes.length) return 'data length does not match file length'
  if (
    channels !== requirements.channels ||
    sampleRateHz !== requirements.sampleRateHz ||
    bitsPerSample !== requirements.bitsPerSample ||
    blockAlign !== 2 ||
    byteRate !== sampleRateHz * blockAlign ||
    dataBytes === 0 ||
    dataBytes % blockAlign !== 0
  ) {
    return 'expected nonempty mono 24 kHz 16-bit PCM'
  }

  const frames = dataBytes / blockAlign
  return { channels, sampleRateHz, bitsPerSample, frames, durationSeconds: frames / sampleRateHz }
}

export function validateCanonicalWavHeader(
  bytes: Buffer,
  requirements: WavRequirements,
  segmentId: string,
): CanonicalWavHeader {
  const header = readCanonicalWavHeader(bytes, requirements)
  if (typeof header === 'string') invalid(header, segmentId)
  return header
}

export function validateCanonicalWavBytes(
  bytes: Buffer,
  requirements: WavRequirements,
  text: string,
  segmentId: string,
): ValidatedWav {
  const { channels, sampleRateHz, bitsPerSample, frames, durationSeconds } =
    validateCanonicalWavHeader(bytes, requirements, segmentId)
  const wordCount = text.trim().split(/\s+/u).filter(Boolean).length
  if (wordCount === 0) invalid('render text has no words', segmentId)
  // A ratio has no intercept and mistakes fixed short-utterance variance for speaking rate (#91).
  // The upper allowance becomes negligible over prose. The lower side instead keeps an absolute,
  // measured truncation floor: onset/release overhead can only lengthen an utterance, not shorten it.
  const minimumTextDurationSeconds = Math.max(
    requirements.minimumUtteranceDurationSeconds,
    requirements.minimumSecondsPerWord * wordCount,
  )
  const maximumTextDurationSeconds =
    requirements.maximumSecondsPerWord * wordCount + requirements.fixedUtteranceOverheadSeconds
  if (
    durationSeconds > requirements.maximumDurationSeconds ||
    durationSeconds < minimumTextDurationSeconds ||
    durationSeconds > maximumTextDurationSeconds
  ) {
    invalid('duration is outside configured text-relative bounds', segmentId)
  }

  let clipped = 0
  const frameLength = Math.max(1, Math.round(sampleRateHz * 0.02))
  let activeFrames = 0
  let analyzedFrames = 0
  const activeThreshold = 32_768 * 10 ** (-50 / 20)
  for (let frameStart = 0; frameStart < frames; frameStart += frameLength) {
    const frameEnd = Math.min(frames, frameStart + frameLength)
    let squareTotal = 0
    for (let frame = frameStart; frame < frameEnd; frame += 1) {
      const sample = bytes.readInt16LE(44 + frame * 2)
      squareTotal += sample * sample
      if (Math.abs(sample) >= 32_760) clipped += 1
    }
    const rms = Math.sqrt(squareTotal / (frameEnd - frameStart))
    if (rms > activeThreshold) activeFrames += 1
    analyzedFrames += 1
  }
  const clippedSampleFraction = clipped / frames
  const activeFrameFraction = activeFrames / analyzedFrames
  if (clippedSampleFraction > requirements.maximumClippedSampleFraction)
    invalid('audio is clipped', segmentId)
  if (activeFrameFraction < requirements.minimumActiveFrameFraction)
    invalid('audio is silent or mostly inactive', segmentId)

  return {
    audio: {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      sampleRateHz,
      channels,
      bitsPerSample,
      frames,
      durationSeconds,
    },
    clippedSampleFraction,
    activeFrameFraction,
  }
}

export async function validateCanonicalWav(
  path: string,
  requirements: WavRequirements,
  text: string,
  segmentId: string,
): Promise<ValidatedWav> {
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (error) {
    throw new SpeechEngineError('audio-validation', `Cannot read WAV for ${segmentId}`, {
      cause: error,
      segmentId,
    })
  }
  return validateCanonicalWavBytes(bytes, requirements, text, segmentId)
}
