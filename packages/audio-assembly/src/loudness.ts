import { AudioAssemblyError } from './errors.js'

export interface LoudnessMeasurement {
  /** Integrated loudness in LUFS, or null when the material is too quiet to measure. */
  readonly integratedLufs: number | null
  /** True peak in dBTP, or null when the material is silent. */
  readonly truePeakDbtp: number | null
  readonly loudnessRangeLu: number | null
}

export type LoudnessGainLimit = 'loudness' | 'true_peak' | 'unmeasurable'

export interface LoudnessGainDecision {
  /** Gain in dB, rounded to two decimals so a rerun writes the same bytes. */
  readonly gainDb: number
  readonly limitedBy: LoudnessGainLimit
  readonly warning: string | null
}

const parseMeasuredNumber = (raw: unknown): number | null => {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  // loudnorm reports silence as "-inf"/"inf", which is not a finite measurement.
  const value = Number.parseFloat(trimmed)
  return Number.isFinite(value) ? value : null
}

/**
 * Extracts the JSON block that `loudnorm=print_format=json` writes to stderr. FFmpeg surrounds it
 * with log lines, so the object is located by brace matching rather than by parsing whole stderr.
 */
export const parseLoudnormMeasurement = (stderr: string): LoudnessMeasurement => {
  const start = stderr.lastIndexOf('{')
  const end = stderr.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) {
    throw new AudioAssemblyError('FFmpeg loudness analysis produced no measurement block')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stderr.slice(start, end + 1))
  } catch (error) {
    throw new AudioAssemblyError('FFmpeg loudness measurement was not valid JSON', { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new AudioAssemblyError('FFmpeg loudness measurement was not an object')
  }
  const record = parsed as Record<string, unknown>
  if (!('input_i' in record) || !('input_tp' in record)) {
    throw new AudioAssemblyError('FFmpeg loudness measurement is missing input_i or input_tp')
  }
  return {
    integratedLufs: parseMeasuredNumber(record.input_i),
    truePeakDbtp: parseMeasuredNumber(record.input_tp),
    loudnessRangeLu: parseMeasuredNumber(record.input_lra),
  }
}

export interface LoudnessGainInput {
  readonly measurement: LoudnessMeasurement
  readonly targetLoudnessLufs: number
  readonly maxTruePeakDbtp: number
  readonly loudnessFloorLufs: number
}

/**
 * One linear gain for the whole book: enough to reach the loudness target, reduced when that gain
 * would push the true peak above the ceiling. A single gain keeps dynamics intact, which is why the
 * adapter does not compress or limit.
 */
export const computeLoudnessGainDb = (input: LoudnessGainInput): LoudnessGainDecision => {
  const { integratedLufs, truePeakDbtp } = input.measurement
  if (integratedLufs === null || integratedLufs <= input.loudnessFloorLufs) {
    return {
      gainDb: 0,
      limitedBy: 'unmeasurable',
      warning: `Integrated loudness was not measurable at or above ${input.loudnessFloorLufs} LUFS; no loudness gain was applied`,
    }
  }

  const loudnessGain = input.targetLoudnessLufs - integratedLufs
  const peakGain =
    truePeakDbtp === null ? Number.POSITIVE_INFINITY : input.maxTruePeakDbtp - truePeakDbtp
  const limitedBy: LoudnessGainLimit = peakGain < loudnessGain ? 'true_peak' : 'loudness'
  const gainDb = Math.round(Math.min(loudnessGain, peakGain) * 100) / 100

  return {
    gainDb,
    limitedBy,
    warning:
      limitedBy === 'true_peak'
        ? `True peak headroom limited the loudness gain to ${gainDb} dB; integrated loudness stays below ${input.targetLoudnessLufs} LUFS`
        : null,
  }
}
