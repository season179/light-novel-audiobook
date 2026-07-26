import { canonicalSha256 } from './canonical-json.js'
import type { DirectionRequest } from './port.js'
import type { DirectionWireOutput, ModelDirectedWireSegment } from './schema.js'
import { DirectorFidelityError, type FidelityFinding } from './validation.js'

export interface DirectionSamplingParameters {
  readonly seed: number
  readonly temperature: number
  readonly topP: number
  readonly maxTokens: number
  readonly confidenceThreshold: number
}

/**
 * Fixed, identity-bound recovery policy. Retry profiles are deliberately non-greedy and distinct
 * from the deterministic first request; repeating temperature 0 with the same seed is not a retry.
 */
export const FIDELITY_RECOVERY_POLICY = Object.freeze({
  version: 'gemma-fidelity-recovery@1',
  maxRerequests: 2,
  retrySampling: Object.freeze([
    Object.freeze({ seedOffset: 1, temperature: 0.2, topP: 0.95 }),
    Object.freeze({ seedOffset: 2, temperature: 0.4, topP: 0.9 }),
  ]),
  mechanicalRepairs: Object.freeze([
    Object.freeze({ modelCodePoint: 'U+0020', sourceCodePoint: 'U+00A0' }),
  ]),
})

/** Builds the initial request plus only genuinely distinct retry profiles. */
export function fidelitySamplingAttempts(
  initial: DirectionSamplingParameters,
): readonly DirectionSamplingParameters[] {
  const candidates: DirectionSamplingParameters[] = [
    initial,
    ...FIDELITY_RECOVERY_POLICY.retrySampling
      .slice(0, FIDELITY_RECOVERY_POLICY.maxRerequests)
      .map((retry) => ({
        ...initial,
        seed: initial.seed + retry.seedOffset,
        temperature: retry.temperature,
        topP: retry.topP,
      })),
  ]
  const seen = new Set<string>()
  return Object.freeze(
    candidates.filter((candidate) => {
      const identity = canonicalSha256(candidate)
      if (seen.has(identity)) return false
      seen.add(identity)
      return true
    }),
  )
}

export interface MechanicalSourceRepair {
  readonly sourcePassageId: string
  readonly replacementCount: number
  readonly modelCodePoint: 'U+0020'
  readonly sourceCodePoint: 'U+00A0'
}

export interface MechanicalSourceRepairResult {
  readonly output: DirectionWireOutput
  readonly repairs: readonly MechanicalSourceRepair[]
}

/**
 * Restores one observed tokenizer/model normalization: ordinary SPACE echoed where immutable source
 * contains NO-BREAK SPACE. It is intentionally narrower than Unicode whitespace normalization.
 *
 * A passage is repaired only when lengths match and *every* mismatch is exactly U+00A0 -> U+0020.
 * Fragment lengths are retained, then their text is replaced from the immutable request slices.
 * The ordinary fidelity validator still runs afterwards and remains the final authority.
 */
export function repairMechanicalSourceEcho(
  output: DirectionWireOutput,
  request: DirectionRequest,
): MechanicalSourceRepairResult {
  const segments = [...output.segments]
  const segmentIndexesByPassage = new Map<string, number[]>()
  for (const [index, segment] of segments.entries()) {
    const indexes = segmentIndexesByPassage.get(segment.source_passage_id) ?? []
    indexes.push(index)
    segmentIndexesByPassage.set(segment.source_passage_id, indexes)
  }

  const repairs: MechanicalSourceRepair[] = []
  for (const passage of request.passages) {
    const indexes = segmentIndexesByPassage.get(passage.id) ?? []
    if (indexes.length === 0) continue
    const echoed = indexes.map((index) => segments[index]?.source_text ?? '').join('')
    if (echoed === passage.text || echoed.length !== passage.text.length) continue

    let replacementCount = 0
    let repairable = true
    for (let index = 0; index < passage.text.length; index += 1) {
      const source = passage.text[index]
      const model = echoed[index]
      if (source === model) continue
      if (source === '\u00a0' && model === ' ') {
        replacementCount += 1
        continue
      }
      repairable = false
      break
    }
    if (!repairable || replacementCount === 0) continue

    let cursor = 0
    for (const segmentIndex of indexes) {
      const segment = segments[segmentIndex]
      if (segment === undefined) continue
      const end = cursor + segment.source_text.length
      segments[segmentIndex] = {
        ...segment,
        source_text: passage.text.slice(cursor, end),
      } as ModelDirectedWireSegment
      cursor = end
    }
    repairs.push({
      sourcePassageId: passage.id,
      replacementCount,
      modelCodePoint: 'U+0020',
      sourceCodePoint: 'U+00A0',
    })
  }

  return {
    output: repairs.length === 0 ? output : { segments: Object.freeze(segments) },
    repairs: Object.freeze(repairs),
  }
}

export interface FidelityRecoveryAttempt {
  readonly attemptNumber: number
  readonly sampling: DirectionSamplingParameters
  readonly requestSha256: string
  readonly rawOutputSha256: string
  readonly validatedOutputSha256: string
  readonly findingCodes: readonly string[]
  readonly sourcePassageIds: readonly string[]
}

/** Terminal, text-free proof that every distinct bounded attempt remained invalid. */
export class DirectorFidelityExhaustedError extends DirectorFidelityError {
  override readonly name = 'DirectorFidelityExhaustedError'

  constructor(
    findings: readonly FidelityFinding[],
    readonly attempts: readonly FidelityRecoveryAttempt[],
  ) {
    super(
      findings,
      `Gemma Director fidelity recovery exhausted ${attempts.length} distinct sampling attempt(s); rejected source text remains blocked`,
    )
  }
}
