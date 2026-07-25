import { AudioAssemblyError } from './errors.js'

/**
 * Every parameter that can change assembled bytes. The adapter identity hashes this object, so a
 * changed setting produces a new identity and therefore a new output version rather than reuse.
 */
export interface AssemblySettings {
  /** Chapter master sample rate in hertz. */
  readonly chapterSampleRate: number
  /** FFmpeg sample format for chapter masters. `s32` makes the FLAC encoder emit 24-bit samples. */
  readonly chapterSampleFormat: 's32' | 's16'
  readonly chapterChannels: number
  readonly flacCompressionLevel: number
  readonly audiobookBitrateKbps: number
  readonly audiobookSampleRate: number
  readonly audiobookChannels: number
  /** Integrated loudness target in LUFS for the final book. */
  readonly targetLoudnessLufs: number
  /** Ceiling for true peak in dBTP. The applied gain is reduced when it would exceed this. */
  readonly maxTruePeakDbtp: number
  /** Measured loudness at or below this floor is treated as unmeasurable; no gain is applied. */
  readonly loudnessFloorLufs: number
  /** Pause used when a directed segment asks for no explicit pause. */
  readonly defaultSegmentPauseMs: number
  readonly minSegmentPauseMs: number
  readonly maxSegmentPauseMs: number
  /** Silence appended after the last segment of every chapter. */
  readonly chapterTailPauseMs: number
  /** Segment inputs per FFmpeg invocation. Long chapters are concatenated in ordered batches. */
  readonly maxInputsPerPass: number
}

export const DEFAULT_ASSEMBLY_SETTINGS: AssemblySettings = Object.freeze({
  chapterSampleRate: 48_000,
  chapterSampleFormat: 's32',
  chapterChannels: 1,
  flacCompressionLevel: 5,
  audiobookBitrateKbps: 64,
  audiobookSampleRate: 48_000,
  audiobookChannels: 1,
  targetLoudnessLufs: -18,
  maxTruePeakDbtp: -3,
  loudnessFloorLufs: -70,
  defaultSegmentPauseMs: 350,
  minSegmentPauseMs: 0,
  maxSegmentPauseMs: 10_000,
  chapterTailPauseMs: 1_000,
  maxInputsPerPass: 96,
})

const requirePositiveInteger = (label: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AudioAssemblyError(`${label} must be a positive integer`)
  }
}

const requirePauseMs = (label: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 600_000) {
    throw new AudioAssemblyError(`${label} must be an integer from 0 through 600000 milliseconds`)
  }
}

export const resolveAssemblySettings = (
  overrides: Partial<AssemblySettings> = {},
): AssemblySettings => {
  const settings: AssemblySettings = { ...DEFAULT_ASSEMBLY_SETTINGS, ...overrides }

  requirePositiveInteger('Chapter sample rate', settings.chapterSampleRate)
  requirePositiveInteger('Chapter channel count', settings.chapterChannels)
  requirePositiveInteger('Audiobook bitrate', settings.audiobookBitrateKbps)
  requirePositiveInteger('Audiobook sample rate', settings.audiobookSampleRate)
  requirePositiveInteger('Audiobook channel count', settings.audiobookChannels)
  if (settings.chapterSampleFormat !== 's32' && settings.chapterSampleFormat !== 's16') {
    throw new AudioAssemblyError('Chapter sample format must be s32 or s16')
  }
  if (!Number.isSafeInteger(settings.flacCompressionLevel)) {
    throw new AudioAssemblyError('FLAC compression level must be an integer')
  }
  if (settings.flacCompressionLevel < 0 || settings.flacCompressionLevel > 12) {
    throw new AudioAssemblyError('FLAC compression level must be between 0 and 12')
  }
  if (
    !Number.isFinite(settings.targetLoudnessLufs) ||
    settings.targetLoudnessLufs >= 0 ||
    settings.targetLoudnessLufs <= -70
  ) {
    throw new AudioAssemblyError('Target loudness must be a negative LUFS value above -70')
  }
  if (!Number.isFinite(settings.maxTruePeakDbtp) || settings.maxTruePeakDbtp > 0) {
    throw new AudioAssemblyError('Maximum true peak must be at or below 0 dBTP')
  }
  if (!Number.isFinite(settings.loudnessFloorLufs) || settings.loudnessFloorLufs >= 0) {
    throw new AudioAssemblyError('Loudness floor must be a negative LUFS value')
  }
  requirePauseMs('Default segment pause', settings.defaultSegmentPauseMs)
  requirePauseMs('Minimum segment pause', settings.minSegmentPauseMs)
  requirePauseMs('Maximum segment pause', settings.maxSegmentPauseMs)
  requirePauseMs('Chapter tail pause', settings.chapterTailPauseMs)
  if (settings.minSegmentPauseMs > settings.maxSegmentPauseMs) {
    throw new AudioAssemblyError('Minimum segment pause cannot exceed the maximum segment pause')
  }
  if (
    settings.defaultSegmentPauseMs < settings.minSegmentPauseMs ||
    settings.defaultSegmentPauseMs > settings.maxSegmentPauseMs
  ) {
    throw new AudioAssemblyError('Default segment pause must fall inside the pause bounds')
  }
  if (!Number.isSafeInteger(settings.maxInputsPerPass) || settings.maxInputsPerPass < 2) {
    throw new AudioAssemblyError('Maximum inputs per pass must be an integer of at least 2')
  }

  return Object.freeze(settings)
}
