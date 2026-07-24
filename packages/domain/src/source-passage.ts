export interface SourcePassageProps {
  readonly id: string
  readonly chapterId: string
  readonly sourceText: string
}

/** Immutable source-book text. Derived speech text must live in a separate object. */
export class SourcePassage {
  readonly id: string
  readonly chapterId: string
  readonly sourceText: string

  constructor(props: SourcePassageProps) {
    if (props.id.length === 0) {
      throw new Error('Source passage ID is required')
    }
    if (props.chapterId.length === 0) {
      throw new Error('Chapter ID is required')
    }
    if (props.sourceText.length === 0) {
      throw new Error('Source text is required')
    }

    this.id = props.id
    this.chapterId = props.chapterId
    this.sourceText = props.sourceText
    Object.freeze(this)
  }
}

export interface SpeechTransformation {
  readonly kind: 'punctuation' | 'abbreviation' | 'number' | 'pronunciation'
  readonly sourceStart: number
  readonly sourceEnd: number
  readonly replacement: string
}

/** Speech-friendly text linked to, but never replacing, its immutable source passage. */
export class RenderPassage {
  readonly source: SourcePassage
  readonly renderText: string
  readonly transformations: readonly SpeechTransformation[]

  constructor(
    source: SourcePassage,
    renderText: string,
    transformations: readonly SpeechTransformation[],
  ) {
    if (renderText.length === 0) {
      throw new Error('Render text is required')
    }

    this.source = source
    this.renderText = renderText
    this.transformations = Object.freeze([...transformations])
    Object.freeze(this)
  }
}
