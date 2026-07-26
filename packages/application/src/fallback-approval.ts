import { createHash } from 'node:crypto'
import {
  type Book,
  DomainError,
  type FallbackReason,
  type Segment,
  type SegmentKind,
} from '@light-novel-audiobook/domain'
import { normalizeReviewerIdentity } from './reviewer-identity.js'

/** Bumped only when the hashed decision fields change; every existing approval then restales. */
const APPROVAL_SCHEMA_VERSION = 2
const BOOK_GRANT_SCHEMA_VERSION = 3

/** The identity shape `QwenTtsSpeechEngine` validates before it will render a fallback segment. */
const APPROVAL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/
const SHA256 = /^[0-9a-f]{64}$/
const FALLBACK_REASONS: readonly FallbackReason[] = ['unresolved_speaker', 'missing_speaker_voice']

/** Longest review excerpt. Enough to identify a line, never a redistributable extract. */
export const FALLBACK_EXCERPT_MAX_LENGTH = 160

/**
 * One human decision authorizing the fallback voice for one segment, before its identity is
 * derived. PLAN.md:129 and :166 make this decision mandatory and per unresolved speaker; a single
 * book-wide approval is not acceptable, because approving speaker A must never voice speaker B.
 */
export interface FallbackApprovalDecision {
  readonly bookId: string
  readonly segmentId: string
  readonly speakerId: string | null
  readonly fallbackReason: FallbackReason
  /** The fallback profile the human authorized. The adapter refuses to render any other. */
  readonly voiceProfileId: string
  /**
   * Digest of the exact line the human read. PLAN.md:132 requires a later upstream change to
   * invalidate approval, and this is what detects it: re-direction that rewrites this segment's
   * text leaves an approval that no longer describes what would be spoken.
   */
  readonly sourceTextSha256: string
  /**
   * ISO 8601 instant of the decision, and part of its identity. That is deliberate: reconciliation
   * preserves an unchanged decision verbatim, so an unchanged book never restales, while a
   * revocation followed by a fresh approval is a genuinely different decision and re-renders.
   */
  readonly decidedAt: string
  /**
   * Who decided. Required, and part of the identity: a record with no actor is not evidence of a
   * human decision, and issue #45's round-2 review found that renaming an auto-approval policy and
   * persisting its products does not make the choice human. Nothing in this package can mint an
   * approval without naming an actor.
   */
  readonly decidedBy: string
  /**
   * The book-wide grant this segment's approval was derived from, or `null` when the human decided
   * this one segment individually. Provenance only — it is deliberately not compared by
   * `approvalStillDescribes`, so re-granting a book does not restale decisions already recorded.
   */
  readonly grantId: string | null
}

/** A decision with its derived, content-addressed identity. Persisted exactly as-is. */
export interface PersistedFallbackApproval extends FallbackApprovalDecision {
  readonly approvalId: string
  readonly approvalSha256: string
}

/** One exact fallback subject included in the human's announced book-grant scope. */
export interface BookFallbackGrantSubject {
  readonly segmentId: string
  readonly speakerId: string | null
  readonly fallbackReason: FallbackReason
  readonly voiceProfileId: string
  readonly sourceTextSha256: string
}

/**
 * One human decision authorizing the fallback voice for a listed set of subjects in one book.
 *
 * This is the M1 answer to a large review queue that must not stop for a click per line, and it is a
 * durable, actor-attributed act of its own. The exact subject set is part of its identity, so later
 * reconciliation cannot extend the human's decision to a segment or decision tuple they never saw.
 */
export interface BookFallbackGrant {
  readonly bookId: string
  readonly decidedBy: string
  readonly decidedAt: string
  readonly subjects: readonly BookFallbackGrantSubject[]
  readonly grantId: string
  readonly grantSha256: string
}

/**
 * One segment the human explicitly refused to authorize.
 *
 * Recorded rather than merely deleted, because a book-wide grant would otherwise re-create the
 * approval on the next reconciliation and silently undo the revocation. An exclusion outranks any
 * grant and survives until the segment is approved again.
 */
