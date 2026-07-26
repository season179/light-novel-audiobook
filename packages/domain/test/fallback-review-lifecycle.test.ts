/**
 * The awaiting-review resting state issue #45 adds, and the guard it deliberately does **not**
 * relax.
 */
import { describe, expect, it } from 'vitest'
import {
  AudiobookJob,
  type AudiobookJobSnapshot,
  DomainError,
  InvalidStateTransitionError,
  Segment,
  StableIds,
} from '../src/index.js'

const COMMAND_IDENTITY = 'a'.repeat(64)
const BOOK_ID = StableIds.book('b'.repeat(64))
const CHAPTER_ID = StableIds.chapter(BOOK_ID, 1)
const PASSAGE_ID = StableIds.passage(CHAPTER_ID, 1)
const SEGMENT_ID = StableIds.segment(PASSAGE_ID, 1)
const AWAITING_MESSAGE = 'Awaiting fallback approval review'

const directedJob = (): AudiobookJob => {
  const job = new AudiobookJob('job-awaiting')
  job.bindCommand(COMMAND_IDENTITY)
  job.start()
  job.attachBook(BOOK_ID)
  job.beginDirection()
  return job
}

const completedJob = (): AudiobookJob => {
  const job = directedJob()
  job.addFallbackWarning({
    segmentId: SEGMENT_ID,
    speakerId: null,
    voiceProfileId: 'cast-fallback',
    reason: 'unresolved_speaker',
  })
  job.awaitReview()
  job.resumeApprovedRender()
  job.beginRendering(1)
  job.recordSegmentCompleted(SEGMENT_ID)
  job.beginAssembly()
  job.complete(
    {
      version: { value: 1, label: 'v001', fileName: () => 'x' } as never,
      m4bPath: '/workspace/story-v001.m4b',
      chapters: [{ chapterId: CHAPTER_ID, path: '/workspace/story-v001-ch001.flac' }],
    },
    0,
  )
  return job
}

describe('awaiting-review job lifecycle (issue #45)', () => {
  it('rests after direction and resumes into rendering without re-extracting', () => {
    const job = directedJob()
    job.awaitReview()

    expect(job.state).toBe('awaiting_review')
    // The stage stays `directing`: rendering has not begun, and the review has nothing to render yet.
    expect(job.stage).toBe('directing')
    expect(job.progress.latestMessage).toBe(AWAITING_MESSAGE)
    expect(job.progress.currentChapterId).toBeNull()
    expect(job.progress.totalSegments).toBe(0)

    job.resumeApprovedRender()
    expect(job.state).toBe('running')
    job.beginRendering(3)
    expect(job.stage).toBe('rendering')
  })

  it('refuses to rest before direction, or twice, and refuses to resume from anywhere else', () => {
    const extracting = new AudiobookJob('job-extracting')
    extracting.bindCommand(COMMAND_IDENTITY)
    extracting.start()
    expect(() => extracting.awaitReview()).toThrow(InvalidStateTransitionError)

    const job = directedJob()
    job.awaitReview()
    expect(() => job.awaitReview()).toThrow(InvalidStateTransitionError)

    const pending = new AudiobookJob('job-pending')
    expect(() => pending.resumeApprovedRender()).toThrow(InvalidStateTransitionError)
  })

  it('does not accept a fallback warning once the job is resting for review', () => {
    // The set needing a decision is complete at exactly this point, which is what makes a
    // pre-approval step possible without pausing mid-render.
    const job = directedJob()
    job.awaitReview()
    expect(() =>
      job.addFallbackWarning({
        segmentId: SEGMENT_ID,
        speakerId: null,
        voiceProfileId: 'cast-fallback',
        reason: 'unresolved_speaker',
      }),
    ).toThrow('can only be added during direction')
  })

  it('reopens a completed job for review, keeping its directed script and dropping its output', () => {
    const job = completedJob()
    expect(job.snapshot().output).not.toBeNull()

    job.reopenForReview()

    expect(job.state).toBe('awaiting_review')
    expect(job.stage).toBe('directing')
    expect(job.snapshot().output).toBeNull()
    expect(job.error).toBeNull()
    expect(job.progress.completedSegments).toBe(0)
    expect(job.progress.totalSegments).toBe(0)
    // The directed script survives: re-rendering after a review decision must not re-direct.
    expect(job.bookId).toBe(BOOK_ID)
    expect(job.commandIdentity).toBe(COMMAND_IDENTITY)
    expect(job.warnings.map((warning) => warning.segmentId)).toEqual([SEGMENT_ID])

    job.resumeApprovedRender()
    job.beginRendering(1)
    expect(job.stage).toBe('rendering')
  })

  it('has no raw completed-output getter and requires an explicit catalog revision', () => {
    const job = completedJob()

    expect(Object.getOwnPropertyDescriptor(AudiobookJob.prototype, 'output')).toBeUndefined()
    expect('output' in job).toBe(false)
    expect(job.completedOutputAtCatalogRevision(1)).toBeNull()
    expect(job.completedOutputAtCatalogRevision(0)?.m4bPath).toBe('/workspace/story-v001.m4b')
  })

  it('only reopens a completed job', () => {
    const job = directedJob()
    expect(() => job.reopenForReview()).toThrow(InvalidStateTransitionError)
    job.awaitReview()
    expect(() => job.reopenForReview()).toThrow(InvalidStateTransitionError)
  })

  it('round-trips an awaiting-review snapshot and refuses an unreachable one', () => {
    const job = directedJob()
    job.awaitReview()
    const snapshot = job.snapshot()
    const restored = AudiobookJob.reconstitute(snapshot)

    expect(restored.state).toBe('awaiting_review')
    expect(restored.stage).toBe('directing')
    expect(restored.bookId).toBe(BOOK_ID)
    expect(restored.progress.latestMessage).toBe(AWAITING_MESSAGE)

    const invalid =
      (overrides: Partial<AudiobookJobSnapshot>): (() => AudiobookJob) =>
      () =>
        AudiobookJob.reconstitute({ ...snapshot, ...overrides } as AudiobookJobSnapshot)

    // An awaiting-review job that never attached a book, or that claims render progress, or that
    // carries an arbitrary message, is not a state this domain can produce.
    expect(invalid({ bookId: null })).toThrow(DomainError)
    expect(invalid({ stage: 'rendering' })).toThrow(DomainError)
    expect(invalid({ stage: 'assembling' })).toThrow(DomainError)
    expect(
      invalid({ progress: { ...snapshot.progress, totalSegments: 4, completedSegments: 0 } }),
    ).toThrow(DomainError)
    expect(
      invalid({ progress: { ...snapshot.progress, latestMessage: 'Directing chapters' } }),
    ).toThrow(DomainError)
    expect(invalid({ progress: { ...snapshot.progress, currentChapterId: CHAPTER_ID } })).toThrow(
      DomainError,
    )
  })
})

