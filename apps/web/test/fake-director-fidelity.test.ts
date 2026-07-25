import {
  Book,
  Chapter,
  ExactSourceCoverage,
  type FallbackReason,
  Segment,
  SourcePassage,
  StableIds,
} from '@light-novel-audiobook/domain'
import { describe, expect, it } from 'vitest'
import { FakeDirectorModel } from '../src/server/fakes/fake-director-model.js'
import { FIXTURE_CHAPTERS } from '../src/server/fakes/fixture-book.js'
import { createM1VoiceCast } from '../src/server/m1-voice-cast.js'

/**
 * Pins the fake director against the real domain rules it has to satisfy. If an upstream change to
 * `ExactSourceCoverage` or `VoiceCast.resolve` alters source coverage or which voice a segment gets,
 * this fails here instead of silently changing what the UI warns about.
 */
const sha256 = 'a'.repeat(64)
const bookId = StableIds.book(sha256)

const buildFixtureBook = (): Book =>
  new Book({
    id: bookId,
    title: 'Fixture Book',
    author: 'Fixture Author',
    coverPath: null,
    source: { epubPath: '/workspace/uploads/fixture.epub', sha256 },
    chapters: FIXTURE_CHAPTERS.map((fixture, index) => {
      const chapterId = StableIds.chapter(bookId, index + 1)
      return new Chapter({
        id: chapterId,
        bookId,
        position: index + 1,
        title: fixture.title,
        sourcePassages: fixture.passages.map(
          (sourceText, passageIndex) =>
            new SourcePassage({
              id: StableIds.passage(chapterId, passageIndex + 1),
              chapterId,
              sourceText,
            }),
        ),
      })
    }),
  })

const directAll = async (): Promise<readonly Segment[]> => {
  const book = buildFixtureBook()
  const director = new FakeDirectorModel()
  const segments: Segment[] = []
  for (const chapter of book.chapters) {
    const directed = await director.directChapter(book, chapter)
    segments.push(...ExactSourceCoverage.createSegments(chapter, directed.segments))
  }
  await director.release()
  return segments
}

describe('fake director source fidelity', () => {
  it('reproduces every source passage exactly once', async () => {
    const book = buildFixtureBook()
    const director = new FakeDirectorModel()

    for (const chapter of book.chapters) {
      const directed = await director.directChapter(book, chapter)
      // ExactSourceCoverage throws unless the fragments rebuild each passage byte for byte.
      const segments = ExactSourceCoverage.createSegments(chapter, directed.segments)

      for (const passage of chapter.sourcePassages) {
        const rebuilt = segments
          .filter((segment) => segment.sourcePassageId === passage.id)
          .map((segment) => segment.sourceText)
          .join('')
        expect(rebuilt).toBe(passage.sourceText)
      }
    }
  })

  it('emits the segment count the flow tests assume', async () => {
    expect((await directAll()).length).toBe(16)
  })

  it('only classifies narration and dialogue, so narrator-owned kinds cannot shift', async () => {
    const kinds = new Set((await directAll()).map((segment) => segment.kind))
    expect(kinds).toEqual(new Set(['narration', 'dialogue']))
  })
})

describe('M1 cast resolution of the fixture', () => {
  it('produces exactly the four casting outcomes the UI reports', async () => {
    const voices = createM1VoiceCast()
    const outcomes = new Map<string, { profileId: string; reason: FallbackReason | null }>()

    for (const segment of await directAll()) {
      const resolved = voices.resolve(segment)
      outcomes.set(`${segment.kind}:${segment.speakerId ?? 'null'}`, {
        profileId: resolved.profile.id,
        reason: resolved.assignment.fallbackReason,
      })
    }

    expect(Object.fromEntries(outcomes)).toEqual({
      'narration:null': { profileId: 'narrator-aiden-calm', reason: null },
      'dialogue:alice': { profileId: 'character-alice-ryan-energetic', reason: null },
      'dialogue:bruno': { profileId: 'fallback-ryan-restrained', reason: 'missing_speaker_voice' },
      'dialogue:null': { profileId: 'fallback-ryan-restrained', reason: 'unresolved_speaker' },
    })
  })

  it('gives sound cues the narrator without a fallback warning', () => {
    const chapterId = StableIds.chapter(bookId, 1)
    const passageId = StableIds.passage(chapterId, 1)
    const soundCue = new Segment({
      id: StableIds.segment(passageId, 1),
      chapterId,
      sourcePassageId: passageId,
      order: 1,
      sourceText: 'A bell rang twice.',
      kind: 'sound_cue',
      speakerId: null,
      confidence: 0.9,
      delivery: { emotion: 'neutral', pace: 'normal', volume: 'normal', pauseAfterMs: 200 },
    })

    const resolved = createM1VoiceCast().resolve(soundCue)
    expect(resolved.profile.id).toBe('narrator-aiden-calm')
    expect(resolved.assignment.usesFallback).toBe(false)
    expect(resolved.assignment.fallbackReason).toBeNull()
  })
})
