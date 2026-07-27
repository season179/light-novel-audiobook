import { useQuery } from '@tanstack/react-query'
import { useId, useState } from 'react'
import type { AudiobookClient } from '../client/audiobook-client.js'
import type {
  ScriptChapterSummaryView,
  ScriptChapterView,
  ScriptSegmentView,
} from '../server/script-review-view.js'
import { SCRIPT_SEGMENT_FLAG_LABELS } from '../server/script-segment-flags.js'

export interface ScriptReviewPanelProps {
  readonly client: AudiobookClient
  readonly jobId: string
}

const KIND_LABELS: Readonly<Record<ScriptSegmentView['kind'], string>> = {
  narration: 'Narration',
  dialogue: 'Dialogue',
  thought: 'Thought',
  message: 'Message',
  sound_cue: 'Sound cue',
}

const speakerText = (segment: ScriptSegmentView): string => {
  if (segment.kind === 'narration') return 'no speaker (narration)'
  if (segment.speakerId === null) return 'speaker not identified'
  return `spoken by ${segment.speakerId}`
}

const voiceText = (segment: ScriptSegmentView): string => {
  if (segment.voiceProfileId === null) return 'no voice assigned yet'
  return segment.usesFallback
    ? `${segment.voiceProfileId} (fallback voice)`
    : segment.voiceProfileId
}

const deliveryText = (segment: ScriptSegmentView): string =>
  `${segment.delivery.emotion} · ${segment.delivery.pace} pace · ${segment.delivery.volume} volume · ${segment.delivery.pauseAfterMs} ms pause`

/** One directed line, exactly as it will be spoken, with everything the reviewer needs to judge it. */
const ScriptLine = ({ segment }: { readonly segment: ScriptSegmentView }) => (
  <li className="script-line" data-flagged={segment.flags.length > 0 ? true : undefined}>
    <p className="script-text">{segment.sourceText}</p>
    <p className="script-meta">
      {KIND_LABELS[segment.kind]} — {speakerText(segment)} · Voice: {voiceText(segment)} ·
      Confidence {Math.round(segment.confidence * 100)}% · {deliveryText(segment)}
    </p>
    {segment.speakerReason === null ? null : (
      <p className="script-meta">Director note: {segment.speakerReason}</p>
    )}
    {segment.flags.length === 0 ? null : (
      <p className="script-flags">
        Flagged:{' '}
        {segment.flags.map((flag) => (
          <strong key={flag} data-flag={flag}>
            {SCRIPT_SEGMENT_FLAG_LABELS[flag]}
          </strong>
        ))}
      </p>
    )}
  </li>
)

interface ScriptChapterSectionProps {
  readonly client: AudiobookClient
  readonly jobId: string
  readonly summary: ScriptChapterSummaryView
  readonly totalChapters: number
  readonly flaggedOnly: boolean
}

/**
 * One collapsed-by-default chapter. The segments are fetched only when the reader opens the
 * chapter — a full book runs to hundreds of segments per chapter, so the whole book is never one
 * request and never one screen.
 */
