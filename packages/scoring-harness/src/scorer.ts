import { canonicalSha256, type JsonValue, sha256 } from './canonical-json.js'
import {
  type EvaluationPrediction,
  type EvaluationReport,
  type EvaluationRun,
  evaluationRunSchema,
  evaluationSourceSchema,
  goldAnnotationsSchema,
  type MetricResult,
  type RepresentativeCorpus,
  representativeCorpusSchema,
  type SelectionCriterion,
} from './schemas.js'
import {
  AMBIGUITY_POLICY,
  REQUIRED_CRITERIA,
  SCORER_SHA256,
  SCORER_VERSION,
} from './scorer-policy.js'

const RUN_COUNT = 3
const PERCENT = 100
const ELAPSED_LIMIT_MS = 3_600_000
const VRAM_LIMIT_MIB = 15_872
const RAM_LIMIT_MIB = 61_440
const CONTEXT_SIZE = 32_768

type Finding = EvaluationReport['findings'][number]

export interface ScoringInputs {
  readonly source: unknown
  readonly corpus: unknown
  readonly annotations: unknown
  readonly runs: readonly unknown[]
}

export class GovernanceValidationError extends Error {
  readonly codes: readonly string[]

  constructor(codes: readonly string[]) {
    super(`Evaluation governance validation failed: ${codes.join(', ')}`)
    this.name = 'GovernanceValidationError'
    this.codes = Object.freeze([...codes])
  }
}

interface Threshold {
  readonly operator: '>=' | '<=' | '='
  readonly numerator: number
  readonly denominator: number
  readonly label: string
}

function fixedRate(numerator: number, denominator: number): string {
  const scaled = denominator === 0 ? 1_000_000 : Math.floor((numerator * 1_000_000) / denominator)
  return `${Math.floor(scaled / 1_000_000)}.${String(scaled % 1_000_000).padStart(6, '0')}`
}

function metric(
  numerator: number,
  denominator: number,
  observedDenominator: number,
  threshold: Threshold,
  observable = observedDenominator === denominator,
): MetricResult {
  const left = numerator * threshold.denominator
  const right = threshold.numerator * denominator
  const thresholdPassed =
    threshold.operator === '>='
      ? left >= right
      : threshold.operator === '<='
        ? left <= right
        : left === right

  return {
    numerator,
    denominator,
    observed_denominator: observedDenominator,
    rate: fixedRate(numerator, denominator),
    threshold: { ...threshold },
    passed: observable && thresholdPassed,
  }
}

function atLeast(percent: number, label: string): Threshold {
  return { operator: '>=', numerator: percent, denominator: PERCENT, label }
}

function atMost(numerator: number, denominator: number, label: string): Threshold {
  return { operator: '<=', numerator, denominator, label }
}

function exactly(numerator: number, denominator: number, label: string): Threshold {
  return { operator: '=', numerator, denominator, label }
}

function scalarLength(value: string): number {
  return Array.from(value).length
}

function scalarSlice(value: string, start: number, end: number): string {
  return Array.from(value).slice(start, end).join('')
}

function spanKey(reference: {
  source_ref: string
  source_start: number
  source_end: number
}): string {
  return `${reference.source_ref}\0${reference.source_start}\0${reference.source_end}`
}

function unitKey(caseId: string): string {
  return sha256(`evaluation-unit-key@1\0${caseId}`).slice(0, 16)
}

function safeIssues(
  prefix: string,
  issues: readonly { path: PropertyKey[]; code: string }[],
): string[] {
  return issues.map((issue) => `${prefix}:${issue.code}:${issue.path.map(String).join('.') || '$'}`)
}

function unknownInputHash(input: unknown, inputIndex: number): string {
  try {
    return canonicalSha256(input as JsonValue)
  } catch {
    return sha256(`non-json-evaluation-run@1\0${inputIndex}`)
  }
}

function assertUnique(values: readonly string[], code: string, codes: string[]): void {
  if (new Set(values).size !== values.length) codes.push(code)
}

function configurationIdentity(run: EvaluationRun): JsonValue {
  return run.model as JsonValue
}

