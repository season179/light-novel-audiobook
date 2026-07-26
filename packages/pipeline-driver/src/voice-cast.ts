import { DomainError, VoiceCast, VoiceProfile } from '@light-novel-audiobook/domain'
import type { QwenProductionConfig } from '@light-novel-audiobook/qwen-tts'

/**
 * Builds the domain `VoiceCast` from the **pinned Qwen production config**.
 *
 * This mapping did not exist anywhere before. It has to be derived rather than restated, because the
 * Qwen engine matches an application voice against its pinned catalogue on three fields at once:
 *
 *     profile.speaker     === voice.syntheticSpeaker
 *     profile.instruction === voice.instruction
 *     profile.seedSalt    === voice.seed          // note the name change
 *
 * Any mismatch throws `Application voice does not match an approved pinned Qwen profile` — and it
 * throws at *render* time, after a full chapter of direction has already been paid for. Copying the
 * speaker names, the long instruction strings, and especially `seedSalt` into a literal here would be
 * one transcription slip away from that failure, so nothing is copied: every field is read from the
 * config the engine itself validates against. Issue #25 took the same approach for the web layer.
 */

export interface DerivedCast {
  readonly cast: VoiceCast
  /** Speaker IDs the director may legitimately emit, i.e. the ones this cast can actually render. */
  readonly castSpeakerIds: readonly string[]
  readonly narratorProfileId: string
  readonly fallbackProfileId: string
  readonly characterProfileIds: readonly string[]
}

/** Domain speaker IDs must satisfy `AudiobookJob.validateWarning`'s charset, so keep them simple. */
const SPEAKER_ID_PATTERN = /^[a-z\d](?:[a-z\d._:-]*[a-z\d])?$/i

function requireSpeakerId(speakerId: string): string {
  if (!SPEAKER_ID_PATTERN.test(speakerId)) {
    throw new DomainError(
      `Cast speaker ID ${JSON.stringify(speakerId)} is not accepted by the job warning charset`,
    )
  }
  return speakerId
}

/**
 * @param characterSpeakerIds Speaker IDs to bind, in order, to the pinned character profiles. Only
 *   as many are cast as there are pinned character profiles; a fourth character voice has nothing
 *   approved to render it, so it is refused here rather than mid-batch.
 */
export function deriveVoiceCast(
  production: QwenProductionConfig,
  characterSpeakerIds: readonly string[] = [],
): DerivedCast {
  const pinned = production.voiceProfiles
  const fallbackPinned = pinned.find((profile) => profile.id === production.fallbackVoiceProfileId)
  if (fallbackPinned === undefined) {
    throw new DomainError(
      `Pinned config names fallback profile ${production.fallbackVoiceProfileId}, which it does not define`,
    )
  }
  const narratorPinned = pinned.find((profile) => profile.role === 'narrator')
  if (narratorPinned === undefined) {
    throw new DomainError('Pinned config defines no narrator profile')
  }

  // Whatever is neither the narrator nor the designated fallback is available for characters.
  const characterPinned = pinned.filter(
    (profile) => profile.id !== narratorPinned.id && profile.id !== fallbackPinned.id,
  )
  if (characterSpeakerIds.length > characterPinned.length) {
    throw new DomainError(
      `Cast requests ${characterSpeakerIds.length} character voices but only ${characterPinned.length} pinned profiles are available`,
    )
  }

  const narrator = new VoiceProfile({
    id: narratorPinned.id,
    displayName: `${narratorPinned.speaker} (narrator)`,
    role: 'narrator',
    speakerId: null,
    syntheticSpeaker: narratorPinned.speaker,
    instruction: narratorPinned.instruction,
    seed: narratorPinned.seedSalt,
    revision: 1,
  })
  const fallback = new VoiceProfile({
    id: fallbackPinned.id,
    displayName: `${fallbackPinned.speaker} (fallback)`,
    role: 'fallback',
    speakerId: null,
    syntheticSpeaker: fallbackPinned.speaker,
    instruction: fallbackPinned.instruction,
    seed: fallbackPinned.seedSalt,
    revision: 1,
  })
  const characters = characterSpeakerIds.map((speakerId, index) => {
    const profile = characterPinned[index]
    if (profile === undefined) throw new DomainError('Pinned character profile is missing')
    return new VoiceProfile({
      id: profile.id,
      displayName: `${profile.speaker} (${speakerId})`,
      role: 'character',
      speakerId: requireSpeakerId(speakerId),
      syntheticSpeaker: profile.speaker,
      instruction: profile.instruction,
      seed: profile.seedSalt,
      revision: 1,
    })
  })

  return {
    cast: new VoiceCast(narrator, fallback, characters),
    castSpeakerIds: characters.map((profile) => profile.speakerId as string),
    narratorProfileId: narrator.id,
    fallbackProfileId: fallback.id,
    characterProfileIds: characters.map((profile) => profile.id),
  }
}