export interface FallbackApprovalExclusion {
  readonly bookId: string
  readonly segmentId: string
  readonly decidedBy: string
  readonly decidedAt: string
}

/**
 * Why a recorded decision is being removed.
 *
 * A discriminated union rather than a reason string plus an actor parameter, so the two cases cannot
 * be confused: a human withdrawal **cannot** be recorded without naming who withdrew it, and a system
 * invalidation has nowhere to put an invented actor. Round 2 passed a literal `'reconciliation'` as
 * the actor for the system case, which is exactly the kind of manufactured attribution issue #45
 * exists to prevent.
 */
export type FallbackRevocation =
  | {
      readonly reason: 'human-withdrawal'
      readonly decidedBy: string
      readonly decidedAt: string
    }
  | { readonly reason: 'no-longer-describes-segment' }

/**
 * One atomically consistent read of everything the review context knows about a book.
 *
 * `revision` increments on every mutation and is read in the **same** transaction as the records,
 * so a render can claim a catalog and later prove nothing moved under it. Reading the records and
 * the revision separately would leave exactly the race this exists to close.
 */
export interface FallbackApprovalCatalog {
  readonly revision: number
  readonly approvals: readonly PersistedFallbackApproval[]
  readonly exclusions: readonly FallbackApprovalExclusion[]
  readonly grant: BookFallbackGrant | undefined
}

export const createBookFallbackGrant = (input: {
  readonly bookId: string
  readonly decidedBy: string
  readonly decidedAt: string
  readonly subjects: readonly BookFallbackGrantSubject[]
}): BookFallbackGrant => {
  if (input.bookId.length === 0) throw new DomainError('A fallback grant requires a book')
  validateActor(input.decidedBy)
  validateDecidedAt(input.decidedAt)
  if (input.subjects.length === 0) {
    throw new DomainError('A fallback grant requires at least one reviewed subject')
  }
  const subjects = input.subjects.map((subject) => canonicalGrantSubject(input.bookId, subject))
  subjects.sort((left, right) => (left.segmentId < right.segmentId ? -1 : 1))
  if (new Set(subjects.map((subject) => subject.segmentId)).size !== subjects.length) {
    throw new DomainError('A fallback grant cannot contain the same segment twice')
  }
  const grantSha256 = createHash('sha256')
    .update(
      JSON.stringify({
        schema: `book-fallback-grant@${BOOK_GRANT_SCHEMA_VERSION}`,
        bookId: input.bookId,
        decidedBy: input.decidedBy,
        decidedAt: input.decidedAt,
        subjects,
      }),
      'utf8',
    )
    .digest('hex')
  return Object.freeze({
    bookId: input.bookId,
    decidedBy: input.decidedBy,
    decidedAt: input.decidedAt,
    subjects: Object.freeze(subjects),
    grantId: `grant-${grantSha256.slice(0, 16)}`,
    grantSha256,
  })
}

/** One unresolved speaker awaiting a human decision, as the review UI needs to show it. */
export interface PendingFallbackApproval {
  readonly segmentId: string
  readonly sourcePassageId: string
  readonly kind: SegmentKind
  readonly chapterId: string
  readonly chapterTitle: string
  readonly speakerId: string | null
  readonly fallbackReason: FallbackReason
  /** Why the director/cast could not assign a normal character voice. */
  readonly speakerReason: string
  readonly proposedVoiceProfileId: string
  /**
   * Story text. Nobody can approve a voice for a line they cannot read, so the review read model
   * exposes it deliberately — see the #45 report. Never log it and never commit it.
   */
  readonly sourceTextExcerpt: string
  /**
   * `pending` — nobody has decided. `approved` — a live decision authorizes the fallback voice.
   * `excluded` — the human explicitly withdrew it, which no book-wide grant may override.
   */
  readonly decision: 'approved' | 'pending' | 'excluded'
  readonly approvalId: string | null
  readonly decidedBy: string | null
}

