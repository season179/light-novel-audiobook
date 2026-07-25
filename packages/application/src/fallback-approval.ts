import { createHash } from 'node:crypto'
import {
  type Book,
  DomainError,
  type FallbackReason,
  type Segment,
} from '@light-novel-audiobook/domain'

/** Bumped only when the hashed decision fields change; every existing approval then restales. */
const APPROVAL_SCHEMA_VERSION = 1

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
}

/** A decision with its derived, content-addressed identity. Persisted exactly as-is. */
export interface PersistedFallbackApproval extends FallbackApprovalDecision {
  readonly approvalId: string
  readonly approvalSha256: string
}

/** One unresolved speaker awaiting a human decision, as the review UI needs to show it. */
export interface PendingFallbackApproval {
  readonly segmentId: string
  readonly chapterId: string
  readonly chapterTitle: string
  readonly speakerId: string | null
  readonly fallbackReason: FallbackReason
  readonly proposedVoiceProfileId: string
  /**
   * Story text. Nobody can approve a voice for a line they cannot read, so the review read model
   * exposes it deliberately — see the #45 report. Never log it and never commit it.
   */
  readonly sourceTextExcerpt: string
  readonly decision: 'approved' | 'pending'
  readonly approvalId: string | null
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
  if (
    decision.decidedAt.length === 0 ||
    Number.isNaN(Date.parse(decision.decidedAt)) ||
    new Date(decision.decidedAt).toISOString() !== decision.decidedAt
  ) {
    throw new DomainError('A fallback approval requires a canonical ISO 8601 decision time')
  }
}
