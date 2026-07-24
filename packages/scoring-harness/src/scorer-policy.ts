import { canonicalSha256, type JsonValue } from './canonical-json.js'

export const SCORER_VERSION = 'representative-gold-scorer@1'
export const AMBIGUITY_POLICY = 'exclude-speaker-accuracy-require-review@1' as const

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

export const SCORER_POLICY = {
  scorer_version: SCORER_VERSION,
  canonicalization: 'sorted-key-json-utf8@1',
  ambiguity_policy: AMBIGUITY_POLICY,
  run_count: 3,
  run_configuration: 'identical-model-prompt-schema-seed-context-and-parameters',
  source_offsets: 'unicode-scalar-value-half-open',
  coverage: 'each-source-passage-partitioned-exactly-once-with-exact-scalar-slices',
  metrics: {
    schema_validity: { operator: '>=', numerator: 100, denominator: 100 },
    exact_source_coverage: { operator: '>=', numerator: 100, denominator: 100 },
    dialogue_speaker_accuracy: { operator: '>=', numerator: 95, denominator: 100 },
    alias_coreference_accuracy: { operator: '>=', numerator: 95, denominator: 100 },
    thought_vs_spoken_accuracy: { operator: '>=', numerator: 98, denominator: 100 },
    incorrect_speaker_review_recall: { operator: '>=', numerator: 90, denominator: 100 },
    refusal_rate: { operator: '<=', numerator: 0, denominator: 100 },
    three_run_agreement: { operator: '>=', numerator: 95, denominator: 100 },
    elapsed_time: { operator: '<=', milliseconds: 3_600_000 },
    peak_vram: { operator: '<=', mebibytes: 15_872 },
    peak_ram: { operator: '<=', mebibytes: 61_440 },
    operational_success: { crashes: 0, out_of_memory: 0 },
    context_size: { operator: '=', tokens: 32_768 },
  },
  zero_error_recall: 'vacuously-one-with-zero-denominator',
} as const satisfies JsonValue

export const SCORER_SHA256 = canonicalSha256(SCORER_POLICY)
