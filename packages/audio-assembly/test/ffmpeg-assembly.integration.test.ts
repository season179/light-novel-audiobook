import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssembleAudiobookRequest } from '@light-novel-audiobook/application'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runChecked, SpawnCommandRunner } from '../src/command-runner.js'
import { OutputExistsError } from '../src/errors.js'
import {
  type AudiobookAssemblyResult,
  FfmpegAudioAssembler,
} from '../src/ffmpeg-audio-assembler.js'
import {
  EXPECTED_FFMPEG_VERSION,
  type FfmpegToolchain,
  resolveFfmpegToolchain,
} from '../src/ffmpeg-toolchain.js'
import { parseProbeJson } from '../src/ffprobe.js'
import {
  HOSTILE_AUTHOR,
  HOSTILE_CHAPTER_TITLE,
  HOSTILE_TITLE,
  makeBook,
  makeRequest,
} from './fixtures.js'

const TEST_TIMEOUT_MS = 180_000
const runner = new SpawnCommandRunner()

/**
 * Synthesised segments deliberately differ in sample rate and channel count so the adapter's
 * normalisation is exercised, and differ in level so the assembled order can be verified by
 * measuring each segment's window in the finished audio.
 */
interface SegmentFixture {
  readonly durationMs: number
  readonly sampleRate: number
  readonly channels: number
  readonly frequency: number
  readonly levelDb: number
  readonly directedPauseMs: number
}

const CHAPTER_ONE: readonly SegmentFixture[] = [
  {
    durationMs: 1_500,
    sampleRate: 24_000,
    channels: 1,
    frequency: 200,
    levelDb: -12,
    directedPauseMs: 200,
  },
  {
    durationMs: 2_000,
    sampleRate: 44_100,
    channels: 2,
    frequency: 400,
    levelDb: -30,
    directedPauseMs: 450,
  },
  {
    durationMs: 1_000,
    sampleRate: 48_000,
    channels: 1,
    frequency: 600,
    levelDb: -18,
    directedPauseMs: 0,
  },
]
const CHAPTER_TWO: readonly SegmentFixture[] = [
  {
    durationMs: 1_200,
    sampleRate: 48_000,
    channels: 1,
    frequency: 300,
    levelDb: -24,
    directedPauseMs: 0,
  },
  {
    durationMs: 800,
    sampleRate: 22_050,
    channels: 1,
    frequency: 500,
    levelDb: -36,
    directedPauseMs: 2_000,
  },
]

const TAIL_PAUSE_MS = 1_000
// Chapter one exercises a directed pause, another directed pause, and a directed zero at the end
// (where the chapter tail wins). Chapter two exercises a directed zero *between* segments — so the
// two tones run together with no gap at all — and a directed 2000 ms end pause that beats the tail.
const CHAPTER_ONE_MS = 1_500 + 200 + 2_000 + 450 + 1_000 + TAIL_PAUSE_MS
const CHAPTER_TWO_MS = 1_200 + 0 + 800 + 2_000

let workspace = ''
let outputDirectory = ''
let toolchain: FfmpegToolchain
let request: AssembleAudiobookRequest
let result: AudiobookAssemblyResult

