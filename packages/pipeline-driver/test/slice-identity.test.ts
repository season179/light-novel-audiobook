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
  })

  it('gives different bounds different identities', () => {
    const inner = new StubExtractor()
    const three = new SlicingEpubExtractor(inner, { maxPassagesPerChapter: 3 }).identity
    const all = new SlicingEpubExtractor(inner, { maxPassagesPerChapter: 5 }).identity
    expect(three).not.toBe(all)
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
        directorModel: {
          identity: 'gemma@1',
          directChapter: async () => {
            throw new Error('not reached')
          },
          release: async () => undefined,
        } as never,
        speechEngine: { identity: 'qwen@1' } as never,
        audioAssembler: { identity: 'ffmpeg@1' } as never,
        jobs: jobs as never,
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
