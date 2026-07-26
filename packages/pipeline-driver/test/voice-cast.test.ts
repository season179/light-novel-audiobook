import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CastAssignment } from '@light-novel-audiobook/application'
import { Segment } from '@light-novel-audiobook/domain'
import { loadProductionConfig } from '@light-novel-audiobook/qwen-tts'
import { describe, expect, it } from 'vitest'
import { deriveVoiceCast } from '../src/voice-cast.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const loaded = await loadProductionConfig(path.join(ROOT, 'config/qwen3-tts-production.json'))

const assignments = [
  {
    speakerId: 'speaker-amber',
    aliases: ['Amber'],
    materialProfileId: 'ryan-energetic-baseline',
    sharingGroupId: null,
  },
  {
    speakerId: 'speaker-basil',
    aliases: ['Basil'],
    materialProfileId: 'ryan-low-weary',
    sharingGroupId: 'minor-low',
  },
  {
    speakerId: 'speaker-coral',
    aliases: ['Coral'],
    materialProfileId: 'ryan-low-weary',
    sharingGroupId: 'minor-low',
  },
] as const satisfies readonly CastAssignment[]

const segment = (kind: 'dialogue' | 'thought', speakerId: string | null) =>
  new Segment({
    id: 'book-abc-ch0001-p000001-s001',
    chapterId: 'book-abc-ch0001',
    sourcePassageId: 'book-abc-ch0001-p000001',
    order: 1,
    sourceText: 'Synthetic fixture text.',
    kind,
    speakerId,
    confidence: 1,
    delivery: { emotion: 'neutral', pace: 'normal', volume: 'normal', pauseAfterMs: 0 },
  })

describe('approved cast derivation over bounded pinned material', () => {
  it('gives every speaker a distinct profile while making shared material observable', () => {
    const derived = deriveVoiceCast(loaded.value, assignments)

    expect(derived.characterProfileIds).toEqual([
      'character-speaker-amber',
      'character-speaker-basil',
      'character-speaker-coral',
    ])
    expect(derived.cast.profile('character-speaker-basil')).not.toBe(
      derived.cast.profile('character-speaker-coral'),
    )
    expect(derived.cast.profile('character-speaker-basil')).toMatchObject({
      syntheticSpeaker: derived.cast.profile('character-speaker-coral').syntheticSpeaker,
      instruction: derived.cast.profile('character-speaker-coral').instruction,
      seed: derived.cast.profile('character-speaker-coral').seed,
    })
    expect(derived.sharedMaterialGroups).toEqual([
      {
        sharingGroupId: 'minor-low',
        materialProfileId: 'ryan-low-weary',
        speakerCount: 2,
      },
    ])
  })

  it('resolves identified dialogue and thought without either fallback reason', () => {
    const { cast } = deriveVoiceCast(loaded.value, assignments)

    expect(cast.resolve(segment('dialogue', 'speaker-amber')).assignment).toEqual({
      voiceProfileId: 'character-speaker-amber',
      usesFallback: false,
      fallbackReason: null,
    })
    expect(cast.resolve(segment('thought', 'speaker-amber')).assignment).toEqual({
      voiceProfileId: 'character-speaker-amber',
      usesFallback: false,
      fallbackReason: null,
    })
    expect(cast.resolve(segment('thought', null)).assignment.fallbackReason).toBe(
      'unresolved_speaker',
    )
  })

  it('takes the measured 15 character-bearing shapes from 15 fallbacks to zero once identified and cast', () => {
    const empty = deriveVoiceCast(loaded.value).cast
    const approved = deriveVoiceCast(loaded.value, assignments).cast
    const measuredKinds = [
      ...Array.from({ length: 14 }, () => 'dialogue' as const),
      'thought' as const,
    ]

    const before = measuredKinds.filter(
      (kind) => empty.resolve(segment(kind, null)).assignment.usesFallback,
    ).length
    const after = measuredKinds.filter(
      (kind) => approved.resolve(segment(kind, 'speaker-amber')).assignment.usesFallback,
    ).length

    expect(before).toBe(15)
    expect(after).toBe(0)
  })

  it('binds roster aliases and material changes into cast generation identity', () => {
    const baseline = deriveVoiceCast(loaded.value, assignments).cast.generationIdentity
    const renamedAlias = deriveVoiceCast(loaded.value, [
      { ...assignments[0], aliases: ['Captain Amber'] },
      ...assignments.slice(1),
    ]).cast.generationIdentity
    const changedMaterial = deriveVoiceCast(loaded.value, [
      { ...assignments[0], materialProfileId: 'ryan-low-weary', sharingGroupId: 'all-low' },
      { ...assignments[1], sharingGroupId: 'all-low' },
      { ...assignments[2], sharingGroupId: 'all-low' },
    ]).cast.generationIdentity

    expect(renamedAlias).not.toBe(baseline)
    expect(changedMaterial).not.toBe(baseline)
  })

  it('rejects narrator material for a character before direction or rendering', () => {
    expect(() =>
      deriveVoiceCast(loaded.value, [
        {
          ...assignments[0],
          materialProfileId: 'aiden-calm-narrator',
        },
      ]),
    ).toThrow(/not character-capable pinned material/)
  })
})
