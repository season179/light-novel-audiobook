import { useState } from 'react'
import type { FallbackReviewView } from '../client/audiobook-client.js'

export interface FallbackReviewPanelProps {
  readonly review: FallbackReviewView
  readonly busy: boolean
  readonly onApproveAll: () => void
  readonly onApprove: (segmentId: string) => void
  readonly onRevoke: (segmentId: string) => void
  readonly onRender: () => void
}

/**
 * The review step for a job that stopped because its script contains unresolved speakers.
 *
 * PLAN.md:129 makes this choice one a human has to make — it cannot be inferred — and PLAN.md:166
 * allows the fallback voice only on an explicit approval. So the page stops here, once, for the whole
 * book: a 2,328-passage light novel must not ask per line, but nothing renders until the user says so.
 *
 * The excerpt shown for each line is story text. It is here because nobody can approve a voice for a
 * line they cannot read; it must not be logged or persisted into job state.
 */
export function FallbackReviewPanel({
  review,
  busy,
  onApproveAll,
  onApprove,
  onRevoke,
  onRender,
}: FallbackReviewPanelProps) {
  const [expanded, setExpanded] = useState(false)
  if (!review.awaitingReview || review.items.length === 0) return null

  const approved = review.items.filter((item) => item.decision === 'approved')
  const undecided = review.items.length - approved.length

  return (
    <section className="stack bordered" aria-labelledby="review-heading">
      <h3 id="review-heading">Unresolved speakers need your decision ({review.items.length})</h3>
      <p className="hint">
        {undecided === 0
          ? 'Every unresolved speaker has a decision. Render the approved script to continue.'
          : `${undecided} of ${review.items.length} lines have no cast voice. Approving uses the fallback dialogue voice for them; nothing is rendered until you decide.`}
      </p>
      {review.grantedBy === null ? null : (
        <p className="hint">Approved for this whole book by {review.grantedBy}.</p>
      )}

      <div className="row">
        <button type="button" onClick={onApproveAll} disabled={busy || undecided === 0}>
          Use the fallback voice for all {review.items.length} unresolved speakers
        </button>
        <button type="button" onClick={onRender} disabled={busy || undecided > 0}>
          Render approved script
        </button>
        <button type="button" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Hide the lines' : 'Show the lines'}
        </button>
      </div>

      {!expanded ? null : (
        <ul className="listing">
          {review.items.map((item) => (
            <li key={item.segmentId}>
              <span>
                <strong>{item.chapterTitle}</strong> —{' '}
                {item.speakerId === null
                  ? 'no speaker could be identified'
                  : `${item.speakerId} has no cast voice`}
                . {item.speakerReason} “{item.sourceTextExcerpt}”{' '}
                <em>
                  {item.decision === 'approved'
                    ? `approved by ${item.decidedBy ?? 'a reviewer'}`
                    : item.decision === 'excluded'
                      ? `withdrawn by ${item.decidedBy ?? 'a reviewer'}`
                      : 'not decided'}
                </em>
              </span>
              {item.decision === 'approved' ? (
                <button type="button" onClick={() => onRevoke(item.segmentId)} disabled={busy}>
                  Withdraw
                </button>
              ) : (
                // A withdrawal deliberately outranks the book-wide grant, so approving all cannot
                // undo one. Without this control a withdrawn speaker could never be approved again.
                <button type="button" onClick={() => onApprove(item.segmentId)} disabled={busy}>
                  Approve this speaker
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
