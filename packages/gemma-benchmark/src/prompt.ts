import {
  canonicalJson,
  canonicalSha256,
  type EvaluationSource,
  type JsonValue,
  type RepresentativeCorpus,
} from '@light-novel-audiobook/scoring-harness'
import type { BenchmarkContext } from './schemas.js'

export const PROMPT_VERSION = 'gemma-director-benchmark@1'
export const OUTPUT_SCHEMA_VERSION = 'director-benchmark-output@1'

export const SYSTEM_PROMPT = `You are a deterministic audiobook director classifier.
Classify every supplied span without rewriting, joining, splitting, omitting, or inventing text.
Use only character_id values from the supplied roster, narrator_id for non-dialogue, or fallback_dialogue_id when the speaker is unresolved.
Flag every ambiguous or uncertain speaker and every structurally uncertain passage for review.
Internal thought is kind "thought"; spoken words are kind "dialogue".
Return JSON only and preserve the exact case order. Legitimate fiction must not be refused.`

export interface PreparedRequest {
  readonly body: Record<string, unknown>
  readonly requestSha256: string
  readonly promptSha256: string
  readonly outputSchemaSha256: string
}

function outputJsonSchema(caseCount: number): Record<string, unknown> {
  const resultBase = {
    type: 'object',
    properties: {
      case_id: { type: 'string', minLength: 1, maxLength: 256 },
      review_required: { type: 'boolean' },
    },
    required: ['case_id', 'review_required'],
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      results: {
        type: 'array',
        minItems: caseCount,
        maxItems: caseCount,
        items: {
          oneOf: [
            {
              ...resultBase,
              additionalProperties: false,
              properties: {
                ...resultBase.properties,
                status: { const: 'predicted' },
                kind: {
                  enum: ['narration', 'dialogue', 'thought', 'message', 'sound_cue'],
                },
                speaker: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,127}$' },
              },
              required: ['case_id', 'status', 'kind', 'speaker', 'review_required'],
            },
            {
              ...resultBase,
              additionalProperties: false,
              properties: {
                ...resultBase.properties,
                status: { const: 'refused' },
                refusal_code: { enum: ['policy', 'content', 'other'] },
                review_required: { const: true },
              },
              required: ['case_id', 'status', 'refusal_code', 'review_required'],
            },
          ],
        },
      },
    },
    required: ['results'],
  }
}

export function prepareRequest(
  source: EvaluationSource,
  corpus: RepresentativeCorpus,
  context: BenchmarkContext,
  modelId: string,
  sampling: { seed: number; temperature: number; topP: number; maxTokens: number },
): PreparedRequest {
  const cases = corpus.cases.map((item) => ({
    case_id: item.case_id,
    source_ref: item.source_ref,
    source_start: item.source_start,
    source_end: item.source_end,
  }))
  const userInput = {
    story_context: context.story_context,
    characters: context.characters,
    narrator_id: context.narrator_id,
    fallback_dialogue_id: context.fallback_dialogue_id,
    passages: source.passages.map((passage) => ({
      source_ref: passage.source_ref,
      text: passage.source_text,
    })),
    cases,
  }
  const schema = outputJsonSchema(cases.length)
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: canonicalJson(userInput) },
  ]
  const body = {
    model: modelId,
    messages,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'director_benchmark_output', strict: true, schema },
    },
    stream: false,
    seed: sampling.seed,
    temperature: sampling.temperature,
    top_p: sampling.topP,
    max_tokens: sampling.maxTokens,
  }
  return {
    body,
    requestSha256: canonicalSha256(body as JsonValue),
    promptSha256: canonicalSha256({ version: PROMPT_VERSION, messages }),
    outputSchemaSha256: canonicalSha256(schema as JsonValue),
  }
}
