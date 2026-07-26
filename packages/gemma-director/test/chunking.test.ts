import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DIRECTION_CHUNKING,
  type DirectionChunkingSettings,
  estimateWindowOutputChars,
  estimateWindowPrompt,
  planChapterWindows,
  planWindow,
  resolveChunkingSettings,
  shrinkSettings,
} from '../src/chunking.js'
import { DirectorError } from '../src/errors.js'
import type { DirectorSourcePassage } from '../src/port.js'

const passages = (lengths: readonly number[]): DirectorSourcePassage[] =>
  lengths.map((length, index) => ({
    id: `passage-${String(index + 1).padStart(3, '0')}`,
    text: 'x'.repeat(length),
  }))

const settings = (overrides: Partial<DirectionChunkingSettings> = {}): DirectionChunkingSettings =>
  resolveChunkingSettings(overrides)

describe('resolveChunkingSettings', () => {
  it('applies defaults and rejects non-positive budgets', () => {
    expect(resolveChunkingSettings(undefined)).toEqual(DEFAULT_DIRECTION_CHUNKING)
    expect(resolveChunkingSettings({ windowCharBudget: 123 }).windowCharBudget).toBe(123)
    expect(() => resolveChunkingSettings({ windowCharBudget: 0 })).toThrow(DirectorError)
    expect(() => resolveChunkingSettings({ windowPassageBudget: -1 })).toThrow(DirectorError)
    expect(() => resolveChunkingSettings({ splitFactorAssumption: 0.5 })).toThrow(DirectorError)
    expect(() => resolveChunkingSettings({ maxWindowShrinks: 0 })).toThrow(DirectorError)
    try {
      resolveChunkingSettings({ outputCharsBudget: 0 })
      throw new Error('expected rejection')
    } catch (error) {
      expect((error as DirectorError).code).toBe('configuration')
    }
  })
})

describe('planWindow / planChapterWindows', () => {
  it('tiles a chapter into contiguous ordered windows bounded by chars and count', () => {
    const p = passages([100, 200, 300, 400, 500, 600])
    const s = settings({
      windowCharBudget: 600,
      windowPassageBudget: 2,
      outputCharsBudget: 100_000,
    })
    // count budget binds at [0,2); after that the char budget binds first (300+400 > 600)
    expect(planChapterWindows(p, s)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 3 },
      { start: 3, end: 4 },
      { start: 4, end: 5 },
      { start: 5, end: 6 },
    ])
    const charsOnly = settings({
      windowCharBudget: 600,
      windowPassageBudget: 100,
      outputCharsBudget: 100_000,
    })
    expect(planChapterWindows(p, charsOnly)).toEqual([
      { start: 0, end: 3 }, // 100+200+300 = 600 exactly, +400 would exceed
      { start: 3, end: 4 }, // 400, +500 would exceed
      { start: 4, end: 5 }, // 500
      { start: 5, end: 6 }, // 600
    ])
  })

  it('lets the output estimate bind when chars and count do not', () => {
    const p = passages([100, 100, 100, 100])
    const s = settings({
      windowCharBudget: 10_000,
      windowPassageBudget: 100,
      outputCharsBudget: estimateWindowOutputChars(200, 2, DEFAULT_DIRECTION_CHUNKING),
    })
    expect(planChapterWindows(p, s)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ])
  })

  it('emits an over-budget single passage as a solo window rather than splitting it', () => {
    const p = passages([10, 5_000, 10])
    const s = settings({
      windowCharBudget: 100,
      windowPassageBudget: 10,
      outputCharsBudget: 100_000,
    })
    expect(planChapterWindows(p, s)).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
      { start: 2, end: 3 },
    ])
  })

  it('handles 1-character passages without stalling', () => {
    const p = passages([1, 1, 1, 1, 1])
    const s = settings({
      windowCharBudget: 1000,
      windowPassageBudget: 2,
      outputCharsBudget: 100_000,
    })
    expect(planChapterWindows(p, s)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
      { start: 4, end: 5 },
    ])
  })

  it('rejects an out-of-range start', () => {
    expect(() => planWindow(passages([10]), 1, settings())).toThrow(DirectorError)
  })
})

describe('shrinkSettings', () => {
  it('halves both dimensions down to the single-passage floor', () => {
    const s = settings({ windowCharBudget: 6_000, windowPassageBudget: 24 })
    const once = shrinkSettings(s)
    expect(once.windowCharBudget).toBe(3_000)
    expect(once.windowPassageBudget).toBe(12)
    let current = once
    for (let i = 0; i < 10; i += 1) current = shrinkSettings(current)
    expect(current.windowCharBudget).toBe(500)
    expect(current.windowPassageBudget).toBe(1)
  })
})

describe('estimateWindowPrompt', () => {
  it('counts fixed, passage, id, and envelope characters against the context budget', () => {
    const estimate = estimateWindowPrompt(
      1_000,
      {
        requestId: 'r',
        bookId: 'b',
        bookTitle: 't',
        bookAuthor: null,
        bookSourceSha256: 'a'.repeat(64),
        chapterId: 'c',
        chapterPosition: 1,
        chapterTitle: 'ct',
        passages: passages([4_000]),
        speakers: [],
        narratorSpeakerId: 'narrator',
        fallbackSpeakerId: 'fallback',
      },
      32_768,
      8_192,
      settings(),
    )
    expect(estimate.promptTokenBudget).toBe(32_768 - 2_048 - 8_192)
    expect(estimate.promptChars).toBeGreaterThan(4_000)
    expect(estimate.estimatedPromptTokens).toBe(Math.ceil(estimate.promptChars / 3.5))
  })
})
