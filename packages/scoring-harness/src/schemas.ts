import { z } from 'zod'

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const versionSchema = z.string().regex(/^[a-z][a-z0-9-]*@[1-9][0-9]*$/)
const nonEmptySchema = z.string().min(1)

export const segmentKindSchema = z.enum([
  'narration',
  'dialogue',
  'thought',
  'message',
  'sound_cue',
])

export const selectionCriterionSchema = z.enum([
  'dialogue',
  'narration',
  'internal_thought',
  'alias',
  'coreference',
  'ambiguous_speaker',
  'structurally_ambiguous',
  'repeated_text',
  'source_reference',
])

const provenanceSchema = z.strictObject({
  origin: z.enum(['project_synthetic', 'private_copyrighted', 'permissively_licensed']),
  redistribution: z.enum(['committed_allowed', 'workspace_only']),
  license: nonEmptySchema,
  contains_personal_data: z.boolean(),
})

export const evaluationSourceSchema = z.strictObject({
  schema_version: z.literal('evaluation-source@1'),
  source_version: versionSchema,
  source_id: nonEmptySchema,
  provenance: provenanceSchema,
  extraction_identity: z.strictObject({
    archive_parser: nonEmptySchema,
    xml_parser: nonEmptySchema,
    extraction_rules: versionSchema,
    publication_content_sha256: sha256Schema,
    extraction_sha256: sha256Schema,
    offset_unit: z.literal('unicode-scalar-value'),
  }),
  passages: z
    .array(
      z.strictObject({
        source_ref: nonEmptySchema,
        locator: nonEmptySchema,
        source_text: z.string().min(1),
        source_text_sha256: sha256Schema,
      }),
    )
    .min(1),
})

export const representativeCorpusSchema = z.strictObject({
  schema_version: z.literal('representative-corpus@1'),
  corpus_version: versionSchema,
  corpus_id: nonEmptySchema,
  source_sha256: sha256Schema,
  storage_class: z.enum(['committed_synthetic', 'workspace_private']),
  selection_policy_version: versionSchema,
  selection_rationale: z.string().min(1),
  cases: z
    .array(
      z.strictObject({
        case_id: nonEmptySchema,
        source_ref: nonEmptySchema,
        source_start: z.int().min(0),
        source_end: z.int().positive(),
        legitimate: z.literal(true),
        criteria: z.array(selectionCriterionSchema).min(1),
      }),
    )
    .min(1),
})

const exactSpeakerSchema = z.strictObject({
  status: z.literal('exact'),
  accepted_character_ids: z.array(nonEmptySchema).length(1),
  evidence: z.enum(['explicit', 'alias', 'coreference']),
})
const ambiguousSpeakerSchema = z.strictObject({
  status: z.enum(['ambiguous', 'unresolved']),
  accepted_character_ids: z.array(nonEmptySchema).max(2),
  evidence: z.literal('ambiguous'),
})
const notApplicableSpeakerSchema = z.strictObject({
  status: z.literal('not_applicable'),
  accepted_character_ids: z.tuple([]),
  evidence: z.literal('none'),
})

export const goldAnnotationsSchema = z.strictObject({
  schema_version: z.literal('gold-annotations@1'),
  annotation_version: versionSchema,
  annotation_policy_version: versionSchema,
  source_sha256: sha256Schema,
  corpus_sha256: sha256Schema,
  cases: z
    .array(
      z.strictObject({
        case_id: nonEmptySchema,
        kind: segmentKindSchema,
        speaker: z.discriminatedUnion('status', [
          exactSpeakerSchema,
          ambiguousSpeakerSchema,
          notApplicableSpeakerSchema,
        ]),
      }),
    )
    .min(1),
})

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
)

const predictionReference = {
  source_ref: nonEmptySchema,
  source_start: z.int().min(0),
  source_end: z.int().positive(),
}
const predictedSegmentSchema = z.strictObject({
  ...predictionReference,
  status: z.literal('predicted'),
  text: z.string().min(1),
  kind: segmentKindSchema,
  speaker: nonEmptySchema,
  review_required: z.boolean(),
})
const refusedSegmentSchema = z.strictObject({
  ...predictionReference,
  status: z.literal('refused'),
  refusal_code: z.enum(['policy', 'content', 'other']),
  review_required: z.literal(true),
})

