import { evaluationRunSchema } from '@light-novel-audiobook/scoring-harness'
import { z } from 'zod'

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const versionSchema = z.string().regex(/^[a-z][a-z0-9-]*@[1-9][0-9]*$/)
const opaqueIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/)
const caseIdSchema = z.string().min(1).max(256)
export const datasetClassSchema = z.enum(['private_representative', 'synthetic_operational'])

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

export const performanceSchema = z.strictObject({
  prompt_tokens: z.int().min(0).nullable(),
  generated_tokens: z.int().min(0).nullable(),
  prompt_tokens_per_second: z.number().min(0).nullable(),
  generated_tokens_per_second: z.number().min(0).nullable(),
})

export const resourceCaptureSchema = z.strictObject({
  method_version: z.literal('wsl-system-resource-sampling@2'),
  elapsed_ms: z.int().min(0),
  peak_vram_mib: z.int().min(0),
  peak_ram_mib: z.int().min(0),
  sample_count: z.int().min(0),
  initial_sample_captured: z.boolean(),
  final_sample_captured: z.boolean(),
  complete: z.boolean(),
  error_code: z.enum(['none', 'collector_failed']),
})

export const childExitEvidenceSchema = z.strictObject({
  observed_exited: z.boolean(),
  exit_code: z.int().nullable(),
  signal: z.string().nullable(),
})

export const experimentPlanSchema = z.strictObject({
  schema_version: z.literal('benchmark-experiment-plan@3'),
  experiment_id: opaqueIdSchema,
  dataset_class: datasetClassSchema,
  profile_id: opaqueIdSchema,
  profile_order: z.int().min(0).max(3),
  run_count: z.literal(3),
  source_sha256: sha256Schema,
  corpus_sha256: sha256Schema,
  annotations_sha256: sha256Schema,
  context_sha256: sha256Schema,
  model_id: z.string().min(1),
  model_sha256: sha256Schema,
  host_manifest_sha256: sha256Schema,
  runtime_binary_sha256: sha256Schema,
  runtime_configuration_sha256: sha256Schema,
  request_sha256: sha256Schema,
  prompt_sha256: sha256Schema,
  output_schema_sha256: sha256Schema,
})

export const runFailureCodeSchema = z.enum([
  'none',
  'http',
  'timeout',
  'transport',
  'malformed_json',
  'schema',
  'identity',
  'runtime_exit',
  'oom',
  'resource_capture',
])

export const benchmarkRunManifestSchema = z
  .strictObject({
    schema_version: z.literal('benchmark-run-manifest@3'),
    experiment_id: opaqueIdSchema,
    dataset_class: datasetClassSchema,
    run_index: z.int().min(1).max(3),
    plan_sha256: sha256Schema,
    host_manifest_sha256: sha256Schema,
    runtime_configuration_sha256: sha256Schema,
    request_sha256: sha256Schema,
    annotations_sha256: sha256Schema,
    raw_response_sha256: sha256Schema,
    raw_response: z.string(),
    raw_response_json_valid: z.boolean(),
    provider_http_status: z.int().min(100).max(599).nullable(),
    provider_output_valid: z.boolean(),
    result_state: z.enum(['completed', 'model_output_invalid', 'request_failed']),
    failure_code: runFailureCodeSchema,
    performance: performanceSchema,
    resources: resourceCaptureSchema,
    child_exit: childExitEvidenceSchema,
    evaluation_run: evaluationRunSchema,
  })
  .superRefine((value, context) => {
    const providerValid =
      value.result_state === 'completed' &&
      value.raw_response_json_valid &&
      value.provider_http_status !== null &&
      value.provider_http_status >= 200 &&
      value.provider_http_status < 300
    if (value.provider_output_valid !== providerValid) {
      context.addIssue({ code: 'custom', message: 'Provider-output fields are inconsistent' })
    }
    if (
      value.failure_code === 'none' &&
      (!providerValid ||
        !value.resources.complete ||
        value.child_exit.observed_exited ||
        value.evaluation_run.operational.crashed ||
        value.evaluation_run.operational.out_of_memory)
    ) {
      context.addIssue({ code: 'custom', message: 'Run falsely claims operational success' })
    }
    if (value.resources.complete !== (value.resources.error_code === 'none')) {
      context.addIssue({ code: 'custom', message: 'Resource capture fields are inconsistent' })
    }
    if (value.child_exit.observed_exited !== value.evaluation_run.operational.crashed) {
      context.addIssue({ code: 'custom', message: 'Child exit and crash fields are inconsistent' })
    }
  })

export const runtimeCleanupEvidenceSchema = z
  .strictObject({
    schema_version: z.literal('runtime-cleanup@1'),
    child_exit_observed: z.literal(true),
    exit_code: z.int().nullable(),
    signal: z.string().nullable(),
    termination: z.enum(['already_exited', 'sigterm', 'sigkill']),
    sigterm_sent: z.boolean(),
    sigkill_sent: z.boolean(),
    exit_awaited: z.literal(true),
    api_key_file_removed: z.literal(true),
    port_released: z.literal(true),
  })
  .superRefine((value, context) => {
    if (value.exit_code !== null && value.signal !== null) {
      context.addIssue({ code: 'custom', message: 'Cleanup has two terminal states' })
    }
    const signalsConsistent =
      (value.termination === 'already_exited' && !value.sigterm_sent && !value.sigkill_sent) ||
      (value.termination === 'sigterm' && value.sigterm_sent && !value.sigkill_sent) ||
      (value.termination === 'sigkill' && value.sigterm_sent && value.sigkill_sent)
    if (!signalsConsistent) {
      context.addIssue({ code: 'custom', message: 'Cleanup termination signals are inconsistent' })
    }
  })

const fallbackReasonSchema = z.enum([
  'acceptance_failed',
  'operational_impractical',
  'mature_content_refusal',
])

export const fallbackHistorySchema = z.strictObject({
  schema_version: z.literal('fallback-history@2'),
  attempts: z.array(
    z.strictObject({
      profile_id: opaqueIdSchema,
      report_sha256: sha256Schema,
      overall_passed: z.literal(false),
      evaluation_reason: z.enum(['primary_locked', 'mature_content_refusal', 'ordered_fallback']),
      failure_reasons: z.array(fallbackReasonSchema).min(1),
    }),
  ),
})

export type BenchmarkContext = z.infer<typeof benchmarkContextSchema>
export type ModelOutput = z.infer<typeof modelOutputSchema>
export type Performance = z.infer<typeof performanceSchema>
export type ResourceCapture = z.infer<typeof resourceCaptureSchema>
export type ChildExitEvidence = z.infer<typeof childExitEvidenceSchema>
export type ExperimentPlan = z.infer<typeof experimentPlanSchema>
export type BenchmarkRunManifest = z.infer<typeof benchmarkRunManifestSchema>
export type RuntimeCleanupEvidence = z.infer<typeof runtimeCleanupEvidenceSchema>
export type FallbackHistory = z.infer<typeof fallbackHistorySchema>

export function isGracefulOwnedShutdown(value: RuntimeCleanupEvidence): boolean {
  return (
    value.child_exit_observed &&
    value.exit_awaited &&
    value.termination === 'sigterm' &&
    value.sigterm_sent &&
    !value.sigkill_sent &&
    value.exit_code === 0 &&
    value.signal === null &&
    value.api_key_file_removed &&
    value.port_released
  )
}
