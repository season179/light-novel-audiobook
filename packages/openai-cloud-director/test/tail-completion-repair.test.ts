import {
  type DirectionRequest,
  type DirectionWireOutput,
  directionWireOutputSchemaFor,
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
      { sourcePassageId: 'p1', appendedCodeUnitCount: ' quietly.'.length },
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
      { sourcePassageId: 'p1', appendedCodeUnitCount: NARRATION_TAIL_COMPLETION_MAX_CODE_UNITS },
    ])
    expect(result.output.segments[1]?.source_text).toBe(tail)
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
