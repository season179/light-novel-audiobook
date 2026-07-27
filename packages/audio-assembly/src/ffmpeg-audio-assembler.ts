import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AssembleAudiobookRequest, AudioAssembler } from '@light-novel-audiobook/application'
import type {
  AudiobookOutput,
  ChapterAudioOutput,
  OutputVersion,
} from '@light-novel-audiobook/domain'
import { type AssemblyPlan, type PlannedChapter, planAssembly } from './assembly-plan.js'
import { buildBookTags, buildChapterTags } from './book-metadata.js'
import { type CommandRunner, runChecked, SpawnCommandRunner } from './command-runner.js'
import {
  buildAudiobookArgs,
  buildChapterMasterArgs,
  buildCoverProbeArgs,
  buildLoudnessAnalysisArgs,
  buildProbeArgs,
  buildSegmentConcatArgs,
  type CoverArtHandling,
} from './commands.js'
import { AudioAssemblyError } from './errors.js'
import { buildFfmetadata } from './ffmetadata.js'
import { type FfmpegToolchain, resolveFfmpegToolchain } from './ffmpeg-toolchain.js'
import { type ProbeResult, parseProbeJson, probedDurationMs } from './ffprobe.js'
import { computeLoudnessGainDb, parseLoudnormMeasurement } from './loudness.js'
import {
  ASSEMBLY_MANIFEST_SCHEMA,
  type AssemblyManifest,
  chapterBitDepth,
  createAssemblerIdentity,
  type ManifestChapterEntry,
  measurementForManifest,
  serializeManifest,
} from './manifest.js'
import {
  assertOutputAbsent,
  assertOutputPresent,
  claimOutputPath,
  pathExists,
  rollbackClaimedOutputs,
} from './no-overwrite.js'
import { type AssemblySettings, resolveAssemblySettings } from './settings.js'

export interface AssembledChapterOutput extends ChapterAudioOutput {
  readonly position: number
  readonly durationMs: number
  readonly startMs: number
  readonly endMs: number
  readonly probe: ProbeResult
}

/**
 * The port's `AudiobookOutput` plus the probe results, manifest, and warnings this adapter is asked
 * to report back. It is a widening of the port type, so the port contract is unchanged.
 */
export interface AudiobookAssemblyResult extends AudiobookOutput {
  readonly version: OutputVersion
  readonly m4bPath: string
  readonly chapters: readonly AssembledChapterOutput[]
  readonly manifestPath: string
  readonly manifest: AssemblyManifest
  readonly probe: ProbeResult
  readonly warnings: readonly string[]
}

export interface FfmpegAudioAssemblerOptions {
  readonly settings?: Partial<AssemblySettings>
  /** FFmpeg directory, version pinning, and command runner used to resolve the toolchain. */
  readonly toolchainDirectory?: string
  readonly requireExpectedVersion?: boolean
  readonly runner?: CommandRunner
}

interface StagedChapter {
  readonly chapter: PlannedChapter
  readonly stagedPath: string
  readonly probe: ProbeResult
  readonly durationMs: number
  readonly startMs: number
  readonly endMs: number
}

const COPYABLE_COVER_CODECS = new Set(['mjpeg', 'png'])

/**
 * How far the encoded book may sit from the span its chapter markers cover. Lossy encoding and
 * container edit lists are exact enough on the pinned build that this only fires on a real
 * divergence, not on normal priming or per-chapter millisecond rounding.
 */
const MAX_TOTAL_DURATION_DRIFT_MS = 50

const stopped = (signal?: AbortSignal): boolean => signal?.aborted === true

/**
 * FFmpeg/FFprobe implementation of the application's `AudioAssembler` port.
 *
 * Every output is encoded into a staging directory first and only then claimed at its reserved path,
 * so a failed run cannot leave a half-written export where a valid one is expected.
 */
export class FfmpegAudioAssembler implements AudioAssembler {
  readonly identity: string
  private readonly settings: AssemblySettings
  private readonly toolchain: FfmpegToolchain
  private readonly runner: CommandRunner

