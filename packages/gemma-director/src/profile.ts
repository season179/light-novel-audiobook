import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { DirectorModelIdentity } from './port.js'

export const GEMMA_DIRECTOR_PROMPT_VERSION = 'gemma-director@4'
export const GEMMA_DIRECTOR_SCHEMA_VERSION = 'gemma-direction-output@4'

export const SELECTED_GEMMA_PROFILE = Object.freeze({
  id: 'google-gemma-4-26b-a4b-it-qat-q4-0',
  modelId: 'google-gemma-4-26b-a4b-it-qat-q4-0',
  repository: 'google/gemma-4-26B-A4B-it-qat-q4_0-gguf',
  revision: 'd1c082be9cf3c8a514acf63b8761f4b41935842e',
  file: 'gemma-4-26B_q4_0-it.gguf',
  sizeBytes: 14_439_363_584,
  sha256: '3eca3b8f6d7baf218a7dd6bba5fb59a56ee25fe2d567b6f5f589b4f697eca51d',
  llamaCppCommit: '555881ebc8b0fc0402b30e09258a32a7bfd13c52',
  contextSize: 32_768,
  gpuLayers: 35,
  cacheTypeK: 'q8_0',
  cacheTypeV: 'q8_0',
  batchSize: 2_048,
  microBatchSize: 512,
  threads: 16,
  reasoning: 'off',
  seed: 42,
  temperature: 0,
  topP: 1,
  maxTokens: 8_192,
  defaultRuntimeRoot: resolve(
    process.env.XDG_CACHE_HOME ?? resolve(homedir(), '.cache'),
    'light-novel-audiobook/issue-6-brain',
  ),
} as const)

export const GEMMA_DIRECTOR_MODEL_IDENTITY: DirectorModelIdentity = Object.freeze({
  adapter: 'tanstack-ai-openai-compatible',
  profileId: SELECTED_GEMMA_PROFILE.id,
  modelId: SELECTED_GEMMA_PROFILE.modelId,
  modelRevision: SELECTED_GEMMA_PROFILE.revision,
  modelSha256: SELECTED_GEMMA_PROFILE.sha256,
  promptVersion: GEMMA_DIRECTOR_PROMPT_VERSION,
  schemaVersion: GEMMA_DIRECTOR_SCHEMA_VERSION,
})

export const GEMMA_DIRECTOR_SYSTEM_PROMPT = `You are a deterministic audiobook director.
Cover every supplied source passage with one or more ordered fragments. A passage may and should be split when narration, spoken dialogue, thought, message, or sound-cue kind changes inside it.
For every fragment, copy source_passage_id and source_text exactly. The ordered fragment texts for each passage must concatenate to that passage's complete source_text exactly. Keep passages and fragments in source order. Never trim, join across passages, omit, duplicate, overlap, reorder, rewrite, or invent story text. Source ranges are derived deterministically after validation; do not calculate or return character offsets.
Speaker roles are constrained by the response schema. For narration and sound cues, do not choose a speaker; the adapter assigns the narrator deterministically. For dialogue, thought, and messages, choose only a character speaker ID admitted by the response schema. If none can be resolved from the supplied roster and context, set speaker_id null and give a short factual speaker_reason. A resolved character speaker must have speaker_reason null.
Choose restrained delivery only from the schema enums. Prefer neutral, normal pace, and normal volume unless the text clearly supports a different choice; avoid theatrical exaggeration.
Confidence is from 0 to 1 and measures the kind and speaker assignment. Return schema-constrained JSON only. Legitimate fiction must not be refused.`
