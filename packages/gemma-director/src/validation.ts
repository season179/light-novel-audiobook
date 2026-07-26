import { DirectorError } from './errors.js'
import type { DirectedAnnotation, DirectionRequest, DirectorWarning } from './port.js'
import {
  type DirectedWireSegment,
  type NormalizedDirectionWireOutput,
  parseDirectionOutputForValidation,
} from './schema.js'

/** Codes describe actual model text/identity defects, never discarded model range arithmetic. */
export type FidelityFindingCode =
  | 'text_omission'
  | 'text_insertion'
  | 'text_duplication'
  | 'text_substitution'
  | 'passage_reorder'
  | 'unknown_passage'
  | 'split_grapheme'
  | 'unknown_speaker'
  | 'speaker_semantics'

export interface FidelityFinding {
  readonly code: FidelityFindingCode
  readonly sourcePassageId: string
  readonly message: string
}

export class DirectorFidelityError extends DirectorError {
  override readonly name: string = 'DirectorFidelityError'

  constructor(
    readonly findings: readonly FidelityFinding[],
    message = `Gemma Director output failed deterministic fidelity validation (${[...new Set(findings.map((item) => item.code))].join(', ')})`,
  ) {
    super('fidelity', message)
  }
}

export interface ValidatedDirection {
  readonly annotations: readonly DirectedAnnotation[]
  readonly warnings: readonly DirectorWarning[]
}

function speakerFindings(item: DirectedWireSegment, request: DirectionRequest): FidelityFinding[] {
  const finding = (message: string): FidelityFinding => ({
    code: 'speaker_semantics',
    sourcePassageId: item.source_passage_id,
    message,
  })
  const allowed = new Set([
    request.narratorSpeakerId,
    request.fallbackSpeakerId,
    ...request.speakers.map((speaker) => speaker.id),
  ])
  if (!allowed.has(item.speaker_id)) {
    return [
      {
        code: 'unknown_speaker',
        sourcePassageId: item.source_passage_id,
        message: 'Output invented a speaker ID outside the supplied roster',
      },
    ]
  }
  if (
    (item.kind === 'narration' || item.kind === 'sound_cue') &&
    item.speaker_id !== request.narratorSpeakerId
  ) {
    return [finding('Narration and sound cues must use the supplied narrator speaker')]
  }
  if (
    item.kind !== 'narration' &&
    item.kind !== 'sound_cue' &&
    item.speaker_id === request.narratorSpeakerId
  ) {
    return [finding('Narrator speaker is only valid for narration and sound cues')]
  }
  if (item.speaker_id === request.fallbackSpeakerId) {
    if (!item.unresolved_speaker || item.speaker_reason === null) {
      return [finding('Fallback speaker requires unresolved_speaker and a reason')]
    }
    if (item.kind === 'narration' || item.kind === 'sound_cue') {
      return [finding('Fallback speaker is only valid for dialogue, thought, or message')]
    }
    return []
  }
  if (item.unresolved_speaker || item.speaker_reason !== null) {
    return [finding('Resolved speaker must set unresolved_speaker false and speaker_reason null')]
  }
  return []
}

/**
 * Offsets are raw UTF-16 code units, so a boundary can land inside an astral character. Both
 * halves would still concatenate back to the source, but each fragment handed to TTS and SQLite
 * would carry a lone surrogate instead of the character.
 */
function splitsSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false
  const high = text.charCodeAt(offset - 1)
  const low = text.charCodeAt(offset)
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff
}

interface DerivedWireSegment {
  readonly item: DirectedWireSegment
  readonly sourceStart: number
  readonly sourceEnd: number
  readonly sourceText: string
}

interface FidelityAnalysis {
  readonly findings: readonly FidelityFinding[]
  readonly segments: readonly DerivedWireSegment[]
}

