import { DomainError, InvalidStateTransitionError } from './errors.js'
import type { Segment } from './segment.js'
import { ExactSourceCoverage } from './source-coverage.js'
import type { SourcePassage } from './source-passage.js'

export const CHAPTER_STATES = [
  'draft',
  'needs_review',
  'approved',
  'rendering',
  'rendered',
] as const
export type ChapterState = (typeof CHAPTER_STATES)[number]

const allowedTransitions: Readonly<Record<ChapterState, readonly ChapterState[]>> = {
  draft: ['needs_review'],
  needs_review: ['draft', 'approved'],
  approved: ['draft', 'rendering'],
  rendering: ['approved', 'rendered'],
  rendered: ['draft'],
}

export interface ChapterProps {
  readonly id: string
  readonly bookId: string
  readonly position: number
  readonly title: string
  readonly sourcePassages: readonly SourcePassage[]
}

export class Chapter {
  readonly id: string
  readonly bookId: string
  readonly position: number
  readonly title: string
  readonly sourcePassages: readonly SourcePassage[]
  private currentState: ChapterState = 'draft'
  private directedSegments: readonly Segment[] = Object.freeze([])

  constructor(props: ChapterProps) {
    if (props.id.length === 0 || props.bookId.length === 0 || props.title.length === 0) {
      throw new DomainError('Chapter ID, book ID, and title are required')
    }
    if (!Number.isSafeInteger(props.position) || props.position < 1) {
      throw new DomainError('Chapter position must be a positive integer')
    }
    if (props.sourcePassages.length === 0) {
      throw new DomainError('A chapter requires at least one source passage')
    }
    const passageIds = new Set<string>()
    for (const passage of props.sourcePassages) {
      if (passage.chapterId !== props.id) {
        throw new DomainError(`Source passage ${passage.id} belongs to another chapter`)
      }
      if (passageIds.has(passage.id)) {
        throw new DomainError(`Duplicate source passage ID: ${passage.id}`)
      }
      passageIds.add(passage.id)
    }

    this.id = props.id
    this.bookId = props.bookId
    this.position = props.position
    this.title = props.title
    this.sourcePassages = Object.freeze([...props.sourcePassages])
  }

  get state(): ChapterState {
    return this.currentState
  }

  get segments(): readonly Segment[] {
    return this.directedSegments
  }

  submitForReview(segments: readonly Segment[]): void {
    if (this.currentState !== 'draft') {
      throw new InvalidStateTransitionError('Chapter', this.currentState, 'needs_review')
    }
    ExactSourceCoverage.assertSegments(this, segments)
    const ids = new Set<string>()
    for (const [index, segment] of segments.entries()) {
      if (segment.chapterId !== this.id || segment.order !== index + 1) {
        throw new DomainError('Chapter segments must belong to the chapter in exact order')
      }
      if (ids.has(segment.id)) throw new DomainError(`Duplicate segment ID: ${segment.id}`)
      ids.add(segment.id)
    }
    this.directedSegments = Object.freeze([...segments])
    this.transition('needs_review')
  }

  approve(): void {
    if (this.directedSegments.some((segment) => segment.voiceAssignment === null)) {
      throw new DomainError('Every segment requires a voice before chapter approval')
    }
    this.transition('approved')
  }

  beginRendering(): void {
    this.transition('rendering')
  }

  renderingFailed(): void {
    this.transition('approved')
  }

  markRendered(): void {
    this.transition('rendered')
  }

  reopen(): void {
    this.transition('draft')
    this.directedSegments = Object.freeze([])
  }

  static canTransition(from: ChapterState, to: ChapterState): boolean {
    return allowedTransitions[from].includes(to)
  }

  private transition(to: ChapterState): void {
    if (!Chapter.canTransition(this.currentState, to)) {
      throw new InvalidStateTransitionError('Chapter', this.currentState, to)
    }
    this.currentState = to
  }
}
