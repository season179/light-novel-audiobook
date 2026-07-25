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

function invalid(message: string, segmentId: string): never {
  throw new SpeechEngineError('audio-validation', `Invalid WAV for ${segmentId}: ${message}`, {
    segmentId,
  })
}

export function validateCanonicalWavBytes(
  bytes: Buffer,
  requirements: WavRequirements,
  text: string,
  segmentId: string,
): ValidatedWav {
  if (bytes.length < 46) invalid('file is empty or shorter than a PCM header', segmentId)
  if (
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE' ||
    bytes.toString('ascii', 12, 16) !== 'fmt ' ||
    bytes.toString('ascii', 36, 40) !== 'data'
  ) {
    invalid('expected canonical RIFF/WAVE fmt/data layout', segmentId)
  }
  if (bytes.readUInt32LE(4) + 8 !== bytes.length)
    invalid('RIFF length does not match file length', segmentId)
  if (bytes.readUInt32LE(16) !== 16 || bytes.readUInt16LE(20) !== 1)
    invalid('expected canonical PCM fmt chunk', segmentId)

  const channels = bytes.readUInt16LE(22)
  const sampleRateHz = bytes.readUInt32LE(24)
  const byteRate = bytes.readUInt32LE(28)
  const blockAlign = bytes.readUInt16LE(32)
  const bitsPerSample = bytes.readUInt16LE(34)
  const dataBytes = bytes.readUInt32LE(40)
  if (44 + dataBytes !== bytes.length) invalid('data length does not match file length', segmentId)
  if (
    channels !== requirements.channels ||
    sampleRateHz !== requirements.sampleRateHz ||
    bitsPerSample !== requirements.bitsPerSample ||
    blockAlign !== 2 ||
    byteRate !== sampleRateHz * blockAlign ||
    dataBytes === 0 ||
    dataBytes % blockAlign !== 0
  ) {
    invalid('expected nonempty mono 24 kHz 16-bit PCM', segmentId)
  }

  const frames = dataBytes / blockAlign
  const durationSeconds = frames / sampleRateHz
  const wordCount = text.trim().split(/\s+/u).filter(Boolean).length
  if (wordCount === 0) invalid('render text has no words', segmentId)
  const secondsPerWord = durationSeconds / wordCount
  if (
    durationSeconds > requirements.maximumDurationSeconds ||
    secondsPerWord < requirements.minimumSecondsPerWord ||
    secondsPerWord > requirements.maximumSecondsPerWord
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
