import { createHash } from 'node:crypto'
import { type Book, DomainError } from '@light-novel-audiobook/domain'
import { hashSourceText } from './fallback-approval.js'
import { normalizeReviewerIdentity } from './reviewer-identity.js'

const SHA256 = /^[a-f\d]{64}$/i
const SCRIPT_IDENTITY_SCHEMA = 'directed-script@1'
const APPROVAL_IDENTITY_SCHEMA = 'direction-approval@1'

/** Lookup key for an approval of one exact persisted script. */
export interface DirectionApprovalQuery {
  readonly jobId: string
  readonly bookId: string
  readonly scriptSha256: string
}

/** Human decision before its content-addressed approval ID is derived. */
export interface DirectionApprovalDecision extends DirectionApprovalQuery {
  readonly decidedBy: string
  readonly decidedAt: string
}

/** Durable evidence that one actor confirmed one exact directed script. */
export interface PersistedDirectionApproval extends DirectionApprovalDecision {
  readonly approvalId: string
}

/**
 * Canonical identity of every field shown for whole-script direction review.
 *
 * Arrays preserve book/chapter order and segment order. Chapter IDs make a chapter reorder visible
 * even when two chapters happen to contain identical segment annotations. Fixed object construction
 * pins JSON key order; no map, locale operation, clock, title, or story text enters the material.
 */
export const createDirectionScriptSha256 = (book: Book): string => {
  book.assertGloballyUniqueSegmentIds()
  const chapters = book.chapters.map((chapter) => {
    if (chapter.segments.length === 0) {
      throw new DomainError(`Chapter ${chapter.id} has no directed segments`)
    }
    return {
      chapterId: chapter.id,
      segments: chapter.segments.map((segment) => {
        const voice = segment.voiceAssignment
        if (voice === null) {
          throw new DomainError(`Directed segment ${segment.id} has no voice assignment`)
        }
        return {
          segmentId: segment.id,
          sourceTextSha256: hashSourceText(segment.sourceText),
          kind: segment.kind,
          speakerId: segment.speakerId,
          confidence: segment.confidence,
          delivery: {
            emotion: segment.delivery.emotion,
            pace: segment.delivery.pace,
            volume: segment.delivery.volume,
            pauseAfterMs: segment.delivery.pauseAfterMs,
          },
          voiceAssignment: {
            voiceProfileId: voice.voiceProfileId,
            usesFallback: voice.usesFallback,
            fallbackReason: voice.fallbackReason,
          },
        }
      }),
    }
  })
  return createHash('sha256')
    .update(JSON.stringify({ schema: SCRIPT_IDENTITY_SCHEMA, chapters }), 'utf8')
    .digest('hex')
}

/** Canonical construction and validation for one whole-script confirmation record. */
export const createDirectionApprovalRecord = (
  decision: DirectionApprovalDecision,
): PersistedDirectionApproval => {
  validateStableId(decision.jobId, 'job')
  validateStableId(decision.bookId, 'book')
  if (!SHA256.test(decision.scriptSha256)) {
    throw new DomainError('A direction approval requires a script SHA-256')
  }
  const decidedBy = normalizeReviewerIdentity(decision.decidedBy)
  if (decidedBy === undefined || decidedBy !== decision.decidedBy) {
    throw new DomainError('A direction approval requires a valid actor without control characters')
  }
  if (
    decision.decidedAt.length === 0 ||
    Number.isNaN(Date.parse(decision.decidedAt)) ||
    new Date(decision.decidedAt).toISOString() !== decision.decidedAt
  ) {
    throw new DomainError('A direction approval requires a canonical ISO 8601 decision time')
  }
  const canonical: DirectionApprovalDecision = {
    jobId: decision.jobId,
    bookId: decision.bookId,
    scriptSha256: decision.scriptSha256.toLowerCase(),
    decidedBy,
    decidedAt: decision.decidedAt,
  }
  const identity = createHash('sha256')
    .update(JSON.stringify({ schema: APPROVAL_IDENTITY_SCHEMA, ...canonical }), 'utf8')
    .digest('hex')
  return Object.freeze({ ...canonical, approvalId: `direction-${identity}` })
}

const validateStableId = (value: string, label: string): void => {
  if (
    value.length === 0 ||
    value.length > 256 ||
    [...value].some((character) => (character.codePointAt(0) ?? 0) < 0x20)
  ) {
    throw new DomainError(`A direction approval requires a valid ${label} ID`)
  }
}
