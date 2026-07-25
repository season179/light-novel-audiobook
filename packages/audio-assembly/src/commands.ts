import { metadataArguments, safeFileArgument } from './argument-safety.js'
import { AudioAssemblyError } from './errors.js'
import type { AssemblySettings } from './settings.js'

/**
 * Shared FFmpeg prologue. `-nostdin` stops FFmpeg from consuming the worker's stdin, and `-n`
 * refuses to overwrite. FFmpeg exits 0 when `-n` declines, so every caller still verifies that the
 * output was created; `-n` is the second lock, not the only one.
 */
const FFMPEG_PROLOGUE: readonly string[] = ['-nostdin', '-hide_banner', '-n']

/**
 * Output-side `+bitexact` drops the encoder tag and other build-dependent header fields, so the same
 * inputs and the same pinned FFmpeg build produce byte-identical files. It must appear after the
 * inputs to apply to the output rather than to an input.
 */
const BITEXACT_OUTPUT: readonly string[] = ['-fflags', '+bitexact']

export interface PaddedInput {
  readonly path: string
  /** Silence appended after this input, in milliseconds. */
  readonly padMs: number
}

/**
 * Filter graphs are built only from indices, numbers, and fixed keywords. No title, author, chapter
 * name, or file path is ever interpolated into a filter string, so book metadata cannot reach the
 * filter parser where `:`, `;`, `[`, and `\` are syntax.
 */
const normalizedInputChain = (index: number, settings: AssemblySettings, padMs: number): string => {
  const format = [
    `aformat=sample_fmts=${settings.chapterSampleFormat}`,
    `channel_layouts=${settings.chapterChannels === 1 ? 'mono' : 'stereo'}`,
    `sample_rates=${settings.chapterSampleRate}`,
  ].join(':')
  const pad = padMs > 0 ? `,apad=pad_dur=${padMs}ms` : ''
  return `[${index}:a]${format}${pad}[a${index}]`
}

const concatChain = (count: number): string => {
  const labels = Array.from({ length: count }, (_, index) => `[a${index}]`).join('')
  return `${labels}concat=n=${count}:v=0:a=1`
}

const requireInputs = (label: string, count: number): void => {
  if (count < 1) throw new AudioAssemblyError(`${label} requires at least one input`)
}

const flacOutputArguments = (settings: AssemblySettings): readonly string[] => [
  '-c:a',
  'flac',
  '-compression_level',
  String(settings.flacCompressionLevel),
  '-sample_fmt',
  settings.chapterSampleFormat,
  '-ar',
  String(settings.chapterSampleRate),
  '-ac',
  String(settings.chapterChannels),
]

export interface SegmentConcatCommand {
  readonly inputs: readonly PaddedInput[]
  readonly outputPath: string
  readonly settings: AssemblySettings
}

/**
 * Concatenates segment WAVs in the exact order given, appending each segment's pause. Input order in
 * `argv` is the audio order: FFmpeg input index N becomes filter label `[aN]`, and the concat filter
 * consumes those labels in ascending order.
 */
export const buildSegmentConcatArgs = (command: SegmentConcatCommand): readonly string[] => {
  requireInputs('Segment concatenation', command.inputs.length)
  const args = [...FFMPEG_PROLOGUE]
  const chains: string[] = []
  for (const [index, input] of command.inputs.entries()) {
    if (!Number.isSafeInteger(input.padMs) || input.padMs < 0) {
      throw new AudioAssemblyError(`Segment pause must be a non-negative integer: ${input.padMs}`)
    }
    args.push('-i', safeFileArgument('Segment audio', input.path))
    chains.push(normalizedInputChain(index, command.settings, input.padMs))
  }
  args.push(
    '-filter_complex',
    `${chains.join(';')};${concatChain(command.inputs.length)}[out]`,
    '-map',
    '[out]',
    '-map_metadata',
    '-1',
    ...flacOutputArguments(command.settings),
    ...BITEXACT_OUTPUT,
    '-f',
    'flac',
    safeFileArgument('Chapter part output', command.outputPath),
  )
  return Object.freeze(args)
}

export interface ChapterMasterCommand {
  readonly inputPaths: readonly string[]
  readonly gainDb: number
  readonly tags: readonly (readonly [key: string, value: string])[]
  readonly outputPath: string
  readonly settings: AssemblySettings
}

/**
 * Joins a chapter's intermediate parts, applies the single book-wide loudness gain, and writes the
 * tagged chapter master. Metadata arrives as `-metadata key=value` argv pairs, never as shell text.
 */
