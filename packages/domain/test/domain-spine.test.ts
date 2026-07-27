import { describe, expect, it } from 'vitest'
import {
  AUDIOBOOK_JOB_STAGES,
  AUDIOBOOK_JOB_STATES,
  AudiobookJob,
  type AudiobookJobSnapshot,
  Book,
  CHAPTER_STATES,
  Chapter,
  type DirectedSegment,
  DomainError,
  ExactSourceCoverage,
  InvalidStateTransitionError,
  OutputVersion,
  Segment,
  SourceCoverageError,
  SourcePassage,
  StableIds,
  VoiceCast,
  VoiceProfile,
} from '../src/index.js'

const hash = 'a'.repeat(64)
const bookId = StableIds.book(hash)
const chapterId = StableIds.chapter(bookId, 1)
const commandIdentity = 'd'.repeat(64)

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

  it('rejects globally duplicated passage and segment IDs across two chapters', () => {
    const firstId = StableIds.chapter(bookId, 1)
    const secondId = StableIds.chapter(bookId, 2)
    const chapter = (id: string, position: number, passageId: string) =>
      new Chapter({
        id,
        bookId,
        position,
        title: `Chapter ${position}`,
        sourcePassages: [new SourcePassage({ id: passageId, chapterId: id, sourceText: 'Exact.' })],
      })
    const first = chapter(firstId, 1, 'globally-shared-passage')
    const second = chapter(secondId, 2, 'globally-shared-passage')
    expect(
      () =>
        new Book({
          id: bookId,
          title: 'Collision',
          author: null,
          coverPath: null,
          source: { epubPath: '/book.epub', sha256: hash },
          chapters: [first, second],
        }),
    ).toThrow('Duplicate source passage ID across book')

    const uniqueFirst = chapter(firstId, 1, 'passage-one')
    const uniqueSecond = chapter(secondId, 2, 'passage-two')
    const duplicateSegment = (owner: Chapter) =>
      new Segment({
        id: 'globally-shared-segment',
        chapterId: owner.id,
        sourcePassageId: required(owner.sourcePassages[0]).id,
        order: 1,
        sourceText: 'Exact.',
        kind: 'narration',
        speakerId: null,
        confidence: 1,
        delivery: {
          emotion: 'neutral',
          pace: 'normal',
          volume: 'normal',
          pauseAfterMs: 0,
        },
      })
    uniqueFirst.submitForReview([duplicateSegment(uniqueFirst)])
    uniqueSecond.submitForReview([duplicateSegment(uniqueSecond)])
    const aggregate = new Book({
      id: bookId,
      title: 'Collision',
      author: null,
      coverPath: null,
      source: { epubPath: '/book.epub', sha256: hash },
      chapters: [uniqueFirst, uniqueSecond],
    })
    expect(() => aggregate.assertGloballyUniqueSegmentIds()).toThrow(
      'Duplicate segment ID across book',
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

  it('reads narrator-owned sound cues in the narrator voice, never the fallback', () => {
    const chapter = makeChapter()
    const cue = new Segment({
      id: 'sound-cue-segment',
      chapterId: chapter.id,
      sourcePassageId: required(chapter.sourcePassages[0]).id,
      order: 1,
      sourceText: 'A door slammed.',
      kind: 'sound_cue',
      speakerId: null,
      confidence: 0.99,
      delivery: { emotion: 'neutral', pace: 'normal', volume: 'normal', pauseAfterMs: 0 },
    })
    const cast = new VoiceCast(
      profile('narrator', 'narrator', null),
      profile('fallback', 'fallback', null),
      [],
    )

    expect(cast.resolve(cue).assignment).toEqual({
      voiceProfileId: 'narrator',
      usesFallback: false,
      fallbackReason: null,
    })
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
      'running->abandoned',
      'running->failed',
      'running->completed',
      // Issue #45. Direction rests at awaiting_review until every unresolved speaker has a
      // persisted decision, and a completed book returns there when one is revoked or changed.
      'running->awaiting_review',
      'awaiting_review->running',
      'completed->awaiting_review',
      'abandoned->running',
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
    expect(() => job.beginDirection(1, 1)).toThrow(InvalidStateTransitionError)
    expect(() => job.start()).toThrow('Generation inputs must be bound')
    job.bindCommand(commandIdentity)
    job.start()
    job.attachBook(bookId)
    job.beginDirection(1, 1)
    job.recordDirectionProgress(chapterId, 1, 1, 'Directed chapter 1 of 1')
    job.beginRendering(1)
    expect(() => job.beginAssembly()).toThrow('All segments must complete')
    job.recordSegmentCompleted('segment-1')
    job.beginAssembly()
    const version = new OutputVersion(1)
    job.complete(
      {
        version,
        m4bPath: version.fileName('My Book', 'm4b'),
        chapters: [{ chapterId, path: 'My Book-v001-ch01.flac' }],
      },
      0,
    )

    expect(job.state).toBe('completed')
    expect(job.stage).toBe('completed')
    expect(job.progress).toMatchObject({ completedSegments: 1, totalSegments: 1 })
    expect(() => job.retry()).toThrow(InvalidStateTransitionError)
    expect(version.label).toBe('v001')
    expect(version.fileName('My Book', 'm4b')).toBe('My Book-v001.m4b')
  })

  it('keeps direction passage progress distinct from rendering segments and rejects nonsense', () => {
    const job = new AudiobookJob('job-direction-progress')
    job.bindCommand(commandIdentity)
    job.start()
    job.attachBook(bookId)
    expect(() => job.beginDirection(1, 0)).toThrow('positive chapter and passage totals')
    job.beginDirection(2, 5)
    job.recordDirectionProgress(chapterId, 0, 2, 'Directed 2 of 5 passages')

    expect(job.progress.direction).toEqual({
      completedChapters: 0,
      totalChapters: 2,
      completedPassages: 2,
      totalPassages: 5,
    })
    expect(job.progress).toMatchObject({ completedSegments: 0, totalSegments: 0 })
    expect(() => job.recordDirectionProgress(chapterId, 0, 1, 'Progress went backward')).toThrow(
      'Direction progress is invalid',
    )
    expect(() => job.recordDirectionProgress(chapterId, 1, 6, 'Too many passages')).toThrow(
      'Direction progress is invalid',
    )
    expect(() => job.awaitReview()).toThrow('every chapter and passage')
  })

  it('allows failed jobs to retry from extraction without changing their book', () => {
    const job = new AudiobookJob('job-retry')
    job.bindCommand(commandIdentity)
    job.start()
    job.attachBook(bookId)
    job.fail('temporary failure')
    job.retry()
    expect(job.stage).toBe('extracting')
    expect(job.error).toBeNull()
    expect(() => job.attachBook('another-book')).toThrow('cannot change its source book')
  })

  it('requires an explicit abandoned transition before recovering an active job', () => {
    const job = new AudiobookJob('job-abandoned')
    job.bindCommand(commandIdentity)
    job.start()
    expect(() => job.recoverAbandoned()).toThrow(InvalidStateTransitionError)
    job.markAbandoned()
    expect(job.state).toBe('abandoned')
    job.recoverAbandoned()
    expect(job.state).toBe('running')
    expect(job.stage).toBe('extracting')
  })

  it('round-trips completed and failed snapshots without replaying transitions', () => {
    const completed = new AudiobookJob('job-snapshot-completed')
    completed.bindCommand(commandIdentity)
    completed.start()
    completed.attachBook(bookId)
    completed.beginDirection(1, 1)
    completed.recordDirectionProgress(chapterId, 1, 1, 'Directed chapter 1 of 1')
    completed.beginRendering(1)
    completed.recordSegmentCompleted('segment-1')
    completed.beginAssembly()
    completed.complete(
      {
        version: new OutputVersion(3),
        m4bPath: '/output/book-v003.m4b',
        chapters: [{ chapterId, path: '/output/book-v003-ch01.flac' }],
      },
      0,
    )
    const completedReloaded = AudiobookJob.reconstitute(
      JSON.parse(JSON.stringify(completed.snapshot())),
    )
    expect(completedReloaded.snapshot()).toEqual(completed.snapshot())
    expect(completedReloaded.state).toBe('completed')
    expect(completedReloaded.catalogRevision).toBe(0)

    const failed = new AudiobookJob('job-snapshot-failed')
    failed.bindCommand(commandIdentity)
    failed.start()
    failed.fail('disk unavailable')
    const failedReloaded = AudiobookJob.reconstitute(JSON.parse(JSON.stringify(failed.snapshot())))
    expect(failedReloaded.snapshot()).toEqual(failed.snapshot())
    failedReloaded.retry()
    expect(failedReloaded.state).toBe('running')
  })

  it('rejects corrupt snapshots and duplicate completed output paths', () => {
    const pending = new AudiobookJob('job-invalid-snapshot').snapshot()
    expect(() =>
      AudiobookJob.reconstitute({
        ...pending,
        state: 'completed',
        stage: 'completed',
      }),
    ).toThrow('require a command identity')

    const job = new AudiobookJob('job-duplicate-output')
    job.bindCommand(commandIdentity)
    job.start()
    job.attachBook(bookId)
    job.beginDirection(1, 1)
    job.recordDirectionProgress(chapterId, 1, 1, 'Directed chapter 1 of 1')
    job.beginRendering(1)
    job.recordSegmentCompleted('segment-1')
    job.beginAssembly()
    expect(() =>
      job.complete(
        {
          version: new OutputVersion(1),
          m4bPath: '/output/shared',
          chapters: [{ chapterId, path: '/output/shared' }],
        },
        0,
      ),
    ).toThrow('pairwise distinct')
  })

  it('rejects every unreachable stage-specific persistence snapshot', () => {
    const runningExtracting = new AudiobookJob('snapshot-running-extracting')
    runningExtracting.bindCommand(commandIdentity)
    runningExtracting.start()

    const directing = new AudiobookJob('snapshot-directing')
    directing.bindCommand(commandIdentity)
    directing.start()
    directing.attachBook(bookId)
    directing.beginDirection(1, 1)

    const rendering = new AudiobookJob('snapshot-rendering')
    rendering.bindCommand(commandIdentity)
    rendering.start()
    rendering.attachBook(bookId)
    rendering.beginDirection(1, 1)
    rendering.recordDirectionProgress(chapterId, 1, 1, 'Directed chapter 1 of 1')
    rendering.beginRendering(2)

    const assembling = AudiobookJob.reconstitute(rendering.snapshot())
    assembling.recordSegmentCompleted('segment-1')
    assembling.recordSegmentCompleted('segment-2')
    assembling.beginAssembly()

    const completed = AudiobookJob.reconstitute(assembling.snapshot())
    completed.complete(
      {
        version: new OutputVersion(1),
        m4bPath: '/output/book-v001.m4b',
        chapters: [{ chapterId, path: '/output/book-v001-ch01.flac' }],
      },
      0,
    )

    const pending = new AudiobookJob('snapshot-pending').snapshot()
    const runningSnapshot = runningExtracting.snapshot()
    const directingSnapshot = directing.snapshot()
    const renderingSnapshot = rendering.snapshot()
    const assemblingSnapshot = assembling.snapshot()
    const completedSnapshot = completed.snapshot()
    for (const reachable of [
      pending,
      runningSnapshot,
      directingSnapshot,
      renderingSnapshot,
      assemblingSnapshot,
      completedSnapshot,
    ]) {
      expect(AudiobookJob.reconstitute(reachable).snapshot()).toEqual(reachable)
    }

    const warning = {
      segmentId: 'segment-warning',
      speakerId: null,
      voiceProfileId: 'fallback',
      reason: 'unresolved_speaker' as const,
    }
    const impossible: readonly [string, unknown][] = [
      ['old embedded-output schema', { ...pending, schemaVersion: 3 }],
      ['pending with book', { ...pending, bookId }],
      [
        'pending with progress',
        { ...pending, progress: { ...pending.progress, totalSegments: 1 } },
      ],
      ['pending directing', { ...pending, stage: 'directing' }],
      [
        'extracting with total',
        { ...runningSnapshot, progress: { ...runningSnapshot.progress, totalSegments: 1 } },
      ],
      ['extracting with warning', { ...runningSnapshot, warnings: [warning] }],
      [
        'extracting with chapter',
        {
          ...runningSnapshot,
          progress: { ...runningSnapshot.progress, currentChapterId: chapterId },
        },
      ],
      ['directing without book', { ...directingSnapshot, bookId: null }],
      [
        'directing with total',
        { ...directingSnapshot, progress: { ...directingSnapshot.progress, totalSegments: 1 } },
      ],
      [
        'rendering without total',
        { ...renderingSnapshot, progress: { ...renderingSnapshot.progress, totalSegments: 0 } },
      ],
      ['rendering without book', { ...renderingSnapshot, bookId: null }],
      [
        'assembling incomplete',
        {
          ...assemblingSnapshot,
          progress: { ...assemblingSnapshot.progress, completedSegments: 1 },
        },
      ],
      [
        'assembling with chapter',
        {
          ...assemblingSnapshot,
          progress: { ...assemblingSnapshot.progress, currentChapterId: chapterId },
        },
      ],
      ['failed message differs', { ...runningSnapshot, state: 'failed', error: 'failure' }],
      ['running with error', { ...runningSnapshot, error: 'impossible' }],
      ['abandoned message differs', { ...runningSnapshot, state: 'abandoned' }],
      ['completed without book', { ...completedSnapshot, bookId: null }],
      ['completed invalid command', { ...completedSnapshot, commandIdentity: 'unsafe' }],
      [
        'completed with zero total',
        {
          ...completedSnapshot,
          progress: { ...completedSnapshot.progress, completedSegments: 0, totalSegments: 0 },
        },
      ],
      [
        'completed incomplete',
        { ...completedSnapshot, progress: { ...completedSnapshot.progress, completedSegments: 0 } },
      ],
      [
        'completed current chapter',
        {
          ...completedSnapshot,
          progress: { ...completedSnapshot.progress, currentChapterId: chapterId },
        },
      ],
      [
        'completed wrong message',
        {
          ...completedSnapshot,
          progress: { ...completedSnapshot.progress, latestMessage: 'Not done' },
        },
      ],
    ]

    for (const [name, snapshot] of impossible) {
      expect(() => AudiobookJob.reconstitute(snapshot as AudiobookJobSnapshot), name).toThrow(
        DomainError,
      )
    }
  })

  it('validates every fallback warning field and speaker-reason relationship at runtime', () => {
    const job = new AudiobookJob('snapshot-warning-validation')
    job.bindCommand(commandIdentity)
    job.start()
    job.attachBook(bookId)
    job.beginDirection(1, 1)
    const segmentId = StableIds.segment(StableIds.passage(chapterId, 1), 1)
    const valid = {
      segmentId,
      speakerId: null,
      voiceProfileId: 'fallback-dialogue',
      reason: 'unresolved_speaker' as const,
    }
    job.addFallbackWarning(valid)
    const snapshot = job.snapshot()
    expect(AudiobookJob.reconstitute(snapshot).warnings).toEqual([valid])
    expect(
      AudiobookJob.reconstitute({
        ...snapshot,
        warnings: [
          {
            ...valid,
            speakerId: 'missing-character',
            reason: 'missing_speaker_voice',
          },
        ],
      }).warnings,
    ).toHaveLength(1)

    const probes: readonly [string, unknown][] = [
      ['null warning', null],
      ['non-string segment', { ...valid, segmentId: 42 }],
      ['empty segment', { ...valid, segmentId: '' }],
      ['unstable segment', { ...valid, segmentId: 'segment-1' }],
      [
        'foreign segment',
        {
          ...valid,
          segmentId: StableIds.segment(
            StableIds.passage(StableIds.chapter(StableIds.book('b'.repeat(64)), 1), 1),
            1,
          ),
        },
      ],
      ['non-string voice', { ...valid, voiceProfileId: 42 }],
      ['empty voice', { ...valid, voiceProfileId: '' }],
      ['unstable voice', { ...valid, voiceProfileId: 'bad voice/id' }],
      ['non-string speaker', { ...valid, speakerId: 42 }],
      ['non-string reason', { ...valid, reason: 42 }],
      ['unknown reason', { ...valid, reason: 'other' }],
      ['unresolved with speaker', { ...valid, speakerId: 'alice' }],
      [
        'missing voice with null speaker',
        { ...valid, reason: 'missing_speaker_voice', speakerId: null },
      ],
      [
        'missing voice with empty speaker',
        { ...valid, reason: 'missing_speaker_voice', speakerId: '' },
      ],
      [
        'missing voice with unstable speaker',
        { ...valid, reason: 'missing_speaker_voice', speakerId: 'bad speaker/id' },
      ],
    ]
    for (const [name, warning] of probes) {
      expect(
        () =>
          AudiobookJob.reconstitute({
            ...snapshot,
            warnings: [warning],
          } as AudiobookJobSnapshot),
        name,
      ).toThrow(DomainError)
    }
  })
})
