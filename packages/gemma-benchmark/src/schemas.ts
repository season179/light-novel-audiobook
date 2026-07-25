import { evaluationRunSchema } from '@light-novel-audiobook/scoring-harness'
import { z } from 'zod'

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const versionSchema = z.string().regex(/^[a-z][a-z0-9-]*@[1-9][0-9]*$/)
const opaqueIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/)
const caseIdSchema = z.string().min(1).max(256)

export const benchmarkContextSchema = z.strictObject({
  schema_version: z.literal('benchmark-context@1'),
  context_version: versionSchema,
  source_sha256: sha256Schema,
  corpus_sha256: sha256Schema,
  story_context: z.string(),
  characters: z
    .array(
      z.strictObject({
        character_id: opaqueIdSchema,
        aliases: z.array(z.string().min(1)),
      }),
    )
    .min(1),
  narrator_id: opaqueIdSchema,
  fallback_dialogue_id: opaqueIdSchema,
  governance: z.strictObject({
    lawful_access_confirmed: z.literal(true),
    permitted_use: z.literal('local_evaluation'),
    redistribution: z.enum(['workspace_only', 'committed_allowed']),
    gold_annotations_completed_before_model_runs: z.literal(true),
    gold_annotators_blind_to_model_outputs: z.literal(true),
    independent_annotator_count: z.int().min(2),
    disagreements_adjudicated: z.literal(true),
  }),
})

const modelResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    case_id: caseIdSchema,
    status: z.literal('predicted'),
    kind: z.enum(['narration', 'dialogue', 'thought', 'message', 'sound_cue']),
    speaker: opaqueIdSchema,
    review_required: z.boolean(),
  }),
  z.strictObject({
    case_id: caseIdSchema,
    status: z.literal('refused'),
    refusal_code: z.enum(['policy', 'content', 'other']),
    review_required: z.literal(true),
  }),
])

export const modelOutputSchema = z.strictObject({
  results: z.array(modelResultSchema).min(1),
})

const performanceSchema = z.strictObject({
  prompt_tokens: z.int().min(0).nullable(),
  generated_tokens: z.int().min(0).nullable(),
  prompt_tokens_per_second: z.number().min(0).nullable(),
  generated_tokens_per_second: z.number().min(0).nullable(),
})

export const benchmarkRunManifestSchema = z.strictObject({
  schema_version: z.literal('benchmark-run-manifest@1'),
  experiment_id: opaqueIdSchema,
  dataset_class: z.enum(['private_representative', 'synthetic_operational']),
  run_index: z.int().min(1).max(3),
  request_sha256: sha256Schema,
  raw_response_sha256: sha256Schema,
  raw_response: z.string(),
  result_state: z.enum(['completed', 'model_output_invalid', 'request_failed']),
  failure_code: z
    .enum(['none', 'http', 'malformed_json', 'schema', 'identity', 'runtime_exit', 'oom'])
    .optional(),
  performance: performanceSchema,
  evaluation_run: evaluationRunSchema,
})

export const fallbackHistorySchema = z.strictObject({
  schema_version: z.literal('fallback-history@1'),
  attempts: z.array(
    z.strictObject({
      profile_id: opaqueIdSchema,
      report_sha256: sha256Schema,
      overall_passed: z.literal(false),
      reason: z.enum(['acceptance_failed', 'operational_impractical', 'mature_content_refusal']),
    }),
  ),
})

export type BenchmarkContext = z.infer<typeof benchmarkContextSchema>
export type ModelOutput = z.infer<typeof modelOutputSchema>
export type BenchmarkRunManifest = z.infer<typeof benchmarkRunManifestSchema>
export type FallbackHistory = z.infer<typeof fallbackHistorySchema>
