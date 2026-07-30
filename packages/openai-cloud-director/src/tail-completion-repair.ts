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

export type NarrationTailCompletionMode =
  | 'attach-to-previous'
  | 'synthesize-narration'
  | 'merge-whitespace-segment'

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

interface WhitespaceSegmentMergeResult {
  readonly output: DirectionWireOutput
  readonly repairs: readonly NarrationTailCompletionRepair[]
}

/**
 * Merges model-emitted whitespace-only segments without changing same-passage concatenation.
 *
 * A run is consumed left to right. Each member first folds into the running previous target while
 * that candidate remains splitter-safe. If one cannot append, that member and the rest of the run
 * are considered together as an ordered prefix for the next same-passage non-whitespace target.
 * The grouped forward candidate is atomic so leading runs cannot be reversed by repeated prepends.
 */
function mergeWhitespaceOnlySegments(output: DirectionWireOutput): WhitespaceSegmentMergeResult {
  const segmentIndexesByPassage = new Map<string, number[]>()
  for (const [index, segment] of output.segments.entries()) {
    const indexes = segmentIndexesByPassage.get(segment.source_passage_id) ?? []
    indexes.push(index)
    segmentIndexesByPassage.set(segment.source_passage_id, indexes)
  }

  const replacementBySegmentIndex = new Map<number, ModelDirectedWireSegment>()
  const removedSegmentIndexes = new Set<number>()
  const indexedRepairs: Array<{
    readonly segmentIndex: number
    readonly repair: NarrationTailCompletionRepair
  }> = []
  const segmentAt = (index: number): ModelDirectedWireSegment | undefined =>
    replacementBySegmentIndex.get(index) ?? output.segments[index]
  const replaceSourceText = (index: number, sourceText: string): void => {
    const segment = segmentAt(index)
    if (segment === undefined) return
    replacementBySegmentIndex.set(
      index,
      Object.freeze({
        ...segment,
        source_text: sourceText,
      }),
    )
  }
  const recordMerge = (index: number, segment: ModelDirectedWireSegment): void => {
    removedSegmentIndexes.add(index)
    indexedRepairs.push({
      segmentIndex: index,
      repair: {
        sourcePassageId: segment.source_passage_id,
        appendedCodeUnitCount: segment.source_text.length,
        mode: 'merge-whitespace-segment',
      },
    })
  }

  for (const indexes of segmentIndexesByPassage.values()) {
    let position = 0
    let previousNonWhitespaceIndex: number | undefined
    while (position < indexes.length) {
      const segmentIndex = indexes[position]
      const segment = segmentIndex === undefined ? undefined : output.segments[segmentIndex]
      if (segment === undefined) {
        position += 1
        continue
      }
      if (segment.source_text.trim().length > 0) {
        previousNonWhitespaceIndex = segmentIndex
        position += 1
        continue
      }

      const runStart = position
      while (position < indexes.length) {
        const runIndex = indexes[position]
        const runSegment = runIndex === undefined ? undefined : output.segments[runIndex]
        if (runSegment === undefined || runSegment.source_text.trim().length > 0) break
        position += 1
      }
      const runEnd = position
      const nextNonWhitespaceIndex = indexes[position]
      let pendingPosition = runStart

      if (previousNonWhitespaceIndex !== undefined) {
        while (pendingPosition < runEnd) {
          const whitespaceIndex = indexes[pendingPosition]
          const whitespaceSegment =
            whitespaceIndex === undefined ? undefined : output.segments[whitespaceIndex]
          const previousSegment = segmentAt(previousNonWhitespaceIndex)
          if (
            whitespaceIndex === undefined ||
            whitespaceSegment === undefined ||
            previousSegment === undefined
          ) {
            break
          }
          const mergedSourceText = previousSegment.source_text + whitespaceSegment.source_text
          if (!splitterAcceptsMergedTail(mergedSourceText, whitespaceSegment.source_passage_id)) {
            break
          }
          replaceSourceText(previousNonWhitespaceIndex, mergedSourceText)
          recordMerge(whitespaceIndex, whitespaceSegment)
          pendingPosition += 1
        }
      }

      if (pendingPosition < runEnd && nextNonWhitespaceIndex !== undefined) {
        const nextSegment = segmentAt(nextNonWhitespaceIndex)
        const pendingIndexes = indexes.slice(pendingPosition, runEnd)
        const pendingSegments = pendingIndexes.map((index) => output.segments[index])
        if (nextSegment !== undefined && pendingSegments.every((item) => item !== undefined)) {
          const whitespacePrefix = pendingSegments.map((item) => item?.source_text ?? '').join('')
          const mergedSourceText = whitespacePrefix + nextSegment.source_text
          if (splitterAcceptsMergedTail(mergedSourceText, nextSegment.source_passage_id)) {
            replaceSourceText(nextNonWhitespaceIndex, mergedSourceText)
            for (const [offset, whitespaceSegment] of pendingSegments.entries()) {
              const whitespaceIndex = pendingIndexes[offset]
              if (whitespaceIndex !== undefined && whitespaceSegment !== undefined) {
                recordMerge(whitespaceIndex, whitespaceSegment)
              }
            }
          }
        }
      }

      if (nextNonWhitespaceIndex !== undefined) previousNonWhitespaceIndex = nextNonWhitespaceIndex
    }
  }

  if (indexedRepairs.length === 0) return { output, repairs: [] }

  const segments: ModelDirectedWireSegment[] = []
  for (const [index, segment] of output.segments.entries()) {
    if (!removedSegmentIndexes.has(index)) {
      segments.push(replacementBySegmentIndex.get(index) ?? segment)
    }
  }
  indexedRepairs.sort((left, right) => left.segmentIndex - right.segmentIndex)
  return {
    output: { segments: Object.freeze(segments) },
    repairs: indexedRepairs.map(({ repair }) => repair),
  }
}

