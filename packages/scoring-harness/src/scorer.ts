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
  SCORER_POLICY,
  SCORER_SHA256,
  SCORER_VERSION,
} from './scorer-policy.js'

const RUN_COUNT = SCORER_POLICY.run_set.required_count
const PERCENT = 100
const ELAPSED_LIMIT_MS = SCORER_POLICY.metrics.elapsed_time.milliseconds
const VRAM_LIMIT_MIB = SCORER_POLICY.metrics.peak_vram.mebibytes
const RAM_LIMIT_MIB = SCORER_POLICY.metrics.peak_ram.mebibytes
const CONTEXT_SIZE = SCORER_POLICY.metrics.context_size.tokens
const REQUIRED_COMPLETE_RATE = SCORER_POLICY.arithmetic.required_complete_rate_percent

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

const SAFE_SCHEMA_PATH_TOKENS = new Set([
  'accepted_character_ids',
  'adapter_id',
  'adapter_version',
  'annotation_policy_version',
  'annotation_version',
  'annotations',
  'archive_parser',
  'case_id',
  'cases',
  'collector_id',
  'collector_version',
  'contains_personal_data',
  'context_size',
  'corpus',
  'corpus_id',
  'corpus_sha256',
  'corpus_version',
  'crashed',
  'criteria',
  'elapsed_ms',
  'elapsed_scope',
  'evidence',
  'extraction_identity',
  'extraction_rules',
  'extraction_sha256',
  'kind',
  'legitimate',
  'license',
  'locator',
  'memory_unit',
  'method_version',
  'model',
  'model_id',
  'model_sha256',
  'operational',
  'origin',
  'out_of_memory',
  'output_schema_sha256',
  'output_schema_version',
  'parameters',
  'passages',
  'peak_ram_mib',
  'peak_vram_mib',
  'predictions',
  'prompt_sha256',
  'prompt_version',
  'provenance',
  'publication_content_sha256',
  'redistribution',
  'refusal_code',
  'resource_measurement',
  'review_required',
  'run',
  'run_index',
  'schema_version',
  'seed',
  'selection_policy_version',
  'selection_rationale',
  'source',
  'source_end',
  'source_id',
  'source_ref',
  'source_sha256',
  'source_start',
  'source_text',
  'source_text_sha256',
  'source_version',
  'speaker',
  'status',
  'storage_class',
  'text',
  'xml_parser',
])

function safeIssuePath(
  prefix: 'source' | 'corpus' | 'annotations' | 'run',
  path: PropertyKey[],
): string {
  const tokens: string[] = [prefix]
  let insideArbitraryParameters = false
  for (const part of path) {
    if (typeof part === 'number') {
      tokens.push('[]')
      continue
    }
    if (insideArbitraryParameters) {
      tokens.push('<key>')
      continue
    }
    if (typeof part === 'string' && SAFE_SCHEMA_PATH_TOKENS.has(part)) {
      tokens.push(part)
      if (part === 'parameters') insideArbitraryParameters = true
      continue
    }
    tokens.push('<key>')
  }
  return tokens.join('.')
}

function safeIssues(
  prefix: 'source' | 'corpus' | 'annotations' | 'run',
  issues: readonly { path: PropertyKey[]; code: string }[],
): { code: string; path: string }[] {
  return issues.map((issue) => ({ code: issue.code, path: safeIssuePath(prefix, issue.path) }))
}

function unknownInputHash(input: unknown, inputIndex: number): string {
  try {
    return canonicalSha256(input as JsonValue)
  } catch {
    return sha256(`non-json-evaluation-run@2\0${inputIndex}`)
  }
}

function assertUnique(values: readonly string[], code: string, codes: string[]): void {
  if (new Set(values).size !== values.length) codes.push(code)
}