const ScriptChapterSection = ({
  client,
  jobId,
  summary,
  totalChapters,
  flaggedOnly,
}: ScriptChapterSectionProps) => {
  const panelId = useId()
  const [expanded, setExpanded] = useState(false)
  const chapterQuery = useQuery({
    queryKey: ['script-chapter', jobId, summary.chapterId],
    queryFn: () => client.getScriptChapter({ jobId, chapterId: summary.chapterId }),
    enabled: expanded,
    refetchOnMount: 'always',
  })

  const chapter: ScriptChapterView | null =
    chapterQuery.data?.ok === true ? chapterQuery.data.value : null
  const visible = (chapter?.segments ?? []).filter(
    (segment) => !flaggedOnly || segment.flags.length > 0,
  )

  return (
    <li className="script-chapter">
      <h4>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setExpanded(!expanded)}
        >
          Chapter {summary.position} of {totalChapters} — {summary.title}
        </button>
      </h4>
      <p className="hint">
        {summary.segmentCount} {summary.segmentCount === 1 ? 'segment' : 'segments'}
        {summary.flaggedCount === 0
          ? ' · none flagged'
          : ` · ${summary.flaggedCount} flagged — worth a look`}
      </p>
      {!expanded ? null : (
        <div id={panelId} className="script-chapter-body">
          {chapterQuery.isPending ? (
            <p className="hint">Reading this chapter…</p>
          ) : chapter === null ? (
            <p className="error" role="alert">
              {chapterQuery.data?.ok === false
                ? chapterQuery.data.error.message
                : 'This chapter could not be read from the local server.'}
            </p>
          ) : visible.length === 0 ? (
            <p className="hint">No flagged lines in this chapter.</p>
          ) : (
            <ol
              className="script-lines"
              aria-label={`Directed script for chapter ${summary.position}`}
            >
              {visible.map((segment) => (
                <ScriptLine key={segment.segmentId} segment={segment} />
              ))}
            </ol>
          )}
        </div>
      )}
    </li>
  )
}

/**
 * The read-only whole-script review (#96 step 6): the exact directed script the render gate hashes,
 * shown so the user can read what they are confirming. There is deliberately nothing to click that
 * changes the script — review decisions stay in the fallback panel; this surface only reads.
 *
 * The text here IS the book. It is on screen because nobody can approve a voice for a line they
 * cannot read; it must never be logged or written into job state.
 *
 * Nothing in this panel is a live region: job polling keeps re-rendering around it, and a screen
 * reader must never have the book re-announced at it.
 */
export function ScriptReviewPanel({ client, jobId }: ScriptReviewPanelProps) {
  const regionId = useId()
  const [open, setOpen] = useState(false)
  const [flaggedOnly, setFlaggedOnly] = useState(false)
  // Fetched only once the reader opens the panel — never as part of the 700 ms job-state poll.
  const listQuery = useQuery({
    queryKey: ['script-chapters', jobId],
    queryFn: () => client.listScriptChapters({ jobId }),
    enabled: open,
    refetchOnMount: 'always',
  })

  const list = listQuery.data?.ok === true ? listQuery.data.value : null

  return (
    <section className="stack bordered" aria-labelledby="script-review-heading">
      <h3 id="script-review-heading">Read the directed script</h3>
      <p className="hint">
        The exact script you are being asked to confirm, read back from what is saved. Nothing here
        changes it — this view only reads.
      </p>
      <div className="row">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={regionId}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Hide the script' : 'Show the script'}
        </button>
      </div>
      {!open ? null : (
        <div id={regionId}>
          {listQuery.isPending ? (
            <p className="hint">Reading the saved script…</p>
          ) : list === null ? (
            <p className="error" role="alert">
              {listQuery.data?.ok === false
                ? listQuery.data.error.message
                : 'The script could not be read from the local server.'}
            </p>
          ) : list.chapters.length === 0 ? (
            <p className="hint">No directed script yet — direction has not finished.</p>
          ) : (
            <div className="stack">
              <p className="hint">
                {list.chapterCount} {list.chapterCount === 1 ? 'chapter' : 'chapters'} ·{' '}
                {list.totalSegments} {list.totalSegments === 1 ? 'segment' : 'segments'} ·{' '}
                {list.flaggedSegments === 0
                  ? 'none flagged'
                  : `${list.flaggedSegments} flagged across the book`}
              </p>
              <label className="review-select">
                <input
                  type="checkbox"
                  checked={flaggedOnly}
                  onChange={() => setFlaggedOnly(!flaggedOnly)}
                />
                <span>
                  Show only flagged lines — fallback voices, unidentified speakers, and
                  low-confidence attributions
                </span>
              </label>
              <ol className="script-chapters">
                {list.chapters.map((summary) => (
                  <ScriptChapterSection
                    key={summary.chapterId}
                    client={client}
                    jobId={jobId}
                    summary={summary}
                    totalChapters={list.chapterCount}
                    flaggedOnly={flaggedOnly}
                  />
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
