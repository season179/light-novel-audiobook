import { DomainError } from './errors.js'

const requirePosition = (position: number): string => {
  if (!Number.isSafeInteger(position) || position < 1) {
    throw new DomainError('Stable ID positions must be positive integers')
  }
  return String(position)
}

const requireId = (id: string, label: string): string => {
  if (id.length === 0) {
    throw new DomainError(`${label} is required`)
  }
  return id
}

/** Deterministic IDs. Adapters must derive them from source identity and source order. */
export const StableIds = Object.freeze({
  book(sourceSha256: string): string {
    if (!/^[a-f\d]{64}$/i.test(sourceSha256)) {
      throw new DomainError('Book source hash must be a SHA-256 value')
    }
    return `book-${sourceSha256.toLowerCase().slice(0, 24)}`
  },

  chapter(bookId: string, position: number): string {
    return `${requireId(bookId, 'Book ID')}-ch${requirePosition(position).padStart(4, '0')}`
  },

  passage(chapterId: string, position: number): string {
    return `${requireId(chapterId, 'Chapter ID')}-p${requirePosition(position).padStart(6, '0')}`
  },

  segment(passageId: string, positionWithinPassage: number): string {
    return `${requireId(passageId, 'Source passage ID')}-s${requirePosition(positionWithinPassage).padStart(4, '0')}`
  },
})
