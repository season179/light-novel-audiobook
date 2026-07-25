import type { FallbackHistory } from './schemas.js'

export interface BenchmarkProfile {
  readonly id: string
  readonly order: number
  readonly modelId: string
  readonly repository: string
  readonly revision: string
  readonly file: string
  readonly modelSha256: string
  readonly contextSize: 32768
  readonly gpuLayers: number
  readonly cacheTypeK: 'q8_0'
  readonly cacheTypeV: 'q8_0'
  readonly flashAttention: true
  readonly reasoning: 'off'
  readonly batchSize: 2048
  readonly microBatchSize: 512
  readonly threads: 16
  readonly seed: 42
  readonly temperature: 0
  readonly topP: 1
  readonly maxTokens: 8192
}

const runtimeDefaults = {
  contextSize: 32768,
  gpuLayers: 35,
  cacheTypeK: 'q8_0',
  cacheTypeV: 'q8_0',
  flashAttention: true,
  reasoning: 'off',
  batchSize: 2048,
  microBatchSize: 512,
  threads: 16,
  seed: 42,
  temperature: 0,
  topP: 1,
  maxTokens: 8192,
} as const

export const BENCHMARK_PROFILES: readonly BenchmarkProfile[] = Object.freeze([
  {
    ...runtimeDefaults,
    id: 'google-gemma-4-26b-a4b-it-qat-q4-0',
    order: 0,
    modelId: 'google/gemma-4-26B-A4B-it-qat-q4_0-gguf',
    repository: 'google/gemma-4-26B-A4B-it-qat-q4_0-gguf',
    revision: 'd1c082be9cf3c8a514acf63b8761f4b41935842e',
    file: 'gemma-4-26B_q4_0-it.gguf',
    modelSha256: '3eca3b8f6d7baf218a7dd6bba5fb59a56ee25fe2d567b6f5f589b4f697eca51d',
  },
  {
    ...runtimeDefaults,
    id: 'hauhaucs-gemma-4-26b-a4b-balanced-mtp',
    order: 1,
    modelId: 'HauhauCS/Gemma4-26B-A4B-QAT-Uncensored-HauhauCS-Balanced-MTP',
    repository: 'HauhauCS/Gemma4-26B-A4B-QAT-Uncensored-HauhauCS-Balanced-MTP',
    revision: 'not-pinned-until-authorized',
    file: 'not-downloaded',
    modelSha256: '0'.repeat(64),
  },
  {
    ...runtimeDefaults,
    gpuLayers: 999,
    id: 'hauhaucs-gemma-4-12b-balanced',
    order: 2,
    modelId: 'HauhauCS/Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced',
    repository: 'HauhauCS/Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced',
    revision: 'not-pinned-until-authorized',
    file: 'not-downloaded',
    modelSha256: '0'.repeat(64),
  },
  {
    ...runtimeDefaults,
    gpuLayers: 999,
    id: 'google-gemma-4-12b-it-qat-q4-0',
    order: 3,
    modelId: 'google/gemma-4-12B-it-qat-q4_0-gguf',
    repository: 'google/gemma-4-12B-it-qat-q4_0-gguf',
    revision: 'not-pinned-until-authorized',
    file: 'not-downloaded',
    modelSha256: '0'.repeat(64),
  },
])

export function profileById(profileId: string): BenchmarkProfile {
  const profile = BENCHMARK_PROFILES.find((candidate) => candidate.id === profileId)
  if (!profile) throw new Error('Unknown benchmark profile')
  return profile
}

export function enforceFallbackOrder(
  profile: BenchmarkProfile,
  history: FallbackHistory | undefined,
): void {
  if (profile.order === 0) {
    if (history && history.attempts.length > 0) throw new Error('Primary profile takes no history')
    return
  }
  if (!history || history.attempts.length !== profile.order) {
    throw new Error('Every preceding fallback attempt is required')
  }
  for (let index = 0; index < profile.order; index += 1) {
    const expected = BENCHMARK_PROFILES[index]
    const attempt = history.attempts[index]
    if (!expected || !attempt || attempt.profile_id !== expected.id || attempt.overall_passed) {
      throw new Error('Fallback history is not in the locked order')
    }
  }
  if (profile.order === 1 && history.attempts[0]?.reason !== 'mature_content_refusal') {
    throw new Error('The first fallback is reserved for mature-content obstruction')
  }
}