describe('reviewed reassignment is deliberately NOT added (issue #45, prerequisite 4)', () => {
  /**
   * The decision, argued in full in the #45 report: direction assigns the fallback voice and review
   * only *approves* it. Nothing in the approval flow ever reassigns a segment, so
   * `Segment.assignVoice()`'s refusal to change a stable assignment stays exactly as issue #29 wrote
   * it. Giving an unresolved speaker a real cast voice is a change to the cast, which moves the
   * generation command identity and is re-directed — not a per-segment mutation with no consumer.
   *
   * These assertions pin that decision so a later change has to be deliberate.
   */
  const fallbackAssigned = (): Segment => {
    const segment = new Segment({
      id: SEGMENT_ID,
      chapterId: CHAPTER_ID,
      sourcePassageId: PASSAGE_ID,
      order: 1,
      sourceText: '“Nobody counted the hours.”',
      kind: 'dialogue',
      speakerId: null,
      confidence: 0.4,
      delivery: { emotion: 'flat', pace: 'normal', volume: 'normal', pauseAfterMs: 200 },
    })
    segment.assignVoice({
      voiceProfileId: 'cast-fallback',
      usesFallback: true,
      fallbackReason: 'unresolved_speaker',
    })
    return segment
  }

  it('still refuses to replace a fallback assignment with a real cast voice', () => {
    expect(() =>
      fallbackAssigned().assignVoice({
        voiceProfileId: 'cast-alice',
        usesFallback: false,
        fallbackReason: null,
      }),
    ).toThrow('already has a stable voice assignment')
  })

  it('still refuses to change the reason or the profile behind an existing fallback', () => {
    expect(() =>
      fallbackAssigned().assignVoice({
        voiceProfileId: 'cast-fallback',
        usesFallback: true,
        fallbackReason: 'missing_speaker_voice',
      }),
    ).toThrow('already has a stable voice assignment')
    expect(() =>
      fallbackAssigned().assignVoice({
        voiceProfileId: 'cast-second-fallback',
        usesFallback: true,
        fallbackReason: 'unresolved_speaker',
      }),
    ).toThrow('already has a stable voice assignment')
  })

  it('accepts the identical assignment again, which is all the read path needs', () => {
    // `findBook` rebuilds a segment and assigns its persisted voice once; re-reading is idempotent.
    const segment = fallbackAssigned()
    expect(() =>
      segment.assignVoice({
        voiceProfileId: 'cast-fallback',
        usesFallback: true,
        fallbackReason: 'unresolved_speaker',
      }),
    ).not.toThrow()
    expect(segment.voiceAssignment).toEqual({
      voiceProfileId: 'cast-fallback',
      usesFallback: true,
      fallbackReason: 'unresolved_speaker',
    })
  })
})