export const buildChapterMasterArgs = (command: ChapterMasterCommand): readonly string[] => {
  requireInputs('Chapter master', command.inputPaths.length)
  if (!Number.isFinite(command.gainDb)) {
    throw new AudioAssemblyError('Loudness gain must be a finite number of decibels')
  }
  const args = [...FFMPEG_PROLOGUE]
  for (const path of command.inputPaths) {
    args.push('-i', safeFileArgument('Chapter part', path))
  }
  const gain = command.gainDb === 0 ? '' : `,volume=${command.gainDb.toFixed(2)}dB`
  args.push(
    '-filter_complex',
    `${command.inputPaths
      .map((_, index) => normalizedInputChain(index, command.settings, 0))
      .join(';')};${concatChain(command.inputPaths.length)}${gain}[out]`,
    '-map',
    '[out]',
    '-map_metadata',
    '-1',
    ...flacOutputArguments(command.settings),
    ...metadataArguments(command.tags),
    ...BITEXACT_OUTPUT,
    '-f',
    'flac',
    safeFileArgument('Chapter master output', command.outputPath),
  )
  return Object.freeze(args)
}

export interface LoudnessAnalysisCommand {
  readonly inputPaths: readonly string[]
  readonly settings: AssemblySettings
}

/**
 * Measures the whole book in one pass and discards the audio; only the printed report is used.
 *
 * Chapters are opened together rather than in batches. `maxInputsPerPass` guards the segment passes
 * because a chapter's segment count is unbounded, whereas the chapter count is the book's spine
 * length — tens, not thousands — and measuring in batches would defeat the point of one book-wide
 * measurement. The same reasoning applies to the export below.
 */
export const buildLoudnessAnalysisArgs = (command: LoudnessAnalysisCommand): readonly string[] => {
  requireInputs('Loudness analysis', command.inputPaths.length)
  const args = ['-nostdin', '-hide_banner']
  for (const path of command.inputPaths) {
    args.push('-i', safeFileArgument('Chapter master', path))
  }
  const loudnorm = [
    `loudnorm=I=${command.settings.targetLoudnessLufs}`,
    `TP=${command.settings.maxTruePeakDbtp}`,
    'print_format=json',
  ].join(':')
  args.push(
    '-filter_complex',
    `${command.inputPaths
      .map((_, index) => normalizedInputChain(index, command.settings, 0))
      .join(';')};${concatChain(command.inputPaths.length)},${loudnorm}[out]`,
    '-map',
    '[out]',
    '-f',
    'null',
    '-',
  )
  return Object.freeze(args)
}

export type CoverArtHandling = 'copy' | 'transcode'

export interface AudiobookCommand {
  readonly chapterPaths: readonly string[]
  readonly ffmetadataPath: string
  readonly cover: { readonly path: string; readonly handling: CoverArtHandling } | null
  readonly outputPath: string
  readonly settings: AssemblySettings
}

/**
 * Builds the numbered M4B: mono AAC-LC in an iPod-flavoured MP4 so chapter markers and cover art
 * are written, with global tags and chapter markers taken from the ffmetadata input.
 */
export const buildAudiobookArgs = (command: AudiobookCommand): readonly string[] => {
  requireInputs('Audiobook export', command.chapterPaths.length)
  const args = [...FFMPEG_PROLOGUE]
  for (const path of command.chapterPaths) {
    args.push('-i', safeFileArgument('Chapter master', path))
  }
  const metadataIndex = command.chapterPaths.length
  args.push('-i', safeFileArgument('Chapter marker metadata', command.ffmetadataPath))
  const coverIndex = metadataIndex + 1
  if (command.cover !== null) {
    args.push('-i', safeFileArgument('Cover art', command.cover.path))
  }

  args.push(
    '-filter_complex',
    `${command.chapterPaths
      .map((_, index) => normalizedInputChain(index, command.settings, 0))
      .join(';')};${concatChain(command.chapterPaths.length)}[out]`,
    '-map',
    '[out]',
  )
  if (command.cover !== null) {
    args.push(
      '-map',
      `${coverIndex}:v`,
      '-c:v',
      command.cover.handling === 'copy' ? 'copy' : 'mjpeg',
      '-disposition:v',
      'attached_pic',
    )
  }
  args.push(
    '-map_metadata',
    String(metadataIndex),
    '-map_chapters',
    String(metadataIndex),
    '-c:a',
    'aac',
    '-profile:a',
    'aac_low',
    '-b:a',
    `${command.settings.audiobookBitrateKbps}k`,
    '-ar',
    String(command.settings.audiobookSampleRate),
    '-ac',
    String(command.settings.audiobookChannels),
    ...BITEXACT_OUTPUT,
    '-movflags',
    '+faststart',
    '-f',
    'ipod',
    safeFileArgument('Audiobook output', command.outputPath),
  )
  return Object.freeze(args)
}

/** Full probe used for the returned results and for the adapter's own output assertions. */
export const buildProbeArgs = (path: string): readonly string[] =>
  Object.freeze([
    '-hide_banner',
    '-loglevel',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    '-show_chapters',
    safeFileArgument('Probe target', path),
  ])

/** Minimal probe used to decide whether cover art can be stream-copied into the container. */
export const buildCoverProbeArgs = (path: string): readonly string[] =>
  Object.freeze([
    '-hide_banner',
    '-loglevel',
    'error',
    '-print_format',
    'json',
    '-show_streams',
    '-select_streams',
    'v:0',
    safeFileArgument('Cover art', path),
  ])