  constructor(input: {
    readonly toolchain: FfmpegToolchain
    readonly settings?: Partial<AssemblySettings>
    readonly runner?: CommandRunner
  }) {
    this.settings = resolveAssemblySettings(input.settings)
    this.toolchain = input.toolchain
    this.runner = input.runner ?? new SpawnCommandRunner()
    this.identity = createAssemblerIdentity({
      settings: this.settings,
      ffmpegVersion: this.toolchain.ffmpegVersion,
      ffprobeVersion: this.toolchain.ffprobeVersion,
    })
  }

  /** Resolves and verifies the pinned toolchain, then binds its versions into the identity. */
  static async create(options: FfmpegAudioAssemblerOptions = {}): Promise<FfmpegAudioAssembler> {
    const toolchain = await resolveFfmpegToolchain({
      ...(options.toolchainDirectory === undefined
        ? {}
        : { directory: options.toolchainDirectory }),
      ...(options.requireExpectedVersion === undefined
        ? {}
        : { requireExpectedVersion: options.requireExpectedVersion }),
      ...(options.runner === undefined ? {} : { runner: options.runner }),
    })
    return new FfmpegAudioAssembler({
      toolchain,
      ...(options.settings === undefined ? {} : { settings: options.settings }),
      ...(options.runner === undefined ? {} : { runner: options.runner }),
    })
  }

  async assemble(request: AssembleAudiobookRequest): Promise<AudiobookAssemblyResult> {
    if (stopped(request.signal)) throw new AudioAssemblyError('Audio assembly was stopped')
    const plan = planAssembly(request, this.settings)
    const warnings: string[] = []

    await this.assertSegmentAudioPresent(plan)
    const outputPaths = [
      plan.m4bPath,
      plan.manifestPath,
      ...plan.chapters.map((chapter) => chapter.outputPath),
    ]
    for (const path of outputPaths) {
      await assertOutputAbsent(path)
    }
    // Reserved directories normally already exist; creating them keeps a fresh workspace usable
    // without ever touching a reserved file.
    for (const directory of new Set(outputPaths.map((path) => dirname(path)))) {
      await mkdir(directory, { recursive: true })
    }

    // Staging lives beside the export so claiming an output is a rename-class operation, not a copy.
    const stagingRoot = await mkdtemp(join(dirname(plan.m4bPath), '.lna-assembly-'))
    try {
      const rawChapters: string[] = []
      for (const chapter of plan.chapters) {
        rawChapters.push(await this.buildRawChapter(chapter, stagingRoot, request.signal))
      }

      const measurement = await this.measureBookLoudness(rawChapters, request.signal)
      const gain = computeLoudnessGainDb({
        measurement,
        targetLoudnessLufs: this.settings.targetLoudnessLufs,
        maxTruePeakDbtp: this.settings.maxTruePeakDbtp,
        loudnessFloorLufs: this.settings.loudnessFloorLufs,
      })
      if (gain.warning !== null) warnings.push(gain.warning)

      const staged: StagedChapter[] = []
      // Marker positions accumulate chapter durations already rounded to whole milliseconds, so a
      // marker can sit up to half a millisecond per preceding chapter away from the exact sample
      // boundary. The chapter timebase is milliseconds, so that rounding is unavoidable and the drift
      // stays far below anything audible or seekable.
      let cursorMs = 0
      for (const [index, chapter] of plan.chapters.entries()) {
        const rawPath = rawChapters[index]
        if (rawPath === undefined) throw new AudioAssemblyError('Missing staged chapter audio')
        const stagedPath = join(stagingRoot, `master-${String(index).padStart(4, '0')}.flac`)
        await this.runFfmpeg(
          buildChapterMasterArgs({
            inputPaths: [rawPath],
            gainDb: gain.gainDb,
            tags: buildChapterTags(plan, chapter),
            outputPath: stagedPath,
            settings: this.settings,
          }),
          `Chapter master for ${chapter.chapterId}`,
          request.signal,
        )
        await assertOutputPresent(stagedPath, `Chapter master for ${chapter.chapterId}`)
        const probe = await this.probe(stagedPath, request.signal)
        this.assertChapterFormat(chapter, probe)
        const durationMs = probedDurationMs(probe)
        staged.push({
          chapter,
          stagedPath,
          probe,
          durationMs,
          startMs: cursorMs,
          endMs: cursorMs + durationMs,
        })
        cursorMs += durationMs
      }

      const ffmetadataPath = join(stagingRoot, 'chapters.ffmetadata')
      await writeFile(
        ffmetadataPath,
        buildFfmetadata({
          tags: buildBookTags(plan),
          chapters: staged.map((entry) => ({
            startMs: entry.startMs,
            endMs: entry.endMs,
            title: entry.chapter.title,
          })),
        }),
        'utf8',
      )

      const cover = await this.resolveCover(plan, warnings, request.signal)
      const stagedM4b = join(stagingRoot, 'audiobook.m4b')
      await this.runFfmpeg(
        buildAudiobookArgs({
          chapterPaths: staged.map((entry) => entry.stagedPath),
          ffmetadataPath,
          cover,
          outputPath: stagedM4b,
          settings: this.settings,
        }),
        'Audiobook export',
        request.signal,
      )
      await assertOutputPresent(stagedM4b, 'Audiobook export')
      const bookProbe = await this.probe(stagedM4b, request.signal)
      this.assertAudiobook(plan, staged, bookProbe)

      const manifest = this.buildManifest({ plan, staged, measurement, gain, cover, warnings })
      const stagedManifest = join(stagingRoot, 'manifest.json')
      await writeFile(stagedManifest, serializeManifest(manifest), 'utf8')

      const claims: (readonly [staged: string, final: string])[] = [
        ...staged.map((entry) => [entry.stagedPath, entry.chapter.outputPath] as const),
        [stagedM4b, plan.m4bPath] as const,
        [stagedManifest, plan.manifestPath] as const,
      ]
      const claimed: string[] = []
      try {
        for (const [source, destination] of claims) {
          if (stopped(request.signal)) {
            throw new AudioAssemblyError('Audio assembly was stopped')
          }
          await claimOutputPath(source, destination)
          claimed.push(destination)
        }
      } catch (error) {
        await rollbackClaimedOutputs(claimed)
        throw error
      }

      return {
        version: plan.version,
        m4bPath: plan.m4bPath,
        chapters: staged.map((entry) => ({
          chapterId: entry.chapter.chapterId,
          path: entry.chapter.outputPath,
          position: entry.chapter.position,
          durationMs: entry.durationMs,
          startMs: entry.startMs,
          endMs: entry.endMs,
          probe: entry.probe,
        })),
        manifestPath: plan.manifestPath,
        manifest,
        probe: bookProbe,
        warnings: Object.freeze([...warnings]),
      }
    } finally {
      await rm(stagingRoot, { recursive: true, force: true })
    }
  }

