import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { DirectorModelIdentity } from './port.js'

export const GEMMA_DIRECTOR_PROMPT_VERSION = 'gemma-director@1'
export const GEMMA_DIRECTOR_SCHEMA_VERSION = 'gemma-direction-output@1'

export const SELECTED_GEMMA_PROFILE = Object.freeze({
  id: 'google-gemma-4-26b-a4b-it-qat-q4-0',
  modelId: 'google-gemma-4-26b-a4b-it-qat-q4-0',
  repository: 'google/gemma-4-26B-A4B-it-qat-q4_0-gguf',
  revision: 'd1c082be9cf3c8a514acf63b8761f4b41935842e',
  file: 'gemma-4-26B_q4_0-it.gguf',
  sizeBytes: 14_439_363_584,
  sha256: '3eca3b8f6d7baf218a7dd6bba5fb59a56ee25fe2d567b6f5f589b4f697eca51d',
  contextSize: 32_768,
  seed: 42,
  temperature: 0,
  topP: 1,
  maxTokens: 8_192,
  defaultRuntimeRoot: resolve(
    process.env.XDG_CACHE_HOME ?? resolve(homedir(), '.cache'),
    'light-novel-audiobook/issue-6-brain',
  ),
} as const)

export const GEMMA_DIRECTOR_IDENTITY: DirectorModelIdentity = Object.freeze({
  adapter: 'tanstack-ai-openai-compatible',
  profileId: SELECTED_GEMMA_PROFILE.id,
  modelId: SELECTED_GEMMA_PROFILE.modelId,
  modelRevision: SELECTED_GEMMA_PROFILE.revision,
  modelSha256: SELECTED_GEMMA_PROFILE.sha256,
  promptVersion: GEMMA_DIRECTOR_PROMPT_VERSION,
  schemaVersion: GEMMA_DIRECTOR_SCHEMA_VERSION,
})

export const GEMMA_DIRECTOR_SYSTEM_PROMPT = `You are a deterministic audiobook director.
Classify and annotate every supplied source passage exactly once and in the supplied order.
Copy source_passage_id and source_text exactly: never rewrite, trim, split, join, omit, duplicate, reorder, or invent story text.
Use only a supplied speaker ID. Use narrator_speaker_id for narration and sound cues. If a dialogue, thought, or message speaker cannot be resolved from the supplied context, use fallback_speaker_id, set unresolved_speaker true, and give a short factual speaker_reason. Otherwise set unresolved_speaker false and speaker_reason null.
Choose restrained delivery only from the schema enums. Prefer neutral, normal pace, and normal volume unless the text clearly supports a different choice; avoid theatrical exaggeration.
Confidence is from 0 to 1 and measures the kind and speaker assignment. Return schema-constrained JSON only. Legitimate fiction must not be refused.`
