import {
  MAX_FRAGMENT_CHARACTERS,
  SEPARATOR_OVERSHOOT,
  splitDirectedSegments,
} from '@light-novel-audiobook/application'
import {
  type DirectionRequest,
  type DirectionWireOutput,
  directionWireOutputSchemaFor,
  type ModelDirectedWireSegment,
  validateDirectionOutput,
} from '@light-novel-audiobook/gemma-director'
import { describe, expect, it } from 'vitest'
import {
  NARRATION_TAIL_COMPLETION_MAX_CODE_UNITS,
  repairNarrationTailCompletion,
} from '../src/tail-completion-repair.js'

function requestFor(
  passages: ReadonlyArray<{ readonly id: string; readonly text: string }>,
): DirectionRequest {
  return {
    requestId: 'request-135',
    bookId: 'book-135',
    bookTitle: 'Tail Repair Fixture',
    bookAuthor: null,
    bookSourceSha256: 'd'.repeat(64),
    chapterId: 'chapter-135',
    chapterPosition: 1,
    chapterTitle: 'Dropped Tails',
    passages,
    speakers: [],
    narratorSpeakerId: 'narrator',
    fallbackSpeakerId: 'fallback-dialogue',
  }
}

function narration(sourcePassageId: string, sourceText: string) {
  return {
    source_passage_id: sourcePassageId,
    source_text: sourceText,
    kind: 'narration' as const,
    confidence: 0.8,
    delivery: {
      emotion: 'calm' as const,
      pace: 'normal' as const,
      volume: 'normal' as const,
      pause_after_ms: 250,
    },
  }
}

