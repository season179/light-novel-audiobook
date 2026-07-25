import { AudioAssemblyError } from './errors.js'

export interface ProbedAudioStream {
  readonly codecName: string
  readonly profile: string | null
  readonly sampleRate: number
  readonly channels: number
  readonly sampleFormat: string | null
  readonly bitsPerRawSample: number | null
  readonly durationSeconds: number | null
  /** Stream duration in timebase ticks; for PCM/FLAC this is the exact sample count. */
  readonly durationTicks: number | null
  readonly timeBaseDenominator: number | null
}

export interface ProbedChapter {
  readonly startMs: number
  readonly endMs: number
  readonly title: string | null
}

export interface ProbeResult {
  readonly formatName: string
  readonly durationSeconds: number | null
  readonly sizeBytes: number | null
  readonly bitRateBps: number | null
  readonly audio: ProbedAudioStream | null
  readonly streamCodecs: readonly string[]
  readonly chapters: readonly ProbedChapter[]
  readonly tags: Readonly<Record<string, string>>
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : [])

const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const asStringRecord = (value: unknown): Record<string, string> => {
  const tags: Record<string, string> = {}
  for (const [key, raw] of Object.entries(asRecord(value))) {
    if (typeof raw === 'string') tags[key] = raw
  }
  return tags
}

const parseTimebaseDenominator = (timeBase: unknown): number => {
  const text = asString(timeBase)
  if (text === null) return 0
  const [numerator, denominator] = text.split('/')
  if (numerator !== '1' || denominator === undefined) return 0
  const parsed = Number.parseInt(denominator, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
}

const chapterEdgeMs = (ticks: unknown, seconds: unknown, denominator: number): number => {
  const tickValue = asNumber(ticks)
  if (tickValue !== null && denominator > 0) {
    return Math.round((tickValue / denominator) * 1000)
  }
  const secondsValue = asNumber(seconds)
  if (secondsValue === null) {
    throw new AudioAssemblyError('FFprobe reported a chapter without usable boundaries')
  }
  return Math.round(secondsValue * 1000)
}

/** Parses `ffprobe -show_format -show_streams -show_chapters -of json` output. */
export const parseProbeJson = (raw: string): ProbeResult => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new AudioAssemblyError('FFprobe did not return valid JSON', { cause: error })
  }
  const root = asRecord(parsed)
  const format = asRecord(root.format)
  const streams = asArray(root.streams).map(asRecord)

  const audioStream = streams.find((stream) => asString(stream.codec_type) === 'audio')
  let audio: ProbedAudioStream | null = null
  if (audioStream !== undefined) {
    const sampleRate = asNumber(audioStream.sample_rate)
    const channels = asNumber(audioStream.channels)
    if (sampleRate === null || channels === null) {
      throw new AudioAssemblyError('FFprobe reported an audio stream without rate or channels')
    }
    audio = {
      codecName: asString(audioStream.codec_name) ?? 'unknown',
      profile: asString(audioStream.profile),
      sampleRate,
      channels,
      sampleFormat: asString(audioStream.sample_fmt),
      bitsPerRawSample: asNumber(audioStream.bits_per_raw_sample),
      durationSeconds: asNumber(audioStream.duration),
      durationTicks: asNumber(audioStream.duration_ts),
      timeBaseDenominator: parseTimebaseDenominator(audioStream.time_base) || null,
    }
  }

  const chapters = asArray(root.chapters).map((entry): ProbedChapter => {
    const chapter = asRecord(entry)
    const denominator = parseTimebaseDenominator(chapter.time_base)
    return {
      startMs: chapterEdgeMs(chapter.start, chapter.start_time, denominator),
      endMs: chapterEdgeMs(chapter.end, chapter.end_time, denominator),
      title: asString(asStringRecord(chapter.tags).title),
    }
  })

  return {
    formatName: asString(format.format_name) ?? 'unknown',
    durationSeconds: asNumber(format.duration),
    sizeBytes: asNumber(format.size),
    bitRateBps: asNumber(format.bit_rate),
    audio,
    streamCodecs: streams.map((stream) => asString(stream.codec_name) ?? 'unknown'),
    chapters,
    tags: asStringRecord(format.tags),
  }
}

/**
 * Chapter boundaries must not drift, so the duration comes from the exact sample count when the
 * container reports one and falls back to the rounded duration string only when it does not.
 */
export const probedDurationMs = (probe: ProbeResult): number => {
  const audio = probe.audio
  if (audio !== null && audio.durationTicks !== null && audio.timeBaseDenominator !== null) {
    const exactMs = Math.round((audio.durationTicks * 1000) / audio.timeBaseDenominator)
    if (exactMs > 0) return exactMs
  }
  const seconds = audio?.durationSeconds ?? probe.durationSeconds
  if (seconds === null || seconds === undefined || seconds <= 0) {
    throw new AudioAssemblyError('FFprobe reported no usable duration for assembled audio')
  }
  return Math.round(seconds * 1000)
}
