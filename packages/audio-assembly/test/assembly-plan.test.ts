import type { AssembleAudiobookRequest } from '@light-novel-audiobook/application'
import { OutputVersion } from '@light-novel-audiobook/domain'
import { describe, expect, it } from 'vitest'
import { planAssembly, resolveSegmentPauseMs } from '../src/assembly-plan.js'
import { AssemblyOrderError, AudioAssemblyError } from '../src/errors.js'
import { DEFAULT_ASSEMBLY_SETTINGS, resolveAssemblySettings } from '../src/settings.js'
import { HOSTILE_CHAPTER_TITLE, makeBook, makeRequest } from './fixtures.js'

const settings = DEFAULT_ASSEMBLY_SETTINGS
const outputDirectory = '/work/output'
const wavDirectory = '/work/wav'

const twoChapterRequest = (): AssembleAudiobookRequest => {
  const { book } = makeBook({
    chapters: [
      { title: HOSTILE_CHAPTER_TITLE, pauses: [200, 0, 900] },
      { title: 'Chapter Two', pauses: [0, 450] },
    ],
  })
  return makeRequest({ book, outputDirectory, wavDirectory })
}

describe('resolveSegmentPauseMs', () => {
  it('uses the directed pause and falls back to the default when none was directed', () => {
    const { book } = makeBook({ chapters: [{ title: 'One', pauses: [0, 700] }] })
    const [first, second] = book.chapters[0]?.segments ?? []
    if (first === undefined || second === undefined) throw new Error('fixture segments missing')
    expect(resolveSegmentPauseMs(first, settings)).toBe(settings.defaultSegmentPauseMs)
    expect(resolveSegmentPauseMs(second, settings)).toBe(700)
  })

  it('clamps a directed pause into the configured bounds', () => {
    const clamped = resolveAssemblySettings({
      minSegmentPauseMs: 100,
      maxSegmentPauseMs: 500,
      defaultSegmentPauseMs: 200,
    })
    const { book } = makeBook({ chapters: [{ title: 'One', pauses: [50, 9000] }] })
    const [first, second] = book.chapters[0]?.segments ?? []
    if (first === undefined || second === undefined) throw new Error('fixture segments missing')
    expect(resolveSegmentPauseMs(first, clamped)).toBe(100)
    expect(resolveSegmentPauseMs(second, clamped)).toBe(500)
  })
})

