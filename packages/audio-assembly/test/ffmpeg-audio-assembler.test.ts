import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { AssembleAudiobookRequest } from '@light-novel-audiobook/application'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AssemblyOrderError, AudioAssemblyError, OutputExistsError } from '../src/errors.js'
import { FfmpegAudioAssembler } from '../src/ffmpeg-audio-assembler.js'
import { canonicalJson, serializeManifest } from '../src/manifest.js'
import { FAKE_TOOLCHAIN, FakeFfmpeg } from './fake-ffmpeg.js'
import { HOSTILE_CHAPTER_TITLE, makeBook, makeRequest } from './fixtures.js'

let workspace = ''
let outputDirectory = ''
let wavDirectory = ''

const CHAPTER_DURATIONS_MS = [5_300, 3_200]

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'lna-assembler-'))
  outputDirectory = join(workspace, 'output')
  wavDirectory = join(workspace, 'wav')
  await mkdir(outputDirectory, { recursive: true })
  await mkdir(wavDirectory, { recursive: true })
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

const buildRequest = async (options: { readonly coverPath?: string | null } = {}) => {
  const { book } = makeBook({
    ...(options.coverPath === undefined ? {} : { coverPath: options.coverPath }),
    chapters: [
      { title: HOSTILE_CHAPTER_TITLE, pauses: [200, 0] },
      { title: 'Chapter Two', pauses: [0] },
    ],
  })
  const request = makeRequest({ book, outputDirectory, wavDirectory })
  for (const chapter of request.chapters) {
    for (const { audio } of chapter.segments) {
      await writeFile(audio.wavPath, 'fake wav', 'utf8')
    }
  }
  return request
}

const assemblerFor = (runner: FakeFfmpeg): FfmpegAudioAssembler =>
  new FfmpegAudioAssembler({ toolchain: FAKE_TOOLCHAIN, runner })

describe('FfmpegAudioAssembler identity', () => {
  it('binds the FFmpeg build and every encoding and pause setting', () => {
    const runner = new FakeFfmpeg({ chapterDurationsMs: CHAPTER_DURATIONS_MS })
    const base = assemblerFor(runner)
    expect(base.identity).toMatch(/^ffmpeg-assembly\/1\+[\da-f]{16}$/u)
    expect(assemblerFor(runner).identity).toBe(base.identity)

    const changedPause = new FfmpegAudioAssembler({
      toolchain: FAKE_TOOLCHAIN,
      runner,
      settings: { defaultSegmentPauseMs: 500 },
    })
    const changedBuild = new FfmpegAudioAssembler({
      toolchain: { ...FAKE_TOOLCHAIN, ffmpegVersion: '7.1.0-static' },
      runner,
    })
    expect(changedPause.identity).not.toBe(base.identity)
    expect(changedBuild.identity).not.toBe(base.identity)
  })
})

