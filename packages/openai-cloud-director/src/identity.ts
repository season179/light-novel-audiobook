import {
  canonicalSha256,
  type DirectionChunkingSettings,
  directionWireOutputIdentitySchema,
  resolveChunkingSettings,
} from '@light-novel-audiobook/gemma-director'
import { z } from 'zod'
import { OPENAI_CLOUD_DIRECTOR_PROFILE } from './profile.js'

export const OPENAI_CLOUD_DIRECTOR_IDENTITY_SCHEMA = 'openai-cloud-director-identity@1'

export interface OpenAiCloudDirectorIdentitySettings {
  readonly confidenceThreshold: number
  readonly chunking?: Partial<DirectionChunkingSettings>
}

export function openAiCloudDirectorIdentityMaterial(settings: OpenAiCloudDirectorIdentitySettings) {
  return {
    schema: OPENAI_CLOUD_DIRECTOR_IDENTITY_SCHEMA,
    adapter: {
      id: OPENAI_CLOUD_DIRECTOR_PROFILE.adapter,
      package: '@light-novel-audiobook/openai-cloud-director',
      tanstackAiVersion: '0.42.0',
      tanstackOpenAiVersion: '0.17.1',
      api: OPENAI_CLOUD_DIRECTOR_PROFILE.api,
      provider: OPENAI_CLOUD_DIRECTOR_PROFILE.provider,
      baseUrl: OPENAI_CLOUD_DIRECTOR_PROFILE.baseUrl,
      maxRetries: OPENAI_CLOUD_DIRECTOR_PROFILE.maxRetries,
    },
    model: {
      profileId: OPENAI_CLOUD_DIRECTOR_PROFILE.id,
      modelId: OPENAI_CLOUD_DIRECTOR_PROFILE.modelId,
    },
    prompt: {
      version: OPENAI_CLOUD_DIRECTOR_PROFILE.promptVersion,
      sha256: canonicalSha256(OPENAI_CLOUD_DIRECTOR_PROFILE.systemPrompt),
    },
    outputSchema: {
      version: OPENAI_CLOUD_DIRECTOR_PROFILE.schemaVersion,
      sha256: canonicalSha256(z.toJSONSchema(directionWireOutputIdentitySchema)),
      requestSpecific: true,
      strict: true,
    },
    generation: {
      reasoning: OPENAI_CLOUD_DIRECTOR_PROFILE.reasoning,
      reasoningSummary: OPENAI_CLOUD_DIRECTOR_PROFILE.reasoningSummary,
      maxOutputTokens: OPENAI_CLOUD_DIRECTOR_PROFILE.maxOutputTokens,
      store: OPENAI_CLOUD_DIRECTOR_PROFILE.store,
      temperature: 'omitted',
      topP: 'omitted',
      seed: 'omitted',
      confidenceThreshold: settings.confidenceThreshold,
    },
    chunking: resolveChunkingSettings(settings.chunking),
    fidelity: {
      mechanicalSourceEchoRecovery: 'space-for-no-break-space@1',
      deterministicExactSourceValidation: true,
      rerequests: 0,
    },
  } as const
}

export function createOpenAiCloudDirectorIdentity(
  settings: OpenAiCloudDirectorIdentitySettings,
): string {
  return canonicalSha256(openAiCloudDirectorIdentityMaterial(settings))
}