/** One segment of an approved script whose voice assignment fell back to the fallback profile. */
export interface FallbackApprovalSubject {
  readonly segment: Segment
  readonly chapterId: string
  readonly chapterTitle: string
  readonly speakerId: string | null
  readonly fallbackReason: FallbackReason
  readonly voiceProfileId: string
  readonly sourceTextSha256: string
}

export const hashSourceText = (sourceText: string): string =>
  createHash('sha256').update(sourceText, 'utf8').digest('hex')

/**
 * Derives the persisted identity of one decision. Content-addressed, so the same decision always
 * produces the same `approvalId`/`approvalSha256` and the same reusable audio.
 */
export const createFallbackApprovalRecord = (
  decision: FallbackApprovalDecision,
): PersistedFallbackApproval => {
  validateDecision(decision)
  const approvalSha256 = createHash('sha256')
    .update(
      JSON.stringify({
        schema: APPROVAL_SCHEMA_VERSION,
        bookId: decision.bookId,
        segmentId: decision.segmentId,
        speakerId: decision.speakerId,
        fallbackReason: decision.fallbackReason,
        voiceProfileId: decision.voiceProfileId,
        sourceTextSha256: decision.sourceTextSha256.toLowerCase(),
        decidedAt: decision.decidedAt,
        decidedBy: decision.decidedBy,
        grantId: decision.grantId,
      }),
      'utf8',
    )
    .digest('hex')
  const approvalId = `fallback-${decision.segmentId}-${approvalSha256.slice(0, 8)}`
  // Checked here rather than at render time. The engine validates this pattern per segment, and a
  // segment ID that cannot produce a legal approval ID would otherwise surface hours into a run.
  if (!APPROVAL_ID.test(approvalId)) {
    throw new DomainError(`Segment ${decision.segmentId} cannot carry a fallback approval identity`)
  }
  return Object.freeze({
    ...decision,
    sourceTextSha256: decision.sourceTextSha256.toLowerCase(),
    approvalId,
    approvalSha256,
  })
}

/**
 * Every fallback segment in an approved script, in book order. Derived from the script rather than
 * from `job.warnings` on purpose: the script is what the speech engine's gate reads, so anything
 * derived from a projection could disagree with what actually has to be approved.
 */
export const collectFallbackSubjects = (book: Book): readonly FallbackApprovalSubject[] => {
  const subjects: FallbackApprovalSubject[] = []
  for (const chapter of book.chapters) {
    for (const segment of chapter.segments) {
      const assignment = segment.voiceAssignment
      if (assignment === null || !assignment.usesFallback) continue
      if (assignment.fallbackReason === null) {
        throw new DomainError(`Fallback segment ${segment.id} has no fallback reason`)
      }
      subjects.push(
        Object.freeze({
          segment,
          chapterId: chapter.id,
          chapterTitle: chapter.title,
          speakerId: segment.speakerId,
          fallbackReason: assignment.fallbackReason,
          voiceProfileId: assignment.voiceProfileId,
          sourceTextSha256: hashSourceText(segment.sourceText),
        }),
      )
    }
  }
  return Object.freeze(subjects)
}

/**
 * Whether a persisted decision still describes this segment. Every field the human's decision was
 * about is compared, so a re-directed speaker, a changed line, or a different fallback profile all
 * count as the decision no longer standing.
 */
export const approvalStillDescribes = (
  approval: PersistedFallbackApproval,
  subject: FallbackApprovalSubject,
): boolean =>
  approval.segmentId === subject.segment.id &&
  approval.speakerId === subject.speakerId &&
  approval.fallbackReason === subject.fallbackReason &&
  approval.voiceProfileId === subject.voiceProfileId &&
  approval.sourceTextSha256 === subject.sourceTextSha256