function textDifferenceFinding(
  expected: string,
  actual: string,
  sourcePassageId: string,
): FidelityFinding {
  let prefix = 0
  while (
    prefix < expected.length &&
    prefix < actual.length &&
    expected[prefix] === actual[prefix]
  ) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < expected.length - prefix &&
    suffix < actual.length - prefix &&
    expected[expected.length - 1 - suffix] === actual[actual.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const expectedMiddle = expected.slice(prefix, expected.length - suffix)
  const actualMiddle = actual.slice(prefix, actual.length - suffix)
  if (expectedMiddle.length === 0) {
    const before = expected.slice(Math.max(0, prefix - actualMiddle.length), prefix)
    const after = expected.slice(prefix, prefix + actualMiddle.length)
    const duplicated =
      actualMiddle.length > 0 && (actualMiddle === before || actualMiddle === after)
    return {
      code: duplicated ? 'text_duplication' : 'text_insertion',
      sourcePassageId,
      message: duplicated
        ? 'Model output duplicates immutable source text'
        : 'Model output inserts text absent from the immutable source passage',
    }
  }
  if (actualMiddle.length === 0) {
    return {
      code: 'text_omission',
      sourcePassageId,
      message: 'Model output omits text from the immutable source passage',
    }
  }
  return {
    code: 'text_substitution',
    sourcePassageId,
    message: 'Model output substitutes or reorders immutable source text',
  }
}

/**
 * The model supplies exact fragment text and semantic annotations; this function owns coordinates.
 * A per-passage sequential cursor derives UTF-16 ranges only after the concatenated model text equals
 * the immutable source exactly. The clean @4 wire schema cannot carry model-reported offsets.
 */
function analyzeFidelity(
  output: NormalizedDirectionWireOutput,
  request: DirectionRequest,
): FidelityAnalysis {
  const findings: FidelityFinding[] = []
  const derived: DerivedWireSegment[] = []
  const passageIndex = new Map(request.passages.map((passage, index) => [passage.id, index]))
  const fragmentsByPassage = new Map(
    request.passages.map((passage) => [passage.id, [] as DirectedWireSegment[]]),
  )
  let lastPassageIndex = -1

  for (const item of output.segments) {
    const currentPassageIndex = passageIndex.get(item.source_passage_id)
    if (currentPassageIndex === undefined) {
      findings.push({
        code: 'unknown_passage',
        sourcePassageId: item.source_passage_id,
        message: 'Model output references a passage ID absent from the request',
      })
      findings.push(...speakerFindings(item, request))
      continue
    }
    if (currentPassageIndex < lastPassageIndex) {
      findings.push({
        code: 'passage_reorder',
        sourcePassageId: item.source_passage_id,
        message: 'Model output places a source passage after a later passage',
      })
    }
    lastPassageIndex = Math.max(lastPassageIndex, currentPassageIndex)
    fragmentsByPassage.get(item.source_passage_id)?.push(item)
    findings.push(...speakerFindings(item, request))
  }

  for (const passage of request.passages) {
    const fragments = fragmentsByPassage.get(passage.id) ?? []
    if (fragments.length === 0) {
      findings.push({
        code: 'text_omission',
        sourcePassageId: passage.id,
        message: 'Model output omits the entire immutable source passage',
      })
      continue
    }
    const combined = fragments.map((item) => item.source_text).join('')
    if (combined !== passage.text) {
      findings.push(textDifferenceFinding(passage.text, combined, passage.id))
      continue
    }

    let cursor = 0
    for (const item of fragments) {
      const sourceStart = cursor
      const sourceEnd = sourceStart + item.source_text.length
      if (
        splitsSurrogatePair(passage.text, sourceStart) ||
        splitsSurrogatePair(passage.text, sourceEnd)
      ) {
        findings.push({
          code: 'split_grapheme',
          sourcePassageId: passage.id,
          message: 'A model fragment boundary splits a UTF-16 surrogate pair',
        })
      }
      const sourceText = passage.text.slice(sourceStart, sourceEnd)
      derived.push({ item, sourceStart, sourceEnd, sourceText })
      cursor = sourceEnd
    }
  }
  return { findings, segments: derived }
}

function warningFor(
  segment: DerivedWireSegment,
  request: DirectionRequest,
  confidenceThreshold: number,
): DirectorWarning | undefined {
  const { item, sourceStart, sourceEnd } = segment
  if (item.speaker_id === request.fallbackSpeakerId) {
    return {
      code: 'unresolved_speaker',
      sourcePassageId: item.source_passage_id,
      sourceStart,
      sourceEnd,
      candidateSpeakerId: null,
      confidence: item.confidence,
      confidenceThreshold,
      message: item.speaker_reason ?? 'Speaker could not be resolved',
      reviewRequired: true,
      usesFallback: true,
    }
  }
  if (item.confidence >= confidenceThreshold) return undefined
  const range = {
    sourcePassageId: item.source_passage_id,
    sourceStart,
    sourceEnd,
    candidateSpeakerId: item.speaker_id,
    confidence: item.confidence,
    confidenceThreshold,
    reviewRequired: true,
  } as const
  // Narration and sound cues are the majority of a light novel and always belong to the narrator,
  // so they are flagged for review without rerouting a voice that fallback cannot improve.
  if (item.speaker_id === request.narratorSpeakerId) {
    return {
      ...range,
      code: 'low_confidence_kind',
      message: 'Narrator-owned segment is below the configured confidence threshold',
      usesFallback: false,
    }
  }
  return {
    ...range,
    code: 'low_confidence_speaker',
    message: 'Known-speaker assignment is below the configured confidence threshold',
    usesFallback: true,
  }
}

/** Schema parsing is intentionally separate from semantic/source-fidelity validation. */
export function validateDirectionOutput(
  input: unknown,
  request: DirectionRequest,
  confidenceThreshold: number,
): ValidatedDirection {
  if (!Number.isFinite(confidenceThreshold) || confidenceThreshold < 0 || confidenceThreshold > 1) {
    throw new Error('Director confidence threshold must be between zero and one')
  }
  let parsed: NormalizedDirectionWireOutput
  try {
    parsed = parseDirectionOutputForValidation(input, request)
  } catch (cause: unknown) {
    throw new DirectorError(
      'schema_validation',
      'Gemma Director output failed the direction schema',
      false,
      { cause },
    )
  }
  const analysis = analyzeFidelity(parsed, request)
  if (analysis.findings.length > 0) {
    throw new DirectorFidelityError(Object.freeze(analysis.findings))
  }

  const annotations = analysis.segments.map(
    ({ item, sourceStart, sourceEnd, sourceText }): DirectedAnnotation => ({
      sourcePassageId: item.source_passage_id,
      sourceStart,
      sourceEnd,
      // Always comes from the immutable request passage slice, never the model-owned string.
      sourceText,
      kind: item.kind,
      speakerId: item.speaker_id,
      confidence: item.confidence,
      delivery: {
        emotion: item.delivery.emotion,
        pace: item.delivery.pace,
        volume: item.delivery.volume,
        pauseAfterMs: item.delivery.pause_after_ms,
      },
    }),
  )
  const warnings = analysis.segments.flatMap((segment): DirectorWarning[] => {
    const warning = warningFor(segment, request, confidenceThreshold)
    return warning === undefined ? [] : [warning]
  })
  return { annotations: Object.freeze(annotations), warnings: Object.freeze(warnings) }
}