/**
 * Normalizes whitespace-only segment boundaries, then completes only a short, quote-free suffix
 * omitted after a nonempty exact source prefix.
 *
 * The pre-pass runs first so an eligible trim-empty last segment can merge into its neighbour before
 * tail completion. Appended tail text is sliced from the immutable request, never model output.
 * The ordinary fidelity validator still runs afterwards and remains the final authority.
 */
export function repairNarrationTailCompletion(
  output: DirectionWireOutput,
  request: DirectionRequest,
): NarrationTailCompletionRepairResult {
  const whitespaceMerged = mergeWhitespaceOnlySegments(output)
  const repairableOutput = whitespaceMerged.output
  const segmentIndexesByPassage = new Map<string, number[]>()
  for (const [index, segment] of repairableOutput.segments.entries()) {
    const indexes = segmentIndexesByPassage.get(segment.source_passage_id) ?? []
    indexes.push(index)
    segmentIndexesByPassage.set(segment.source_passage_id, indexes)
  }

  const replacementBySegmentIndex = new Map<number, ModelDirectedWireSegment>()
  const synthesizedByLastSegmentIndex = new Map<number, ModelDirectedWireSegment>()
  const repairs: NarrationTailCompletionRepair[] = [...whitespaceMerged.repairs]
  for (const passage of request.passages) {
    const indexes = segmentIndexesByPassage.get(passage.id) ?? []
    if (indexes.length === 0) continue

    const echoed = indexes
      .map((index) => repairableOutput.segments[index]?.source_text ?? '')
      .join('')
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
      const lastSegment = repairableOutput.segments[lastSegmentIndex]
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
  for (const [index, segment] of repairableOutput.segments.entries()) {
    segments.push(replacementBySegmentIndex.get(index) ?? segment)
    const synthesized = synthesizedByLastSegmentIndex.get(index)
    if (synthesized !== undefined) segments.push(synthesized)
  }
  return {
    output: { segments: Object.freeze(segments) },
    repairs: Object.freeze(repairs),
  }
}
