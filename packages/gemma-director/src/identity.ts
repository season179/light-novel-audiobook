import { resolve } from 'node:path'
import { z } from 'zod'
import { canonicalSha256 } from './canonical-json.js'
import { type DirectionChunkingSettings, resolveChunkingSettings } from './chunking.js'
import {
  GEMMA_DIRECTOR_PROMPT_VERSION,
  GEMMA_DIRECTOR_SCHEMA_VERSION,
  GEMMA_DIRECTOR_SYSTEM_PROMPT,
  SELECTED_GEMMA_PROFILE,
} from './profile.js'
import { directionWireOutputIdentitySchema } from './schema.js'

export const GEMMA_DIRECTOR_IDENTITY_SCHEMA = 'gemma-director-identity@1'
export const GPU_LEASE_PROTOCOL = 'flock-exclusive-nonblock@1'

export interface GemmaDirectorIdentitySettings {
  readonly baseUrl: string
  readonly confidenceThreshold: number
  readonly gpuLeaseLockFilePath: string
  /**
   * Issue #53 passage-window budgets. Window boundaries can change fragmentation and therefore
   * direction output, so the resolved values are part of the identity. Omitted means defaults.
   */
  readonly chunking?: Partial<DirectionChunkingSettings>
}

/** Application identity material for every stable setting that can affect direction/runtime. */
export function gemmaDirectorIdentityMaterial(settings: GemmaDirectorIdentitySettings) {
  return {
    schema: GEMMA_DIRECTOR_IDENTITY_SCHEMA,
    adapter: {
      id: 'tanstack-ai-openai-compatible',
      package: '@light-novel-audiobook/gemma-director',
      tanstackAiVersion: '0.42.0',
      tanstackOpenAiVersion: '0.17.1',
    },
    model: {
      profileId: SELECTED_GEMMA_PROFILE.id,
      repository: SELECTED_GEMMA_PROFILE.repository,
      revision: SELECTED_GEMMA_PROFILE.revision,
      file: SELECTED_GEMMA_PROFILE.file,
      sizeBytes: SELECTED_GEMMA_PROFILE.sizeBytes,
      sha256: SELECTED_GEMMA_PROFILE.sha256,
    },
    prompt: {
      version: GEMMA_DIRECTOR_PROMPT_VERSION,
      sha256: canonicalSha256(GEMMA_DIRECTOR_SYSTEM_PROMPT),
    },
    outputSchema: {
      version: GEMMA_DIRECTOR_SCHEMA_VERSION,
      sha256: canonicalSha256(z.toJSONSchema(directionWireOutputIdentitySchema)),
    },
    runtime: {
      provider: 'llama.cpp',
      commit: SELECTED_GEMMA_PROFILE.llamaCppCommit,
      baseUrl: settings.baseUrl,
      contextSize: SELECTED_GEMMA_PROFILE.contextSize,
      parallel: 1,
      gpuLayers: SELECTED_GEMMA_PROFILE.gpuLayers,
      cacheTypeK: SELECTED_GEMMA_PROFILE.cacheTypeK,
      cacheTypeV: SELECTED_GEMMA_PROFILE.cacheTypeV,
      flashAttention: true,
      batchSize: SELECTED_GEMMA_PROFILE.batchSize,
      microBatchSize: SELECTED_GEMMA_PROFILE.microBatchSize,
      threads: SELECTED_GEMMA_PROFILE.threads,
      reasoning: SELECTED_GEMMA_PROFILE.reasoning,
      promptCache: false,
      gpuLease: {
        protocol: GPU_LEASE_PROTOCOL,
        lockFilePath: resolve(settings.gpuLeaseLockFilePath),
        owner: 'gemma',
        releaseOrder: 'runtime-exit-before-lease-release',
      },
    },
    generation: {
      seed: SELECTED_GEMMA_PROFILE.seed,
      temperature: SELECTED_GEMMA_PROFILE.temperature,
      topP: SELECTED_GEMMA_PROFILE.topP,
      maxTokens: SELECTED_GEMMA_PROFILE.maxTokens,
      confidenceThreshold: settings.confidenceThreshold,
    },
    chunking: resolveChunkingSettings(settings.chunking),
  } as const
}

export function createGemmaDirectorIdentity(settings: GemmaDirectorIdentitySettings): string {
  return canonicalSha256(gemmaDirectorIdentityMaterial(settings))
}
