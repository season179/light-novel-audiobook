import { describe, expect, it } from 'vitest'
import {
  AUDIOBOOK_JOB_STAGES,
  AUDIOBOOK_JOB_STATES,
  AudiobookJob,
  CHAPTER_STATES,
  Chapter,
  type DirectedSegment,
  DomainError,
  ExactSourceCoverage,
  InvalidStateTransitionError,
  OutputVersion,
  SourceCoverageError,
  SourcePassage,
  StableIds,
  VoiceCast,
  VoiceProfile,
} from '../src/index.js'

const hash = 'a'.repeat(64)
const bookId = StableIds.book(hash)
const chapterId = StableIds.chapter(bookId, 1)

const makeChapter = (): Chapter =>
  new Chapter({
    id: chapterId,
    bookId,
    position: 1,
    title: 'First',
    sourcePassages: [
      new SourcePassage({
        id: StableIds.passage(chapterId, 1),
        chapterId,
        sourceText: 'Hello. “Wait!”',
      }),
      new SourcePassage({
        id: StableIds.passage(chapterId, 2),
        chapterId,
        sourceText: ' Exact whitespace stays. ',
      }),
    ],
  })

const directed = (chapter: Chapter) => [
  {
    sourcePassageId: chapter.sourcePassages[0]?.id ?? '',
    sourceText: 'Hello. ',
    kind: 'narration' as const,
    speakerId: null,
    confidence: 1,
    delivery: {
      emotion: 'neutral',
      pace: 'normal' as const,
      volume: 'normal' as const,
      pauseAfterMs: 0,
    },
  },
  {
    sourcePassageId: chapter.sourcePassages[0]?.id ?? '',
    sourceText: '“Wait!”',
    kind: 'dialogue' as const,
    speakerId: null,
    confidence: 0.5,
    delivery: {
      emotion: 'urgent',
      pace: 'fast' as const,
      volume: 'loud' as const,
      pauseAfterMs: 250,
    },
  },
  {
    sourcePassageId: chapter.sourcePassages[1]?.id ?? '',
    sourceText: ' Exact whitespace stays. ',
    kind: 'narration' as const,
    speakerId: null,
    confidence: 1,
    delivery: {
      emotion: 'neutral',
      pace: 'normal' as const,
      volume: 'normal' as const,
      pauseAfterMs: 0,
    },
  },
]

const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('fixture value is missing')
  return value
}

const corruptions: readonly [string, (chapter: Chapter) => readonly DirectedSegment[]][] = [
  ['omission', (chapter) => directed(chapter).slice(0, 2)],
  [
    'rewrite',
    (chapter) =>
      directed(chapter).map((part, index) =>
        index === 0 ? { ...part, sourceText: 'Hello! ' } : part,
      ),
  ],
  ['duplication', (chapter) => [...directed(chapter), required(directed(chapter)[2])]],
  [
    'reordering',
    (chapter) => [
      required(directed(chapter)[2]),
      required(directed(chapter)[0]),
      required(directed(chapter)[1]),
    ],
  ],
  [
    'invention',
    (chapter) => [
      ...directed(chapter),
      { ...required(directed(chapter)[2]), sourcePassageId: 'invented' },
    ],
  ],
]

const profile = (
  id: string,
  role: 'narrator' | 'character' | 'fallback',
  speakerId: string | null,
) =>
  new VoiceProfile({
    id,
    displayName: id,
    role,
    speakerId,
    syntheticSpeaker: role === 'narrator' ? 'Aiden' : 'Ryan',
    instruction: 'restrained and clear',
    seed: 7,
    revision: 1,
  })

describe('stable identities and exact source coverage', () => {
  it('derives repeatable hierarchy IDs from source identity and source order', () => {
    expect(StableIds.book(hash.toUpperCase())).toBe(bookId)
    expect(StableIds.chapter(bookId, 1)).toBe(chapterId)
    expect(StableIds.passage(chapterId, 12)).toBe(`${chapterId}-p000012`)
    expect(StableIds.segment(`${chapterId}-p000012`, 3)).toBe(`${chapterId}-p000012-s0003`)
    expect(() => StableIds.chapter(bookId, 0)).toThrow(DomainError)
  })

  it('accepts exact fragments and gives each fragment a stable source-relative ID', () => {
    const chapter = makeChapter()
    const segments = ExactSourceCoverage.createSegments(chapter, directed(chapter))

    expect(segments.map((segment) => segment.sourceText).join('')).toBe(
      chapter.sourcePassages.map((passage) => passage.sourceText).join(''),
    )
    expect(segments.map((segment) => segment.id)).toEqual([
      `${chapter.sourcePassages[0]?.id}-s0001`,
      `${chapter.sourcePassages[0]?.id}-s0002`,
      `${chapter.sourcePassages[1]?.id}-s0001`,
    ])
  })

  it.each(corruptions)('rejects source %s', (_name, corrupt) => {
    const chapter = makeChapter()
    expect(() => ExactSourceCoverage.createSegments(chapter, corrupt(chapter))).toThrow(
      SourceCoverageError,
    )
  })
})

