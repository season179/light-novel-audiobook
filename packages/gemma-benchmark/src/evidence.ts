import { canonicalSha256, type JsonValue } from '@light-novel-audiobook/scoring-harness'
import { z } from 'zod'
import { hostManifestSchema } from './runtime.js'
import {
  childExitEvidenceSchema,
  experimentPlanSchema,
  isGracefulOwnedShutdown,
  performanceSchema,
  type RuntimeCleanupEvidence,
  resourceCaptureSchema,
  runtimeCleanupEvidenceSchema,
  sha256Schema,
} from './schemas.js'

const gitIdentitySchema = z.strictObject({
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  tree: z.string().regex(/^[a-f0-9]{40}$/),
  canonical_source_set_sha256: sha256Schema,
  source_files: z.array(z.string().min(1)).min(1),
})

const externalProofFields = {
  canonicalized: z.literal(true),
  outsideRepository: z.literal(true),
  outsideGitDirectory: z.literal(true),
  outsideTtsRoots: z.literal(true),
  overlapCheckedBothDirections: z.literal(true),
  symlinkComponentsRejected: z.literal(true),
  pathClasses: z.array(z.string().min(1)).min(1),
} as const

const externalProofSchema = z.union([
  z.strictObject({
    ...externalProofFields,
    ext4: z.literal(true),
  }),
  z.strictObject({
    schemaVersion: z.literal(2),
    ...externalProofFields,
    filesystem: z.enum(['ext4', 'apfs']),
  }),
])

const evidenceRunSchema = z.strictObject({
  run_index: z.int().min(1).max(3),
  manifest_file_sha256: sha256Schema,
  raw_response_sha256: sha256Schema,
  evaluation_run_sha256: sha256Schema,
  annotations_sha256: sha256Schema,
  result_state: z.literal('completed'),
  failure_code: z.literal('none'),
  provider_output_valid: z.literal(true),
  resources: resourceCaptureSchema,
  child_exit: childExitEvidenceSchema,
  performance: performanceSchema,
  crashed: z.literal(false),
  out_of_memory: z.literal(false),
})

export const syntheticEvidenceSchema = z.strictObject({
  schema_version: z.literal('issue-6-synthetic-evidence@2'),
  scope: z.literal('synthetic-operational-only-not-representative-accuracy'),
  representative_accuracy_claim_permitted: z.literal(false),
  implementation: gitIdentitySchema,
  runtime: z.strictObject({
    host_manifest: hostManifestSchema,
    host_manifest_file_sha256: sha256Schema,
    model_sha256: sha256Schema,
    model_size_bytes: z.int().positive(),
    binary_sha256: sha256Schema,
    cmake_configuration_sha256: sha256Schema,
    runtime_configuration_sha256: sha256Schema,
    external_root_proof: externalProofSchema,
    model_bytes_verified: z.literal(true),
    binary_bytes_verified: z.literal(true),
    text_model_only: z.literal(true),
  }),
  experiment: z.strictObject({
    plan: experimentPlanSchema,
    plan_canonical_sha256: sha256Schema,
    plan_file_sha256: sha256Schema,
    annotations_sha256: sha256Schema,
    runs: z.array(evidenceRunSchema).length(3),
    sanitized_report: z.record(z.string(), z.unknown()),
    sanitized_report_file_sha256: sha256Schema,
  }),
  cleanup: runtimeCleanupEvidenceSchema,
  runtime_lifecycle_passed: z.literal(true),
  evidence_binding_sha256: sha256Schema,
})

export type SyntheticEvidence = z.infer<typeof syntheticEvidenceSchema>

export function evidenceBinding(value: Omit<SyntheticEvidence, 'evidence_binding_sha256'>): string {
  return canonicalSha256(value as unknown as JsonValue)
}

export function verifySyntheticAnnotationFixtureIdentity(
  value: SyntheticEvidence,
  annotationFixture: JsonValue,
): void {
  const fixtureSha256 = canonicalSha256(annotationFixture)
  if (
    fixtureSha256 !== value.experiment.annotations_sha256 ||
    fixtureSha256 !== value.experiment.plan.annotations_sha256 ||
    fixtureSha256 !==
      (
        value.experiment.sanitized_report as {
          scoring?: { identities?: { annotation_sha256?: unknown } }
        }
      ).scoring?.identities?.annotation_sha256
  ) {
    throw new Error('Recorded implementation annotation fixture identity mismatch')
  }
}

export function verifyPassingCleanupEvidence(value: RuntimeCleanupEvidence): void {
  if (!isGracefulOwnedShutdown(value)) {
    throw new Error('Evidence cleanup is not a graceful owned shutdown')
  }
}

export function verifyEvidenceInternalConsistency(value: SyntheticEvidence): void {
  const { evidence_binding_sha256: recordedBinding, ...preimage } = value
  if (evidenceBinding(preimage) !== recordedBinding) throw new Error('Evidence binding mismatch')
  if (
    value.experiment.plan_canonical_sha256 !==
    canonicalSha256(value.experiment.plan as unknown as JsonValue)
  ) {
    throw new Error('Evidence plan canonical hash mismatch')
  }
  if (value.experiment.annotations_sha256 !== value.experiment.plan.annotations_sha256) {
    throw new Error('Evidence annotations hash mismatch')
  }
  const report = value.experiment.sanitized_report as {
    schema_version?: unknown
    dataset_class?: unknown
    representative_accuracy_claim_permitted?: unknown
    operational_passed?: unknown
    plan_sha256?: unknown
    annotations_sha256?: unknown
    run_count?: unknown
    run_manifest_sha256?: unknown
    decision?: unknown
    runs?: Array<Record<string, unknown>>
    scoring?: { identities?: { annotation_sha256?: unknown } }
  }
  if (report.scoring?.identities?.annotation_sha256 !== value.experiment.annotations_sha256) {
    throw new Error('Evidence scoring annotation identity mismatch')
  }
  if (
    report.schema_version !== 'issue-6-benchmark-report@3' ||
    report.dataset_class !== 'synthetic_operational' ||
    report.representative_accuracy_claim_permitted !== false ||
    report.operational_passed !== true ||
    report.plan_sha256 !== value.experiment.plan_canonical_sha256 ||
    report.annotations_sha256 !== value.experiment.plan.annotations_sha256 ||
    report.run_count !== 3 ||
    report.decision !== 'synthetic-operational-smoke-only'
  ) {
    throw new Error('Evidence report does not prove a synthetic operational pass')
  }
  const reportRunHashes = report.run_manifest_sha256
  if (
    !Array.isArray(reportRunHashes) ||
    reportRunHashes.some(
      (hash, index) => hash !== value.experiment.runs[index]?.manifest_file_sha256,
    )
  ) {
    throw new Error('Evidence report run-manifest binding mismatch')
  }
  if (
    value.experiment.runs.some(
      (run, index) =>
        run.run_index !== index + 1 ||
        run.annotations_sha256 !== value.experiment.annotations_sha256 ||
        !run.resources.complete ||
        run.child_exit.observed_exited ||
        run.crashed ||
        run.out_of_memory,
    )
  ) {
    throw new Error('Evidence contains a failed or incomplete operational run')
  }
  verifyPassingCleanupEvidence(value.cleanup)
  const serialized = JSON.stringify(value)
  if (
    serialized.includes('The brass bell rang.') ||
    /\/home\/|\/mnt\/|[A-Z]:\\/.test(serialized) ||
    /"(?:raw_response|source_text|api_key|pid|path)"/i.test(serialized)
  ) {
    throw new Error('Evidence contains a forbidden raw, private, or host-path field')
  }
}
