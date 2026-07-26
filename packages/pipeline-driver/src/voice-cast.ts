import type { CastAssignment } from '@light-novel-audiobook/application'
import { DomainError, VoiceCast, VoiceProfile } from '@light-novel-audiobook/domain'
import type { QwenProductionConfig } from '@light-novel-audiobook/qwen-tts'

/**
 * Builds a domain cast from one human-approved assignment and the pinned Qwen inventory.
 *
 * A character profile has its own domain ID/speaker ID while its material is copied from an admitted
 * production profile. Multiple character profiles may deliberately reuse material, but that fact was
 * made explicit by `CastAssignment.sharingGroupId` before approval. Exact material fields are never
 * restated here: Qwen accepts them only by exact speaker/instruction/seed equality.
 */
export interface DerivedCast {
  readonly cast: VoiceCast
  readonly castSpeakers: readonly { readonly id: string; readonly aliases: readonly string[] }[]
  readonly narratorProfileId: string
  readonly fallbackProfileId: string
  readonly characterProfileIds: readonly string[]
  readonly sharedMaterialGroups: readonly {
    readonly sharingGroupId: string
    readonly materialProfileId: string
    readonly speakerCount: number
  }[]
}

/** Domain speaker IDs must satisfy `AudiobookJob.validateWarning`'s charset. */
const SPEAKER_ID_PATTERN = /^[a-z\d](?:[a-z\d._:-]*[a-z\d])?$/i

const requireSpeakerId = (speakerId: string): string => {
  if (!SPEAKER_ID_PATTERN.test(speakerId)) {
    throw new DomainError(
      `Cast speaker ID ${JSON.stringify(speakerId)} is not accepted by the job warning charset`,
    )
  }
  return speakerId
}

export function deriveVoiceCast(
  production: QwenProductionConfig,
  assignments: readonly CastAssignment[] = [],
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

  const characters = assignments.map((assignment) => {
    const material = pinned.find((profile) => profile.id === assignment.materialProfileId)
    if (material === undefined || material.role === 'narrator') {
      throw new DomainError(
        `Cast material ${assignment.materialProfileId} is not character-capable pinned material`,
      )
    }
    return new VoiceProfile({
      id: `character-${requireSpeakerId(assignment.speakerId)}`,
      displayName: `${material.speaker} (${assignment.speakerId})`,
      role: 'character',
      speakerId: assignment.speakerId,
      speakerAliases: assignment.aliases,
      syntheticSpeaker: material.speaker,
      instruction: material.instruction,
      seed: material.seedSalt,
      revision: 1,
    })
  })

  const sharing = new Map<
    string,
    { sharingGroupId: string; materialProfileId: string; speakerCount: number }
  >()
  for (const assignment of assignments) {
    if (assignment.sharingGroupId === null) continue
    const current = sharing.get(assignment.sharingGroupId)
    if (current === undefined) {
      sharing.set(assignment.sharingGroupId, {
        sharingGroupId: assignment.sharingGroupId,
        materialProfileId: assignment.materialProfileId,
        speakerCount: 1,
      })
    } else {
      if (current.materialProfileId !== assignment.materialProfileId) {
        throw new DomainError(
          `Cast sharing group ${assignment.sharingGroupId} names more than one voice material`,
        )
      }
      current.speakerCount += 1
    }
  }

  return {
    cast: new VoiceCast(narrator, fallback, characters),
    castSpeakers: Object.freeze(
      characters.map((profile) => ({
        id: profile.speakerId as string,
        aliases: profile.speakerAliases,
      })),
    ),
    narratorProfileId: narrator.id,
    fallbackProfileId: fallback.id,
    characterProfileIds: characters.map((profile) => profile.id),
    sharedMaterialGroups: Object.freeze(
      [...sharing.values()]
        .filter((group) => group.speakerCount > 1)
        .sort((left, right) => left.sharingGroupId.localeCompare(right.sharingGroupId))
        .map((group) => Object.freeze(group)),
    ),
  }
}
