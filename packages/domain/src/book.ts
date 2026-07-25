import type { Chapter } from './chapter.js'
import { DomainError } from './errors.js'

export interface BookSource {
  readonly epubPath: string
  readonly sha256: string
}

export interface BookProps {
  readonly id: string
  readonly title: string
  readonly author: string | null
  readonly coverPath: string | null
  readonly source: BookSource
  readonly chapters: readonly Chapter[]
}

export class Book {
  readonly id: string
  readonly title: string
  readonly author: string | null
  readonly coverPath: string | null
  readonly source: BookSource
  readonly chapters: readonly Chapter[]

  constructor(props: BookProps) {
    if (props.id.length === 0 || props.title.length === 0 || props.source.epubPath.length === 0) {
      throw new DomainError('Book ID, title, and EPUB path are required')
    }
    if (!/^[a-f\d]{64}$/i.test(props.source.sha256)) {
      throw new DomainError('Book source hash must be a SHA-256 value')
    }
    if (props.chapters.length === 0) throw new DomainError('A book requires at least one chapter')

    const chapterIds = new Set<string>()
    const passageIds = new Set<string>()
    for (const [index, chapter] of props.chapters.entries()) {
      if (chapter.bookId !== props.id || chapter.position !== index + 1) {
        throw new DomainError('Book chapters must belong to the book in exact spine order')
      }
      if (chapterIds.has(chapter.id)) throw new DomainError(`Duplicate chapter ID: ${chapter.id}`)
      chapterIds.add(chapter.id)
      for (const passage of chapter.sourcePassages) {
        if (passageIds.has(passage.id)) {
          throw new DomainError(`Duplicate source passage ID across book: ${passage.id}`)
        }
        passageIds.add(passage.id)
      }
    }

    this.id = props.id
    this.title = props.title
    this.author = props.author
    this.coverPath = props.coverPath
    this.source = Object.freeze({ ...props.source, sha256: props.source.sha256.toLowerCase() })
    this.chapters = Object.freeze([...props.chapters])
  }

  assertGloballyUniqueSegmentIds(): void {
    const segmentIds = new Set<string>()
    for (const chapter of this.chapters) {
      for (const segment of chapter.segments) {
        if (segmentIds.has(segment.id)) {
          throw new DomainError(`Duplicate segment ID across book: ${segment.id}`)
        }
        segmentIds.add(segment.id)
      }
    }
  }
}
