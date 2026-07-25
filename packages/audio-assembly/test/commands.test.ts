import { describe, expect, it } from 'vitest'
import {
  buildAudiobookArgs,
  buildChapterMasterArgs,
  buildLoudnessAnalysisArgs,
  buildProbeArgs,
  buildSegmentConcatArgs,
} from '../src/commands.js'
import { AudioAssemblyError } from '../src/errors.js'
import { DEFAULT_ASSEMBLY_SETTINGS, resolveAssemblySettings } from '../src/settings.js'
import { HOSTILE_AUTHOR, HOSTILE_CHAPTER_TITLE, HOSTILE_TITLE } from './fixtures.js'

const settings = DEFAULT_ASSEMBLY_SETTINGS

const filterGraph = (args: readonly string[]): string => {
  const index = args.indexOf('-filter_complex')
  const graph = args[index + 1]
  if (graph === undefined) throw new Error('no filter graph in command')
  return graph
}

const inputPaths = (args: readonly string[]): readonly string[] =>
  args.flatMap((arg, index) => (arg === '-i' ? [args[index + 1] ?? ''] : []))

describe('buildSegmentConcatArgs', () => {
  const inputs = [
    { path: '/w/seg-1.wav', padMs: 350 },
    { path: '/w/seg-2.wav', padMs: 0 },
    { path: '/w/seg-3.wav', padMs: 1000 },
  ]

  it('passes segments as inputs in the exact order given', () => {
    const args = buildSegmentConcatArgs({ inputs, outputPath: '/w/out.flac', settings })
    expect([...inputPaths(args)]).toStrictEqual(['/w/seg-1.wav', '/w/seg-2.wav', '/w/seg-3.wav'])
  })

  it('maps each input index onto its own filter label and concatenates in index order', () => {
    const args = buildSegmentConcatArgs({ inputs, outputPath: '/w/out.flac', settings })
    expect(filterGraph(args)).toBe(
      '[0:a]aformat=sample_fmts=s32:channel_layouts=mono:sample_rates=48000,apad=pad_dur=350ms[a0];' +
        '[1:a]aformat=sample_fmts=s32:channel_layouts=mono:sample_rates=48000[a1];' +
        '[2:a]aformat=sample_fmts=s32:channel_layouts=mono:sample_rates=48000,apad=pad_dur=1000ms[a2];' +
        '[a0][a1][a2]concat=n=3:v=0:a=1[out]',
    )
  })

  it('writes a 48 kHz 24-bit mono FLAC and refuses to overwrite', () => {
    const args = buildSegmentConcatArgs({ inputs, outputPath: '/w/out.flac', settings })
    expect(args).toContain('-n')
    expect(args.at(-1)).toBe('/w/out.flac')
    for (const [flag, value] of [
      ['-c:a', 'flac'],
      ['-sample_fmt', 's32'],
      ['-ar', '48000'],
      ['-ac', '1'],
      ['-map_metadata', '-1'],
    ] as const) {
      expect(args[args.indexOf(flag) + 1]).toBe(value)
    }
  })

  it('places +bitexact after the inputs so it applies to the written file', () => {
    const args = buildSegmentConcatArgs({ inputs, outputPath: '/w/out.flac', settings })
    const bitexact = args.indexOf('-fflags')
    expect(args[bitexact + 1]).toBe('+bitexact')
    expect(bitexact).toBeGreaterThan(args.lastIndexOf('-i'))
    for (const built of [
      buildChapterMasterArgs({
        inputPaths: ['/w/raw.flac'],
        gainDb: 0,
        tags: [],
        outputPath: '/w/ch01.flac',
        settings,
      }),
      buildAudiobookArgs({
        chapterPaths: ['/w/ch01.flac'],
        ffmetadataPath: '/w/chapters.ffmetadata',
        cover: null,
        outputPath: '/w/book-v001.m4b',
        settings,
      }),
    ]) {
      expect(built.indexOf('-fflags')).toBeGreaterThan(built.lastIndexOf('-i'))
    }
  })

  it('rejects an empty input list and a negative pause', () => {
    expect(() => buildSegmentConcatArgs({ inputs: [], outputPath: '/w/o.flac', settings })).toThrow(
      AudioAssemblyError,
    )
    expect(() =>
      buildSegmentConcatArgs({
        inputs: [{ path: '/w/a.wav', padMs: -1 }],
        outputPath: '/w/o.flac',
        settings,
      }),
    ).toThrow(/non-negative integer/u)
  })

  it('honours a changed sample format and channel count', () => {
    const stereo = resolveAssemblySettings({ chapterSampleFormat: 's16', chapterChannels: 2 })
    const args = buildSegmentConcatArgs({ inputs, outputPath: '/w/out.flac', settings: stereo })
    expect(filterGraph(args)).toContain('sample_fmts=s16:channel_layouts=stereo')
  })
})

