import type { EpubExtractionRequest, EpubExtractor } from '@light-novel-audiobook/application'
import { GenerateAudiobook } from '@light-novel-audiobook/application'
import {
  type AudiobookJob,
  Book,
  Chapter,
  SourcePassage,
  StableIds,
  VoiceCast,
  VoiceProfile,
} from '@light-novel-audiobook/domain'
import { describe, expect, it } from 'vitest'
import { SlicingEpubExtractor } from '../src/slice.js'

const SOURCE_SHA256 = 'c'.repeat(64)

function book(passagesPerChapter: number, chapters: number): Book {
  const bookId = StableIds.book(SOURCE_SHA256)
  return new Book({
    id: bookId,
    title: 'Slice Identity',
    author: null,
    coverPath: null,
    source: { epubPath: '/nonexistent/slice.epub', sha256: SOURCE_SHA256 },
    chapters: Array.from({ length: chapters }, (_, chapterIndex) => {
      const chapterId = StableIds.chapter(bookId, chapterIndex + 1)
      return new Chapter({
        id: chapterId,
        bookId,
        position: chapterIndex + 1,
        title: `Chapter ${chapterIndex + 1}`,
        sourcePassages: Array.from(
          { length: passagesPerChapter },
          (__, passageIndex) =>
            new SourcePassage({
              id: StableIds.passage(chapterId, passageIndex + 1),
              chapterId,
              sourceText: `Passage ${passageIndex + 1}.`,
            }),
        ),
      })
    }),
  })
}

function cast(): VoiceCast {
  return new VoiceCast(
    new VoiceProfile({
      id: 'narrator-profile',
      displayName: 'Narrator',
      role: 'narrator',
      speakerId: null,
      syntheticSpeaker: 'speaker-a',
      instruction: 'read plainly',
      seed: 1,
      revision: 1,
    }),
    new VoiceProfile({
      id: 'fallback-profile',
      displayName: 'Fallback',
      role: 'fallback',
      speakerId: null,
      syntheticSpeaker: 'speaker-b',
      instruction: 'read plainly',
      seed: 2,
      revision: 1,
    }),
    [],
  )
}

class StubExtractor implements EpubExtractor {
  readonly identity = 'epub-ingestion@4'
  calls = 0

  async extract(_request: EpubExtractionRequest): Promise<Book> {
    this.calls += 1
    return book(5, 3)
  }
}

const REQUEST = {
  epubPath: '/nonexistent/slice.epub',
  workspaceRoot: '/nonexistent/workspace',
} as unknown as EpubExtractionRequest

describe('SlicingEpubExtractor chapter selection', () => {
  it('selects the requested chapter instead of the prefix ending at it', async () => {
    const extractor = new SlicingEpubExtractor(new StubExtractor(), {
      firstChapter: 3,
      maxChapters: 1,
      maxPassagesPerChapter: 5,
    })
    const sliced = await extractor.extract(REQUEST)

    // One chapter, and it is the third one — not chapters 1..3.
    expect(sliced.chapters).toHaveLength(1)
    expect(sliced.chapters[0]?.title).toBe('Chapter 3')
    expect(extractor.report?.selectedChapterPositions).toEqual([3])
    expect(extractor.report?.slicedPassages).toBe(5)
    // The whole publication was still extracted; only what direction and rendering see is reduced.
    expect(extractor.report?.extractedChapters).toBe(3)
    expect(extractor.report?.extractedPassages).toBe(15)
    expect(extractor.report?.sliced).toBe(true)
  })

  it('keeps the original chapter ID while renumbering position for the domain invariant', async () => {
    const bookId = StableIds.book(SOURCE_SHA256)
    const extractor = new SlicingEpubExtractor(new StubExtractor(), { firstChapter: 3 })
    const sliced = await extractor.extract(REQUEST)

    // `Book` requires position === index + 1, so the window is renumbered...
    expect(sliced.chapters[0]?.position).toBe(1)
    // ...but the ID still names the real chapter, which is what identity and every passage ID use.
    expect(sliced.chapters[0]?.id).toBe(StableIds.chapter(bookId, 3))
    expect(sliced.chapters[0]?.sourcePassages[0]?.chapterId).toBe(StableIds.chapter(bookId, 3))
  })

  it('still takes a prefix when no selector is given', async () => {
    const extractor = new SlicingEpubExtractor(new StubExtractor(), {
      maxChapters: 2,
      maxPassagesPerChapter: 1,
    })
    const sliced = await extractor.extract(REQUEST)
    expect(sliced.chapters.map((chapter) => chapter.title)).toEqual(['Chapter 1', 'Chapter 2'])
    expect(extractor.report?.selectedChapterPositions).toEqual([1, 2])
  })

  it('fails loudly when the selected chapter is past the end of the book', async () => {
    const extractor = new SlicingEpubExtractor(new StubExtractor(), { firstChapter: 4 })
    await expect(extractor.extract(REQUEST)).rejects.toThrow(
      /firstChapter=4 is past the end of a 3-chapter book/,
    )
  })
})

