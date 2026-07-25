import type { AudiobookJobSnapshot } from '@light-novel-audiobook/domain'
import { describe, expect, it } from 'vitest'
import {
  buildJobStateView,
  deriveChapterLabel,
  deriveChapterNumber,
} from '../src/server/job-state-view.js'

const bookId = `book-${'a'.repeat(24)}`

const runningSnapshot: AudiobookJobSnapshot = {
  schemaVersion: 3,
  id: 'job-aaaaaaaaaaaaaaaaaaaaaaaa',
  state: 'running',
  stage: 'rendering',
  commandIdentity: 'b'.repeat(64),
  renderContract: null,
  bookId,
  progress: {
    currentChapterId: `${bookId}-ch0002`,
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
  output: null,
  error: null,
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
      chapters: [{ chapterId: `${bookId}-ch0002`, position: 2, title: 'A Stranger' }],
    })

    expect(view.bookTitle).toBe('A Small Story')
    expect(view.currentChapterTitle).toBe('A Stranger')
  })
})