function predictionIndex(run: EvaluationRun): ReadonlyMap<string, readonly EvaluationPrediction[]> {
  const mutable = new Map<string, EvaluationPrediction[]>()
  for (const prediction of run.predictions) {
    const key = spanKey(prediction)
    const group = mutable.get(key) ?? []
    group.push(prediction)
    mutable.set(key, group)
  }
  return mutable
}

function exactCoverage(
  run: EvaluationRun,
  passages: readonly {
    source_ref: string
    source_text: string
  }[],
  findings: Finding[],
): number {
  let covered = 0
  let hasUnknownReference = false
  const knownReferences = new Set(passages.map((passage) => passage.source_ref))
  for (const prediction of run.predictions) {
    if (!knownReferences.has(prediction.source_ref)) {
      hasUnknownReference = true
      findings.push({ code: 'unknown-source-reference', run_index: run.run_index })
    }
  }

  for (const passage of passages) {
    const predictions = run.predictions
      .filter((prediction) => prediction.source_ref === passage.source_ref)
      .sort(
        (left, right) =>
          left.source_start - right.source_start || left.source_end - right.source_end,
      )
    let cursor = 0
    let exact = predictions.length > 0
    for (const prediction of predictions) {
      if (
        prediction.status !== 'predicted' ||
        prediction.source_start !== cursor ||
        prediction.source_end > scalarLength(passage.source_text) ||
        prediction.text !==
          scalarSlice(passage.source_text, prediction.source_start, prediction.source_end)
      ) {
        exact = false
      }
      cursor = prediction.source_end
    }
    if (cursor !== scalarLength(passage.source_text)) exact = false
    if (exact) covered += 1
    else {
      findings.push({
        code: 'source-coverage-failed',
        run_index: run.run_index,
        unit_key: unitKey(passage.source_ref),
      })
    }
  }
  return hasUnknownReference ? 0 : covered
}

