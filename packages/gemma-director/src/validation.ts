import { DirectorError } from './errors.js'
import type { DirectedAnnotation, DirectionRequest, DirectorWarning } from './port.js'
import {
  type DirectedWireSegment,
  type DirectionWireOutput,
  directionWireOutputSchema,
} from './schema.js'

export type FidelityFindingCode =
  | 'omission'
  | 'duplicate'
  | 'invention'
  | 'reorder'
  | 'gap'
  | 'overlap'
  | 'invalid_range'
  | 'text_mismatch'
  | 'unknown_speaker'
  | 'speaker_semantics'

export interface FidelityFinding {
  readonly code: FidelityFindingCode
  readonly sourcePassageId: string
  readonly message: string
}

export class DirectorFidelityError extends DirectorError {
  override readonly name = 'DirectorFidelityError'

  constructor(readonly findings: readonly FidelityFinding[]) {
    super(
      'fidelity',
      `Gemma Director output failed deterministic fidelity validation (${[...new Set(findings.map((item) => item.code))].join(', ')})`,
    )
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

function fidelityFindings(
  output: DirectionWireOutput,
  request: DirectionRequest,
): FidelityFinding[] {
  const findings: FidelityFinding[] = []
  const passageIndex = new Map(request.passages.map((passage, index) => [passage.id, index]))
  const passageById = new Map(request.passages.map((passage) => [passage.id, passage]))
  const cursors = new Map(request.passages.map((passage) => [passage.id, 0]))
  const fragmentCounts = new Map(request.passages.map((passage) => [passage.id, 0]))
  const fragmentKeys = new Set<string>()
  let lastPassageIndex = -1

  for (const item of output.segments) {
    const expectedPassage = passageById.get(item.source_passage_id)
    const currentPassageIndex = passageIndex.get(item.source_passage_id)
    if (expectedPassage === undefined || currentPassageIndex === undefined) {
      findings.push({
        code: 'invention',
        sourcePassageId: item.source_passage_id,
        message: 'Directed output contains an unknown source passage ID',
      })
      findings.push(...speakerFindings(item, request))
      continue
    }

    if (currentPassageIndex < lastPassageIndex) {
      findings.push({
        code: 'reorder',
        sourcePassageId: item.source_passage_id,
        message: 'A source passage fragment appears after a later passage',
      })
    }
    lastPassageIndex = Math.max(lastPassageIndex, currentPassageIndex)
    fragmentCounts.set(
      item.source_passage_id,
      (fragmentCounts.get(item.source_passage_id) ?? 0) + 1,
    )

    const fragmentKey = `${item.source_passage_id}\u0000${item.source_start}\u0000${item.source_end}`
    if (fragmentKeys.has(fragmentKey)) {
      findings.push({
        code: 'duplicate',
        sourcePassageId: item.source_passage_id,
        message: 'The same source range occurs more than once',
      })
    }
    fragmentKeys.add(fragmentKey)

    const cursor = cursors.get(item.source_passage_id) ?? 0
    if (item.source_end <= item.source_start) {
      findings.push({
        code: 'invalid_range',
        sourcePassageId: item.source_passage_id,
        message: 'Fragment source_end must be greater than source_start',
      })
    }
    if (item.source_start > cursor) {
      findings.push({
        code: 'gap',
        sourcePassageId: item.source_passage_id,
        message: 'Fragment starts after the next uncovered source offset',
      })
    } else if (item.source_start < cursor) {
      findings.push({
        code: 'overlap',
        sourcePassageId: item.source_passage_id,
        message: 'Fragment overlaps an earlier source range',
      })
    }
    if (item.source_end > expectedPassage.text.length) {
      findings.push({
        code: 'invention',
        sourcePassageId: item.source_passage_id,
        message: 'Fragment range extends beyond the immutable source passage',
      })
    }
    const expectedText = expectedPassage.text.slice(item.source_start, item.source_end)
    if (item.source_text !== expectedText) {
      findings.push({
        code: 'text_mismatch',
        sourcePassageId: item.source_passage_id,
        message: 'Fragment text differs from its declared immutable source range',
      })
    }
    cursors.set(item.source_passage_id, Math.max(cursor, item.source_end))
    findings.push(...speakerFindings(item, request))
  }

  for (const passage of request.passages) {
    const count = fragmentCounts.get(passage.id) ?? 0
    const cursor = cursors.get(passage.id) ?? 0
    if (count === 0) {
      findings.push({
        code: 'omission',
        sourcePassageId: passage.id,
        message: 'Source passage has no directed fragments',
      })
    } else if (cursor < passage.text.length) {
      findings.push({
        code: 'gap',
        sourcePassageId: passage.id,
        message: 'Source passage has uncovered trailing text',
      })
    }
  }
  return findings
}

function warningFor(
  item: DirectedWireSegment,
  request: DirectionRequest,
  confidenceThreshold: number,
): DirectorWarning | undefined {
  if (item.speaker_id === request.fallbackSpeakerId) {
    return {
      code: 'unresolved_speaker',
      sourcePassageId: item.source_passage_id,
      sourceStart: item.source_start,
      sourceEnd: item.source_end,
      candidateSpeakerId: null,
      confidence: item.confidence,
      confidenceThreshold,
      message: item.speaker_reason ?? 'Speaker could not be resolved',
      reviewRequired: true,
      usesFallback: true,
    }
  }
  const knownSpeaker = request.speakers.some((speaker) => speaker.id === item.speaker_id)
  if (knownSpeaker && item.confidence < confidenceThreshold) {
    return {
      code: 'low_confidence_speaker',
      sourcePassageId: item.source_passage_id,
      sourceStart: item.source_start,
      sourceEnd: item.source_end,
      candidateSpeakerId: item.speaker_id,
      confidence: item.confidence,
      confidenceThreshold,
      message: 'Known-speaker assignment is below the configured confidence threshold',
      reviewRequired: true,
      usesFallback: true,
    }
  }
  return undefined
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
  const parsed = directionWireOutputSchema.safeParse(input)
  if (!parsed.success) {
    throw new DirectorError(
      'schema_validation',
      'Gemma Director output failed the direction schema',
      false,
      { cause: parsed.error },
    )
  }
  const findings = fidelityFindings(parsed.data, request)
  if (findings.length > 0) throw new DirectorFidelityError(Object.freeze(findings))

  const annotations = parsed.data.segments.map(
    (item): DirectedAnnotation => ({
      sourcePassageId: item.source_passage_id,
      sourceStart: item.source_start,
      sourceEnd: item.source_end,
      sourceText: item.source_text,
      kind: item.kind,
      speakerId: item.speaker_id,
      confidence: item.confidence,
      delivery: {
        emotion: item.delivery.emotion,
        pace: item.delivery.pace,
        volume: item.delivery.volume,
        pauseAfterMs: item.delivery.pause_after_ms,
      },
      unresolvedSpeaker: item.unresolved_speaker,
      speakerReason: item.speaker_reason,
    }),
  )
  const warnings = parsed.data.segments.flatMap((item): DirectorWarning[] => {
    const warning = warningFor(item, request, confidenceThreshold)
    return warning === undefined ? [] : [warning]
  })
  return { annotations: Object.freeze(annotations), warnings: Object.freeze(warnings) }
}
