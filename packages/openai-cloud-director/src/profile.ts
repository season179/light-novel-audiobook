import {
  GEMMA_DIRECTOR_PROMPT_VERSION,
  GEMMA_DIRECTOR_SCHEMA_VERSION,
  GEMMA_DIRECTOR_SYSTEM_PROMPT,
} from '@light-novel-audiobook/gemma-director'

export const OPENAI_CLOUD_DIRECTOR_PROFILE = Object.freeze({
  id: 'openai-gpt-5.6-luna-low',
  provider: 'openai',
  adapter: 'tanstack-ai-openai-compatible-responses',
  modelId: 'gpt-5.6-luna',
  api: 'responses',
  baseUrl: 'https://api.openai.com/v1',
  reasoning: Object.freeze({ effort: 'low' as const }),
  reasoningSummary: false,
  maxOutputTokens: 8_192,
  store: false,
  maxRetries: 0,
  promptVersion: GEMMA_DIRECTOR_PROMPT_VERSION,
  schemaVersion: GEMMA_DIRECTOR_SCHEMA_VERSION,
  systemPrompt: GEMMA_DIRECTOR_SYSTEM_PROMPT,
} as const)

export interface OpenAiCloudModelIdentity {
  readonly adapter: typeof OPENAI_CLOUD_DIRECTOR_PROFILE.adapter
  readonly provider: typeof OPENAI_CLOUD_DIRECTOR_PROFILE.provider
  readonly profileId: typeof OPENAI_CLOUD_DIRECTOR_PROFILE.id
  readonly modelId: typeof OPENAI_CLOUD_DIRECTOR_PROFILE.modelId
  readonly reasoningEffort: typeof OPENAI_CLOUD_DIRECTOR_PROFILE.reasoning.effort
  readonly reasoningSummary: false
  readonly maxOutputTokens: number
  readonly store: false
  readonly promptVersion: string
  readonly schemaVersion: string
}

export const OPENAI_CLOUD_MODEL_IDENTITY: OpenAiCloudModelIdentity = Object.freeze({
  adapter: OPENAI_CLOUD_DIRECTOR_PROFILE.adapter,
  provider: OPENAI_CLOUD_DIRECTOR_PROFILE.provider,
  profileId: OPENAI_CLOUD_DIRECTOR_PROFILE.id,
  modelId: OPENAI_CLOUD_DIRECTOR_PROFILE.modelId,
  reasoningEffort: OPENAI_CLOUD_DIRECTOR_PROFILE.reasoning.effort,
  reasoningSummary: OPENAI_CLOUD_DIRECTOR_PROFILE.reasoningSummary,
  maxOutputTokens: OPENAI_CLOUD_DIRECTOR_PROFILE.maxOutputTokens,
  store: OPENAI_CLOUD_DIRECTOR_PROFILE.store,
  promptVersion: OPENAI_CLOUD_DIRECTOR_PROFILE.promptVersion,
  schemaVersion: OPENAI_CLOUD_DIRECTOR_PROFILE.schemaVersion,
})