function validateGovernance(sourceInput: unknown, corpusInput: unknown, annotationInput: unknown) {
  const sourceResult = evaluationSourceSchema.safeParse(sourceInput)
  const corpusResult = representativeCorpusSchema.safeParse(corpusInput)
  const annotationResult = goldAnnotationsSchema.safeParse(annotationInput)
  const schemaCodes = [
    ...(sourceResult.success ? [] : safeIssues('source', sourceResult.error.issues)),
    ...(corpusResult.success ? [] : safeIssues('corpus', corpusResult.error.issues)),
    ...(annotationResult.success ? [] : safeIssues('annotations', annotationResult.error.issues)),
  ]
  if (!sourceResult.success || !corpusResult.success || !annotationResult.success) {
    throw new GovernanceValidationError(schemaCodes)
  }

  const source = sourceResult.data
  const corpus = corpusResult.data
  const annotations = annotationResult.data
  const sourceHash = canonicalSha256(source as JsonValue)
  const corpusHash = canonicalSha256(corpus as JsonValue)
  const codes: string[] = []

  if (corpus.source_sha256 !== sourceHash) codes.push('corpus-source-hash-mismatch')
  if (annotations.source_sha256 !== sourceHash) codes.push('annotation-source-hash-mismatch')
  if (annotations.corpus_sha256 !== corpusHash) codes.push('annotation-corpus-hash-mismatch')
  if (
    source.provenance.redistribution === 'workspace_only' &&
    corpus.storage_class !== 'workspace_private'
  ) {
    codes.push('private-source-must-use-workspace-storage')
  }
  if (
    corpus.storage_class === 'committed_synthetic' &&
    (source.provenance.origin !== 'project_synthetic' ||
      source.provenance.redistribution !== 'committed_allowed')
  ) {
    codes.push('committed-corpus-must-be-redistributable-synthetic')
  }

  assertUnique(
    source.passages.map((passage) => passage.source_ref),
    'duplicate-source-reference',
    codes,
  )
  assertUnique(
    corpus.cases.map((item) => item.case_id),
    'duplicate-corpus-case-id',
    codes,
  )
  assertUnique(
    annotations.cases.map((item) => item.case_id),
    'duplicate-annotation-case-id',
    codes,
  )

  const passageByReference = new Map(
    source.passages.map((passage) => [passage.source_ref, passage]),
  )
  for (const passage of source.passages) {
    if (passage.source_text_sha256 !== sha256(passage.source_text)) {
      codes.push('source-passage-hash-mismatch')
    }
    const cases = corpus.cases
      .filter((item) => item.source_ref === passage.source_ref)
      .sort((left, right) => left.source_start - right.source_start)
    let cursor = 0
    for (const item of cases) {
      if (item.source_start !== cursor || item.source_end > scalarLength(passage.source_text)) {
        codes.push('corpus-cases-do-not-partition-source')
        break
      }
      cursor = item.source_end
    }
    if (cursor !== scalarLength(passage.source_text))
      codes.push('corpus-cases-do-not-partition-source')
  }
  for (const item of corpus.cases) {
    if (!passageByReference.has(item.source_ref)) codes.push('corpus-source-reference-missing')
  }

  const corpusCaseIds = new Set(corpus.cases.map((item) => item.case_id))
  const annotationCaseIds = new Set(annotations.cases.map((item) => item.case_id))
  if (
    corpusCaseIds.size !== annotationCaseIds.size ||
    [...corpusCaseIds].some((caseId) => !annotationCaseIds.has(caseId))
  ) {
    codes.push('annotation-case-set-mismatch')
  }

  for (const criterion of REQUIRED_CRITERIA) {
    if (!corpus.cases.some((item) => item.criteria.includes(criterion))) {
      codes.push(`missing-selection-criterion:${criterion}`)
    }
  }

  const corpusById = new Map(corpus.cases.map((item) => [item.case_id, item]))
  const caseText = (item: RepresentativeCorpus['cases'][number]): string => {
    const passage = passageByReference.get(item.source_ref)
    return passage ? scalarSlice(passage.source_text, item.source_start, item.source_end) : ''
  }
  for (const annotation of annotations.cases) {
    const corpusCase = corpusById.get(annotation.case_id)
    if (!corpusCase) continue
    if (annotation.kind === 'dialogue' && annotation.speaker.status === 'not_applicable') {
      codes.push('dialogue-speaker-not-annotated')
    }
    if (annotation.kind !== 'dialogue' && annotation.speaker.status !== 'not_applicable') {
      codes.push('non-dialogue-speaker-annotated')
    }
    if (corpusCase.criteria.includes('dialogue') !== (annotation.kind === 'dialogue')) {
      codes.push('dialogue-tag-annotation-mismatch')
    }
    if (corpusCase.criteria.includes('narration') !== (annotation.kind === 'narration')) {
      codes.push('narration-tag-annotation-mismatch')
    }
    if (corpusCase.criteria.includes('internal_thought') !== (annotation.kind === 'thought')) {
      codes.push('thought-tag-annotation-mismatch')
    }
    if (
      corpusCase.criteria.includes('ambiguous_speaker') !==
      (annotation.speaker.status === 'ambiguous' || annotation.speaker.status === 'unresolved')
    ) {
      codes.push('ambiguity-tag-annotation-mismatch')
    }
    if (
      corpusCase.criteria.includes('alias') !==
      (annotation.speaker.status === 'exact' && annotation.speaker.evidence === 'alias')
    ) {
      codes.push('alias-tag-annotation-mismatch')
    }
    if (
      corpusCase.criteria.includes('coreference') !==
      (annotation.speaker.status === 'exact' && annotation.speaker.evidence === 'coreference')
    ) {
      codes.push('coreference-tag-annotation-mismatch')
    }
    if (
      corpusCase.criteria.includes('source_reference') &&
      !corpus.cases.some(
        (other) =>
          other.case_id !== corpusCase.case_id && other.source_ref === corpusCase.source_ref,
      )
    ) {
      codes.push('source-reference-criterion-not-demonstrated')
    }
    if (
      corpusCase.criteria.includes('repeated_text') &&
      !corpus.cases.some(
        (other) =>
          other.case_id !== corpusCase.case_id &&
          other.source_ref !== corpusCase.source_ref &&
          caseText(other) === caseText(corpusCase),
      )
    ) {
      codes.push('repeated-text-criterion-not-demonstrated')
    }
  }

  if (codes.length > 0) throw new GovernanceValidationError([...new Set(codes)].sort())
  return { source, corpus, annotations, sourceHash, corpusHash }
}