describe('FfmpegAudioAssembler.assemble', () => {
  it('honours the reservation and returns paths, probe results, and a manifest', async () => {
    const request = await buildRequest()
    const runner = new FakeFfmpeg({ chapterDurationsMs: CHAPTER_DURATIONS_MS })
    const result = await assemblerFor(runner).assemble(request)

    expect(result.version.value).toBe(request.reservation.version.value)
    expect(result.m4bPath).toBe(request.reservation.m4bPath)
    expect(result.chapters.map((chapter) => chapter.chapterId)).toStrictEqual(
      request.reservation.chapters.map((chapter) => chapter.chapterId),
    )
    expect(result.chapters.map((chapter) => chapter.path)).toStrictEqual(
      request.reservation.chapters.map((chapter) => chapter.path),
    )
    expect(result.probe.audio?.codecName).toBe('aac')
    expect(result.probe.chapters).toHaveLength(2)
    expect(result.warnings).toStrictEqual([])

    for (const path of [
      result.m4bPath,
      result.manifestPath,
      ...result.chapters.map((c) => c.path),
    ]) {
      await expect(readFile(path, 'utf8')).resolves.not.toBe('')
    }
  })

  it('computes chapter markers from measured chapter durations', async () => {
    const request = await buildRequest()
    const runner = new FakeFfmpeg({ chapterDurationsMs: CHAPTER_DURATIONS_MS })
    const result = await assemblerFor(runner).assemble(request)

    expect(result.chapters.map((chapter) => [chapter.startMs, chapter.endMs])).toStrictEqual([
      [0, 5_300],
      [5_300, 8_500],
    ])

    const ffmetadataPath = runner
      .argsFor((args) => args.includes('ipod'))
      .find((arg) => arg.endsWith('.ffmetadata'))
    expect(ffmetadataPath).toBeDefined()
    expect(result.manifest.chapters.map((chapter) => chapter.durationMs)).toStrictEqual([
      5_300, 3_200,
    ])
  })

  it('writes escaped chapter markers and book tags into the ffmetadata document', async () => {
    const request = await buildRequest()
    const runner = new FakeFfmpeg({ chapterDurationsMs: CHAPTER_DURATIONS_MS })
    let captured = ''
    const assembler = new FfmpegAudioAssembler({
      toolchain: FAKE_TOOLCHAIN,
      runner: {
        async run(executable, args) {
          if (args.includes('ipod')) {
            const path = args.find((arg) => arg.endsWith('.ffmetadata'))
            if (path !== undefined) captured = await readFile(path, 'utf8')
          }
          return await runner.run(executable, args)
        },
      },
    })
    await assembler.assemble(request)

    expect(captured.startsWith(';FFMETADATA1\n')).toBe(true)
    expect(captured).toContain('title=The "Book"\\; \\#1 \\= a\\\\path/name と日本語 ★')
    expect(captured).toContain('artist=A. Author\\; \\= \\#ghost\\\\writer')
    expect(captured).toContain('album_artist=A. Author\\; \\= \\#ghost\\\\writer')
    expect(captured).toContain('media_type=2')
    expect(captured).toContain('START=0\nEND=5300\ntitle=Ch\\=1\\; \\#wait\\\\stop -y --metadata')
    expect(captured).toContain('START=5300\nEND=8500\ntitle=Chapter Two')
  })

  it('concatenates every segment WAV in chapter and source order', async () => {
    const request = await buildRequest()
    const runner = new FakeFfmpeg({ chapterDurationsMs: CHAPTER_DURATIONS_MS })
    await assemblerFor(runner).assemble(request)

    const concatCommands = runner.ffmpegInvocations.filter((invocation) =>
      basename(invocation.args.at(-1) ?? '').startsWith('part-'),
    )
    expect(concatCommands).toHaveLength(2)
    const inputsOf = (args: readonly string[]) =>
      args.flatMap((arg, index) => (arg === '-i' ? [args[index + 1] ?? ''] : []))

    const expectedFirst = request.chapters[0]?.segments.map((item) => item.audio.wavPath)
    const expectedSecond = request.chapters[1]?.segments.map((item) => item.audio.wavPath)
    expect(inputsOf(concatCommands[0]?.args ?? [])).toStrictEqual(expectedFirst)
    expect(inputsOf(concatCommands[1]?.args ?? [])).toStrictEqual(expectedSecond)
  })

  it('applies one book-wide loudness gain to every chapter master', async () => {
    const request = await buildRequest()
    const runner = new FakeFfmpeg({
      chapterDurationsMs: CHAPTER_DURATIONS_MS,
      measuredIntegratedLufs: '-22.55',
      measuredTruePeakDbtp: '-18.06',
    })
    const result = await assemblerFor(runner).assemble(request)

    expect(result.manifest.loudness).toMatchObject({
      targetLufs: -18,
      maxTruePeakDbtp: -3,
      measuredIntegratedLufs: -22.55,
      measuredTruePeakDbtp: -18.06,
      appliedGainDb: 4.55,
      limitedBy: 'loudness',
    })
    const masterCommands = runner.ffmpegInvocations.filter((invocation) =>
      basename(invocation.args.at(-1) ?? '').startsWith('master-'),
    )
    expect(masterCommands).toHaveLength(2)
    for (const command of masterCommands) {
      expect(command.args.join(' ')).toContain('volume=4.55dB')
    }
  })

  it('reports a warning instead of failing when the book cannot be measured', async () => {
    const request = await buildRequest()
    const runner = new FakeFfmpeg({
      chapterDurationsMs: CHAPTER_DURATIONS_MS,
      measuredIntegratedLufs: '-inf',
      measuredTruePeakDbtp: '-inf',
    })
    const result = await assemblerFor(runner).assemble(request)

    expect(result.manifest.loudness.appliedGainDb).toBe(0)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/not measurable/u)
    expect(result.manifest.warnings).toStrictEqual(result.warnings)
  })

  it('embeds cover art when it exists and warns when it does not', async () => {
    const coverPath = join(workspace, 'cover.jpg')
    await writeFile(coverPath, 'fake jpeg', 'utf8')
    const withCover = await buildRequest({ coverPath })
    const runner = new FakeFfmpeg({ chapterDurationsMs: CHAPTER_DURATIONS_MS })
    const result = await assemblerFor(runner).assemble(withCover)
    const exportArgs = runner.argsFor((args) => args.includes('ipod'))
    expect(exportArgs).toContain(coverPath)
    expect(exportArgs[exportArgs.indexOf('-c:v') + 1]).toBe('copy')
    expect(result.manifest.coverPath).toBe(coverPath)

    await rm(outputDirectory, { recursive: true, force: true })
    await mkdir(outputDirectory, { recursive: true })
    const missing = await buildRequest({ coverPath: join(workspace, 'gone.jpg') })
    const secondRunner = new FakeFfmpeg({ chapterDurationsMs: CHAPTER_DURATIONS_MS })
    const secondResult = await assemblerFor(secondRunner).assemble(missing)
    expect(secondResult.warnings[0]).toMatch(/Cover art is missing/u)
    expect(secondRunner.argsFor((args) => args.includes('ipod'))).not.toContain('-c:v')
  })

  it('transcodes a cover the container cannot carry', async () => {
    const coverPath = join(workspace, 'cover.webp')
    await writeFile(coverPath, 'fake webp', 'utf8')
    const request = await buildRequest({ coverPath })
    const runner = new FakeFfmpeg({ chapterDurationsMs: CHAPTER_DURATIONS_MS, coverCodec: 'webp' })
    await assemblerFor(runner).assemble(request)
    const exportArgs = runner.argsFor((args) => args.includes('ipod'))
    expect(exportArgs[exportArgs.indexOf('-c:v') + 1]).toBe('mjpeg')
  })

  it('records a deterministic manifest of the encoding actually used', async () => {
    const request = await buildRequest()
    const first = new FakeFfmpeg({ chapterDurationsMs: CHAPTER_DURATIONS_MS })
    const result = await assemblerFor(first).assemble(request)
    const written = await readFile(result.manifestPath, 'utf8')

    expect(result.manifest.toolchain).toStrictEqual({
      ffmpegVersion: '7.0.2-static',
      ffprobeVersion: '7.0.2-static',
    })
    expect(result.manifest.encoding).toStrictEqual({
      chapterCodec: 'flac',
      chapterSampleRate: 48_000,
      chapterSampleFormat: 's32',
      chapterBitDepth: 24,
      chapterChannels: 1,
      flacCompressionLevel: 5,
      audiobookContainer: 'm4b',
      audiobookMuxer: 'ipod',
      audiobookCodec: 'aac',
      audiobookProfile: 'aac_low',
      audiobookBitrateKbps: 64,
      audiobookSampleRate: 48_000,
      audiobookChannels: 1,
    })
    expect(result.manifest.pauses.chapterTailPauseMs).toBe(1_000)
    expect(result.manifest.sourceSha256).toBe(request.book.source.sha256)
    expect(result.manifest.chapters[0]?.segments).toStrictEqual(
      request.chapters[0]?.segments.map((item) => ({
        segmentId: item.segment.id,
        sha256: item.audio.sha256,
      })),
    )
    // Keys are sorted at every level, so an unchanged run rewrites byte-identical content.
    expect(written).toBe(`${JSON.stringify(canonicalJson(JSON.parse(written)), null, 2)}\n`)
    expect(written).toBe(serializeManifest(result.manifest))
  })

  it('refuses to overwrite an existing output and spawns nothing', async () => {
    const request = await buildRequest()
    await writeFile(request.reservation.m4bPath, 'previous export', 'utf8')
    const runner = new FakeFfmpeg({ chapterDurationsMs: CHAPTER_DURATIONS_MS })

    await expect(assemblerFor(runner).assemble(request)).rejects.toBeInstanceOf(OutputExistsError)
    expect(runner.invocations).toHaveLength(0)
    expect(await readFile(request.reservation.m4bPath, 'utf8')).toBe('previous export')
  })

  it('refuses to overwrite an existing chapter master or manifest', async () => {
    const first = await buildRequest()
    const chapterPath = first.reservation.chapters[1]?.path
    if (chapterPath === undefined) throw new Error('fixture reservation missing')
    await writeFile(chapterPath, 'previous chapter', 'utf8')
    await expect(
      assemblerFor(new FakeFfmpeg({ chapterDurationsMs: CHAPTER_DURATIONS_MS })).assemble(first),
    ).rejects.toThrow(OutputExistsError)
    await rm(chapterPath)

    const manifestPath = `${first.reservation.m4bPath.replace(/\.m4b$/u, '')}.manifest.json`
    await writeFile(manifestPath, '{}', 'utf8')
    await expect(
      assemblerFor(new FakeFfmpeg({ chapterDurationsMs: CHAPTER_DURATIONS_MS })).assemble(first),
    ).rejects.toThrow(OutputExistsError)
  })

  it('leaves no staging directory or partial output behind when a run fails', async () => {
    const request = await buildRequest()
    const failing = {
      async run(executable: string, args: readonly string[]) {
        if (args.includes('ipod')) {
          return { exitCode: 1, signal: null, stdout: '', stderr: 'ipod muxer exploded' }
        }
        return await new FakeFfmpeg({ chapterDurationsMs: CHAPTER_DURATIONS_MS }).run(
          executable,
          args,
        )
      },
    }
    const assembler = new FfmpegAudioAssembler({ toolchain: FAKE_TOOLCHAIN, runner: failing })

    await expect(assembler.assemble(request)).rejects.toThrow(/ipod muxer exploded/u)
    expect(await readdir(outputDirectory)).toStrictEqual([])
  })

  it('fails when rendered segment audio is missing', async () => {
    const request = await buildRequest()
    const missing = request.chapters[0]?.segments[0]?.audio.wavPath
    if (missing === undefined) throw new Error('fixture segment missing')
    await rm(missing)
    const runner = new FakeFfmpeg({ chapterDurationsMs: CHAPTER_DURATIONS_MS })

    await expect(assemblerFor(runner).assemble(request)).rejects.toThrow(/is missing/u)
    expect(runner.invocations).toHaveLength(0)
  })

  it('fails when the export does not carry one marker per chapter', async () => {
    const request = await buildRequest()
    const runner = new FakeFfmpeg({
      chapterDurationsMs: CHAPTER_DURATIONS_MS,
      reportedChapterMarkers: [[0, 8_500]],
    })
    await expect(assemblerFor(runner).assemble(request)).rejects.toThrow(
      /1 chapter markers, expected 2/u,
    )
    expect(await readdir(outputDirectory)).toStrictEqual([])
  })

  it('fails when a marker does not line up with its chapter audio', async () => {
    const request = await buildRequest()
    const runner = new FakeFfmpeg({
      chapterDurationsMs: CHAPTER_DURATIONS_MS,
      reportedChapterMarkers: [
        [0, 5_300],
        [5_300, 9_000],
      ],
    })
    await expect(assemblerFor(runner).assemble(request)).rejects.toThrow(
      /Chapter marker 2 spans 5300\.\.9000 ms but chapter audio spans 5300\.\.8500 ms/u,
    )
  })

  it('rejects a request whose chapters are out of order before touching FFmpeg', async () => {
    const request = await buildRequest()
    const reordered: AssembleAudiobookRequest = {
      ...request,
      chapters: [...request.chapters].reverse(),
    }
    const runner = new FakeFfmpeg({ chapterDurationsMs: CHAPTER_DURATIONS_MS })
    await expect(assemblerFor(runner).assemble(reordered)).rejects.toBeInstanceOf(
      AssemblyOrderError,
    )
    expect(runner.invocations).toHaveLength(0)
  })

  it('concatenates a long chapter in ordered batches', async () => {
    const { book } = makeBook({
      chapters: [{ title: 'Long', pauses: Array.from({ length: 5 }, () => 100) }],
    })
    const request = makeRequest({ book, outputDirectory, wavDirectory })
    for (const chapter of request.chapters) {
      for (const { audio } of chapter.segments) await writeFile(audio.wavPath, 'fake wav', 'utf8')
    }
    const runner = new FakeFfmpeg({ chapterDurationsMs: [4_000] })
    const assembler = new FfmpegAudioAssembler({
      toolchain: FAKE_TOOLCHAIN,
      runner,
      settings: { maxInputsPerPass: 2 },
    })

    const result = await assembler.assemble(request)

    const partCommands = runner.ffmpegInvocations.filter((invocation) =>
      basename(invocation.args.at(-1) ?? '').startsWith('part-'),
    )
    expect(partCommands).toHaveLength(3)
    const wavs = request.chapters[0]?.segments.map((item) => item.audio.wavPath) ?? []
    expect(
      partCommands.flatMap((command) =>
        command.args.flatMap((arg, index) => (arg === '-i' ? [command.args[index + 1] ?? ''] : [])),
      ),
    ).toStrictEqual(wavs)
    // The batches are then joined in order before the chapter master is written.
    const joinArgs = runner.argsFor((args) => basename(args.at(-1) ?? '').startsWith('raw-'))
    expect(joinArgs.filter((arg) => basename(arg).startsWith('part-'))).toHaveLength(3)
    expect(result.chapters).toHaveLength(1)
  })

  it('rejects a settings override that cannot produce a valid encode', () => {
    expect(
      () =>
        new FfmpegAudioAssembler({
          toolchain: FAKE_TOOLCHAIN,
          runner: new FakeFfmpeg({ chapterDurationsMs: CHAPTER_DURATIONS_MS }),
          settings: { targetLoudnessLufs: 3 },
        }),
    ).toThrow(AudioAssemblyError)
  })
})
