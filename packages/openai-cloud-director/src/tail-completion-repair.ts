import type {
  DirectionRequest,
  DirectionWireOutput,
  ModelDirectedWireSegment,
} from '@light-novel-audiobook/gemma-director'

/**
 * Attribution tails are short. Capping at 200 UTF-16 code units keeps this repair from turning a
 * substantial omission into narrator-owned text; longer tails remain validator/retry failures.
 */
export const NARRATION_TAIL_COMPLETION_MAX_CODE_UNITS = 200

// U+0022, U+0027, U+201C, U+201D, U+2018, and U+2019 respectively.
const FORBIDDEN_TAIL_QUOTES = /["'“”‘’]/u

export interface NarrationTailCompletionRepair {
  readonly sourcePassageId: string
  readonly appendedCodeUnitCount: number
}

export interface NarrationTailCompletionRepairResult {
  readonly output: DirectionWireOutput
  readonly repairs: readonly NarrationTailCompletionRepair[]
}

/**
 * Completes only a short, quote-free suffix omitted after a nonempty exact source prefix.
 *
 * The appended text is sliced from the immutable request, never model output. One schema-valid
 * narrator-owned segment is inserted immediately after the passage's last emitted segment. The
 * ordinary fidelity validator still runs afterwards and remains the final authority.
 */
export function repairNarrationTailCompletion(
  output: DirectionWireOutput,
  request: DirectionRequest,
): NarrationTailCompletionRepairResult {
  const segmentIndexesByPassage = new Map<string, number[]>()
  for (const [index, segment] of output.segments.entries()) {
    const indexes = segmentIndexesByPassage.get(segment.source_passage_id) ?? []
    indexes.push(index)
    segmentIndexesByPassage.set(segment.source_passage_id, indexes)
  }

  const synthesizedByLastSegmentIndex = new Map<number, ModelDirectedWireSegment>()
  const repairs: NarrationTailCompletionRepair[] = []
  for (const passage of request.passages) {
    const indexes = segmentIndexesByPassage.get(passage.id) ?? []
    if (indexes.length === 0) continue

    const echoed = indexes.map((index) => output.segments[index]?.source_text ?? '').join('')
    if (
      echoed.length === 0 ||
      echoed.length >= passage.text.length ||
      !passage.text.startsWith(echoed)
    ) {
      continue
    }

    const missingTail = passage.text.slice(echoed.length)
    if (
      missingTail.length === 0 ||
      missingTail.length > NARRATION_TAIL_COMPLETION_MAX_CODE_UNITS ||
      FORBIDDEN_TAIL_QUOTES.test(missingTail)
    ) {
      continue
    }

    const lastSegmentIndex = indexes[indexes.length - 1]
    if (lastSegmentIndex === undefined) continue
    synthesizedByLastSegmentIndex.set(
      lastSegmentIndex,
      Object.freeze({
        source_passage_id: passage.id,
        source_text: missingTail,
        kind: 'narration',
        confidence: 1,
        delivery: Object.freeze({
          emotion: 'neutral',
          pace: 'normal',
          volume: 'normal',
          pause_after_ms: 0,
        }),
      }),
    )
    repairs.push({
      sourcePassageId: passage.id,
      appendedCodeUnitCount: missingTail.length,
    })
  }

  if (repairs.length === 0) {
    return { output, repairs: Object.freeze(repairs) }
  }

  const segments: ModelDirectedWireSegment[] = []
  for (const [index, segment] of output.segments.entries()) {
    segments.push(segment)
    const synthesized = synthesizedByLastSegmentIndex.get(index)
    if (synthesized !== undefined) segments.push(synthesized)
  }
  return {
    output: { segments: Object.freeze(segments) },
    repairs: Object.freeze(repairs),
  }
}
