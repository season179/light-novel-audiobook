import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { CommandResult, CommandRunner } from '../src/command-runner.js'
import type { FfmpegToolchain } from '../src/ffmpeg-toolchain.js'

export const FAKE_TOOLCHAIN: FfmpegToolchain = Object.freeze({
  ffmpegPath: '/opt/ffmpeg/ffmpeg',
  ffprobePath: '/opt/ffmpeg/ffprobe',
  ffmpegVersion: '7.0.2-static',
  ffprobeVersion: '7.0.2-static',
})

export interface FakeInvocation {
  readonly executable: string
  readonly args: readonly string[]
}

export interface FakeFfmpegOptions {
  /** Duration reported for each chapter master, in book order. */
  readonly chapterDurationsMs: readonly number[]
  readonly measuredIntegratedLufs?: string
  readonly measuredTruePeakDbtp?: string
  readonly coverCodec?: string
  /** Chapter marker boundaries to report instead of the true ones, to prove the adapter checks. */
  readonly reportedChapterMarkers?: readonly (readonly [startMs: number, endMs: number])[]
}

const SAMPLE_RATE = 48_000

const chapterIndexFor = (outputPath: string): number => {
  const name = basename(outputPath)
  const master = /^master-(\d{4})\./u.exec(name)
  if (master?.[1] !== undefined) return Number.parseInt(master[1], 10)
  const raw = /^raw-(\d{4})\./u.exec(name)
  if (raw?.[1] !== undefined) return Number.parseInt(raw[1], 10) - 1
  const part = /^part-(\d{4})-/u.exec(name)
  if (part?.[1] !== undefined) return Number.parseInt(part[1], 10) - 1
  return 0
}

/**
 * Stands in for the real binaries so the assembly flow can be exercised without audio. It records
 * every argument vector, writes placeholder files where FFmpeg would write output, and answers
 * probes with the shape ffprobe really returns.
 */
export class FakeFfmpeg implements CommandRunner {
  readonly invocations: FakeInvocation[] = []
  private readonly options: FakeFfmpegOptions

  constructor(options: FakeFfmpegOptions) {
    this.options = options
  }

  get ffmpegInvocations(): readonly FakeInvocation[] {
    return this.invocations.filter((invocation) => invocation.executable.endsWith('ffmpeg'))
  }

  argsFor(predicate: (args: readonly string[]) => boolean): readonly string[] {
    const found = this.invocations.find((invocation) => predicate(invocation.args))
    if (found === undefined) throw new Error('no matching invocation')
    return found.args
  }

  async run(executable: string, args: readonly string[]): Promise<CommandResult> {
    this.invocations.push({ executable, args: [...args] })
    if (executable.endsWith('ffprobe')) return this.probe(args)
    if (args.at(-1) === '-') return this.analyse()
    return await this.encode(args)
  }

  private analyse(): CommandResult {
    const report = {
      input_i: this.options.measuredIntegratedLufs ?? '-22.55',
      input_tp: this.options.measuredTruePeakDbtp ?? '-18.06',
      input_lra: '2.50',
      input_thresh: '-32.63',
      target_offset: '-0.61',
    }
    return {
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: `[Parsed_loudnorm_0 @ 0x1] \n${JSON.stringify(report, null, 1)}\n`,
    }
  }

  private async encode(args: readonly string[]): Promise<CommandResult> {
    const outputPath = args.at(-1)
    if (outputPath === undefined) throw new Error('command has no output path')
    await writeFile(outputPath, `fake audio for ${basename(outputPath)}`, 'utf8')
    return { exitCode: 0, signal: null, stdout: '', stderr: '' }
  }

  private durationMs(outputPath: string): number {
    return this.options.chapterDurationsMs[chapterIndexFor(outputPath)] ?? 1_000
  }

  private probe(args: readonly string[]): CommandResult {
    const target = args.at(-1)
    if (target === undefined) throw new Error('probe has no target')
    if (args.includes('v:0')) {
      return {
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify({
          streams: [{ codec_name: this.options.coverCodec ?? 'mjpeg', codec_type: 'video' }],
        }),
        stderr: '',
      }
    }
    if (target.endsWith('.flac')) {
      const durationMs = this.durationMs(target)
      return {
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify({
          streams: [
            {
              codec_name: 'flac',
              codec_type: 'audio',
              sample_fmt: 's32',
              sample_rate: String(SAMPLE_RATE),
              channels: 1,
              bits_per_raw_sample: '24',
              time_base: `1/${SAMPLE_RATE}`,
              duration_ts: (durationMs / 1000) * SAMPLE_RATE,
              duration: (durationMs / 1000).toFixed(6),
            },
          ],
          format: { format_name: 'flac', duration: (durationMs / 1000).toFixed(6), size: '1024' },
          chapters: [],
        }),
        stderr: '',
      }
    }
    const markers = this.markers()
    return {
      exitCode: 0,
      signal: null,
      stdout: JSON.stringify({
        streams: [
          {
            codec_name: 'aac',
            codec_type: 'audio',
            profile: 'LC',
            sample_rate: '48000',
            channels: 1,
            sample_fmt: 'fltp',
          },
        ],
        format: {
          format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
          duration: ((markers.at(-1)?.end ?? 0) / 1000).toFixed(6),
          size: '65536',
          bit_rate: '64000',
          tags: { title: 'probed title' },
        },
        chapters: markers.map((marker) => ({
          time_base: '1/1000',
          start: marker.start,
          end: marker.end,
          tags: { title: `marker ${marker.start}` },
        })),
      }),
      stderr: '',
    }
  }

  private markers(): readonly { readonly start: number; readonly end: number }[] {
    if (this.options.reportedChapterMarkers !== undefined) {
      return this.options.reportedChapterMarkers.map(([start, end]) => ({ start, end }))
    }
    let cursor = 0
    return this.options.chapterDurationsMs.map((durationMs) => {
      const start = cursor
      cursor += durationMs
      return { start, end: cursor }
    })
  }
}