describe('deterministic narration-tail completion repair', () => {
  it('appends the immutable quote-free tail as one schema-valid neutral narration segment', () => {
    const request = requestFor([{ id: 'p1', text: 'Mira crossed the room quietly.' }])
    const output: DirectionWireOutput = {
      segments: [narration('p1', 'Mira crossed the room')],
    }

    const result = repairNarrationTailCompletion(output, request)

    expect(result.repairs).toEqual([
      {
        sourcePassageId: 'p1',
        appendedCodeUnitCount: ' quietly.'.length,
        mode: 'synthesize-narration',
      },
    ])
    expect(result.output.segments).toEqual([
      output.segments[0],
      {
        source_passage_id: 'p1',
        source_text: ' quietly.',
        kind: 'narration',
        confidence: 1,
        delivery: {
          emotion: 'neutral',
          pace: 'normal',
          volume: 'normal',
          pause_after_ms: 0,
        },
      },
    ])
    expect(() => directionWireOutputSchemaFor(request).parse(result.output)).not.toThrow()
    const validated = validateDirectionOutput(result.output, request, 0.8)
    expect(validated.annotations[1]).toMatchObject({
      sourcePassageId: 'p1',
      sourceText: ' quietly.',
      speakerId: 'narrator',
      confidence: 1,
    })
  })

  it('attaches the diagnosed one-unit whitespace tail to the last of two segments', () => {
    const firstText = 'a'.repeat(39)
    const lastText = 'b'.repeat(83)
    const sourceText = `${firstText}${lastText} `
    expect(sourceText).toHaveLength(123)
    const request = requestFor([{ id: 'p1', text: sourceText }])
    const output: DirectionWireOutput = {
      segments: [
        narration('p1', firstText),
        {
          source_passage_id: 'p1',
          source_text: lastText,
          kind: 'dialogue',
          speaker_id: null,
          speaker_reason: 'Synthetic unresolved-speaker fixture',
          confidence: 0.61,
          delivery: {
            emotion: 'uneasy',
            pace: 'slow',
            volume: 'soft',
            pause_after_ms: 430,
          },
        },
      ],
    }

    const result = repairNarrationTailCompletion(output, request)

    expect(result.repairs).toEqual([
      { sourcePassageId: 'p1', appendedCodeUnitCount: 1, mode: 'attach-to-previous' },
    ])
    expect(result.output.segments).toHaveLength(2)
    expect(result.output.segments[0]).toBe(output.segments[0])
    expect(result.output.segments[1]?.source_text).toBe(`${lastText} `)
    expect(result.output.segments.map((segment) => segment.source_text).join('')).toBe(sourceText)
    expect(() => directionWireOutputSchemaFor(request).parse(result.output)).not.toThrow()
    const validated = validateDirectionOutput(result.output, request, 0.8)
    expect(validated.annotations.map((annotation) => annotation.sourceText).join('')).toBe(
      sourceText,
    )

    const split = splitDirectedSegments(validated.annotations)
    expect(split.some((segment) => segment.sourceText.trim().length === 0)).toBe(false)
    expect(split.map((segment) => segment.sourceText).join('')).toBe(sourceText)
  })

  it('merges a mid-passage whitespace-only segment backward end to end', () => {
    const sourceText = 'Mira crossed the room.'
    const request = requestFor([{ id: 'p1', text: sourceText }])
    const output: DirectionWireOutput = {
      segments: [
        narration('p1', 'Mira crossed'),
        narration('p1', ' '),
        narration('p1', 'the room.'),
      ],
    }

    const result = repairNarrationTailCompletion(output, request)

    expect(result.repairs).toEqual([
      { sourcePassageId: 'p1', appendedCodeUnitCount: 1, mode: 'merge-whitespace-segment' },
    ])
    expect(result.output.segments).toHaveLength(2)
    expect(result.output.segments[0]?.source_text).toBe('Mira crossed ')
    expect(result.output.segments[1]).toBe(output.segments[2])
    expect(() => directionWireOutputSchemaFor(request).parse(result.output)).not.toThrow()
    const validated = validateDirectionOutput(result.output, request, 0.8)
    const split = splitDirectedSegments(validated.annotations)
    expect(split.map((segment) => segment.sourceText).join('')).toBe(sourceText)
    expect(split.some((segment) => segment.sourceText.trim().length === 0)).toBe(false)
  })

  it('merges a leading whitespace-only segment forward without crossing passages', () => {
    const sourceText = ' Leading narration.'
    const request = requestFor([
      { id: 'p0', text: 'Earlier passage.' },
      { id: 'p1', text: sourceText },
    ])
    const earlier = narration('p0', 'Earlier passage.')
    const leading = narration('p1', ' ')
    const content = narration('p1', 'Leading narration.')
    const output: DirectionWireOutput = { segments: [earlier, leading, content] }

    const result = repairNarrationTailCompletion(output, request)

    expect(result.repairs).toEqual([
      { sourcePassageId: 'p1', appendedCodeUnitCount: 1, mode: 'merge-whitespace-segment' },
    ])
    expect(result.output.segments).toHaveLength(2)
    expect(result.output.segments[0]).toBe(earlier)
    expect(result.output.segments[1]).not.toBe(content)
    expect(result.output.segments[1]).toEqual({ ...content, source_text: sourceText })
    expect(Object.isFrozen(result.output.segments[1])).toBe(true)
    expect(content.source_text).toBe('Leading narration.')
  })

  it('leaves a whitespace-only segment unchanged when both splitter probes reject it', () => {
    const previousText = 'a'.repeat(MAX_FRAGMENT_CHARACTERS)
    const whitespace = ' '.repeat(SEPARATOR_OVERSHOOT + 1)
    const nextText = 'b'.repeat(MAX_FRAGMENT_CHARACTERS)
    const request = requestFor([{ id: 'p1', text: previousText + whitespace + nextText }])
    const output: DirectionWireOutput = {
      segments: [
        narration('p1', previousText),
        narration('p1', whitespace),
        narration('p1', nextText),
      ],
    }

    expect(() =>
      splitDirectedSegments([
        {
          sourcePassageId: 'p1',
          sourceText: previousText + whitespace,
          kind: 'narration',
          speakerId: null,
          confidence: 1,
          delivery: { emotion: 'neutral', pace: 'normal', volume: 'normal', pauseAfterMs: 0 },
        },
      ]),
    ).toThrow()
    expect(() =>
      splitDirectedSegments([
        {
          sourcePassageId: 'p1',
          sourceText: whitespace + nextText,
          kind: 'narration',
          speakerId: null,
          confidence: 1,
          delivery: { emotion: 'neutral', pace: 'normal', volume: 'normal', pauseAfterMs: 0 },
        },
      ]),
    ).toThrow()

    const result = repairNarrationTailCompletion(output, request)

    expect(result.output).toBe(output)
    expect(result.repairs).toEqual([])
  })

  it('folds adjacent whitespace-only segments left to right into one running merge', () => {
    const sourceText = 'Alpha \t\nOmega'
    const request = requestFor([{ id: 'p1', text: sourceText }])
    const output: DirectionWireOutput = {
      segments: [
        narration('p1', 'Alpha'),
        narration('p1', ' '),
        narration('p1', '\t'),
        narration('p1', '\n'),
        narration('p1', 'Omega'),
      ],
    }

    const result = repairNarrationTailCompletion(output, request)

    expect(result.repairs).toEqual([
      { sourcePassageId: 'p1', appendedCodeUnitCount: 1, mode: 'merge-whitespace-segment' },
      { sourcePassageId: 'p1', appendedCodeUnitCount: 1, mode: 'merge-whitespace-segment' },
      { sourcePassageId: 'p1', appendedCodeUnitCount: 1, mode: 'merge-whitespace-segment' },
    ])
    expect(result.output.segments.map((segment) => segment.source_text)).toEqual([
      'Alpha \t\n',
      'Omega',
    ])
    expect(result.output.segments.map((segment) => segment.source_text).join('')).toBe(sourceText)
  })

  it('falls forward for the remainder of a run when the running backward merge fills', () => {
    const previousText = 'a'.repeat(MAX_FRAGMENT_CHARACTERS)
    const backwardWhitespace = ' '.repeat(SEPARATOR_OVERSHOOT)
    const forwardWhitespace = '\t'
    const nextText = 'b'.repeat(MAX_FRAGMENT_CHARACTERS)
    const sourceText = previousText + backwardWhitespace + forwardWhitespace + nextText
    const request = requestFor([{ id: 'p1', text: sourceText }])
    const output: DirectionWireOutput = {
      segments: [
        narration('p1', previousText),
        narration('p1', backwardWhitespace),
        narration('p1', forwardWhitespace),
        narration('p1', nextText),
      ],
    }

    const result = repairNarrationTailCompletion(output, request)

    expect(result.output.segments.map((segment) => segment.source_text)).toEqual([
      previousText + backwardWhitespace,
      forwardWhitespace + nextText,
    ])
    expect(result.output.segments.map((segment) => segment.source_text).join('')).toBe(sourceText)
    expect(result.repairs.map((repair) => repair.appendedCodeUnitCount)).toEqual([
      SEPARATOR_OVERSHOOT,
      1,
    ])
  })

  it('preserves order when an adjacent leading run folds forward', () => {
    const sourceText = ' \t\nOmega'
    const request = requestFor([{ id: 'p1', text: sourceText }])
    const output: DirectionWireOutput = {
      segments: [
        narration('p1', ' '),
        narration('p1', '\t'),
        narration('p1', '\n'),
        narration('p1', 'Omega'),
      ],
    }

    const result = repairNarrationTailCompletion(output, request)

    expect(result.output.segments.map((segment) => segment.source_text)).toEqual([sourceText])
    expect(result.output.segments[0]?.source_text).not.toBe('\n\t Omega')
    expect(result.repairs).toHaveLength(3)
    expect(result.repairs.every((repair) => repair.mode === 'merge-whitespace-segment')).toBe(true)
  })

  it('repairs the 184-unit diagnosed shape with one standalone single-space segment', () => {
    const tokens = ['"abc"', "'def'", ...Array.from({ length: 31 }, () => 'word'), 'z'.repeat(16)]
    const sourceText = `${tokens.join(' ')} `
    const standaloneSpaceIndex = sourceText.indexOf(' ', 40)
    const before = sourceText.slice(0, standaloneSpaceIndex)
    const after = sourceText.slice(standaloneSpaceIndex + 1)
    expect(sourceText).toHaveLength(184)
    expect(sourceText.match(/ /gu)).toHaveLength(34)
    expect(sourceText.match(/["']/gu)).toHaveLength(4)
    expect(sourceText.endsWith(' ')).toBe(true)
    expect(sourceText).not.toMatch(/ {2}/u)
    const request = requestFor([{ id: 'p1', text: sourceText }])
    const output: DirectionWireOutput = {
      segments: [narration('p1', before), narration('p1', ' '), narration('p1', after)],
    }

    const result = repairNarrationTailCompletion(output, request)

    expect(result.repairs).toEqual([
      { sourcePassageId: 'p1', appendedCodeUnitCount: 1, mode: 'merge-whitespace-segment' },
    ])
    expect(() => directionWireOutputSchemaFor(request).parse(result.output)).not.toThrow()
    const validated = validateDirectionOutput(result.output, request, 0.8)
    const split = splitDirectedSegments(validated.annotations)
    expect(split.map((segment) => segment.sourceText).join('')).toBe(sourceText)
    expect(split.some((segment) => segment.sourceText.trim().length === 0)).toBe(false)
  })

  it('preserves every wire field in a frozen copy without mutating input segments', () => {
    const first = Object.freeze(narration('p1', 'Opening'))
    const delivery = Object.freeze({
      emotion: 'weary' as const,
      pace: 'fast' as const,
      volume: 'loud' as const,
      pause_after_ms: 987,
    })
    const last: ModelDirectedWireSegment = Object.freeze({
      source_passage_id: 'p1',
      source_text: ' exchange',
      kind: 'thought',
      speaker_id: null,
      speaker_reason: 'Synthetic ambiguity fixture',
      confidence: 0.37,
      delivery,
    })
    const segments = Object.freeze([first, last])
    const output: DirectionWireOutput = Object.freeze({ segments })
    const request = requestFor([{ id: 'p1', text: 'Opening exchange\t' }])

    const result = repairNarrationTailCompletion(output, request)

    expect(result.output).not.toBe(output)
    expect(result.output.segments[0]).toBe(first)
    const attached = result.output.segments[1]
    expect(attached).not.toBe(last)
    expect(attached).toEqual({ ...last, source_text: ' exchange\t' })
    expect(attached?.delivery).toBe(delivery)
    expect(Object.isFrozen(attached)).toBe(true)
    expect(Object.isFrozen(result.output.segments)).toBe(true)
    expect(last.source_text).toBe(' exchange')
    expect(output.segments).toBe(segments)
    expect(result.output.segments.map((segment) => segment.source_text).join('')).toBe(
      request.passages[0]?.text,
    )
  })

  it('composes the whitespace pre-pass with whitespace-tail attachment', () => {
    const request = requestFor([{ id: 'p1', text: 'Prefix   ' }])
    const output: DirectionWireOutput = {
      segments: [narration('p1', 'Prefix'), narration('p1', ' ')],
    }

    const result = repairNarrationTailCompletion(output, request)

    expect(result.repairs).toEqual([
      { sourcePassageId: 'p1', appendedCodeUnitCount: 1, mode: 'merge-whitespace-segment' },
      { sourcePassageId: 'p1', appendedCodeUnitCount: 2, mode: 'attach-to-previous' },
    ])
    expect(result.output.segments).toHaveLength(1)
    expect(result.output.segments[0]?.source_text).toBe('Prefix   ')
    expect(() => validateDirectionOutput(result.output, request, 0.8)).not.toThrow()
  })

  it('still declines tail completion for whole-passage whitespace output', () => {
    const request = requestFor([{ id: 'p1', text: '   ' }])
    const output: DirectionWireOutput = { segments: [narration('p1', ' ')] }

    const result = repairNarrationTailCompletion(output, request)

    expect(result.output).toBe(output)
    expect(result.repairs).toEqual([])
    expect(() => validateDirectionOutput(result.output, request, 0.8)).toThrow()
  })

  it.each(['"', "'", '“', '”', '‘', '’'])(
    'does not repair a missing tail containing quote character %s',
    (quote) => {
      const request = requestFor([{ id: 'p1', text: `Prefix ${quote}quoted tail` }])
      const output: DirectionWireOutput = { segments: [narration('p1', 'Prefix ')] }

      const result = repairNarrationTailCompletion(output, request)

      expect(result.output).toBe(output)
      expect(result.repairs).toEqual([])
    },
  )

  it.each([
    ['middle omission', 'Alpha gamma.'],
    ['substitution', 'Alpha zeta gamma.'],
    ['duplication', 'Alpha Alpha beta gamma.'],
  ])('leaves %s untouched when the echo is not a strict prefix', (_case, echoed) => {
    const request = requestFor([{ id: 'p1', text: 'Alpha beta gamma.' }])
    const output: DirectionWireOutput = { segments: [narration('p1', echoed)] }

    const result = repairNarrationTailCompletion(output, request)

    expect(result.output).toBe(output)
    expect(result.repairs).toEqual([])
  })

  it('leaves an entirely omitted passage untouched', () => {
    const request = requestFor([
      { id: 'p1', text: 'Entirely omitted.' },
      { id: 'p2', text: 'Still emitted.' },
    ])
    const output: DirectionWireOutput = {
      segments: [narration('p2', 'Still emitted.')],
    }

    const result = repairNarrationTailCompletion(output, request)

    expect(result.output).toBe(output)
    expect(result.repairs).toEqual([])
  })

  it('repairs each eligible passage in place while preserving multi-passage ordering', () => {
    const request = requestFor([
      { id: 'p1', text: 'First attribution.' },
      { id: 'p2', text: 'Second ending.' },
    ])
    const output: DirectionWireOutput = {
      segments: [narration('p1', 'First '), narration('p1', 'attr'), narration('p2', 'Second')],
    }

    const result = repairNarrationTailCompletion(output, request)

    expect(result.repairs.map((repair) => repair.sourcePassageId)).toEqual(['p1', 'p2'])
    expect(
      result.output.segments.map((segment) => [segment.source_passage_id, segment.source_text]),
    ).toEqual([
      ['p1', 'First '],
      ['p1', 'attr'],
      ['p1', 'ibution.'],
      ['p2', 'Second'],
      ['p2', ' ending.'],
    ])
    expect(() => validateDirectionOutput(result.output, request, 0.8)).not.toThrow()
  })

  it('preserves a model passage reorder for the unchanged validator to reject', () => {
    const request = requestFor([
      { id: 'p1', text: 'First.' },
      { id: 'p2', text: 'Second.' },
    ])
    const output: DirectionWireOutput = {
      segments: [narration('p2', 'Second'), narration('p1', 'First')],
    }

    const result = repairNarrationTailCompletion(output, request)

    expect(
      result.output.segments.map((segment) => [segment.source_passage_id, segment.source_text]),
    ).toEqual([
      ['p2', 'Second'],
      ['p2', '.'],
      ['p1', 'First'],
      ['p1', '.'],
    ])
    expect(() => validateDirectionOutput(result.output, request, 0.8)).toThrow()
  })

  it('repairs a tail at the 200-code-unit cap', () => {
    const prefix = 'Prefix'
    const tail = 'x'.repeat(NARRATION_TAIL_COMPLETION_MAX_CODE_UNITS)
    const request = requestFor([{ id: 'p1', text: `${prefix}${tail}` }])
    const output: DirectionWireOutput = { segments: [narration('p1', prefix)] }

    const result = repairNarrationTailCompletion(output, request)

    expect(result.repairs).toEqual([
      {
        sourcePassageId: 'p1',
        appendedCodeUnitCount: NARRATION_TAIL_COMPLETION_MAX_CODE_UNITS,
        mode: 'synthesize-narration',
      },
    ])
    expect(result.output.segments[1]?.source_text).toBe(tail)
  })

  it('attaches a whitespace-only tail at the 200-code-unit cap', () => {
    const prefix = 'Prefix'
    const tail = ' '.repeat(NARRATION_TAIL_COMPLETION_MAX_CODE_UNITS)
    const request = requestFor([{ id: 'p1', text: `${prefix}${tail}` }])
    const output: DirectionWireOutput = { segments: [narration('p1', prefix)] }

    const result = repairNarrationTailCompletion(output, request)

    expect(result.repairs).toEqual([
      {
        sourcePassageId: 'p1',
        appendedCodeUnitCount: NARRATION_TAIL_COMPLETION_MAX_CODE_UNITS,
        mode: 'attach-to-previous',
      },
    ])
    expect(result.output.segments).toHaveLength(1)
    expect(result.output.segments[0]?.source_text).toBe(`${prefix}${tail}`)
    expect(() => validateDirectionOutput(result.output, request, 0.8)).not.toThrow()
  })

  it('declines a whitespace tail the splitter would reject on a near-budget segment', () => {
    const lastText = 'b'.repeat(MAX_FRAGMENT_CHARACTERS)
    const tail = ' '.repeat(SEPARATOR_OVERSHOOT + 1)
    const request = requestFor([{ id: 'p1', text: `${lastText}${tail}` }])
    const output: DirectionWireOutput = { segments: [narration('p1', lastText)] }

    expect(() =>
      splitDirectedSegments([
        {
          sourcePassageId: 'p1',
          sourceText: `${lastText}${tail}`,
          kind: 'narration',
          speakerId: null,
          confidence: 1,
          delivery: { emotion: 'neutral', pace: 'normal', volume: 'normal', pauseAfterMs: 0 },
        },
      ]),
    ).toThrow()

    const result = repairNarrationTailCompletion(output, request)

    expect(result.output).toBe(output)
    expect(result.repairs).toEqual([])
    expect(() => validateDirectionOutput(result.output, request, 0.8)).toThrow()
  })

  it('attaches an over-budget whitespace tail merge the splitter accepts', () => {
    const lastText = 'word '.repeat(MAX_FRAGMENT_CHARACTERS / 5 + 1).trimEnd()
    const sourceText = `${lastText} `
    expect(sourceText.length).toBeGreaterThan(MAX_FRAGMENT_CHARACTERS)
    const request = requestFor([{ id: 'p1', text: sourceText }])
    const output: DirectionWireOutput = { segments: [narration('p1', lastText)] }

    const result = repairNarrationTailCompletion(output, request)

    expect(result.repairs).toEqual([
      { sourcePassageId: 'p1', appendedCodeUnitCount: 1, mode: 'attach-to-previous' },
    ])
    expect(result.output.segments).toHaveLength(1)
    expect(result.output.segments[0]?.source_text).toBe(sourceText)
    const validated = validateDirectionOutput(result.output, request, 0.8)
    const split = splitDirectedSegments(validated.annotations)
    expect(split.some((segment) => segment.sourceText.trim().length === 0)).toBe(false)
    expect(split.map((segment) => segment.sourceText).join('')).toBe(sourceText)
  })

  it('declines a tail over the 200-code-unit cap so normal validation can reject it', () => {
    const prefix = 'Prefix'
    const tail = 'x'.repeat(NARRATION_TAIL_COMPLETION_MAX_CODE_UNITS + 1)
    const request = requestFor([{ id: 'p1', text: `${prefix}${tail}` }])
    const output: DirectionWireOutput = { segments: [narration('p1', prefix)] }

    const result = repairNarrationTailCompletion(output, request)

    expect(result.output).toBe(output)
    expect(result.repairs).toEqual([])
    expect(() => validateDirectionOutput(result.output, request, 0.8)).toThrow()
  })
})