describe('chapter lifecycle and stable casting', () => {
  it('defines every valid and invalid chapter state pair', () => {
    const valid = new Set([
      'draft->needs_review',
      'needs_review->draft',
      'needs_review->approved',
      'approved->draft',
      'approved->rendering',
      'rendering->approved',
      'rendering->rendered',
      'rendered->draft',
    ])
    for (const from of CHAPTER_STATES) {
      for (const to of CHAPTER_STATES) {
        expect(Chapter.canTransition(from, to), `${from}->${to}`).toBe(valid.has(`${from}->${to}`))
      }
    }
  })

  it('requires review, assigned voices, and legal rendering transitions', () => {
    const chapter = makeChapter()
    const segments = ExactSourceCoverage.createSegments(chapter, directed(chapter))
    chapter.submitForReview(segments)
    expect(() => chapter.beginRendering()).toThrow(InvalidStateTransitionError)
    expect(() => chapter.approve()).toThrow('Every segment requires a voice')

    const cast = new VoiceCast(
      profile('narrator', 'narrator', null),
      profile('fallback', 'fallback', null),
      [],
    )
    for (const segment of segments) segment.assignVoice(cast.resolve(segment).assignment)
    chapter.approve()
    chapter.beginRendering()
    chapter.markRendered()
    expect(chapter.state).toBe('rendered')
  })

  it('uses one narrator, stable character voices, and an explicit fallback with warnings', () => {
    const chapter = makeChapter()
    const segments = ExactSourceCoverage.createSegments(chapter, directed(chapter))
    const cast = new VoiceCast(
      profile('narrator', 'narrator', null),
      profile('fallback', 'fallback', null),
      [profile('alice-voice', 'character', 'alice')],
    )

    expect(cast.resolve(required(segments[0])).profile.id).toBe('narrator')
    expect(cast.resolve(required(segments[1])).assignment).toMatchObject({
      voiceProfileId: 'fallback',
      usesFallback: true,
      fallbackReason: 'unresolved_speaker',
    })
    const segment = segments[1]
    if (segment === undefined) throw new Error('fixture segment is missing')
    segment.assignVoice(cast.resolve(segment).assignment)
    expect(() =>
      segment.assignVoice({
        voiceProfileId: 'alice-voice',
        usesFallback: false,
        fallbackReason: null,
      }),
    ).toThrow('stable voice assignment')
  })
})

describe('audiobook job and numbered output lifecycle', () => {
  it('defines every valid and invalid job state and stage pair', () => {
    const validStates = new Set([
      'pending->running',
      'running->failed',
      'running->completed',
      'failed->running',
    ])
    for (const from of AUDIOBOOK_JOB_STATES) {
      for (const to of AUDIOBOOK_JOB_STATES) {
        expect(AudiobookJob.canTransition(from, to), `${from}->${to}`).toBe(
          validStates.has(`${from}->${to}`),
        )
      }
    }

    const validStages = new Set([
      'extracting->directing',
      'directing->rendering',
      'rendering->assembling',
      'assembling->completed',
    ])
    for (const from of AUDIOBOOK_JOB_STAGES) {
      for (const to of AUDIOBOOK_JOB_STAGES) {
        expect(AudiobookJob.canAdvanceStage(from, to), `${from}->${to}`).toBe(
          validStages.has(`${from}->${to}`),
        )
      }
    }
  })

  it('rejects skipped work and reaches a terminal completed state', () => {
    const job = new AudiobookJob('job-1')
    expect(() => job.beginDirection()).toThrow(InvalidStateTransitionError)
    job.start()
    job.attachBook(bookId)
    job.beginDirection()
    job.beginRendering(1)
    expect(() => job.beginAssembly()).toThrow('All segments must complete')
    job.recordSegmentCompleted('segment-1')
    job.beginAssembly()
    const version = new OutputVersion(1)
    job.complete({
      version,
      m4bPath: version.fileName('My Book', 'm4b'),
      chapters: [{ chapterId, path: 'My Book-v001-ch01.flac' }],
    })

    expect(job.state).toBe('completed')
    expect(job.stage).toBe('completed')
    expect(job.progress).toMatchObject({ completedSegments: 1, totalSegments: 1 })
    expect(() => job.restart()).toThrow(InvalidStateTransitionError)
    expect(version.label).toBe('v001')
    expect(version.fileName('My Book', 'm4b')).toBe('My Book-v001.m4b')
  })

  it('allows failed jobs to retry from extraction without changing their book', () => {
    const job = new AudiobookJob('job-retry')
    job.start()
    job.attachBook(bookId)
    job.fail('temporary failure')
    job.restart()
    expect(job.stage).toBe('extracting')
    expect(job.error).toBeNull()
    expect(() => job.attachBook('another-book')).toThrow('cannot change its source book')
  })
})