describe('buildChapterMasterArgs', () => {
  it('applies the loudness gain and maps hostile metadata into single argv elements', () => {
    const args = buildChapterMasterArgs({
      inputPaths: ['/w/raw.flac'],
      gainDb: -2.5,
      tags: [
        ['title', HOSTILE_CHAPTER_TITLE],
        ['album', HOSTILE_TITLE],
        ['artist', HOSTILE_AUTHOR],
        ['track', '1/2'],
      ],
      outputPath: '/w/ch01.flac',
      settings,
    })

    expect(filterGraph(args)).toContain(',volume=-2.50dB[out]')
    expect(args).toContain('title=Ch=1; #wait\\stop -y --metadata')
    expect(args).toContain('album=The "Book"; #1 = a\\path/name と日本語 ★')
    expect(args).toContain('artist=A. Author; = #ghost\\writer')
    expect(args).toContain('track=1/2')
    // No metadata value may leak into the filter graph, where `:` and `;` are syntax.
    expect(filterGraph(args)).not.toMatch(/[#"★]/u)
    expect(filterGraph(args)).toMatch(/^[\w[\]:=,.;|/@+-]+$/u)
  })

  it('omits the volume filter when no gain is required', () => {
    const args = buildChapterMasterArgs({
      inputPaths: ['/w/raw.flac'],
      gainDb: 0,
      tags: [],
      outputPath: '/w/ch01.flac',
      settings,
    })
    expect(filterGraph(args)).not.toContain('volume=')
    expect(args).not.toContain('-metadata')
  })

  it('joins chapter parts in order', () => {
    const args = buildChapterMasterArgs({
      inputPaths: ['/w/part-0.flac', '/w/part-1.flac', '/w/part-2.flac'],
      gainDb: 1,
      tags: [],
      outputPath: '/w/ch01.flac',
      settings,
    })
    expect([...inputPaths(args)]).toStrictEqual([
      '/w/part-0.flac',
      '/w/part-1.flac',
      '/w/part-2.flac',
    ])
    expect(filterGraph(args)).toContain('[a0][a1][a2]concat=n=3:v=0:a=1,volume=1.00dB[out]')
  })

  it('rejects a non-finite gain', () => {
    expect(() =>
      buildChapterMasterArgs({
        inputPaths: ['/w/raw.flac'],
        gainDb: Number.NaN,
        tags: [],
        outputPath: '/w/ch01.flac',
        settings,
      }),
    ).toThrow(/finite number of decibels/u)
  })
})

describe('buildLoudnessAnalysisArgs', () => {
  it('measures the whole book in one pass and writes no file', () => {
    const args = buildLoudnessAnalysisArgs({
      inputPaths: ['/w/ch01.flac', '/w/ch02.flac'],
      settings,
    })
    expect(filterGraph(args)).toContain('concat=n=2:v=0:a=1,loudnorm=I=-18:TP=-3:print_format=json')
    expect(args.slice(-3)).toStrictEqual(['-f', 'null', '-'])
    expect(args).not.toContain('-n')
  })
})

describe('buildAudiobookArgs', () => {
  const chapterPaths = ['/w/ch01.flac', '/w/ch02.flac']

  it('orders chapters, then the ffmetadata input, then the cover', () => {
    const args = buildAudiobookArgs({
      chapterPaths,
      ffmetadataPath: '/w/chapters.ffmetadata',
      cover: { path: '/w/cover.jpg', handling: 'copy' },
      outputPath: '/w/book-v001.m4b',
      settings,
    })
    expect([...inputPaths(args)]).toStrictEqual([
      '/w/ch01.flac',
      '/w/ch02.flac',
      '/w/chapters.ffmetadata',
      '/w/cover.jpg',
    ])
    expect(args[args.indexOf('-map_metadata') + 1]).toBe('2')
    expect(args[args.indexOf('-map_chapters') + 1]).toBe('2')
    expect(args[args.indexOf('-map', args.indexOf('-map') + 1) + 1]).toBe('3:v')
    expect(args[args.indexOf('-c:v') + 1]).toBe('copy')
    expect(args[args.indexOf('-disposition:v') + 1]).toBe('attached_pic')
  })

  it('encodes mono AAC-LC at the configured bitrate into an m4b container', () => {
    const args = buildAudiobookArgs({
      chapterPaths,
      ffmetadataPath: '/w/chapters.ffmetadata',
      cover: null,
      outputPath: '/w/book-v001.m4b',
      settings,
    })
    for (const [flag, value] of [
      ['-c:a', 'aac'],
      ['-profile:a', 'aac_low'],
      ['-b:a', '64k'],
      ['-ac', '1'],
      ['-ar', '48000'],
      ['-movflags', '+faststart'],
      ['-f', 'ipod'],
    ] as const) {
      expect(args[args.indexOf(flag) + 1]).toBe(value)
    }
    expect(args.at(-1)).toBe('/w/book-v001.m4b')
    expect(args).toContain('-n')
    expect(args).not.toContain('-c:v')
  })

  it('transcodes a cover that the container cannot carry as-is', () => {
    const args = buildAudiobookArgs({
      chapterPaths,
      ffmetadataPath: '/w/chapters.ffmetadata',
      cover: { path: '/w/cover.webp', handling: 'transcode' },
      outputPath: '/w/book-v001.m4b',
      settings,
    })
    expect(args[args.indexOf('-c:v') + 1]).toBe('mjpeg')
  })
})

describe('buildProbeArgs', () => {
  it('asks for format, streams, and chapters as JSON', () => {
    expect([...buildProbeArgs('/w/book-v001.m4b')]).toStrictEqual([
      '-hide_banner',
      '-loglevel',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      '-show_chapters',
      '/w/book-v001.m4b',
    ])
  })
})