  private async assertSegmentAudioPresent(plan: AssemblyPlan): Promise<void> {
    for (const chapter of plan.chapters) {
      for (const segment of chapter.segments) {
        if (!(await pathExists(segment.wavPath))) {
          throw new AudioAssemblyError(
            `Rendered audio for segment ${segment.segmentId} is missing: ${segment.wavPath}`,
          )
        }
      }
    }
  }

  /** Concatenates a chapter in ordered batches so a very long chapter cannot exhaust input slots. */
  private async buildRawChapter(
    chapter: PlannedChapter,
    stagingRoot: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const partPaths: string[] = []
    for (const [passIndex, pass] of chapter.passes.entries()) {
      const partPath = join(
        stagingRoot,
        `part-${String(chapter.position).padStart(4, '0')}-${String(passIndex).padStart(4, '0')}.flac`,
      )
      await this.runFfmpeg(
        buildSegmentConcatArgs({
          inputs: pass.map((segment) => ({ path: segment.wavPath, padMs: segment.padMs })),
          outputPath: partPath,
          settings: this.settings,
        }),
        `Segment concatenation for ${chapter.chapterId} pass ${passIndex + 1}`,
        signal,
      )
      await assertOutputPresent(partPath, `Segment concatenation for ${chapter.chapterId}`)
      partPaths.push(partPath)
    }
    if (partPaths.length === 1) {
      const only = partPaths[0]
      if (only === undefined) throw new AudioAssemblyError('Missing staged chapter part')
      return only
    }
    const joinedPath = join(stagingRoot, `raw-${String(chapter.position).padStart(4, '0')}.flac`)
    await this.runFfmpeg(
      buildChapterMasterArgs({
        inputPaths: partPaths,
        gainDb: 0,
        tags: [],
        outputPath: joinedPath,
        settings: this.settings,
      }),
      `Chapter join for ${chapter.chapterId}`,
      signal,
    )
    await assertOutputPresent(joinedPath, `Chapter join for ${chapter.chapterId}`)
    return joinedPath
  }