function configurationIdentity(run: EvaluationRun): JsonValue {
  return {
    model: run.model,
    resource_measurement: run.operational.resource_measurement,
  } as JsonValue
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
    const predictions = run.predictions.filter(
      (prediction) => prediction.source_ref === passage.source_ref,
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
  ].map((issue) => `schema:${issue.code}:${issue.path}`)
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
    const cases = corpus.cases.filter((item) => item.source_ref === passage.source_ref)
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
  const sourceOrderedCaseIds = source.passages.flatMap((passage) =>
    corpus.cases
      .filter((item) => item.source_ref === passage.source_ref)
      .map((item) => item.case_id),
  )
  if (sourceOrderedCaseIds.some((caseId, index) => corpus.cases[index]?.case_id !== caseId)) {
    codes.push('corpus-case-order-mismatch')
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
    const schemaRuns = new Map<number, EvaluationRun>()
    const identityRuns = new Map<number, EvaluationRun>()
    const indexedInputHashes = new Map<number, string>()
    const positionalInputHashes = new Map<number, string>()
    const duplicateIndexes = new Set<number>()
    let schemaConformantCount = 0

    for (const [inputIndex, input] of inputs.runs.slice(0, RUN_COUNT).entries()) {
      const hash = unknownInputHash(input, inputIndex)
      positionalInputHashes.set(inputIndex + 1, hash)
      const parsed = evaluationRunSchema.safeParse(input)
      if (!parsed.success) {
        findings.push(
          ...safeIssues('run', parsed.error.issues).map((issue) => ({
            code: `run-schema-invalid-${issue.code}`,
            run_index: inputIndex + 1,
            path: issue.path,
          })),
        )
        continue
      }

      schemaConformantCount += 1
      const run = parsed.data
      if (schemaRuns.has(run.run_index)) {
        duplicateIndexes.add(run.run_index)
        findings.push({ code: 'duplicate-run-index', run_index: run.run_index })
        continue
      }
      schemaRuns.set(run.run_index, run)
      indexedInputHashes.set(run.run_index, hash)
    }

    if (inputs.runs.length > RUN_COUNT) findings.push({ code: 'unexpected-extra-run' })
    for (let runIndex = 1; runIndex <= RUN_COUNT; runIndex += 1) {
      if (!schemaRuns.has(runIndex)) findings.push({ code: 'run-missing', run_index: runIndex })
    }

    const runSetValid =
      inputs.runs.length === RUN_COUNT &&
      schemaRuns.size === RUN_COUNT &&
      duplicateIndexes.size === 0

    for (const [runIndex, run] of schemaRuns) {
      if (run.source_sha256 === sourceHash && run.corpus_sha256 === corpusHash) {
        identityRuns.set(runIndex, run)
      } else {
        findings.push({ code: 'run-source-corpus-identity-mismatch', run_index: runIndex })
      }
    }

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
    const structuralCases = corpus.cases.filter((item) =>
      item.criteria.includes('structurally_ambiguous'),
    )

    let predictionOrderCorrect = 0
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
    let structuralAmbiguityReviewed = 0
    let structuralAmbiguityObserved = 0

    const runPredictionIndexes = new Map<
      number,
      ReadonlyMap<string, readonly EvaluationPrediction[]>
    >()
    for (const run of identityRuns.values()) {
      const predictionsInCorpusOrder =
        run.predictions.length === corpus.cases.length &&
        run.predictions.every((prediction, index) => {
          const corpusCase = corpus.cases[index]
          return corpusCase !== undefined && spanKey(prediction) === spanKey(corpusCase)
        })
      if (predictionsInCorpusOrder) predictionOrderCorrect += 1
      else findings.push({ code: 'prediction-order-invalid', run_index: run.run_index })

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
        const gold = goldByCase.get(corpusCase.case_id)
        if (!gold) continue
        if (gold.speaker.status === 'ambiguous' || gold.speaker.status === 'unresolved') {
          ambiguityObserved += 1
          if (prediction.review_required) ambiguityReviewed += 1
        }
        if (corpusCase.criteria.includes('structurally_ambiguous')) {
          structuralAmbiguityObserved += 1
          if (prediction.review_required) structuralAmbiguityReviewed += 1
        }
        if (prediction.status === 'refused') {
          refusals += 1
          continue
        }
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

    const configurationHashes = [...identityRuns.values()].map((run) =>
      canonicalSha256(configurationIdentity(run)),
    )
    const configurationConsistent =
      runSetValid &&
      configurationHashes.length === RUN_COUNT &&
      new Set(configurationHashes).size === 1

    const expectedSpeaker = expectedSpeakerCases.length * RUN_COUNT
    const expectedAlias = aliasCases.length * RUN_COUNT
    const expectedThoughtSpoken = thoughtSpokenCases.length * RUN_COUNT
    const expectedRefusals = corpus.cases.length * RUN_COUNT
    const expectedAmbiguous = ambiguousCases.length * RUN_COUNT
    const expectedStructural = structuralCases.length * RUN_COUNT
    const expectedCoverage = source.passages.length * RUN_COUNT
    const runs = [...identityRuns.values()]
    const completeRuns = runSetValid && runs.length === RUN_COUNT

    const metrics: EvaluationReport['metrics'] = {
      run_set_integrity: metric(
        runSetValid ? RUN_COUNT : 0,
        RUN_COUNT,
        Math.min(inputs.runs.length, RUN_COUNT),
        atLeast(
          SCORER_POLICY.metrics.run_set_integrity.numerator,
          'exactly one run for each index 1, 2, and 3',
        ),
        runSetValid,
      ),
      schema_validity: metric(
        schemaConformantCount,
        RUN_COUNT,
        Math.min(inputs.runs.length, RUN_COUNT),
        atLeast(
          SCORER_POLICY.metrics.schema_validity.numerator,
          '100% schema conformance across the first three run documents',
        ),
      ),
      source_corpus_identity: metric(
        identityRuns.size,
        RUN_COUNT,
        schemaRuns.size,
        atLeast(
          SCORER_POLICY.metrics.source_corpus_identity.numerator,
          'all indexed runs lock the scored source and corpus hashes',
        ),
      ),
      prediction_order_integrity: metric(
        predictionOrderCorrect,
        RUN_COUNT,
        identityRuns.size,
        atLeast(
          SCORER_POLICY.metrics.prediction_order_integrity.numerator,
          'all runs preserve exact corpus-case order',
        ),
      ),
      exact_source_coverage: metric(
        coverageCorrect,
        expectedCoverage,
        identityRuns.size * source.passages.length,
        atLeast(
          SCORER_POLICY.metrics.exact_source_coverage.numerator,
          '100% passage-run exact coverage',
        ),
      ),
      dialogue_speaker_accuracy: metric(
        speakerCorrect,
        expectedSpeaker,
        speakerObserved,
        atLeast(
          SCORER_POLICY.metrics.dialogue_speaker_accuracy.numerator,
          'at least 95% exact canonical speaker accuracy',
        ),
      ),
      alias_coreference_accuracy: metric(
        aliasCorrect,
        expectedAlias,
        aliasObserved,
        atLeast(
          SCORER_POLICY.metrics.alias_coreference_accuracy.numerator,
          'at least 95% alias/coreference accuracy',
        ),
      ),
      thought_vs_spoken_accuracy: metric(
        thoughtSpokenCorrect,
        expectedThoughtSpoken,
        thoughtSpokenObserved,
        atLeast(
          SCORER_POLICY.metrics.thought_vs_spoken_accuracy.numerator,
          'at least 98% thought-versus-spoken accuracy',
        ),
      ),
      incorrect_speaker_review_recall: metric(
        reviewedIncorrectSpeakers,
        incorrectSpeakers,
        incorrectSpeakers,
        atLeast(
          SCORER_POLICY.metrics.incorrect_speaker_review_recall.numerator,
          'at least 90% of known incorrect speakers flagged',
        ),
        speakerObserved === expectedSpeaker,
      ),
      refusal_rate: metric(
        refusals,
        expectedRefusals,
        refusalObserved,
        atMost(
          SCORER_POLICY.metrics.refusal_rate.numerator,
          SCORER_POLICY.metrics.refusal_rate.denominator,
          '0% refusal on legitimate cases',
        ),
      ),
      three_run_agreement: metric(
        agreementCorrect,
        corpus.cases.length,
        agreementObserved,
        atLeast(
          SCORER_POLICY.metrics.three_run_agreement.numerator,
          'at least 95% joint speaker-and-kind three-run agreement',
        ),
        configurationConsistent && agreementObserved === corpus.cases.length,
      ),
      elapsed_time_within_limit: metric(
        runs.filter((run) => run.operational.elapsed_ms <= ELAPSED_LIMIT_MS).length,
        RUN_COUNT,
        runs.length,
        atLeast(REQUIRED_COMPLETE_RATE, 'every run at or below 3600000 ms'),
      ),
      vram_within_limit: metric(
        runs.filter((run) => run.operational.peak_vram_mib <= VRAM_LIMIT_MIB).length,
        RUN_COUNT,
        runs.length,
        atLeast(REQUIRED_COMPLETE_RATE, 'every run at or below 15872 MiB VRAM'),
      ),
      ram_within_limit: metric(
        runs.filter((run) => run.operational.peak_ram_mib <= RAM_LIMIT_MIB).length,
        RUN_COUNT,
        runs.length,
        atLeast(REQUIRED_COMPLETE_RATE, 'every run at or below 61440 MiB RAM'),
      ),
      operational_success: metric(
        runs.filter((run) => !run.operational.crashed && !run.operational.out_of_memory).length,
        RUN_COUNT,
        runs.length,
        atLeast(REQUIRED_COMPLETE_RATE, 'zero crashes and zero out-of-memory outcomes'),
      ),
      context_size_configuration: metric(
        runs.filter((run) => run.model.context_size === CONTEXT_SIZE).length,
        RUN_COUNT,
        runs.length,
        exactly(REQUIRED_COMPLETE_RATE, PERCENT, 'all runs use the initial 32768-token context'),
      ),
      repeated_run_configuration: metric(
        configurationConsistent ? RUN_COUNT : 0,
        RUN_COUNT,
        runs.length,
        atLeast(REQUIRED_COMPLETE_RATE, 'three identical recorded run configurations'),
        completeRuns,
      ),
      ambiguity_review_coverage: metric(
        ambiguityReviewed,
        expectedAmbiguous,
        ambiguityObserved,
        atLeast(
          SCORER_POLICY.metrics.ambiguity_review_coverage.numerator,
          'all ambiguous/unresolved speakers flagged for review',
        ),
      ),
      structural_ambiguity_review_coverage: metric(
        structuralAmbiguityReviewed,
        expectedStructural,
        structuralAmbiguityObserved,
        atLeast(
          SCORER_POLICY.metrics.structural_ambiguity_review_coverage.numerator,
          'all structurally ambiguous cases flagged for review',
        ),
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
      const run = schemaRuns.get(runIndex)
      return {
        run_index: runIndex,
        input_sha256:
          indexedInputHashes.get(runIndex) ??
          positionalInputHashes.get(runIndex) ??
          sha256(`missing-evaluation-run@2\0${runIndex}`),
        configuration_sha256: run
          ? canonicalSha256(configurationIdentity(run))
          : sha256(`invalid-evaluation-run-configuration@2\0${runIndex}`),
        schema_conformant: run !== undefined,
        source_corpus_identity_valid: identityRuns.has(runIndex),
        elapsed_ms: run?.operational.elapsed_ms ?? null,
        peak_vram_mib: run?.operational.peak_vram_mib ?? null,
        peak_ram_mib: run?.operational.peak_ram_mib ?? null,
        crashed: run?.operational.crashed ?? null,
        out_of_memory: run?.operational.out_of_memory ?? null,
      }
    })

    const report: EvaluationReport = {
      schema_version: 'evaluation-report@2',
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
