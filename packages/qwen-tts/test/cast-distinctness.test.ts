import { describe, expect, it } from 'vitest'
import {
  assertApprovedSpeakersPresent,
  assertDistinctProfileMaterial,
  type ProfileMaterial,
} from '../src/cast-distinctness.js'
import { loadProductionConfig } from '../src/config.js'
import { APPROVED_SPEAKERS } from '../src/types.js'

const PRODUCTION_CONFIG = new URL('../../../config/qwen3-tts-production.json', import.meta.url)

const material = (
  id: string,
  speaker: string,
  instruction = 'read it',
  seedSalt = 1,
): ProfileMaterial => ({ id, speaker, instruction, seedSalt })

describe('assertDistinctProfileMaterial', () => {
  it('rejects two IDs that resolve to the same voice', () => {
    expect(() =>
      assertDistinctProfileMaterial([material('first', 'Ryan'), material('second', 'Ryan')]),
    ).toThrow(/first and second are the same voice/)
  })

  it('accepts one speaker under two instructions, which is the shipped Ryan pair', () => {
    expect(() =>
      assertDistinctProfileMaterial([
        material('ryan-energetic-baseline', 'Ryan', 'energetic'),
        material('ryan-low-weary', 'Ryan', 'weary'),
      ]),
    ).not.toThrow()
  })

  it('accepts one speaker and instruction under two seed salts', () => {
    expect(() =>
      assertDistinctProfileMaterial([
        material('a', 'Ryan', 'same', 1),
        material('b', 'Ryan', 'same', 2),
      ]),
    ).not.toThrow()
  })

  it('treats speaker casing as insignificant, because the model does', () => {
    // `Ryan` and `ryan` are one voice to the model, so two profiles spelling it differently would
    // advertise two voices and render one.
    expect(() =>
      assertDistinctProfileMaterial([material('upper', 'Ryan'), material('lower', 'ryan')]),
    ).toThrow(/same voice/)
  })
})

describe('assertApprovedSpeakersPresent', () => {
  it('rejects an approved speaker no profile can reach', () => {
    expect(() =>
      assertApprovedSpeakersPresent([material('only', 'Ryan')], ['Ryan', 'serena']),
    ).toThrow(/no voice profile uses approved speaker\(s\) serena/)
  })

  it('names every unreachable speaker, not just the first', () => {
    expect(() =>
      assertApprovedSpeakersPresent([material('only', 'Ryan')], ['Ryan', 'serena', 'vivian']),
    ).toThrow(/serena, vivian/)
  })

  it('accepts a roster every approved speaker appears in', () => {
    expect(() =>
      assertApprovedSpeakersPresent(
        [material('a', 'Ryan'), material('b', 'serena')],
        ['ryan', 'Serena'],
      ),
    ).not.toThrow()
  })
})

/**
 * The guards are wired into `validateConfig`, so the shipped config has to satisfy them. This is the
 * part that would catch a real drift: a typo'd speaker ID or a duplicated voice reaches the model on a
 * real book, after the GPU has already loaded 3.4 GB of weights.
 */
describe('the shipped production config satisfies both guards', () => {
  it('loads, which means both guards passed inside validateConfig', async () => {
    const loaded = await loadProductionConfig(PRODUCTION_CONFIG.pathname)
    expect(loaded.profiles.size).toBe(10)
    expect(
      new Set([...loaded.profiles.values()].map((profile) => profile.speaker.toLowerCase())),
    ).toHaveProperty('size', 9)
  })

  it('selects exactly the seven speakers the MPS MVP listening decision approves', async () => {
    const loaded = await loadProductionConfig(PRODUCTION_CONFIG.pathname)
    const speakers = [...loaded.selectedProfiles.values()].map((profile) =>
      profile.speaker.toLowerCase(),
    )
    expect([...new Set(speakers)].sort()).toEqual(
      [...APPROVED_SPEAKERS].map((speaker) => speaker.toLowerCase()).sort(),
    )
  })
})