  private async measureBookLoudness(chapterPaths: readonly string[], signal?: AbortSignal) {
    const result = await runChecked(
      this.runner,
      this.toolchain.ffmpegPath,
      buildLoudnessAnalysisArgs({ inputPaths: chapterPaths, settings: this.settings }),
      'Book loudness analysis',
      signal,
    )
    return parseLoudnormMeasurement(result.stderr)
  }

  private async resolveCover(
    plan: AssemblyPlan,
    warnings: string[],
    signal?: AbortSignal,
  ): Promise<{ readonly path: string; readonly handling: CoverArtHandling } | null> {
    if (plan.coverPath === null) return null
    if (!(await pathExists(plan.coverPath))) {
      warnings.push(`Cover art is missing and was not embedded: ${plan.coverPath}`)
      return null
    }
    const result = await this.runner.run(
      this.toolchain.ffprobePath,
      buildCoverProbeArgs(plan.coverPath),
      signal,
    )
    if (result.exitCode !== 0) {
      warnings.push(`Cover art could not be read and was not embedded: ${plan.coverPath}`)
      return null
    }
    const codec = parseProbeJson(result.stdout).streamCodecs[0]
    if (codec === undefined) {
      warnings.push(`Cover art has no image stream and was not embedded: ${plan.coverPath}`)
      return null
    }
    return {
      path: plan.coverPath,
      handling: COPYABLE_COVER_CODECS.has(codec) ? 'copy' : 'transcode',
    }
  }

  private assertChapterFormat(chapter: PlannedChapter, probe: ProbeResult): void {
    const audio = probe.audio
    if (audio === null) {
      throw new AudioAssemblyError(`Chapter master for ${chapter.chapterId} has no audio stream`)
    }
    const expectedBitDepth = chapterBitDepth(this.settings)
    if (
      audio.codecName !== 'flac' ||
      audio.sampleRate !== this.settings.chapterSampleRate ||
      audio.channels !== this.settings.chapterChannels ||
      (audio.bitsPerRawSample !== null && audio.bitsPerRawSample !== expectedBitDepth)
    ) {
      throw new AudioAssemblyError(
        `Chapter master for ${chapter.chapterId} is ${audio.codecName} ${audio.sampleRate} Hz ${audio.channels}ch ${String(audio.bitsPerRawSample)}-bit, not FLAC ${this.settings.chapterSampleRate} Hz ${this.settings.chapterChannels}ch ${expectedBitDepth}-bit`,
      )
    }
  }

  private assertAudiobook(
    plan: AssemblyPlan,
    staged: readonly StagedChapter[],
    probe: ProbeResult,
  ): void {
    const audio = probe.audio
    if (audio === null || audio.codecName !== 'aac') {
      throw new AudioAssemblyError('Audiobook export does not contain an AAC audio stream')
    }
    if (audio.channels !== this.settings.audiobookChannels) {
      throw new AudioAssemblyError(
        `Audiobook export has ${audio.channels} channels, expected ${this.settings.audiobookChannels}`,
      )
    }
    if (probe.chapters.length !== plan.chapters.length) {
      throw new AudioAssemblyError(
        `Audiobook export has ${probe.chapters.length} chapter markers, expected ${plan.chapters.length}`,
      )
    }
    for (const [index, marker] of probe.chapters.entries()) {
      const expected = staged[index]
      if (expected === undefined) throw new AudioAssemblyError('Unexpected chapter marker')
      if (marker.startMs !== expected.startMs || marker.endMs !== expected.endMs) {
        throw new AudioAssemblyError(
          `Chapter marker ${index + 1} spans ${marker.startMs}..${marker.endMs} ms but chapter audio spans ${expected.startMs}..${expected.endMs} ms`,
        )
      }
    }
    // The marker comparison above is a round trip of numbers this adapter wrote: the muxer stores
    // whatever ffmetadata declares, even a span longer than the audio. Only the encoded stream's own
    // duration can catch a real divergence between the chapter boundaries and the audio behind them.
    const expectedTotalMs = staged.at(-1)?.endMs ?? 0
    const encodedTotalMs = probedDurationMs(probe)
    if (Math.abs(encodedTotalMs - expectedTotalMs) > MAX_TOTAL_DURATION_DRIFT_MS) {
      throw new AudioAssemblyError(
        `Audiobook export is ${encodedTotalMs} ms long but its chapter markers cover ${expectedTotalMs} ms`,
      )
    }
  }

