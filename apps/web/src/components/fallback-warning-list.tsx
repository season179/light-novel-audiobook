import type { JobWarningView } from '../server/job-state-view.js'

export interface FallbackWarningListProps {
  readonly warnings: readonly JobWarningView[]
}

/** Fallback-speaker warnings in plain language, so the user knows what needs a listen. */
export function FallbackWarningList({ warnings }: FallbackWarningListProps) {
  if (warnings.length === 0) return null
  return (
    <section className="stack bordered" aria-labelledby="warnings-heading">
      <h3 id="warnings-heading">Fallback voice warnings ({warnings.length})</h3>
      <p className="hint">
        These lines were rendered with the fallback dialogue voice because their speaker was not
        resolved to a cast voice.
      </p>
      <ul className="listing">
        {warnings.map((warning) => (
          <li key={warning.segmentId}>
            <span>
              <strong>{warning.chapterLabel}</strong> — {warning.message}
              {warning.speakerId === null ? '' : ` Speaker: ${warning.speakerId}.`} Voice used:{' '}
              {warning.voiceProfileId}.
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
