import { VoiceCast, VoiceProfile } from '@light-novel-audiobook/domain'

/**
 * The approved M1 cast from docs/PLAN.md: narrator Aiden calm, character Ryan energetic, and a
 * restrained low/weary Ryan as the fallback dialogue voice. Serena is excluded from English casting.
 * Casting is a composition-root decision, never a browser one.
 */
export const createM1VoiceCast = (): VoiceCast =>
  new VoiceCast(
    new VoiceProfile({
      id: 'narrator-aiden-calm',
      displayName: 'Aiden — calm narrator',
      role: 'narrator',
      speakerId: null,
      syntheticSpeaker: 'Aiden',
      instruction: 'Calm, even narration with restrained warmth.',
      seed: 101,
      revision: 1,
    }),
    new VoiceProfile({
      id: 'fallback-ryan-restrained',
      displayName: 'Ryan — restrained fallback',
      role: 'fallback',
      speakerId: null,
      syntheticSpeaker: 'Ryan',
      instruction: 'Low, weary, restrained delivery for unresolved speakers.',
      seed: 103,
      revision: 1,
    }),
    [
      new VoiceProfile({
        id: 'character-alice-ryan-energetic',
        displayName: 'Ryan — energetic (Alice)',
        role: 'character',
        speakerId: 'alice',
        syntheticSpeaker: 'Ryan',
        instruction: 'Energetic, forward delivery with clear consonants.',
        seed: 102,
        revision: 1,
      }),
    ],
  )
