import { type DirectedSegment, DomainError } from '@light-novel-audiobook/domain'
import { describe, expect, it } from 'vitest'
import {
  MAX_FRAGMENT_CHARACTERS,
  SEPARATOR_OVERSHOOT,
  splitDirectedSegments,
} from '../src/split-directed-segments.js'

const BASE_FRAGMENT: DirectedSegment = {
  sourcePassageId: 'passage-1',
  sourceText: '',
  kind: 'narration',
  speakerId: null,
  confidence: 0.9,
  delivery: { emotion: 'neutral', pace: 'normal', volume: 'normal', pauseAfterMs: 0 },
}

function fragment(sourceText: string): DirectedSegment {
  return { ...BASE_FRAGMENT, sourceText }
}

function split(sourceText: string, maxCharacters = MAX_FRAGMENT_CHARACTERS): string[] {
  return splitDirectedSegments([fragment(sourceText)], maxCharacters).map((item) => item.sourceText)
}

/** Every index at which a grapheme cluster ends in `text` (0 and length included). */
function graphemeBoundaryIndices(text: string): Set<number> {
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
  const indices = new Set<number>([0])
  let position = 0
  for (const part of segmenter.segment(text)) {
    position += part.segment.length
    indices.add(position)
  }
  return indices
}

describe('splitDirectedSegments (#55)', () => {
  it('is a no-op for fragments already within the budget', () => {
    const text = 'A short passage that needs no splitting.'
    expect(split(text)).toEqual([text])
  })

  it('partitions a long real-shaped passage so the pieces reassemble byte-for-byte', () => {
    const sentence =
      'The rider crossed the empty courtyard, glanced once at the sealed gate, and kept moving toward the lantern light at the far end of the street. '
    const text = sentence.repeat(12) // well over budget, many sentence + clause boundaries
    const pieces = split(text)

    expect(pieces.length).toBeGreaterThan(1)
    expect(pieces.join('')).toBe(text) // exact partition: nothing lost, duplicated, or reordered
    for (const piece of pieces)
      expect(Array.from(piece).length).toBeLessThanOrEqual(MAX_FRAGMENT_CHARACTERS)
  })

  it('never splits mid-grapheme: astral characters, combining marks, and an emoji sequence placed at split points survive intact', () => {
    // astral (U+1D54F), combining mark (e + U+0301), and a ZWJ family emoji embedded in a long run.
    const tricky = 'café 𝕏maton greeted the 👨‍👩‍👧 family. '
    const text = tricky.repeat(40)
    const pieces = split(text)

    expect(pieces.join('')).toBe(text)
    // Direct check of the #30 hazard: every cumulative split point must land on a grapheme boundary.
    const boundaries = graphemeBoundaryIndices(text)
    let cumulative = 0
    for (const piece of pieces) {
      cumulative += piece.length
      expect(boundaries.has(cumulative)).toBe(true)
    }
    // And no piece may end with a lone high surrogate (mid-astral split).
    for (const piece of pieces) {
      const last = piece.charCodeAt(piece.length - 1)
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
    }
    // The multi-code-point graphemes survive whole: each tricky cluster is a substring of some
    // piece (the grapheme-boundary check above already proves they cannot straddle a split).
    const whole = ['\u{1d54f}', '👨‍👩‍👧']
    for (const grapheme of whole)
      expect(pieces.some((piece) => piece.includes(grapheme))).toBe(true)
  })

  it('prefers a sentence boundary over a clause boundary that would pack more', () => {
    // sentenceA has internal clause boundaries (commas) but ends with a sentence terminator;
    // sentenceB is long. The first piece must end at sentenceA's period, not at a later comma in B.
    const sentenceA =
      'The quick brown fox jumps, over the lazy dog, again and again, until it finally comes to rest here. '
    const sentenceB = 'Then a much longer second sentence full of words '.repeat(20)
    const text = sentenceA + sentenceB
    const pieces = split(text)

    expect(pieces[0]).toBe(sentenceA)
    expect(pieces[0]?.endsWith('. ')).toBe(true)
  })

  it('falls back to clause boundaries inside a single over-long sentence', () => {
    // One sentence, no terminator, many commas; splits must land on commas and stay in budget.
    const text = 'he walked, and talked, and paused, and breathed, '.repeat(30)
    const pieces = split(text)

    expect(pieces.join('')).toBe(text)
    for (const piece of pieces)
      expect(Array.from(piece).length).toBeLessThanOrEqual(MAX_FRAGMENT_CHARACTERS)
    // Every non-final piece ends at a clause boundary (a comma followed by a space).
    for (const piece of pieces.slice(0, -1)) expect(piece.endsWith(', ')).toBe(true)
  })

  it('falls back to word boundaries when there is no punctuation at all', () => {
    const text = 'word '.repeat(200)
    const pieces = split(text)

    expect(pieces.join('')).toBe(text)
    for (const piece of pieces)
      expect(Array.from(piece).length).toBeLessThanOrEqual(MAX_FRAGMENT_CHARACTERS)
    for (const piece of pieces.slice(0, -1)) expect(piece.endsWith(' ')).toBe(true)
  })

  it('inherits kind, speaker, confidence, and delivery on every split piece (only text differs)', () => {
    const original: DirectedSegment = {
      sourcePassageId: 'passage-7',
      sourceText: 'Sentence one. '.repeat(60),
      kind: 'dialogue',
      speakerId: 'char-rylie',
      confidence: 0.42,
      delivery: { emotion: 'weary', pace: 'slow', volume: 'soft', pauseAfterMs: 250 },
    }
    const pieces = splitDirectedSegments([original])

    expect(pieces.length).toBeGreaterThan(1)
    for (const piece of pieces) {
      expect(piece.sourcePassageId).toBe(original.sourcePassageId)
      expect(piece.kind).toBe(original.kind)
      expect(piece.speakerId).toBe(original.speakerId)
      expect(piece.confidence).toBe(original.confidence)
      expect(piece.delivery).toEqual(original.delivery)
    }
  })

  it('fails explicitly on a single unbreakable run longer than the budget (never truncates)', () => {
    const unsplittable = fragment('a'.repeat(MAX_FRAGMENT_CHARACTERS + 100)) // no boundary at all
    expect(() => splitDirectedSegments([unsplittable])).toThrow(DomainError)
    expect(() => splitDirectedSegments([unsplittable])).toThrow(
      /cannot be split: a run longer than the .*-character render budget/iu,
    )
  })

  it('attaches an isolated separator instead of emitting a whitespace-only piece (#55 r2)', () => {
    // 400-char unbreakable run + one separator + 400-char unbreakable run would naively yield
    // [400, 1, 400] -- a whitespace-only middle piece that QwenTtsSpeechEngine.validateRequest
    // rejects. The separator attaches to the preceding piece within the bounded overshoot.
    const run = 'A'.repeat(MAX_FRAGMENT_CHARACTERS)
    const text = `${run} ${'B'.repeat(MAX_FRAGMENT_CHARACTERS)}`
    const pieces = split(text)

    expect(pieces.length).toBe(2)
    expect(pieces.join('')).toBe(text)
    for (const piece of pieces) expect(piece.trim().length).toBeGreaterThan(0)
    for (const piece of pieces) {
      expect(Array.from(piece).length).toBeLessThanOrEqual(
        MAX_FRAGMENT_CHARACTERS + SEPARATOR_OVERSHOOT,
      )
    }
    expect(pieces[0]).toBe(`${run} `)
    expect(pieces[1]).toBe('B'.repeat(MAX_FRAGMENT_CHARACTERS))
  })

  it('throws when a separator run is too long to attach within the bounded overshoot (#55 r2)', () => {
    const tooLong = SEPARATOR_OVERSHOOT + 1
    const text = `${'A'.repeat(MAX_FRAGMENT_CHARACTERS)}${' '.repeat(tooLong)}${'B'.repeat(
      MAX_FRAGMENT_CHARACTERS,
    )}`
    expect(() => split(text)).toThrow(DomainError)
    expect(() => split(text)).toThrow(
      /cannot be split: a whitespace run longer than the .*-character separator allowance/iu,
    )
  })
})
