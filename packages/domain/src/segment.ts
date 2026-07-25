import { DomainError } from './errors.js'

export const SEGMENT_KINDS = ['narration', 'dialogue', 'thought', 'message', 'sound_cue'] as const

export type SegmentKind = (typeof SEGMENT_KINDS)[number]

export interface DeliveryDirection {
  readonly emotion: string
  readonly pace: 'slow' | 'normal' | 'fast'
  readonly volume: 'soft' | 'normal' | 'loud'
  readonly pauseAfterMs: number
}

/** Annotation returned by a director. sourceText must remain an exact source fragment. */
export interface DirectedSegment {
  readonly sourcePassageId: string
  readonly sourceText: string
  readonly kind: SegmentKind
  readonly speakerId: string | null
  readonly confidence: number
  readonly delivery: DeliveryDirection
}

export type FallbackReason = 'unresolved_speaker' | 'missing_speaker_voice'

export interface VoiceAssignment {
  readonly voiceProfileId: string
  readonly usesFallback: boolean
  readonly fallbackReason: FallbackReason | null
}

export interface SegmentProps extends DirectedSegment {
  readonly id: string
  readonly chapterId: string
  readonly order: number
}

export class Segment {
  readonly id: string
  readonly chapterId: string
  readonly sourcePassageId: string
  readonly order: number
  readonly sourceText: string
  readonly kind: SegmentKind
  readonly speakerId: string | null
  readonly confidence: number
  readonly delivery: DeliveryDirection
  private assignment: VoiceAssignment | null = null

  constructor(props: SegmentProps) {
    if (
      props.id.length === 0 ||
      props.chapterId.length === 0 ||
      props.sourcePassageId.length === 0
    ) {
      throw new DomainError('Segment, chapter, and source passage IDs are required')
    }
    if (!Number.isSafeInteger(props.order) || props.order < 1) {
      throw new DomainError('Segment order must be a positive integer')
    }
    if (props.sourceText.length === 0) {
      throw new DomainError('Segment source text is required')
    }
    if (!SEGMENT_KINDS.includes(props.kind)) {
      throw new DomainError(`Unsupported segment kind: ${props.kind}`)
    }
    if (props.speakerId !== null && props.speakerId.length === 0) {
      throw new DomainError('Speaker ID cannot be empty')
    }
    if (!Number.isFinite(props.confidence) || props.confidence < 0 || props.confidence > 1) {
      throw new DomainError('Segment confidence must be between zero and one')
    }
    if (props.delivery.emotion.length === 0) {
      throw new DomainError('Delivery emotion is required')
    }
    if (!['slow', 'normal', 'fast'].includes(props.delivery.pace)) {
      throw new DomainError('Delivery pace is invalid')
    }
    if (!['soft', 'normal', 'loud'].includes(props.delivery.volume)) {
      throw new DomainError('Delivery volume is invalid')
    }
    if (
      !Number.isSafeInteger(props.delivery.pauseAfterMs) ||
      props.delivery.pauseAfterMs < 0 ||
      props.delivery.pauseAfterMs > 10_000
    ) {
      throw new DomainError('Pause must be an integer from zero through 10000 milliseconds')
    }

    this.id = props.id
    this.chapterId = props.chapterId
    this.sourcePassageId = props.sourcePassageId
    this.order = props.order
    this.sourceText = props.sourceText
    this.kind = props.kind
    this.speakerId = props.speakerId
    this.confidence = props.confidence
    this.delivery = Object.freeze({ ...props.delivery })
  }

  get voiceAssignment(): VoiceAssignment | null {
    return this.assignment
  }

  assignVoice(assignment: VoiceAssignment): void {
    if (assignment.voiceProfileId.length === 0) {
      throw new DomainError('Voice profile ID is required')
    }
    if (assignment.usesFallback !== (assignment.fallbackReason !== null)) {
      throw new DomainError('Fallback voice assignments require exactly one fallback reason')
    }
    if (this.assignment !== null) {
      const unchanged =
        this.assignment.voiceProfileId === assignment.voiceProfileId &&
        this.assignment.usesFallback === assignment.usesFallback &&
        this.assignment.fallbackReason === assignment.fallbackReason
      if (unchanged) return
      throw new DomainError(`Segment ${this.id} already has a stable voice assignment`)
    }
    this.assignment = Object.freeze({ ...assignment })
  }
}
