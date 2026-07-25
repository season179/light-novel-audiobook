import { join } from 'node:path'
import { SELECTED_VOICE_PROFILE_IDS } from '@light-novel-audiobook/qwen-tts'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createM1VoiceCast,
  loadPinnedQwenConfig,
  pinnedVoiceMaterial,
  QWEN_PRODUCTION_CONFIG_ENV_VAR,
  resolvePinnedQwenConfigPath,
} from '../src/server/m1-voice-cast.js'

/**
 * The real engine resolves an application voice by exact equality of `syntheticSpeaker`,
 * `instruction` and `seed` against the pinned production configuration
 * (`QwenTtsSpeechEngine.selectedVoiceProfile()`). Copied literals drifted from it once and would have
 * failed the first real render on every segment, so this loads the actual config — no model, no GPU —
 * and fails if any cast profile stops resolving.
 */
const loaded = await loadPinnedQwenConfig()

/** The same match the real engine performs. */
const resolvesAgainstPinnedConfig = (voice: {
  syntheticSpeaker: string
  instruction: string
  seed: number
}): boolean =>
  [...loaded.profiles.values()].some(
    (pinned) =>
      pinned.speaker === voice.syntheticSpeaker &&
      pinned.instruction === voice.instruction &&
      pinned.seedSalt === voice.seed,
  )

describe('the M1 cast resolves against the pinned Qwen configuration', () => {
  const cast = createM1VoiceCast(loaded)
  const profiles = [cast.narrator, cast.fallback, cast.profile('character-alice-ryan-energetic')]

  it('reads three approved profiles out of the config', () => {
    expect(loaded.profiles.size).toBe(3)
    expect([...loaded.profiles.keys()].sort()).toEqual([...SELECTED_VOICE_PROFILE_IDS].sort())
  })

  it.each(profiles.map((profile) => [profile.id, profile] as const))(
    'resolves %s exactly as the real engine would',
    (_id, profile) => {
      expect(resolvesAgainstPinnedConfig(profile)).toBe(true)
    },
  )

  it('takes speaker, instruction and seed from the pinned entries, not from literals', () => {
    const narratorPinned = loaded.profiles.get('aiden-calm-narrator')
    const characterPinned = loaded.profiles.get('ryan-energetic-baseline')
    const fallbackPinned = loaded.profiles.get('ryan-low-weary')
    expect(narratorPinned).toBeDefined()
    expect(characterPinned).toBeDefined()
    expect(fallbackPinned).toBeDefined()
    if (
      narratorPinned === undefined ||
      characterPinned === undefined ||
      fallbackPinned === undefined
    ) {
      return
    }

    expect(cast.narrator).toMatchObject({
      syntheticSpeaker: narratorPinned.speaker,
      instruction: narratorPinned.instruction,
      seed: narratorPinned.seedSalt,
    })
    expect(cast.profile('character-alice-ryan-energetic')).toMatchObject({
      syntheticSpeaker: characterPinned.speaker,
      instruction: characterPinned.instruction,
      seed: characterPinned.seedSalt,
    })
    expect(cast.fallback).toMatchObject({
      syntheticSpeaker: fallbackPinned.speaker,
      instruction: fallbackPinned.instruction,
      seed: fallbackPinned.seedSalt,
    })
  })

  /**
   * docs/PLAN.md §7: Aiden calm narrator, Ryan energetic for the character, restrained low/weary Ryan
   * as the fallback dialogue voice, Serena excluded. The pinned roles agree — `ryan-low-weary` is
   * pinned `character-or-fallback`, which sanctions its use here.
   */
  it('keeps the PLAN roles the pinned config sanctions', () => {
    expect(loaded.profiles.get('aiden-calm-narrator')?.role).toBe('narrator')
    expect(loaded.profiles.get('ryan-energetic-baseline')?.role).toBe('character')
    expect(loaded.profiles.get('ryan-low-weary')?.role).toBe('character-or-fallback')
    expect([...loaded.profiles.values()].map((profile) => profile.speaker).sort()).toEqual([
      'Aiden',
      'Ryan',
      'Ryan',
    ])
    expect(cast.narrator.role).toBe('narrator')
    expect(cast.fallback.role).toBe('fallback')
    expect(cast.profile('character-alice-ryan-energetic').speakerId).toBe('alice')
  })

  it('exposes exactly the approved material the fake engine checks against', () => {
    const material = pinnedVoiceMaterial(loaded)
    expect(material).toHaveLength(3)
    for (const entry of material) {
      expect(resolvesAgainstPinnedConfig(entry)).toBe(true)
    }
    for (const profile of profiles) {
      expect(
        material.some(
          (entry) =>
            entry.syntheticSpeaker === profile.syntheticSpeaker &&
            entry.instruction === profile.instruction &&
            entry.seed === profile.seed,
        ),
      ).toBe(true)
    }
  })
})

/**
 * The dev server runs with `apps/web` as its working directory, while the pinned config lives at the
 * repository root — so path resolution has to walk up, and that is the one part of this the test suite
 * would otherwise never exercise (tests run from the repository root).
 */
describe('the pinned configuration is found from wherever the app runs', () => {
  const originalCwd = process.cwd()

  afterEach(() => {
    process.chdir(originalCwd)
    delete process.env[QWEN_PRODUCTION_CONFIG_ENV_VAR]
  })

  it('resolves from the app directory the dev server uses', async () => {
    process.chdir(join(originalCwd, 'apps', 'web'))

    const resolved = resolvePinnedQwenConfigPath()
    expect(resolved).toBe(join(originalCwd, 'config', 'qwen3-tts-production.json'))
    await expect(loadPinnedQwenConfig()).resolves.toMatchObject({ sha256: expect.any(String) })
  })

  it('prefers an explicit override, so a deployment need not sit in the repository', () => {
    process.env[QWEN_PRODUCTION_CONFIG_ENV_VAR] = '/somewhere/else/pinned.json'
    expect(resolvePinnedQwenConfigPath()).toBe('/somewhere/else/pinned.json')
    expect(resolvePinnedQwenConfigPath('/explicit/argument.json')).toBe('/explicit/argument.json')
  })

  it('reports a missing configuration as a clear failure rather than a crash', async () => {
    await expect(loadPinnedQwenConfig('/nonexistent/pinned.json')).rejects.toThrow(
      /Cannot read Qwen production configuration/,
    )
  })
})
