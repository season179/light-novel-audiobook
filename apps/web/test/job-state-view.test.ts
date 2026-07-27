import { type AudiobookJobSnapshot, OutputVersion } from '@light-novel-audiobook/domain'
import { describe, expect, it } from 'vitest'
import {
  buildJobStateView,
  deriveChapterLabel,
  deriveChapterNumber,
  type ReviewQueueEntry,
} from '../src/server/job-state-view.js'

const bookId = `book-${'a'.repeat(24)}`

const runningSnapshot: AudiobookJobSnapshot = {
  schemaVersion: 4,
  id: 'job-aaaaaaaaaaaaaaaaaaaaaaaa',
  state: 'running',
  stage: 'rendering',
  commandIdentity: 'b'.repeat(64),
  renderContract: null,
  catalogRevision: null,
  bookId,
  progress: {
    currentChapterId: `${bookId}-ch0002`,
    direction: {
      completedChapters: 2,
      totalChapters: 4,
      completedPassages: 18,
      totalPassages: 40,
    },
    completedSegments: 3,
    totalSegments: 12,
    latestMessage: 'Rendering A Stranger',
  },
  warnings: [
    {
      segmentId: `${bookId}-ch0002-p000001-s0001`,
      speakerId: null,
      voiceProfileId: 'fallback-ryan-restrained',
      reason: 'unresolved_speaker',
    },
  ],
  error: null,
  failureDiagnosticPath: null,
}

describe('chapter labels derived from stable IDs', () => {
  it('reads the chapter position out of a chapter ID', () => {
    expect(deriveChapterNumber(`${bookId}-ch0007`)).toBe(7)
    expect(deriveChapterLabel(`${bookId}-ch0007`)).toBe('Chapter 7')
  })

  it('reads the chapter position out of a segment ID', () => {
    expect(deriveChapterLabel(`${bookId}-ch0003-p000012-s0002`)).toBe('Chapter 3')
  })

  it('degrades to a safe label when an ID carries no position', () => {
    expect(deriveChapterNumber('not-a-stable-id')).toBeNull()
    expect(deriveChapterLabel('not-a-stable-id')).toBe('Unknown chapter')
  })
})

describe('buildJobStateView', () => {
  it('presents persisted progress without needing a book projection', () => {
    const view = buildJobStateView(runningSnapshot, undefined)

    expect(view.stageLabel).toBe('Rendering speech')
    expect(view.currentChapterLabel).toBe('Chapter 2')
    expect(view.currentChapterTitle).toBeNull()
    expect(view.bookTitle).toBeNull()
    expect(view.percentComplete).toBe(25)
    expect(view.completedPassages).toBe(18)
    expect(view.totalPassages).toBe(40)
    expect(view.directionPercentComplete).toBe(45)
    expect(view.active).toBe(true)
    expect(view.finished).toBe(false)
    expect(view.warnings[0]?.chapterLabel).toBe('Chapter 2')
    expect(view.warnings[0]?.message).toContain('fallback dialogue voice')
  })

  it('uses chapter titles when the projection is warm', () => {
    const view = buildJobStateView(runningSnapshot, {
      bookId,
      title: 'A Small Story',
      author: null,
      chapters: [
        {
          chapterId: `${bookId}-ch0002`,
          position: 2,
          title: 'A Stranger',
          segmentCount: 6,
          flaggedSegments: 1,
        },
      ],
      totalPassages: 40,
      totalSegments: 12,
      fallbackSegments: 2,
    })

    expect(view.bookTitle).toBe('A Small Story')
    expect(view.currentChapterTitle).toBe('A Stranger')
    expect(view.pipelineStages.map((stage) => stage.status)).toEqual([
      'completed',
      'completed',
      'current',
      'upcoming',
    ])
    expect(view.pipelineStages[0]?.summary).toBe('4 chapters and 40 passages extracted')
    expect(view.pipelineStages[1]?.summary).toBe('12 segments directed; 2 needed a fallback voice')
  })

  it('treats completed as a terminal marker and summarizes rendering and assembly', () => {
    const snapshot: AudiobookJobSnapshot = {
      ...runningSnapshot,
      state: 'completed',
      stage: 'completed',
      catalogRevision: 0,
      progress: {
        ...runningSnapshot.progress,
        currentChapterId: null,
        completedSegments: 12,
        latestMessage: 'Audiobook completed',
      },
    }
    const view = buildJobStateView(
      snapshot,
      {
        bookId,
        title: 'A Small Story',
        author: null,
        chapters: [
          {
            chapterId: `${bookId}-ch0002`,
            position: 2,
            title: 'A Stranger',
            segmentCount: 6,
            flaggedSegments: 1,
          },
        ],
        totalPassages: 40,
        totalSegments: 12,
        fallbackSegments: 2,
      },
      {
        version: new OutputVersion(3),
        m4bPath: '/workspace/output-v003.m4b',
        chapters: [{ chapterId: `${bookId}-ch0002`, path: '/workspace/output-v003-ch02.flac' }],
      },
    )

    expect(view.pipelineStages).toHaveLength(4)
    expect(view.pipelineStages.every((stage) => stage.status === 'completed')).toBe(true)
    expect(view.pipelineStages[2]?.summary).toBe('12 segment audio files ready')
    expect(view.pipelineStages[3]?.summary).toBe('Output v003 assembled')
  })
})

const awaitingReviewSnapshot: AudiobookJobSnapshot = {
  ...runningSnapshot,
  state: 'awaiting_review',
  stage: 'directing',
  progress: {
    ...runningSnapshot.progress,
    currentChapterId: null,
    completedSegments: 0,
    totalSegments: 0,
    latestMessage: 'Awaiting fallback approval review',
  },
}

const reviewItem = (decision: ReviewQueueEntry['decision']): ReviewQueueEntry => ({ decision })

describe('derived review status (issue #96)', () => {
  it('needs_decisions while any fallback subject lacks a live approval', () => {
    const view = buildJobStateView(awaitingReviewSnapshot, undefined, undefined, [
      reviewItem('approved'),
      reviewItem('pending'),
      reviewItem('excluded'),
    ])

    expect(view.review).toEqual({ status: 'needs_decisions', blockers: 2, total: 3 })
  })

  it('ready_to_confirm when every fallback subject carries a live approval', () => {
    const view = buildJobStateView(awaitingReviewSnapshot, undefined, undefined, [
      reviewItem('approved'),
      reviewItem('approved'),
    ])

    expect(view.review).toEqual({ status: 'ready_to_confirm', blockers: 0, total: 2 })
  })

  it('an empty queue is ready_to_confirm — nothing is blocking, not a missing panel', () => {
    const view = buildJobStateView(awaitingReviewSnapshot, undefined, undefined, [])

    expect(view.review).toEqual({ status: 'ready_to_confirm', blockers: 0, total: 0 })
  })

  it('answers from the live records, not the stored message: approvals recorded after the snapshot flip it', () => {
    // The snapshot's message still says the book awaits review — it was written before the
    // approvals landed and is never rewritten by a review decision.
    const view = buildJobStateView(awaitingReviewSnapshot, undefined, undefined, [
      reviewItem('approved'),
    ])

    expect(view.review?.status).toBe('ready_to_confirm')
    expect(view.latestMessage).toBe('Awaiting fallback approval review')
  })

  it('is null outside awaiting_review, where there is no review surface at all', () => {
    const view = buildJobStateView(runningSnapshot, undefined, undefined, [reviewItem('pending')])

    expect(view.review).toBeNull()
  })
})