describe('planAssembly', () => {
  it('keeps chapters and segments in exact source order', () => {
    const plan = planAssembly(twoChapterRequest(), settings)
    expect(plan.chapters.map((chapter) => chapter.position)).toStrictEqual([1, 2])
    expect(plan.chapters[0]?.segments.map((segment) => segment.order)).toStrictEqual([1, 2, 3])
    expect(plan.chapters[0]?.segments.map((segment) => segment.wavPath)).toStrictEqual([
      `${wavDirectory}/${plan.chapters[0]?.segments[0]?.segmentId}.wav`,
      `${wavDirectory}/${plan.chapters[0]?.segments[1]?.segmentId}.wav`,
      `${wavDirectory}/${plan.chapters[0]?.segments[2]?.segmentId}.wav`,
    ])
  })

  it('gives every segment its directed pause and the chapter tail to the last segment', () => {
    const plan = planAssembly(twoChapterRequest(), settings)
    expect(plan.chapters[0]?.segments.map((segment) => segment.padMs)).toStrictEqual([
      200,
      settings.defaultSegmentPauseMs,
      settings.chapterTailPauseMs,
    ])
    expect(plan.chapters[1]?.segments.map((segment) => segment.padMs)).toStrictEqual([
      settings.defaultSegmentPauseMs,
      settings.chapterTailPauseMs,
    ])
  })

  it('splits a long chapter into ordered passes without losing or reordering a segment', () => {
    const { book } = makeBook({
      chapters: [{ title: 'Long', pauses: Array.from({ length: 7 }, () => 100) }],
    })
    const plan = planAssembly(
      makeRequest({ book, outputDirectory, wavDirectory }),
      resolveAssemblySettings({ maxInputsPerPass: 3 }),
    )
    const chapter = plan.chapters[0]
    if (chapter === undefined) throw new Error('planned chapter missing')
    expect(chapter.passes.map((pass) => pass.length)).toStrictEqual([3, 3, 1])
    expect(chapter.passes.flat().map((segment) => segment.order)).toStrictEqual([
      1, 2, 3, 4, 5, 6, 7,
    ])
    // Only the chapter's final segment carries the chapter tail; batch edges keep normal pauses.
    expect(chapter.passes.flat().map((segment) => segment.padMs)).toStrictEqual([
      100, 100, 100, 100, 100, 100, 1000,
    ])
  })

  it('derives the numbered outputs from the reservation and names the manifest beside the book', () => {
    const plan = planAssembly(twoChapterRequest(), settings)
    expect(plan.m4bPath).toBe('/work/output/The -Book-; #1 = a-path-name-と日本語 ★-v001.m4b')
    expect(plan.manifestPath).toBe(
      '/work/output/The -Book-; #1 = a-path-name-と日本語 ★-v001.manifest.json',
    )
    expect(plan.chapters.map((chapter) => chapter.outputPath)).toStrictEqual([
      '/work/output/The -Book-; #1 = a-path-name-と日本語 ★-v001-ch01.flac',
      '/work/output/The -Book-; #1 = a-path-name-と日本語 ★-v001-ch02.flac',
    ])
  })

  it('rejects chapters supplied out of spine order', () => {
    const request = twoChapterRequest()
    const reordered: AssembleAudiobookRequest = {
      ...request,
      chapters: [...request.chapters].reverse(),
    }
    expect(() => planAssembly(reordered, settings)).toThrow(AssemblyOrderError)
  })

  it('rejects segments supplied out of order within a chapter', () => {
    const request = twoChapterRequest()
    const first = request.chapters[0]
    if (first === undefined) throw new Error('fixture chapter missing')
    const shuffled: AssembleAudiobookRequest = {
      ...request,
      chapters: [
        { chapter: first.chapter, segments: [...first.segments].reverse() },
        ...request.chapters.slice(1),
      ],
    }
    expect(() => planAssembly(shuffled, settings)).toThrow(/declares order/u)
  })

  it('rejects audio rendered for a different segment', () => {
    const request = twoChapterRequest()
    const first = request.chapters[0]
    const segment = first?.segments[0]
    if (first === undefined || segment === undefined) throw new Error('fixture segment missing')
    const swapped: AssembleAudiobookRequest = {
      ...request,
      chapters: [
        {
          chapter: first.chapter,
          segments: [
            { segment: segment.segment, audio: { ...segment.audio, segmentId: 'other-segment' } },
            ...first.segments.slice(1),
          ],
        },
        ...request.chapters.slice(1),
      ],
    }
    expect(() => planAssembly(swapped, settings)).toThrow(/was supplied for segment/u)
  })

  it('rejects a reservation that does not match the book chapters', () => {
    const request = twoChapterRequest()
    const chapters = request.reservation.chapters
    expect(() =>
      planAssembly(
        { ...request, reservation: { ...request.reservation, bookId: 'book-other' } },
        settings,
      ),
    ).toThrow(/Reservation is for book/u)
    expect(() =>
      planAssembly(
        { ...request, reservation: { ...request.reservation, chapters: chapters.slice(0, 1) } },
        settings,
      ),
    ).toThrow(/lists 1 chapters/u)
    expect(() =>
      planAssembly(
        {
          ...request,
          reservation: {
            ...request.reservation,
            chapters: [...chapters].reverse(),
          },
        },
        settings,
      ),
    ).toThrow(/but the book expects/u)
  })

  it('rejects reserved paths with the wrong container or a duplicate target', () => {
    const request = twoChapterRequest()
    expect(() =>
      planAssembly(
        { ...request, reservation: { ...request.reservation, m4bPath: '/work/output/book.mp3' } },
        settings,
      ),
    ).toThrow(/must end in \.m4b/u)
    const chapters = request.reservation.chapters
    const first = chapters[0]
    if (first === undefined) throw new Error('fixture reservation missing')
    expect(() =>
      planAssembly(
        {
          ...request,
          reservation: {
            ...request.reservation,
            chapters: [{ ...first, path: '/work/output/ch01.wav' }, ...chapters.slice(1)],
          },
        },
        settings,
      ),
    ).toThrow(/must end in \.flac/u)
    expect(() =>
      planAssembly(
        {
          ...request,
          reservation: {
            ...request.reservation,
            chapters: chapters.map((chapter) => ({ ...chapter, path: first.path })),
          },
        },
        settings,
      ),
    ).toThrow(/pairwise distinct/u)
  })

  it('records the reserved version so the output cannot be renumbered later', () => {
    const { book } = makeBook({ chapters: [{ title: 'One', pauses: [100] }] })
    const plan = planAssembly(
      makeRequest({ book, outputDirectory, wavDirectory, version: 12 }),
      settings,
    )
    expect(plan.version).toBeInstanceOf(OutputVersion)
    expect(plan.version.label).toBe('v012')
    expect(plan.m4bPath.endsWith('-v012.m4b')).toBe(true)
  })

  it('rejects a chapter with no rendered segments', () => {
    const request = twoChapterRequest()
    const first = request.chapters[0]
    if (first === undefined) throw new Error('fixture chapter missing')
    expect(() =>
      planAssembly(
        {
          ...request,
          chapters: [{ chapter: first.chapter, segments: [] }, ...request.chapters.slice(1)],
        },
        settings,
      ),
    ).toThrow(AudioAssemblyError)
  })
})
