import { DirectorError } from './errors.js'
import type { DirectedSegment, DirectionRequest, DirectorWarning } from './port.js'
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
  readonly segments: readonly DirectedSegment[]
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
  const expectedIds = request.passages.map((passage) => passage.id)
  const actualIds = output.segments.map((segment) => segment.source_passage_id)
  const actualCounts = new Map<string, number>()
  for (const id of actualIds) actualCounts.set(id, (actualCounts.get(id) ?? 0) + 1)

  for (const passage of request.passages) {
    const count = actualCounts.get(passage.id) ?? 0
    if (count === 0) {
      findings.push({
        code: 'omission',
        sourcePassageId: passage.id,
        message: 'Source passage is absent from directed output',
      })
    } else if (count > 1) {
      findings.push({
        code: 'duplicate',
        sourcePassageId: passage.id,
        message: 'Source passage occurs more than once in directed output',
      })
    }
  }

  const expectedSet = new Set(expectedIds)
  for (const id of new Set(actualIds)) {
    if (!expectedSet.has(id)) {
      findings.push({
        code: 'invention',
        sourcePassageId: id,
        message: 'Directed output contains an unknown source passage ID',
      })
    }
  }

  const sameMembership =
    expectedIds.length === actualIds.length &&
    expectedIds.every((id) => actualCounts.get(id) === 1) &&
    actualIds.every((id) => expectedSet.has(id))
  if (sameMembership && expectedIds.some((id, index) => actualIds[index] !== id)) {
    findings.push({
      code: 'reorder',
      sourcePassageId: actualIds[0] ?? request.chapterId,
      message: 'Source passages are not in the supplied order',
    })
  }

  const expectedById = new Map(request.passages.map((passage) => [passage.id, passage.text]))
  for (const item of output.segments) {
    const expectedText = expectedById.get(item.source_passage_id)
    if (expectedText !== undefined && item.source_text !== expectedText) {
      findings.push({
        code: 'text_mismatch',
        sourcePassageId: item.source_passage_id,
        message: 'Source text differs by one or more code points',
      })
    }
    findings.push(...speakerFindings(item, request))
  }
  return findings
}

/** Schema parsing is intentionally separate from semantic/source-fidelity validation. */
export function validateDirectionOutput(
  input: unknown,
  request: DirectionRequest,
): ValidatedDirection {
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

  const segments = parsed.data.segments.map(
    (item): DirectedSegment => ({
      sourcePassageId: item.source_passage_id,
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
  const warnings = parsed.data.segments.flatMap((item): DirectorWarning[] =>
    item.speaker_id === request.fallbackSpeakerId
      ? [
          {
            code: 'unresolved_speaker',
            sourcePassageId: item.source_passage_id,
            fallbackSpeakerId: request.fallbackSpeakerId,
            confidence: item.confidence,
            message: item.speaker_reason ?? 'Speaker could not be resolved',
            reviewRequired: true,
          },
        ]
      : [],
  )
  return { segments: Object.freeze(segments), warnings: Object.freeze(warnings) }
}