const synthesizeWav = async (path: string, fixture: SegmentFixture): Promise<void> => {
  await runChecked(
    runner,
    toolchain.ffmpegPath,
    [
      '-nostdin',
      '-hide_banner',
      '-v',
      'error',
      '-n',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${fixture.frequency}:sample_rate=${fixture.sampleRate}:duration=${
        fixture.durationMs / 1000
      }`,
      '-af',
      `volume=${fixture.levelDb}dB`,
      '-ac',
      String(fixture.channels),
      '-c:a',
      'pcm_s16le',
      path,
    ],
    'fixture synthesis',
  )
}

const synthesizeCover = async (path: string): Promise<void> => {
  await runChecked(
    runner,
    toolchain.ffmpegPath,
    [
      '-nostdin',
      '-hide_banner',
      '-v',
      'error',
      '-n',
      '-f',
      'lavfi',
      '-i',
      'color=c=navy:s=200x200:d=1',
      '-frames:v',
      '1',
      path,
    ],
    'cover synthesis',
  )
}

const probeOf = async (path: string) => {
  const probe = await runChecked(
    runner,
    toolchain.ffprobePath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      '-show_chapters',
      path,
    ],
    'probe',
  )
  return parseProbeJson(probe.stdout)
}

/** Integrated loudness and true peak of a finished file, measured the same way FFmpeg reports it. */
const measureLoudness = async (path: string): Promise<{ integrated: number; truePeak: number }> => {
  const measured = await runChecked(
    runner,
    toolchain.ffmpegPath,
    [
      '-nostdin',
      '-hide_banner',
      '-i',
      path,
      '-map',
      '0:a',
      '-filter:a',
      'loudnorm=I=-18:TP=-3:print_format=json',
      '-f',
      'null',
      '-',
    ],
    'loudness measurement',
  )
  const start = measured.stderr.lastIndexOf('{')
  const report = JSON.parse(measured.stderr.slice(start, measured.stderr.lastIndexOf('}') + 1))
  return {
    integrated: Number.parseFloat(String(report.input_i)),
    truePeak: Number.parseFloat(String(report.input_tp)),
  }
}

const rmsDbOfWindow = async (
  path: string,
  startMs: number,
  durationMs: number,
): Promise<number> => {
  const measured = await runChecked(
    runner,
    toolchain.ffmpegPath,
    [
      '-nostdin',
      '-hide_banner',
      '-ss',
      (startMs / 1000).toFixed(3),
      '-t',
      (durationMs / 1000).toFixed(3),
      '-i',
      path,
      '-filter:a',
      'astats=metadata=1:reset=0',
      '-f',
      'null',
      '-',
    ],
    'level measurement',
  )
  const match = /RMS level dB: (-?[\d.]+|-?inf)/u.exec(measured.stderr)
  if (match?.[1] === undefined) throw new Error(`no RMS level in astats output for ${path}`)
  return Number.parseFloat(match[1])
}

const silenceIntervals = async (
  path: string,
): Promise<readonly { readonly startMs: number; readonly endMs: number }[]> => {
  const measured = await runChecked(
    runner,
    toolchain.ffmpegPath,
    [
      '-nostdin',
      '-hide_banner',
      '-i',
      path,
      '-filter:a',
      'silencedetect=noise=-60dB:duration=0.15',
      '-f',
      'null',
      '-',
    ],
    'silence detection',
  )
  const intervals: { startMs: number; endMs: number }[] = []
  for (const line of measured.stderr.split('\n')) {
    const start = /silence_start: (-?[\d.]+)/u.exec(line)
    if (start?.[1] !== undefined) {
      intervals.push({ startMs: Math.round(Number.parseFloat(start[1]) * 1000), endMs: -1 })
      continue
    }
    const end = /silence_end: (-?[\d.]+)/u.exec(line)
    const open = intervals.at(-1)
    if (end?.[1] !== undefined && open !== undefined) {
      open.endMs = Math.round(Number.parseFloat(end[1]) * 1000)
    }
  }
  return intervals
}

const sha256Of = async (path: string): Promise<string> =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')

beforeAll(async () => {
  toolchain = await resolveFfmpegToolchain()
  workspace = await mkdtemp(join(tmpdir(), 'lna-assembly-integration-'))
  outputDirectory = join(workspace, 'output')
  const wavDirectory = join(workspace, 'wav')
  await mkdir(outputDirectory, { recursive: true })
  await mkdir(wavDirectory, { recursive: true })

  const coverPath = join(workspace, 'cover.png')
  await synthesizeCover(coverPath)

  const { book } = makeBook({
    coverPath,
    chapters: [
      { title: HOSTILE_CHAPTER_TITLE, pauses: CHAPTER_ONE.map((f) => f.directedPauseMs) },
      { title: 'Chapter Two — 第二章', pauses: CHAPTER_TWO.map((f) => f.directedPauseMs) },
    ],
  })
  request = makeRequest({ book, outputDirectory, wavDirectory })

  const fixtures = [CHAPTER_ONE, CHAPTER_TWO]
  for (const [chapterIndex, chapter] of request.chapters.entries()) {
    for (const [segmentIndex, item] of chapter.segments.entries()) {
      const fixture = fixtures[chapterIndex]?.[segmentIndex]
      if (fixture === undefined) throw new Error('missing segment fixture')
      await synthesizeWav(item.audio.wavPath, fixture)
    }
  }

  const assembler = await FfmpegAudioAssembler.create()
  result = await assembler.assemble(request)
}, TEST_TIMEOUT_MS)

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe('FFmpeg assembly against real audio', () => {
  it('uses the pinned FFmpeg build', () => {
    expect(toolchain.ffmpegVersion.startsWith(EXPECTED_FFMPEG_VERSION)).toBe(true)
    expect(result.manifest.toolchain.ffmpegVersion).toBe(toolchain.ffmpegVersion)
    expect(result.manifest.toolchain.ffprobeVersion).toBe(toolchain.ffprobeVersion)
  })

  it('writes exactly the reserved outputs and cleans up its staging directory', async () => {
    expect(result.m4bPath).toBe(request.reservation.m4bPath)
    expect(result.chapters.map((chapter) => chapter.path)).toStrictEqual(
      request.reservation.chapters.map((chapter) => chapter.path),
    )
    expect((await readdir(outputDirectory)).sort()).toStrictEqual(
      [
        ...request.reservation.chapters.map((chapter) => chapter.path),
        request.reservation.m4bPath,
        result.manifestPath,
      ]
        .map((path) => path.slice(outputDirectory.length + 1))
        .sort(),
    )
  })

  it('produces 48 kHz 24-bit mono FLAC chapter masters of the expected length', async () => {
    const durations = [CHAPTER_ONE_MS, CHAPTER_TWO_MS]
    for (const [index, chapter] of result.chapters.entries()) {
      const probe = await probeOf(chapter.path)
      expect(probe.formatName).toBe('flac')
      expect(probe.audio?.codecName).toBe('flac')
      expect(probe.audio?.sampleRate).toBe(48_000)
      expect(probe.audio?.channels).toBe(1)
      expect(probe.audio?.bitsPerRawSample).toBe(24)
      expect(chapter.durationMs).toBeCloseTo(durations[index] ?? 0, -1)
      expect(probe.tags.TITLE ?? probe.tags.title).toBeDefined()
    }
  })

  it('places segments in exact order with the directed and default pauses between them', async () => {
    const firstChapter = result.chapters[0]?.path
    if (firstChapter === undefined) throw new Error('chapter master missing')

    // Silence appears exactly where each pause was inserted, which is only true if the segments
    // were concatenated in source order with their own pauses.
    const intervals = await silenceIntervals(firstChapter)
    expect(intervals).toHaveLength(3)
    expect(intervals[0]?.startMs).toBeCloseTo(1_500, -2)
    expect(intervals[0]?.endMs).toBeCloseTo(1_700, -2)
    expect(intervals[1]?.startMs).toBeCloseTo(3_700, -2)
    expect(intervals[1]?.endMs).toBeCloseTo(4_150, -2)
    expect(intervals[2]?.startMs).toBeCloseTo(5_150, -2)

    // Each segment was rendered at its own level, so the level pattern proves which audio landed
    // in which slot. A swapped pair would invert these differences.
    const [first, second, third] = await Promise.all([
      rmsDbOfWindow(firstChapter, 200, 1_100),
      rmsDbOfWindow(firstChapter, 1_900, 1_600),
      rmsDbOfWindow(firstChapter, 4_300, 700),
    ])
    expect(third - first).toBeCloseTo(-6, 0)
    // Segment two is the stereo fixture, so its stereo-to-mono downmix costs a further 3 dB.
    expect(second - first).toBeCloseTo(-21, 0)
  })

  it('inserts no silence where the director asked for none, and keeps a longer end pause', async () => {
    const secondChapter = result.chapters[1]?.path
    if (secondChapter === undefined) throw new Error('chapter master missing')

    const intervals = await silenceIntervals(secondChapter)
    // Only the end pause is silent: the directed zero between the two tones produced no gap at all.
    expect(intervals).toHaveLength(1)
    expect(intervals[0]?.startMs).toBeCloseTo(2_000, -2)
    // The directed 2000 ms end pause is respected instead of being cut back to the 1000 ms tail.
    expect(result.chapters[1]?.durationMs).toBeCloseTo(CHAPTER_TWO_MS, -1)
    expect(CHAPTER_TWO_MS - 2_000).toBe(2_000)
  })

  it('exports a mono AAC-LC m4b at roughly the configured bitrate', async () => {
    const probe = await probeOf(result.m4bPath)
    expect(probe.formatName).toContain('mp4')
    expect(probe.audio?.codecName).toBe('aac')
    expect(probe.audio?.profile).toBe('LC')
    expect(probe.audio?.channels).toBe(1)
    expect(probe.audio?.sampleRate).toBe(48_000)
    // 64 kbps is the encoder target, not a floor: this fixture is tones and silence, which AAC
    // encodes for far less, so the achieved container average sits below nominal.
    expect(result.manifest.encoding.audiobookBitrateKbps).toBe(64)
    expect(probe.bitRateBps ?? 0).toBeGreaterThan(20_000)
    expect(probe.bitRateBps ?? 0).toBeLessThan(80_000)
    expect(probe.durationSeconds ?? 0).toBeCloseTo((CHAPTER_ONE_MS + CHAPTER_TWO_MS) / 1000, 1)
    expect(probe.streamCodecs).toContain('png')
  })

  it('carries one chapter marker per chapter at the measured boundaries', async () => {
    const probe = await probeOf(result.m4bPath)
    expect(probe.chapters).toHaveLength(2)
    expect(probe.chapters.map((chapter) => [chapter.startMs, chapter.endMs])).toStrictEqual(
      result.chapters.map((chapter) => [chapter.startMs, chapter.endMs]),
    )
    expect(probe.chapters[0]?.startMs).toBe(0)
    expect(probe.chapters[0]?.endMs).toBeCloseTo(CHAPTER_ONE_MS, -1)
    expect(probe.chapters[1]?.startMs).toBe(probe.chapters[0]?.endMs)
  })

  it('round-trips hostile chapter titles and book metadata through ffmetadata', async () => {
    const probe = await probeOf(result.m4bPath)
    expect(probe.chapters[0]?.title).toBe('Ch=1; #wait\\stop -y --metadata')
    expect(probe.chapters[1]?.title).toBe('Chapter Two — 第二章')
    expect(probe.tags.title).toBe('The "Book"; #1 = a\\path/name と日本語 ★')
    expect(probe.tags.artist).toBe(HOSTILE_AUTHOR)
    expect(probe.tags.album).toBe('The "Book"; #1 = a\\path/name と日本語 ★')
    // The injected `-y --metadata` text stayed a value: no extra tag was created by it.
    expect(Object.keys(probe.tags)).not.toContain('metadata')
  })

  it('lands near -18 LUFS with true peak at or below -3 dBTP', async () => {
    expect(result.manifest.loudness.limitedBy).toBe('loudness')
    const measured = await measureLoudness(result.m4bPath)
    expect(measured.integrated).toBeGreaterThan(-19.5)
    expect(measured.integrated).toBeLessThan(-16.5)
    expect(measured.truePeak).toBeLessThanOrEqual(-3)
  })

  it('records a manifest that describes the run it actually performed', async () => {
    const written = JSON.parse(await readFile(result.manifestPath, 'utf8'))
    expect(written.assemblerIdentity).toBe(result.manifest.assemblerIdentity)
    expect(written.encoding.chapterBitDepth).toBe(24)
    expect(written.encoding.audiobookBitrateKbps).toBe(64)
    expect(written.loudness.appliedGainDb).toBe(result.manifest.loudness.appliedGainDb)
    expect(written.chapters).toHaveLength(2)
    expect(written.chapters[0].segments).toHaveLength(CHAPTER_ONE.length)
    // The manifest records the book's own title; only container tags are normalised.
    expect(written.title).toBe(HOSTILE_TITLE)
    expect(written.sourceSha256).toBe(request.book.source.sha256)
  })

  it(
    'reproduces byte-identical audio from the same inputs under a new version',
    async () => {
      const second = makeRequest({
        book: request.book,
        outputDirectory,
        wavDirectory: join(workspace, 'wav'),
        version: 2,
      })
      const assembler = await FfmpegAudioAssembler.create()
      const rerun = await assembler.assemble(second)

      expect(rerun.m4bPath).not.toBe(result.m4bPath)
      expect(await sha256Of(rerun.m4bPath)).toBe(await sha256Of(result.m4bPath))
      for (const [index, chapter] of rerun.chapters.entries()) {
        const original = result.chapters[index]?.path
        if (original === undefined) throw new Error('original chapter master missing')
        expect(await sha256Of(chapter.path)).toBe(await sha256Of(original))
      }
      expect(rerun.manifest.loudness.appliedGainDb).toBe(result.manifest.loudness.appliedGainDb)

      for (const path of [
        rerun.m4bPath,
        rerun.manifestPath,
        ...rerun.chapters.map((chapter) => chapter.path),
      ]) {
        await rm(path)
      }
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'refuses a second assembly into the same reservation and leaves the export untouched',
    async () => {
      const before = await Promise.all(
        [result.m4bPath, result.manifestPath, ...result.chapters.map((c) => c.path)].map(sha256Of),
      )
      const assembler = await FfmpegAudioAssembler.create()

      await expect(assembler.assemble(request)).rejects.toBeInstanceOf(OutputExistsError)

      const after = await Promise.all(
        [result.m4bPath, result.manifestPath, ...result.chapters.map((c) => c.path)].map(sha256Of),
      )
      expect(after).toStrictEqual(before)
      expect((await readdir(outputDirectory)).length).toBe(4)
    },
    TEST_TIMEOUT_MS,
  )
})
