import {
  type DirectionRequest,
  type DirectionWireOutput,
  directionWireOutputSchemaFor,
  type ModelDirectedWireSegment,
  validateDirectionOutput,
} from '@light-novel-audiobook/gemma-director'
import { describe, expect, it } from 'vitest'
import { splitDirectedSegments } from '../../application/src/split-directed-segments.js'
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

  it('declines a whitespace tail when the last same-passage segment is trim-empty', () => {
    const request = requestFor([{ id: 'p1', text: 'Prefix  ' }])
    const output: DirectionWireOutput = {
      segments: [narration('p1', 'Prefix'), narration('p1', ' ')],
    }

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
