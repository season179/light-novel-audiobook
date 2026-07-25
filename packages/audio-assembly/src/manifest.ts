import { createHash } from 'node:crypto'
import type { LoudnessGainLimit, LoudnessMeasurement } from './loudness.js'
import type { AssemblySettings } from './settings.js'

export const ASSEMBLY_MANIFEST_SCHEMA = 1

export interface ManifestChapterEntry {
  readonly chapterId: string
  readonly position: number
  readonly title: string
  readonly path: string
  readonly durationMs: number
  readonly startMs: number
  readonly endMs: number
  readonly segments: readonly { readonly segmentId: string; readonly sha256: string }[]
}

export interface AssemblyManifest {
  readonly schema: number
  readonly assemblerIdentity: string
  readonly bookId: string
  readonly title: string
  readonly author: string | null
  readonly sourceSha256: string
  readonly version: number
  readonly versionLabel: string
  readonly m4bPath: string
  readonly toolchain: {
    readonly ffmpegVersion: string
    readonly ffprobeVersion: string
  }
  readonly encoding: {
    readonly chapterCodec: 'flac'
    readonly chapterSampleRate: number
    readonly chapterSampleFormat: string
    readonly chapterBitDepth: number
    readonly chapterChannels: number
    readonly flacCompressionLevel: number
    readonly audiobookContainer: 'm4b'
    readonly audiobookMuxer: 'ipod'
    readonly audiobookCodec: 'aac'
    readonly audiobookProfile: 'aac_low'
    readonly audiobookBitrateKbps: number
    readonly audiobookSampleRate: number
    readonly audiobookChannels: number
  }
  readonly pauses: {
    readonly defaultSegmentPauseMs: number
    readonly minSegmentPauseMs: number
    readonly maxSegmentPauseMs: number
    readonly chapterTailPauseMs: number
  }
  readonly loudness: {
    readonly targetLufs: number
    readonly maxTruePeakDbtp: number
    readonly measuredIntegratedLufs: number | null
    readonly measuredTruePeakDbtp: number | null
    readonly measuredLoudnessRangeLu: number | null
    readonly appliedGainDb: number
    readonly limitedBy: LoudnessGainLimit
  }
  readonly coverPath: string | null
  readonly chapters: readonly ManifestChapterEntry[]
  readonly warnings: readonly string[]
}

const BIT_DEPTH_BY_SAMPLE_FORMAT: Readonly<
  Record<AssemblySettings['chapterSampleFormat'], number>
> = { s32: 24, s16: 16 }

export const chapterBitDepth = (settings: AssemblySettings): number =>
  BIT_DEPTH_BY_SAMPLE_FORMAT[settings.chapterSampleFormat]

/** Recursively key-sorted JSON so the same inputs always produce byte-identical manifest content. */
export const canonicalJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (typeof value !== 'object' || value === null) return value
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = canonicalJson((value as Record<string, unknown>)[key])
  }
  return sorted
}

export const serializeManifest = (manifest: AssemblyManifest): string =>
  `${JSON.stringify(canonicalJson(manifest), null, 2)}\n`

/**
 * Binds the adapter identity to everything that can change assembled bytes: the encoding and pause
 * settings plus the exact FFmpeg build. A changed setting yields a new identity, which the
 * application turns into a new output version instead of reusing an old export.
 */
export const createAssemblerIdentity = (input: {
  readonly settings: AssemblySettings
  readonly ffmpegVersion: string
  readonly ffprobeVersion: string
}): string => {
  const canonical = JSON.stringify(
    canonicalJson({
      schema: ASSEMBLY_MANIFEST_SCHEMA,
      settings: input.settings,
      ffmpeg: input.ffmpegVersion,
      ffprobe: input.ffprobeVersion,
    }),
  )
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex')
  return `ffmpeg-assembly/1+${digest.slice(0, 16)}`
}

export const measurementForManifest = (
  measurement: LoudnessMeasurement,
): Pick<
  AssemblyManifest['loudness'],
  'measuredIntegratedLufs' | 'measuredTruePeakDbtp' | 'measuredLoudnessRangeLu'
> => ({
  measuredIntegratedLufs: measurement.integratedLufs,
  measuredTruePeakDbtp: measurement.truePeakDbtp,
  measuredLoudnessRangeLu: measurement.loudnessRangeLu,
})