  private buildManifest(input: {
    readonly plan: AssemblyPlan
    readonly staged: readonly StagedChapter[]
    readonly measurement: ReturnType<typeof parseLoudnormMeasurement>
    readonly gain: ReturnType<typeof computeLoudnessGainDb>
    readonly cover: { readonly path: string } | null
    readonly warnings: readonly string[]
  }): AssemblyManifest {
    const chapters: ManifestChapterEntry[] = input.staged.map((entry) => ({
      chapterId: entry.chapter.chapterId,
      position: entry.chapter.position,
      title: entry.chapter.title,
      path: entry.chapter.outputPath,
      durationMs: entry.durationMs,
      startMs: entry.startMs,
      endMs: entry.endMs,
      segments: entry.chapter.segments.map((segment) => ({
        segmentId: segment.segmentId,
        sha256: segment.sha256,
      })),
    }))

    return {
      schema: ASSEMBLY_MANIFEST_SCHEMA,
      assemblerIdentity: this.identity,
      bookId: input.plan.bookId,
      title: input.plan.title,
      author: input.plan.author,
      sourceSha256: input.plan.sourceSha256,
      version: input.plan.version.value,
      versionLabel: input.plan.version.label,
      m4bPath: input.plan.m4bPath,
      toolchain: {
        ffmpegVersion: this.toolchain.ffmpegVersion,
        ffprobeVersion: this.toolchain.ffprobeVersion,
      },
      encoding: {
        chapterCodec: 'flac',
        chapterSampleRate: this.settings.chapterSampleRate,
        chapterSampleFormat: this.settings.chapterSampleFormat,
        chapterBitDepth: chapterBitDepth(this.settings),
        chapterChannels: this.settings.chapterChannels,
        flacCompressionLevel: this.settings.flacCompressionLevel,
        audiobookContainer: 'm4b',
        audiobookMuxer: 'ipod',
        audiobookCodec: 'aac',
        audiobookProfile: 'aac_low',
        audiobookBitrateKbps: this.settings.audiobookBitrateKbps,
        audiobookSampleRate: this.settings.audiobookSampleRate,
        audiobookChannels: this.settings.audiobookChannels,
      },
      pauses: {
        defaultSegmentPauseMs: this.settings.defaultSegmentPauseMs,
        minSegmentPauseMs: this.settings.minSegmentPauseMs,
        maxSegmentPauseMs: this.settings.maxSegmentPauseMs,
        chapterTailPauseMs: this.settings.chapterTailPauseMs,
      },
      loudness: {
        targetLufs: this.settings.targetLoudnessLufs,
        maxTruePeakDbtp: this.settings.maxTruePeakDbtp,
        ...measurementForManifest(input.measurement),
        appliedGainDb: input.gain.gainDb,
        limitedBy: input.gain.limitedBy,
      },
      coverPath: input.cover === null ? null : input.cover.path,
      chapters,
      warnings: Object.freeze([...input.warnings]),
    }
  }

  private async runFfmpeg(
    args: readonly string[],
    description: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await runChecked(this.runner, this.toolchain.ffmpegPath, args, description, signal)
  }

  private async probe(path: string, signal?: AbortSignal): Promise<ProbeResult> {
    const result = await runChecked(
      this.runner,
      this.toolchain.ffprobePath,
      buildProbeArgs(path),
      `Probe of ${path}`,
      signal,
    )
    return parseProbeJson(result.stdout)
  }
}
