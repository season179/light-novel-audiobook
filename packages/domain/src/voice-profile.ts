import { DomainError } from './errors.js'
import type { FallbackReason, Segment, VoiceAssignment } from './segment.js'

export type VoiceRole = 'narrator' | 'character' | 'fallback'

export interface VoiceProfileProps {
  readonly id: string
  readonly displayName: string
  readonly role: VoiceRole
  readonly speakerId: string | null
  /** Canonical names the director may use to identify this character. Never positional metadata. */
  readonly speakerAliases?: readonly string[] | undefined
  /** Adapter-facing built-in synthetic speaker name, not a provider model ID. */
  readonly syntheticSpeaker: string
  readonly instruction: string
  readonly seed: number
  /** Increment when an approved profile is intentionally changed. */
  readonly revision: number
}

export class VoiceProfile {
  readonly id: string
  readonly displayName: string
  readonly role: VoiceRole
  readonly speakerId: string | null
  readonly speakerAliases: readonly string[]
  readonly syntheticSpeaker: string
  readonly instruction: string
  readonly seed: number
  readonly revision: number

  constructor(props: VoiceProfileProps) {
    if (
      props.id.length === 0 ||
      props.displayName.length === 0 ||
      props.syntheticSpeaker.length === 0 ||
      props.instruction.length === 0
    ) {
      throw new DomainError('Voice profile ID, name, speaker, and instruction are required')
    }
    if (
      !Number.isSafeInteger(props.seed) ||
      !Number.isSafeInteger(props.revision) ||
      props.revision < 1
    ) {
      throw new DomainError('Voice seed must be an integer and revision must be a positive integer')
    }
    if (props.role === 'character' && (props.speakerId === null || props.speakerId.length === 0)) {
      throw new DomainError('Character voices require a speaker ID')
    }
    if (props.role !== 'character' && props.speakerId !== null) {
      throw new DomainError('Narrator and fallback voices cannot name a character speaker')
    }
    const aliases = props.speakerAliases ?? []
    if (props.role !== 'character' && aliases.length > 0) {
      throw new DomainError('Narrator and fallback voices cannot carry character aliases')
    }
    const normalizedAliases = aliases.map((alias) => alias.trim())
    if (
      normalizedAliases.some((alias) => alias.length === 0 || alias.length > 256) ||
      new Set(normalizedAliases).size !== normalizedAliases.length
    ) {
      throw new DomainError('Character voice aliases must be non-empty, bounded, and unique')
    }

    this.id = props.id
    this.displayName = props.displayName
    this.role = props.role
    this.speakerId = props.speakerId
    this.speakerAliases = Object.freeze(normalizedAliases)
    this.syntheticSpeaker = props.syntheticSpeaker
    this.instruction = props.instruction
    this.seed = props.seed
    this.revision = props.revision
    Object.freeze(this)
  }

  /** Stable material used with engine identity and segment content to decide audio reuse. */
  get renderIdentity(): string {
    return JSON.stringify([
      this.id,
      this.revision,
      this.syntheticSpeaker,
      this.instruction,
      this.seed,
    ])
  }
}

export interface ResolvedVoice {
  readonly profile: VoiceProfile
  readonly assignment: VoiceAssignment
}

/** Approved cast. A speaker always resolves to one profile; unresolved speakers use one fallback. */
export class VoiceCast {
  readonly narrator: VoiceProfile
  readonly fallback: VoiceProfile
  private readonly profilesBySpeaker: ReadonlyMap<string, VoiceProfile>
  private readonly profilesById: ReadonlyMap<string, VoiceProfile>

  constructor(
    narrator: VoiceProfile,
    fallback: VoiceProfile,
    characterVoices: readonly VoiceProfile[],
  ) {
    if (narrator.role !== 'narrator' || fallback.role !== 'fallback') {
      throw new DomainError('A cast requires narrator and fallback role profiles')
    }

    const bySpeaker = new Map<string, VoiceProfile>()
    const byId = new Map<string, VoiceProfile>([
      [narrator.id, narrator],
      [fallback.id, fallback],
    ])
    if (narrator.id === fallback.id) {
      throw new DomainError('Voice profile IDs must be unique')
    }

    for (const profile of characterVoices) {
      if (profile.role !== 'character' || profile.speakerId === null) {
        throw new DomainError('Cast character voices must use the character role')
      }
      if (bySpeaker.has(profile.speakerId)) {
        throw new DomainError(`Speaker ${profile.speakerId} has more than one voice`)
      }
      if (byId.has(profile.id)) {
        throw new DomainError(`Duplicate voice profile ID: ${profile.id}`)
      }
      bySpeaker.set(profile.speakerId, profile)
      byId.set(profile.id, profile)
    }

    this.narrator = narrator
    this.fallback = fallback
    this.profilesBySpeaker = bySpeaker
    this.profilesById = byId
    Object.freeze(this)
  }

  resolve(segment: Segment): ResolvedVoice {
    // Sound cues are narrator-owned like narration; they never name a character speaker.
    if (segment.kind === 'narration' || segment.kind === 'sound_cue') {
      return this.resolved(this.narrator, null)
    }
    if (segment.speakerId === null) {
      return this.resolved(this.fallback, 'unresolved_speaker')
    }
    const character = this.profilesBySpeaker.get(segment.speakerId)
    if (character === undefined) {
      return this.resolved(this.fallback, 'missing_speaker_voice')
    }
    return this.resolved(character, null)
  }

  profile(profileId: string): VoiceProfile {
    const profile = this.profilesById.get(profileId)
    if (profile === undefined) throw new DomainError(`Unknown voice profile: ${profileId}`)
    return profile
  }

  /** Deterministic identity for every approved voice that can affect this generation. */
  get generationIdentity(): string {
    const characters = [...this.profilesBySpeaker.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([speakerId, profile]) => [
        speakerId,
        profile.renderIdentity,
        [...profile.speakerAliases].sort(),
      ])
    return JSON.stringify({
      narrator: this.narrator.renderIdentity,
      fallback: this.fallback.renderIdentity,
      characters,
    })
  }

  private resolved(profile: VoiceProfile, reason: FallbackReason | null): ResolvedVoice {
    return {
      profile,
      assignment: Object.freeze({
        voiceProfileId: profile.id,
        usesFallback: reason !== null,
        fallbackReason: reason,
      }),
    }
  }
}
