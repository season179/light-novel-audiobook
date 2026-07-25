import { useQuery } from '@tanstack/react-query'
import { useId } from 'react'
import type { AudiobookClient } from '../client/audiobook-client.js'
import type { JobStateView } from '../server/job-state-view.js'
import { ChapterAudioList } from './chapter-audio-list.js'
import { FallbackWarningList } from './fallback-warning-list.js'

export interface JobProgressPanelProps {
  readonly client: AudiobookClient
  readonly jobId: string
  /** Polling interval while the job is active. */
  readonly pollIntervalMs?: number
}

const DEFAULT_POLL_INTERVAL_MS = 700

const chapterText = (job: JobStateView): string => {
  if (job.currentChapterLabel === null) return 'Not in a chapter yet'
  if (job.currentChapterTitle === null) return job.currentChapterLabel
  return `${job.currentChapterLabel} — ${job.currentChapterTitle}`
}

const stageText = (job: JobStateView): string => `${job.stageLabel} · ${job.state}`

const segmentsText = (job: JobStateView): string => {
  const total = job.totalSegments === 0 ? 'not yet counted' : String(job.totalSegments)
  return `${job.completedSegments} of ${total}`
}

/**
 * Progress and result view. Job state is always fetched from the server, so reloading the page keeps
 * the real progress instead of restarting from whatever React happened to hold.
 */
export function JobProgressPanel({ client, jobId, pollIntervalMs }: JobProgressPanelProps) {
  const progressId = useId()
  const interval = pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const jobQuery = useQuery({
    queryKey: ['job-state', jobId],
    queryFn: () => client.getJobState({ jobId }),
    refetchInterval: (query) => {
      const result = query.state.data
      return result?.ok === true && result.value?.active === true ? interval : false
    },
    refetchOnMount: 'always',
  })

  if (jobQuery.isPending) {
    return (
      <section className="panel" aria-labelledby="job-heading">
        <h2 id="job-heading">Generation</h2>
        <p role="status">Loading job state…</p>
      </section>
    )
  }

  const result = jobQuery.data
  if (jobQuery.isError || result === undefined) {
    return (
      <section className="panel" aria-labelledby="job-heading">
        <h2 id="job-heading">Generation</h2>
        <p className="error" role="alert">
          Job state could not be read from the local server.
        </p>
      </section>
    )
  }

  if (!result.ok) {
    return (
      <section className="panel" aria-labelledby="job-heading">
        <h2 id="job-heading">Generation</h2>
        <p className="error" role="alert">
          {result.error.message}
        </p>
      </section>
    )
  }

  const job = result.value
  if (job === null) {
    return (
      <section className="panel" aria-labelledby="job-heading">
        <h2 id="job-heading">Generation</h2>
        <p className="error" role="alert">
          No job named {jobId} exists in this workspace. Upload the EPUB again to start one.
        </p>
      </section>
    )
  }

  return (
    <section className="panel stack" aria-labelledby="job-heading">
      <h2 id="job-heading">{job.bookTitle ?? 'Generation'}</h2>

      <div className="status-block" role="status" aria-live="polite">
        <p className="stage">{stageText(job)}</p>
        <p className="latest">{job.latestMessage}</p>
      </div>

      <dl className="summary">
        <dt>Chapter</dt>
        <dd>{chapterText(job)}</dd>
        <dt>Segments</dt>
        <dd>{segmentsText(job)}</dd>
        <dt>Job</dt>
        <dd>
          <code>{job.jobId}</code>
        </dd>
      </dl>

      {job.totalSegments > 0 && (
        <div className="field">
          <label htmlFor={progressId}>Segments rendered</label>
          <progress id={progressId} value={job.completedSegments} max={job.totalSegments}>
            {job.percentComplete ?? 0}%
          </progress>
        </div>
      )}

      {job.error !== null && (
        <p className="error" role="alert">
          Generation failed: {job.error}
        </p>
      )}

      <FallbackWarningList warnings={job.warnings} />
      {job.output !== null && <ChapterAudioList output={job.output} />}
    </section>
  )
}