/** First `FALLBACK_EXCERPT_MAX_LENGTH` characters of a line, with collapsed whitespace. */
export const fallbackApprovalExcerpt = (sourceText: string): string => {
  const collapsed = sourceText.replace(/\s+/gu, ' ').trim()
  if (collapsed.length <= FALLBACK_EXCERPT_MAX_LENGTH) return collapsed
  return `${collapsed.slice(0, FALLBACK_EXCERPT_MAX_LENGTH - 1)}…`
}

function canonicalGrantSubject(
  bookId: string,
  subject: BookFallbackGrantSubject,
): BookFallbackGrantSubject {
  if (subject.segmentId.length === 0 || !subject.segmentId.startsWith(`${bookId}-`)) {
    throw new DomainError('A fallback grant subject must belong to its book')
  }
  if (subject.speakerId !== null && subject.speakerId.length === 0) {
    throw new DomainError('A fallback grant speaker cannot be empty')
  }
  if (!FALLBACK_REASONS.includes(subject.fallbackReason)) {
    throw new DomainError(`Unsupported fallback reason: ${subject.fallbackReason}`)
  }
  if ((subject.fallbackReason === 'unresolved_speaker') !== (subject.speakerId === null)) {
    throw new DomainError('A fallback grant subject pairs its reason with the wrong speaker')
  }
  if (subject.voiceProfileId.length === 0 || !SHA256.test(subject.sourceTextSha256)) {
    throw new DomainError('A fallback grant subject requires a voice and source digest')
  }
  return Object.freeze({
    segmentId: subject.segmentId,
    speakerId: subject.speakerId,
    fallbackReason: subject.fallbackReason,
    voiceProfileId: subject.voiceProfileId,
    sourceTextSha256: subject.sourceTextSha256.toLowerCase(),
  })
}

function validateDecision(decision: FallbackApprovalDecision): void {
  if (decision.bookId.length === 0 || decision.segmentId.length === 0) {
    throw new DomainError('A fallback approval requires a book and segment')
  }
  if (!decision.segmentId.startsWith(`${decision.bookId}-`)) {
    throw new DomainError(
      `Fallback approval segment ${decision.segmentId} does not belong to book ${decision.bookId}`,
    )
  }
  if (decision.speakerId !== null && decision.speakerId.length === 0) {
    throw new DomainError('A fallback approval speaker cannot be empty')
  }
  if (!FALLBACK_REASONS.includes(decision.fallbackReason)) {
    throw new DomainError(`Unsupported fallback reason: ${decision.fallbackReason}`)
  }
  // The two reasons are not interchangeable: `unresolved_speaker` means the director named nobody,
  // `missing_speaker_voice` means it named someone the cast has no voice for. The engine matches on
  // both, so a mismatched pair here would be rejected at render time instead.
  if ((decision.fallbackReason === 'unresolved_speaker') !== (decision.speakerId === null)) {
    throw new DomainError(
      `Fallback approval for ${decision.segmentId} pairs ${decision.fallbackReason} with the wrong speaker`,
    )
  }
  if (decision.voiceProfileId.length === 0) {
    throw new DomainError('A fallback approval requires the approved voice profile')
  }
  if (!SHA256.test(decision.sourceTextSha256)) {
    throw new DomainError('A fallback approval requires the approved line digest')
  }
  validateDecidedAt(decision.decidedAt)
  validateActor(decision.decidedBy)
  if (decision.grantId !== null && decision.grantId.length === 0) {
    throw new DomainError('A fallback approval grant reference cannot be empty')
  }
}

function validateActor(decidedBy: string): void {
  const normalized = normalizeReviewerIdentity(decidedBy)
  if (normalized === undefined || normalized !== decidedBy) {
    throw new DomainError('A fallback decision requires a valid actor without control characters')
  }
}

function validateDecidedAt(decidedAt: string): void {
  if (
    decidedAt.length === 0 ||
    Number.isNaN(Date.parse(decidedAt)) ||
    new Date(decidedAt).toISOString() !== decidedAt
  ) {
    throw new DomainError('A fallback decision requires a canonical ISO 8601 decision time')
  }
}
