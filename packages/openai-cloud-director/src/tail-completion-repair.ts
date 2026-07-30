import { splitDirectedSegments } from '@light-novel-audiobook/application'
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

export type NarrationTailCompletionMode = 'attach-to-previous' | 'synthesize-narration'

export interface NarrationTailCompletionRepair {
  readonly sourcePassageId: string
  readonly appendedCodeUnitCount: number
  readonly mode: NarrationTailCompletionMode
}

export interface NarrationTailCompletionRepairResult {
  readonly output: DirectionWireOutput
  readonly repairs: readonly NarrationTailCompletionRepair[]
}

const SPLITTER_PROBE_DELIVERY = Object.freeze({
  emotion: 'neutral',
  pace: 'normal',
  volume: 'normal',
  pauseAfterMs: 0,
} as const)

/**
 * Probes the real application splitter with the candidate merged text. Splitting is per-segment
 * and reads only sourceText and sourcePassageId, so acceptance here is exactly acceptance in the
 * pipeline; only the merged segment's split outcome changes with this repair. Declining hands the
 * passage back to the unchanged fidelity validator, whose window retry is the recovery path —
 * attaching an unsplittable tail would instead fail the chapter deterministically after direction
 * succeeded, outside any retry budget.
 */
function splitterAcceptsMergedTail(sourceText: string, sourcePassageId: string): boolean {
  try {
    splitDirectedSegments([
      {
        sourcePassageId,
        sourceText,
        kind: 'narration',
        speakerId: null,
        confidence: 1,
        delivery: SPLITTER_PROBE_DELIVERY,
      },
    ])
    return true
  } catch {
    return false
  }
}

/**
 * Completes only a short, quote-free suffix omitted after a nonempty exact source prefix.
 *
 * The appended text is sliced from the immutable request, never model output. Whitespace-only
 * tails attach to the last eligible segment; other tails become a schema-valid narrator-owned
 * segment. The ordinary fidelity validator still runs afterwards and remains the final authority.
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

  const replacementBySegmentIndex = new Map<number, ModelDirectedWireSegment>()
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

    if (missingTail.trim().length === 0) {
      const lastSegment = output.segments[lastSegmentIndex]
      if (lastSegment === undefined || lastSegment.source_text.trim().length === 0) {
        // Decline instead of emitting a guaranteed-unrenderable whitespace-only fragment. The
        // unchanged fidelity validator then owns rejection and lets the window retry normally.
        continue
      }
      const mergedSourceText = lastSegment.source_text + missingTail
      if (!splitterAcceptsMergedTail(mergedSourceText, passage.id)) {
        // A tail the splitter rejects (e.g. a trailing whitespace run beyond the separator
        // allowance on a near-budget segment) must decline: the fidelity validator owns the
        // failure and the window retries, instead of a post-direction terminal split failure.
        continue
      }
      // Preserve global director identity for resume compatibility: the previous standalone
      // whitespace repair could never persist because application splitting deterministically
      // rejects a leading whitespace-only piece before chapter persistence. Appending a
      // whitespace suffix also cannot split a source grapheme. The spread deliberately preserves
      // every provider-owned wire semantic field.
      replacementBySegmentIndex.set(
        lastSegmentIndex,
        Object.freeze({
          ...lastSegment,
          source_text: mergedSourceText,
        }),
      )
      repairs.push({
        sourcePassageId: passage.id,
        appendedCodeUnitCount: missingTail.length,
        mode: 'attach-to-previous',
      })
      continue
    }

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
      mode: 'synthesize-narration',
    })
  }

  if (repairs.length === 0) {
    return { output, repairs: Object.freeze(repairs) }
  }

  const segments: ModelDirectedWireSegment[] = []
  for (const [index, segment] of output.segments.entries()) {
    segments.push(replacementBySegmentIndex.get(index) ?? segment)
    const synthesized = synthesizedByLastSegmentIndex.get(index)
    if (synthesized !== undefined) segments.push(synthesized)
  }
  return {
    output: { segments: Object.freeze(segments) },
    repairs: Object.freeze(repairs),
  }
}