describe('SlicingEpubExtractor identity', () => {
  it('reports the inner identity verbatim when no bounds are set', () => {
    const inner = new StubExtractor()
    expect(new SlicingEpubExtractor(inner, {}).identity).toBe(inner.identity)
  })

  it('binds each bound it was given, and only those', () => {
    const inner = new StubExtractor()
    expect(new SlicingEpubExtractor(inner, { maxChapters: 1 }).identity).toBe(
      'epub-ingestion@4+slice(maxChapters=1)',
    )
    expect(new SlicingEpubExtractor(inner, { maxPassagesPerChapter: 3 }).identity).toBe(
      'epub-ingestion@4+slice(maxPassagesPerChapter=3)',
    )
    expect(
      new SlicingEpubExtractor(inner, { maxChapters: 1, maxPassagesPerChapter: 3 }).identity,
    ).toBe('epub-ingestion@4+slice(maxChapters=1,maxPassagesPerChapter=3)')
    expect(
      new SlicingEpubExtractor(inner, {
        firstChapter: 3,
        maxChapters: 1,
        maxPassagesPerChapter: 5,
      }).identity,
    ).toBe('epub-ingestion@4+slice(firstChapter=3,maxChapters=1,maxPassagesPerChapter=5)')
  })

  it('gives different bounds different identities', () => {
    const inner = new StubExtractor()
    const three = new SlicingEpubExtractor(inner, { maxPassagesPerChapter: 3 }).identity
    const all = new SlicingEpubExtractor(inner, { maxPassagesPerChapter: 5 }).identity
    expect(three).not.toBe(all)
  })

  it('gives a selected chapter a different identity from the prefix that contains it', () => {
    // The failure this guards: `--from-chapter 3 --chapters 1` and `--chapters 1` render different
    // audio. If the selector were not bound, they would share a command identity and the second run
    // would be handed the first run's chapter.
    const inner = new StubExtractor()
    const chapterOne = new SlicingEpubExtractor(inner, { maxChapters: 1, maxPassagesPerChapter: 5 })
    const chapterThree = new SlicingEpubExtractor(inner, {
      firstChapter: 3,
      maxChapters: 1,
      maxPassagesPerChapter: 5,
    })
    const chapterTwo = new SlicingEpubExtractor(inner, {
      firstChapter: 2,
      maxChapters: 1,
      maxPassagesPerChapter: 5,
    })
    expect(chapterThree.identity).not.toBe(chapterOne.identity)
    expect(chapterThree.identity).not.toBe(chapterTwo.identity)
    expect(chapterThree.identity).toContain('firstChapter=3')
  })

  it('treats firstChapter=1 as the prefix it is, rather than a second identity for one window', () => {
    const inner = new StubExtractor()
    expect(new SlicingEpubExtractor(inner, { firstChapter: 1, maxChapters: 1 }).identity).toBe(
      new SlicingEpubExtractor(inner, { maxChapters: 1 }).identity,
    )
    expect(new SlicingEpubExtractor(inner, { firstChapter: 1 }).identity).toBe(inner.identity)
  })

  it('rejects a bound that would silently select the wrong window', () => {
    const inner = new StubExtractor()
    // firstChapter 0 would slice from index -1, i.e. the *end* of the book.
    expect(() => new SlicingEpubExtractor(inner, { firstChapter: 0 })).toThrow(
      /firstChapter must be a positive integer/,
    )
    expect(() => new SlicingEpubExtractor(inner, { firstChapter: 1.5 })).toThrow(
      /firstChapter must be a positive integer/,
    )
    expect(() => new SlicingEpubExtractor(inner, { maxChapters: 0 })).toThrow(
      /maxChapters must be a positive integer/,
    )
  })

  it('rejects reusing a completed job when the chapter selection changed', async () => {
    // Round 2 required this for the prefix bounds. A selector is a slice bound too, so the same failure
    // applies: chapter 1's audio must not be handed back to a caller who asked for chapter 3.
    const jobs = new (class {
      job: AudiobookJob | undefined
      async findJob(): Promise<AudiobookJob | undefined> {
        return this.job
      }
      async saveJob(job: AudiobookJob): Promise<void> {
        this.job = job
      }
    })()

    const run = async (extractor: EpubExtractor): Promise<unknown> =>
      await new GenerateAudiobook({
        epubExtractor: extractor,
        directorModelFactory: { identity: 'gemma@1' } as never,
        speechEngineFactory: { identity: 'qwen@1' } as never,
        audioAssembler: { identity: 'ffmpeg@1' } as never,
        jobs: jobs as never,
        approvals: {} as never,
      }).execute({
        jobId: 'slice-selection-job',
        epubPath: '/nonexistent/slice.epub',
        epubSha256: SOURCE_SHA256,
        voices: cast(),
      })

    await expect(
      run(
        new SlicingEpubExtractor(new StubExtractor(), {
          maxChapters: 1,
          maxPassagesPerChapter: 5,
        }),
      ),
    ).rejects.toThrow()

    await expect(
      run(
        new SlicingEpubExtractor(new StubExtractor(), {
          firstChapter: 3,
          maxChapters: 1,
          maxPassagesPerChapter: 5,
        }),
      ),
    ).rejects.toThrow(/stale for the requested generation inputs/)
  })

  it('rejects reusing a completed job when the bounds changed', async () => {
    // The failure this guards: a completed job returns its stored output without re-extracting, so an
    // unbound slice would silently hand back the 3-passage render when the caller asked for 5.
    const jobs = new (class {
      job: AudiobookJob | undefined
      async findJob(): Promise<AudiobookJob | undefined> {
        return this.job
      }
      async saveJob(job: AudiobookJob): Promise<void> {
        this.job = job
      }
    })()

    const first = new SlicingEpubExtractor(new StubExtractor(), { maxPassagesPerChapter: 3 })
    const second = new SlicingEpubExtractor(new StubExtractor(), { maxPassagesPerChapter: 5 })

    // Bind a job to the first slice's command identity the way GenerateAudiobook does.
    const useCaseFor = (extractor: EpubExtractor): GenerateAudiobook =>
      new GenerateAudiobook({
        epubExtractor: extractor,
        directorModelFactory: { identity: 'gemma@1' } as never,
        speechEngineFactory: { identity: 'qwen@1' } as never,
        audioAssembler: { identity: 'ffmpeg@1' } as never,
        jobs: jobs as never,
        approvals: {} as never,
      })

    // The first run binds the command identity, then fails inside direction — enough to persist it.
    await expect(
      useCaseFor(first).execute({
        jobId: 'slice-bounds-job',
        epubPath: '/nonexistent/slice.epub',
        epubSha256: SOURCE_SHA256,
        voices: cast(),
      }),
    ).rejects.toThrow()

    // The same job ID with different bounds must be refused rather than silently reused.
    await expect(
      useCaseFor(second).execute({
        jobId: 'slice-bounds-job',
        epubPath: '/nonexistent/slice.epub',
        epubSha256: SOURCE_SHA256,
        voices: cast(),
      }),
    ).rejects.toThrow(/stale for the requested generation inputs/)
  })
})