export class RepresentativeCorpusScorer {
  score(inputs: ScoringInputs): EvaluationReport {
    const { source, corpus, annotations, sourceHash, corpusHash } = validateGovernance(
      inputs.source,
      inputs.corpus,
      inputs.annotations,
    )
    const annotationHash = canonicalSha256(annotations as JsonValue)
    const findings: Finding[] = []
    const validRuns = new Map<number, EvaluationRun>()
    const inputHashes = new Map<number, string>()

    for (const [inputIndex, input] of inputs.runs.entries()) {
      const parsed = evaluationRunSchema.safeParse(input)
      const inferredIndex = parsed.success
        ? parsed.data.run_index
        : Math.min(inputIndex + 1, RUN_COUNT)
      const hash = unknownInputHash(input, inputIndex)
      if (!parsed.success) {
        findings.push(
          ...safeIssues('run', parsed.error.issues).map((path) => ({
            code: 'run-schema-invalid',
            run_index: inferredIndex,
            path,
          })),
        )
        inputHashes.set(inferredIndex, hash)
        continue
      }
      const run = parsed.data
      inputHashes.set(run.run_index, hash)
      if (validRuns.has(run.run_index)) {
        validRuns.delete(run.run_index)
        findings.push({ code: 'duplicate-run-index', run_index: run.run_index })
        continue
      }
      if (run.source_sha256 !== sourceHash || run.corpus_sha256 !== corpusHash) {
        findings.push({ code: 'run-input-hash-mismatch', run_index: run.run_index })
        continue
      }
      validRuns.set(run.run_index, run)
    }
    for (let runIndex = 1; runIndex <= RUN_COUNT; runIndex += 1) {
      if (!inputHashes.has(runIndex)) {
        inputHashes.set(runIndex, sha256(`missing-evaluation-run@1\0${runIndex}`))
        findings.push({ code: 'run-missing', run_index: runIndex })
      }
    }
    if (inputs.runs.length > RUN_COUNT) findings.push({ code: 'unexpected-extra-run' })

    const goldByCase = new Map(annotations.cases.map((item) => [item.case_id, item]))
    const expectedSpeakerCases = annotations.cases.filter(
      (item) => item.kind === 'dialogue' && item.speaker.status === 'exact',
    )
    const aliasCases = expectedSpeakerCases.filter(
      (item) => item.speaker.evidence === 'alias' || item.speaker.evidence === 'coreference',
    )
    const thoughtSpokenCases = annotations.cases.filter(
      (item) => item.kind === 'dialogue' || item.kind === 'thought',
    )
    const ambiguousCases = annotations.cases.filter(
      (item) => item.speaker.status === 'ambiguous' || item.speaker.status === 'unresolved',
    )

    let coverageCorrect = 0
    let speakerCorrect = 0
    let speakerObserved = 0
    let aliasCorrect = 0
    let aliasObserved = 0
    let thoughtSpokenCorrect = 0
    let thoughtSpokenObserved = 0
    let incorrectSpeakers = 0
    let reviewedIncorrectSpeakers = 0
    let refusals = 0
    let refusalObserved = 0
    let ambiguityReviewed = 0
    let ambiguityObserved = 0

    const runPredictionIndexes = new Map<
      number,
      ReadonlyMap<string, readonly EvaluationPrediction[]>
    >()
    for (const run of validRuns.values()) {
      coverageCorrect += exactCoverage(run, source.passages, findings)
      const index = predictionIndex(run)
      runPredictionIndexes.set(run.run_index, index)
      for (const corpusCase of corpus.cases) {
        const predictions = index.get(spanKey(corpusCase)) ?? []
        if (predictions.length !== 1) {
          findings.push({
            code: predictions.length === 0 ? 'case-output-missing' : 'case-output-duplicated',
            run_index: run.run_index,
            unit_key: unitKey(corpusCase.case_id),
          })
          continue
        }
        const prediction = predictions[0]
        if (!prediction) continue
        refusalObserved += 1
        if (prediction.status === 'refused') {
          refusals += 1
          continue
        }
        const gold = goldByCase.get(corpusCase.case_id)
        if (!gold) continue
        if (gold.kind === 'dialogue' || gold.kind === 'thought') {
          thoughtSpokenObserved += 1
          if (prediction.kind === gold.kind) thoughtSpokenCorrect += 1
        }
        if (gold.kind === 'dialogue' && gold.speaker.status === 'exact') {
          speakerObserved += 1
          const correct = gold.speaker.accepted_character_ids.includes(prediction.speaker)
          if (correct) speakerCorrect += 1
          else {
            incorrectSpeakers += 1
            if (prediction.review_required) reviewedIncorrectSpeakers += 1
          }
          if (gold.speaker.evidence === 'alias' || gold.speaker.evidence === 'coreference') {
            aliasObserved += 1
            if (correct) aliasCorrect += 1
          }
        }
        if (gold.speaker.status === 'ambiguous' || gold.speaker.status === 'unresolved') {
          ambiguityObserved += 1
          if (prediction.review_required) ambiguityReviewed += 1
        }
      }
    }

    let agreementCorrect = 0
    let agreementObserved = 0
    for (const corpusCase of corpus.cases) {
      const values: string[] = []
      for (let runIndex = 1; runIndex <= RUN_COUNT; runIndex += 1) {
        const predictions = runPredictionIndexes.get(runIndex)?.get(spanKey(corpusCase)) ?? []
        const prediction = predictions.length === 1 ? predictions[0] : undefined
        if (prediction?.status === 'predicted') {
          values.push(`${prediction.kind}\0${prediction.speaker}`)
        }
      }
      if (values.length === RUN_COUNT) {
        agreementObserved += 1
        if (new Set(values).size === 1) agreementCorrect += 1
      }
    }

    const configurationHashes = [...validRuns.values()].map((run) =>
      canonicalSha256(configurationIdentity(run)),
    )
    const configurationConsistent =
      configurationHashes.length === RUN_COUNT && new Set(configurationHashes).size === 1

    const expectedSpeaker = expectedSpeakerCases.length * RUN_COUNT
    const expectedAlias = aliasCases.length * RUN_COUNT
    const expectedThoughtSpoken = thoughtSpokenCases.length * RUN_COUNT
    const expectedRefusals = corpus.cases.length * RUN_COUNT
    const expectedAmbiguous = ambiguousCases.length * RUN_COUNT
    const expectedCoverage = source.passages.length * RUN_COUNT
    const runs = [...validRuns.values()]
    const completeRuns = runs.length === RUN_COUNT

    const metrics: EvaluationReport['metrics'] = {
      schema_validity: metric(
        validRuns.size,
        RUN_COUNT,
        RUN_COUNT,
        atLeast(100, '100% valid final run schemas'),
      ),
      exact_source_coverage: metric(
        coverageCorrect,
        expectedCoverage,
        validRuns.size * source.passages.length,
        atLeast(100, '100% passage-run exact coverage'),
      ),
      dialogue_speaker_accuracy: metric(
        speakerCorrect,
        expectedSpeaker,
        speakerObserved,
        atLeast(95, 'at least 95% exact canonical speaker accuracy'),
      ),
      alias_coreference_accuracy: metric(
        aliasCorrect,
        expectedAlias,
        aliasObserved,
        atLeast(95, 'at least 95% alias/coreference accuracy'),
      ),
      thought_vs_spoken_accuracy: metric(
        thoughtSpokenCorrect,
        expectedThoughtSpoken,
        thoughtSpokenObserved,
        atLeast(98, 'at least 98% thought-versus-spoken accuracy'),
      ),
      incorrect_speaker_review_recall: metric(
        reviewedIncorrectSpeakers,
        incorrectSpeakers,
        incorrectSpeakers,
        atLeast(90, 'at least 90% of known incorrect speakers flagged'),
        speakerObserved === expectedSpeaker,
      ),
      refusal_rate: metric(
        refusals,
        expectedRefusals,
        refusalObserved,
        atMost(0, 100, '0% refusal on legitimate cases'),
      ),
      three_run_agreement: metric(
        agreementCorrect,
        corpus.cases.length,
        agreementObserved,
        atLeast(95, 'at least 95% joint speaker-and-kind three-run agreement'),
        configurationConsistent && agreementObserved === corpus.cases.length,
      ),
      elapsed_time_within_limit: metric(
        runs.filter((run) => run.operational.elapsed_ms <= ELAPSED_LIMIT_MS).length,
        RUN_COUNT,
        runs.length,
        atLeast(100, 'every run at or below 3600000 ms'),
      ),
      vram_within_limit: metric(
        runs.filter((run) => run.operational.peak_vram_mib <= VRAM_LIMIT_MIB).length,
        RUN_COUNT,
        runs.length,
        atLeast(100, 'every run at or below 15872 MiB VRAM'),
      ),
      ram_within_limit: metric(
        runs.filter((run) => run.operational.peak_ram_mib <= RAM_LIMIT_MIB).length,
        RUN_COUNT,
        runs.length,
        atLeast(100, 'every run at or below 61440 MiB RAM'),
      ),
      operational_success: metric(
        runs.filter((run) => !run.operational.crashed && !run.operational.out_of_memory).length,
        RUN_COUNT,
        runs.length,
        atLeast(100, 'zero crashes and zero out-of-memory outcomes'),
      ),
      context_size_configuration: metric(
        runs.filter((run) => run.model.context_size === CONTEXT_SIZE).length,
        RUN_COUNT,
        runs.length,
        exactly(100, 100, 'all runs use the initial 32768-token context'),
      ),
      repeated_run_configuration: metric(
        configurationConsistent ? RUN_COUNT : 0,
        RUN_COUNT,
        runs.length,
        atLeast(100, 'three identical recorded run configurations'),
        completeRuns,
      ),
      ambiguity_review_coverage: metric(
        ambiguityReviewed,
        expectedAmbiguous,
        ambiguityObserved,
        atLeast(100, 'all ambiguous/unresolved speakers flagged for review'),
      ),
    }

    const criteriaCounts = Object.fromEntries(
      REQUIRED_CRITERIA.map((criterion) => [
        criterion,
        corpus.cases.filter((item) => item.criteria.includes(criterion)).length,
      ]),
    ) as Record<SelectionCriterion, number>

    const runSummaries = Array.from({ length: RUN_COUNT }, (_, offset) => {
      const runIndex = offset + 1
      const run = validRuns.get(runIndex)
      return {
        run_index: runIndex,
        input_sha256: inputHashes.get(runIndex) as string,
        configuration_sha256: run
          ? canonicalSha256(configurationIdentity(run))
          : sha256(`invalid-evaluation-run-configuration@1\0${runIndex}`),
        schema_valid: run !== undefined,
        elapsed_ms: run?.operational.elapsed_ms ?? null,
        peak_vram_mib: run?.operational.peak_vram_mib ?? null,
        peak_ram_mib: run?.operational.peak_ram_mib ?? null,
        crashed: run?.operational.crashed ?? null,
        out_of_memory: run?.operational.out_of_memory ?? null,
      }
    })

    const report: EvaluationReport = {
      schema_version: 'evaluation-report@1',
      overall_passed: Object.values(metrics).every((item) => item.passed),
      identities: {
        source_version: source.source_version,
        source_sha256: sourceHash,
        corpus_version: corpus.corpus_version,
        corpus_sha256: corpusHash,
        annotation_version: annotations.annotation_version,
        annotation_sha256: annotationHash,
        scorer_version: SCORER_VERSION,
        scorer_sha256: SCORER_SHA256,
      },
      governance: {
        storage_class: corpus.storage_class,
        ambiguity_policy: AMBIGUITY_POLICY,
        criteria_counts: criteriaCounts,
        ambiguous_case_count: ambiguousCases.length,
      },
      run_summaries: runSummaries,
      metrics,
      findings: findings.sort((left, right) => {
        const leftKey = `${left.run_index ?? 0}:${left.code}:${left.unit_key ?? ''}:${left.path ?? ''}`
        const rightKey = `${right.run_index ?? 0}:${right.code}:${right.unit_key ?? ''}:${right.path ?? ''}`
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
      }),
    }
    return report
  }
}
