import { existsSync } from 'node:fs'
import { join, parse, resolve } from 'node:path'
import { VoiceCast, VoiceProfile } from '@light-novel-audiobook/domain'
import {
  type LoadedProductionConfig,
  loadProductionConfig,
  type VoiceProfile as PinnedQwenProfile,
  SELECTED_VOICE_PROFILE_IDS,
  type SelectedVoiceProfileId,
} from '@light-novel-audiobook/qwen-tts'
import { WebApiError } from './errors.js'

/**
 * The M1 cast, **derived from the pinned Qwen production configuration** rather than restated here.
 *
 * `QwenTtsSpeechEngine.selectedVoiceProfile()` resolves an application voice by exact equality of
 * `syntheticSpeaker`, `instruction` and `seed` against that config. Three literals copied into this
 * file drifted from it and would have failed the first real render on every segment, so the values
 * are now read from the config and copied into the domain profiles by construction. There is nothing
 * left to keep in sync.
 *
 * docs/PLAN.md §7 and the pinned config agree on the roles: `aiden-calm-narrator` is the narrator,
 * `ryan-energetic-baseline` is the character voice, and `ryan-low-weary` is pinned
 * `character-or-fallback`, which is exactly how it is used here. Serena is absent from the pinned set.
 */
export const QWEN_PRODUCTION_CONFIG_ENV_VAR = 'AUDIOBOOK_QWEN_PRODUCTION_CONFIG'

const REPOSITORY_CONFIG_PATH = join('config', 'qwen3-tts-production.json')

/** The only fields the real engine matches on. Anything else is presentation. */
export interface PinnedVoiceMaterial {
  readonly syntheticSpeaker: string
  readonly instruction: string
  readonly seed: number
}

interface CastRole {
  readonly id: string
  readonly displayName: string
  readonly role: 'narrator' | 'character' | 'fallback'
  readonly speakerId: string | null
  readonly pinnedId: SelectedVoiceProfileId
}

/**
 * Which pinned profile plays which part. The IDs and speaker binding are this app's decision; every
 * value that reaches the engine comes from the config entry named here.
 */
const M1_CAST_ROLES: readonly CastRole[] = [
  {
    id: 'narrator-aiden-calm',
    displayName: 'Aiden — calm narrator',
    role: 'narrator',
    speakerId: null,
    pinnedId: 'aiden-calm-narrator',
  },
  {
    id: 'character-alice-ryan-energetic',
    displayName: 'Ryan — energetic (Alice)',
    role: 'character',
    speakerId: 'alice',
    pinnedId: 'ryan-energetic-baseline',
  },
  {
    id: 'fallback-ryan-restrained',
    displayName: 'Ryan — restrained fallback',
    role: 'fallback',
    speakerId: null,
    pinnedId: 'ryan-low-weary',
  },
]

const findRepositoryRoot = (from: string): string | undefined => {
  let current = resolve(from)
  for (;;) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current
    const parent = parse(current).dir
    if (parent === current) return undefined
    current = parent
  }
}

export const resolvePinnedQwenConfigPath = (configPath?: string | undefined): string => {
  const configured = configPath ?? process.env[QWEN_PRODUCTION_CONFIG_ENV_VAR]
  if (configured !== undefined && configured.trim().length > 0) return resolve(configured)
  const repositoryRoot = findRepositoryRoot(process.cwd())
  if (repositoryRoot === undefined) {
    throw new WebApiError(
      'internal',
      `Set ${QWEN_PRODUCTION_CONFIG_ENV_VAR} to the pinned Qwen production configuration`,
    )
  }
  return join(repositoryRoot, REPOSITORY_CONFIG_PATH)
}

export const loadPinnedQwenConfig = async (
  configPath?: string | undefined,
): Promise<LoadedProductionConfig> => loadProductionConfig(resolvePinnedQwenConfigPath(configPath))

const requirePinned = (
  loaded: LoadedProductionConfig,
  pinnedId: SelectedVoiceProfileId,
): PinnedQwenProfile => {
  const profile = loaded.profiles.get(pinnedId)
  if (profile === undefined) {
    throw new WebApiError(
      'internal',
      `The pinned Qwen configuration has no approved profile named ${pinnedId}`,
    )
  }
  return profile
}

const toDomainProfile = (role: CastRole, pinned: PinnedQwenProfile): VoiceProfile =>
  new VoiceProfile({
    id: role.id,
    displayName: role.displayName,
    role: role.role,
    speakerId: role.speakerId,
    // The three fields the engine matches on, copied straight from the pinned entry.
    syntheticSpeaker: pinned.speaker,
    instruction: pinned.instruction,
    seed: pinned.seedSalt,
    revision: 1,
  })

/** Casting is a composition-root decision, never a browser one. */
export const createM1VoiceCast = (loaded: LoadedProductionConfig): VoiceCast => {
  const profiles = M1_CAST_ROLES.map((role) =>
    toDomainProfile(role, requirePinned(loaded, role.pinnedId)),
  )
  const narrator = profiles.find((profile) => profile.role === 'narrator')
  const fallback = profiles.find((profile) => profile.role === 'fallback')
  const characters = profiles.filter((profile) => profile.role === 'character')
  if (narrator === undefined || fallback === undefined) {
    throw new WebApiError('internal', 'The M1 cast requires a narrator and a fallback profile')
  }
  return new VoiceCast(narrator, fallback, characters)
}

/** Every approved profile the real engine would accept, for the fake engine to check against. */
export const pinnedVoiceMaterial = (
  loaded: LoadedProductionConfig,
): readonly PinnedVoiceMaterial[] =>
  SELECTED_VOICE_PROFILE_IDS.map((pinnedId) => {
    const profile = requirePinned(loaded, pinnedId)
    return {
      syntheticSpeaker: profile.speaker,
      instruction: profile.instruction,
      seed: profile.seedSalt,
    }
  })
