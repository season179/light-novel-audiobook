import { useState } from 'react'
import type { FallbackReviewView } from '../client/audiobook-client.js'

export interface FallbackReviewPanelProps {
  readonly review: FallbackReviewView
  readonly busy: boolean
  readonly onApproveAll: () => void
  readonly onApproveSelected: (segmentIds: readonly string[]) => void
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
 * The user can approve every line at once, one line at a time, or — the 190-of-200 case from issue
 * #96 — tick the exact lines they accept and make one decision over that set. What is selected and
 * what stays blocking is spelled out in words next to the controls, never carried by colour alone.
 * The server rejects the whole set if any line is no longer awaiting a decision, so a stale page
 * can never approve something the user did not just see.
 *
 * The excerpt shown for each line is story text. It is here because nobody can approve a voice for a
 * line they cannot read; it must not be logged or persisted into job state.
 *
 * An empty queue is a good state, not a missing one (issue #96): direction finished and nothing is
 * blocking, so the panel says so and offers the render action instead of vanishing.
 */
export function FallbackReviewPanel({
  review,
  busy,
  onApproveAll,
  onApproveSelected,
  onApprove,
  onRevoke,
  onRender,
}: FallbackReviewPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([])
  if (!review.awaitingReview) return null

  const approved = review.items.filter((item) => item.decision === 'approved')
  const undecided = review.items.length - approved.length
  const pending = review.items.filter((item) => item.decision === 'pending')
  const pendingIds = new Set(pending.map((item) => item.segmentId))
  // The effective selection is what is still on offer: a line decided since it was ticked simply
  // drops out, so the count the user reads always describes the queue as it is now.
  const selected = selectedIds.filter((segmentId) => pendingIds.has(segmentId))
  const remaining = pending.length - selected.length

  if (review.items.length === 0) {
    return (
      <section className="stack bordered" aria-labelledby="review-heading">
        <h3 id="review-heading">Nothing needs your decision</h3>
        <p className="hint">
          Direction finished and every line has a cast voice, so nothing is blocking. Render the
          approved script when you are ready.
        </p>
        <div className="row">
          <button type="button" onClick={onRender} disabled={busy}>
            Render approved script
          </button>
        </div>
      </section>
    )
  }

  const toggle = (segmentId: string): void => {
    setSelectedIds(
      selected.includes(segmentId)
        ? selected.filter((candidate) => candidate !== segmentId)
        : [...selected, segmentId],
    )
  }

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
        <>
          {pending.length === 0 ? null : (
            <fieldset className="selection">
              <legend>Approve selected lines</legend>
              <div className="stack">
                <p className="hint" aria-live="polite">
                  {selected.length === 0
                    ? `${pending.length} ${pending.length === 1 ? 'line is' : 'lines are'} waiting. Tick the ones you accept; each stays blocking until you approve it.`
                    : `${selected.length} of ${pending.length} waiting selected — approving them leaves ${remaining} still blocking.`}
                </p>
                <div className="row">
                  <button
                    type="button"
                    onClick={() => onApproveSelected(selected)}
                    disabled={busy || selected.length === 0}
                  >
                    Approve the {selected.length} selected{' '}
                    {selected.length === 1 ? 'line' : 'lines'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedIds(pending.map((item) => item.segmentId))}
                    disabled={busy || selected.length === pending.length}
                  >
                    Select all {pending.length} waiting
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedIds([])}
                    disabled={busy || selected.length === 0}
                  >
                    Clear selection
                  </button>
                </div>
              </div>
            </fieldset>
          )}
          <ul className="listing">
            {review.items.map((item) => (
              <li key={item.segmentId}>
                {item.decision === 'pending' ? (
                  <label className="review-select">
                    <input
                      type="checkbox"
                      checked={selected.includes(item.segmentId)}
                      onChange={() => toggle(item.segmentId)}
                      disabled={busy}
                    />
                    <span>
                      <strong>{item.chapterTitle}</strong> —{' '}
                      {item.speakerId === null
                        ? 'no speaker could be identified'
                        : `${item.speakerId} has no cast voice`}
                      . {item.speakerReason} “{item.sourceTextExcerpt}” <em>not decided</em>
                    </span>
                  </label>
                ) : (
                  <span>
                    <strong>{item.chapterTitle}</strong> —{' '}
                    {item.speakerId === null
                      ? 'no speaker could be identified'
                      : `${item.speakerId} has no cast voice`}
                    . {item.speakerReason} “{item.sourceTextExcerpt}”{' '}
                    <em>
                      {item.decision === 'approved'
                        ? `approved by ${item.decidedBy ?? 'a reviewer'}`
                        : `withdrawn by ${item.decidedBy ?? 'a reviewer'}`}
                    </em>
                  </span>
                )}
                {item.decision === 'approved' ? (
                  <button type="button" onClick={() => onRevoke(item.segmentId)} disabled={busy}>
                    Withdraw
                  </button>
                ) : (
                  // A withdrawal deliberately outranks every bulk decision, so neither approve-all
                  // nor a selected set re-approves one. Without this control a withdrawn speaker
                  // could never be approved again.
                  <button type="button" onClick={() => onApprove(item.segmentId)} disabled={busy}>
                    Approve this speaker
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
