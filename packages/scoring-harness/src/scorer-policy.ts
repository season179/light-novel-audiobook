import { canonicalSha256, type JsonValue } from './canonical-json.js'

export const SCORER_VERSION = 'representative-gold-scorer@2'
export const AMBIGUITY_POLICY = 'exclude-speaker-accuracy-require-review@2' as const

export const REQUIRED_CRITERIA = [
  'dialogue',
  'narration',
  'internal_thought',
  'alias',
  'coreference',
  'ambiguous_speaker',
  'structurally_ambiguous',
  'repeated_text',
  'source_reference',
] as const

/** Every field in this object affects acceptance or the interpretation of an acceptance result. */
export const SCORER_POLICY = {
  scorer_version: SCORER_VERSION,
  canonicalization: 'recursive-sorted-key-json-utf8@1',
  required_criteria: REQUIRED_CRITERIA,
  schema_versions: {
    source: 'evaluation-source@1',
    corpus: 'representative-corpus@1',
    annotations: 'gold-annotations@2',
    run: 'evaluation-run@2',
    report: 'evaluation-report@2',
  },
  overall_pass: 'every-required-metric-passes',
  governance: {
    hash_chain:
      'passage-text-sha256-then-canonical-source-then-corpus-source-link-then-annotation-source-and-corpus-links',
    uniqueness: 'source-references-corpus-case-ids-and-annotation-case-ids',
    storage:
      'workspace-only-source-requires-workspace-private-and-committed-synthetic-requires-project-synthetic-committed-allowed',
    case_set: 'corpus-and-annotation-case-id-sets-exactly-equal',
    case_partition:
      'every-source-passage-covered-in-input-order-with-no-gap-overlap-or-unknown-ref',
    criteria_presence: 'every-required-criterion-has-at-least-one-case',
    semantic_tags:
      'dialogue-narration-thought-alias-coreference-and-ambiguous-tags-must-match-gold',
    repeated_text: 'tag-requires-identical-case-text-at-distinct-source-references',
    source_reference: 'tag-requires-multiple-cases-sharing-one-source-reference',
    speaker_applicability: 'dialogue-has-speaker-gold-and-non-dialogue-does-not',
  },
  run_set: {
    required_count: 3,
    required_indexes: [1, 2, 3],
    extra_missing_or_duplicate: 'fail-without-replacing-first-indexed-summary',
  },
  validation: {
    governance_schema_failure: 'abort-with-sanitized-schema-paths',
    run_schema_conformance: 'score-first-three-documents-independently',
    source_corpus_identity: 'separate-required-metric',
    identity_invalid_run_scoring:
      'exclude-from-semantic-and-resource-observations-without-shrinking-fixed-denominators',
    configuration_identity: 'separate-required-identical-three-run-metric',
    report_paths: 'known-schema-properties-or-generic-key-and-array-tokens-only',
  },
  configuration_hash_fields: [
    'model.adapter_id',
    'model.adapter_version',
    'model.model_id',
    'model.model_sha256',
    'model.prompt_version',
    'model.prompt_sha256',
    'model.output_schema_version',
    'model.output_schema_sha256',
    'model.seed',
    'model.context_size',
    'model.parameters',
    'operational.resource_measurement',
  ],
  source: {
    offsets: 'zero-based-half-open-unicode-scalar-values',
    corpus_cases: 'ordered-exact-partition-of-every-selected-source-passage',
    coverage:
      'each-run-passage-is-an-in-order-exact-text-partition-with-no-refusal-or-unknown-reference',
    prediction_order: 'exactly-one-output-per-corpus-case-in-committed-corpus-order',
    repeated_text_identity: 'source-reference-and-offset-never-text-content',
  },
  annotation: {
    exact_speaker: 'one-canonical-character-id',
    ambiguous_speaker: 'zero-or-more-accepted-ids-with-no-maximum',
    ambiguity_policy: AMBIGUITY_POLICY,
    ambiguous_or_unresolved: 'exclude-speaker-accuracy-and-require-review',
    structurally_ambiguous: 'require-review',
    review_flag_observation: 'count-unique-predicted-or-refused-case-output',
    incorrect_speaker: 'exact-speaker-gold-and-predicted-canonical-id-not-accepted',
    zero_error_recall: 'vacuously-one-with-visible-zero-denominator',
  },
  agreement: {
    unit: 'corpus-case',
    value: 'joint-segment-kind-and-speaker',
    eligibility: 'one-non-refused-prediction-in-each-of-three-identically-configured-runs',
  },
  denominators: {
    run_set_integrity: 'required-three-run-set',
    schema_validity: 'first-three-input-documents-with-fixed-denominator-three',
    source_corpus_identity: 'required-indexed-runs-with-fixed-denominator-three',
    prediction_order_integrity: 'required-identity-valid-runs-with-fixed-denominator-three',
    exact_source_coverage: 'selected-source-passages-times-three',
    dialogue_speaker_accuracy: 'exact-speaker-dialogue-cases-times-three',
    alias_coreference_accuracy: 'exact-alias-or-coreference-dialogue-cases-times-three',
    thought_vs_spoken_accuracy: 'gold-dialogue-or-thought-cases-times-three',
    incorrect_speaker_review_recall: 'demonstrably-wrong-exact-speaker-predictions',
    refusal_rate: 'all-legitimate-corpus-cases-times-three',
    three_run_agreement: 'all-corpus-cases-once',
    operational_metrics: 'three-identity-valid-runs',
    ambiguity_review_coverage: 'ambiguous-or-unresolved-cases-times-three',
    structural_ambiguity_review_coverage: 'structurally-ambiguous-cases-times-three',
  },
  metrics: {
    run_set_integrity: { operator: '>=', numerator: 100, denominator: 100 },
    schema_validity: { operator: '>=', numerator: 100, denominator: 100 },
    source_corpus_identity: { operator: '>=', numerator: 100, denominator: 100 },
    prediction_order_integrity: { operator: '>=', numerator: 100, denominator: 100 },
    exact_source_coverage: { operator: '>=', numerator: 100, denominator: 100 },
    dialogue_speaker_accuracy: { operator: '>=', numerator: 95, denominator: 100 },
    alias_coreference_accuracy: { operator: '>=', numerator: 95, denominator: 100 },
    thought_vs_spoken_accuracy: { operator: '>=', numerator: 98, denominator: 100 },
    incorrect_speaker_review_recall: { operator: '>=', numerator: 90, denominator: 100 },
    refusal_rate: { operator: '<=', numerator: 0, denominator: 100 },
    three_run_agreement: { operator: '>=', numerator: 95, denominator: 100 },
    elapsed_time: { operator: '<=', milliseconds: 3_600_000, required_runs: 3 },
    peak_vram: { operator: '<=', mebibytes: 15_872, required_runs: 3 },
    peak_ram: { operator: '<=', mebibytes: 61_440, required_runs: 3 },
    operational_success: { crashes: 0, out_of_memory: 0, required_runs: 3 },
    context_size: { operator: '=', tokens: 32_768, required_runs: 3 },
    repeated_run_configuration: { identical_runs: 3 },
    ambiguity_review_coverage: { operator: '>=', numerator: 100, denominator: 100 },
    structural_ambiguity_review_coverage: {
      operator: '>=',
      numerator: 100,
      denominator: 100,
    },
  },
  arithmetic: {
    required_complete_rate_percent: 100,
    threshold_comparison: 'exact-integer-cross-multiplication',
    displayed_rate: 'floor-to-six-decimal-places',
    incomplete_observation: 'fail-without-shrinking-policy-denominator',
  },
  operational_units: {
    elapsed: 'milliseconds-complete-direction-run',
    memory: 'mebibytes-1048576-bytes',
    measurement_method: 'versioned-and-included-in-configuration-hash',
  },
} as const satisfies JsonValue

export const SCORER_SHA256 = canonicalSha256(SCORER_POLICY)