export const evaluationRunSchema = z.strictObject({
  schema_version: z.literal('evaluation-run@1'),
  run_index: z.int().min(1).max(3),
  source_sha256: sha256Schema,
  corpus_sha256: sha256Schema,
  model: z.strictObject({
    adapter_id: nonEmptySchema,
    adapter_version: nonEmptySchema,
    model_id: nonEmptySchema,
    model_sha256: sha256Schema,
    prompt_version: versionSchema,
    prompt_sha256: sha256Schema,
    output_schema_version: versionSchema,
    seed: z.int(),
    context_size: z.int().positive(),
    parameters: z.record(z.string(), jsonValueSchema),
  }),
  operational: z.strictObject({
    elapsed_ms: z.int().min(0),
    peak_vram_mib: z.int().min(0),
    peak_ram_mib: z.int().min(0),
    crashed: z.boolean(),
    out_of_memory: z.boolean(),
  }),
  predictions: z
    .array(z.discriminatedUnion('status', [predictedSegmentSchema, refusedSegmentSchema]))
    .min(1),
})

const thresholdSchema = z.strictObject({
  operator: z.enum(['>=', '<=', '=']),
  numerator: z.int().min(0),
  denominator: z.int().positive(),
  label: nonEmptySchema,
})

export const metricResultSchema = z.strictObject({
  numerator: z.int().min(0),
  denominator: z.int().min(0),
  observed_denominator: z.int().min(0),
  rate: z.string().regex(/^[0-9]+\.[0-9]{6}$/),
  threshold: thresholdSchema,
  passed: z.boolean(),
})

const reportMetricsSchema = z.strictObject({
  schema_validity: metricResultSchema,
  exact_source_coverage: metricResultSchema,
  dialogue_speaker_accuracy: metricResultSchema,
  alias_coreference_accuracy: metricResultSchema,
  thought_vs_spoken_accuracy: metricResultSchema,
  incorrect_speaker_review_recall: metricResultSchema,
  refusal_rate: metricResultSchema,
  three_run_agreement: metricResultSchema,
  elapsed_time_within_limit: metricResultSchema,
  vram_within_limit: metricResultSchema,
  ram_within_limit: metricResultSchema,
  operational_success: metricResultSchema,
  context_size_configuration: metricResultSchema,
  repeated_run_configuration: metricResultSchema,
  ambiguity_review_coverage: metricResultSchema,
})

const criteriaCountsSchema = z.strictObject({
  dialogue: z.int().min(0),
  narration: z.int().min(0),
  internal_thought: z.int().min(0),
  alias: z.int().min(0),
  coreference: z.int().min(0),
  ambiguous_speaker: z.int().min(0),
  structurally_ambiguous: z.int().min(0),
  repeated_text: z.int().min(0),
  source_reference: z.int().min(0),
})

export const evaluationReportSchema = z.strictObject({
  schema_version: z.literal('evaluation-report@1'),
  overall_passed: z.boolean(),
  identities: z.strictObject({
    source_version: nonEmptySchema,
    source_sha256: sha256Schema,
    corpus_version: nonEmptySchema,
    corpus_sha256: sha256Schema,
    annotation_version: nonEmptySchema,
    annotation_sha256: sha256Schema,
    scorer_version: nonEmptySchema,
    scorer_sha256: sha256Schema,
  }),
  governance: z.strictObject({
    storage_class: z.enum(['committed_synthetic', 'workspace_private']),
    ambiguity_policy: z.literal('exclude-speaker-accuracy-require-review@1'),
    criteria_counts: criteriaCountsSchema,
    ambiguous_case_count: z.int().min(0),
  }),
  run_summaries: z
    .array(
      z.strictObject({
        run_index: z.int().min(1).max(3),
        input_sha256: sha256Schema,
        configuration_sha256: sha256Schema,
        schema_valid: z.boolean(),
        elapsed_ms: z.int().min(0).nullable(),
        peak_vram_mib: z.int().min(0).nullable(),
        peak_ram_mib: z.int().min(0).nullable(),
        crashed: z.boolean().nullable(),
        out_of_memory: z.boolean().nullable(),
      }),
    )
    .length(3),
  metrics: reportMetricsSchema,
  findings: z.array(
    z.strictObject({
      code: nonEmptySchema,
      run_index: z.int().min(1).max(3).optional(),
      unit_key: z
        .string()
        .regex(/^[a-f0-9]{16}$/)
        .optional(),
      path: z.string().min(1).optional(),
    }),
  ),
})

export type EvaluationSource = z.infer<typeof evaluationSourceSchema>
export type RepresentativeCorpus = z.infer<typeof representativeCorpusSchema>
export type GoldAnnotations = z.infer<typeof goldAnnotationsSchema>
export type EvaluationRun = z.infer<typeof evaluationRunSchema>
export type EvaluationPrediction = EvaluationRun['predictions'][number]
export type SelectionCriterion = z.infer<typeof selectionCriterionSchema>
export type MetricResult = z.infer<typeof metricResultSchema>
export type EvaluationReport = z.infer<typeof evaluationReportSchema>
