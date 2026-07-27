import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fragment, useId } from 'react'
import type { AudiobookClient } from '../client/audiobook-client.js'
import type { JobStateView } from '../server/job-state-view.js'
import { ChapterAudioList } from './chapter-audio-list.js'
import { FallbackReviewPanel } from './fallback-review-panel.js'
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

const stageText = (job: JobStateView): string => {
  if (job.state !== 'awaiting_review') return `${job.stageLabel} · ${job.state}`
  // The two situations inside awaiting_review (#96), derived server-side from the live review
  // records — never inferred here from the state or the stored message.
  if (job.review === null) {
    return 'Waiting for fallback voice review. Continuing starts speech rendering.'
  }
  if (job.review.status === 'ready_to_confirm') {
    return 'Direction finished and nothing needs a decision. Confirming starts speech rendering.'
  }
  const { blockers } = job.review
  return `Waiting for fallback voice review — ${blockers} ${blockers === 1 ? 'line needs' : 'lines need'} a decision.`
}

const passagesText = (job: JobStateView): string =>
  `${job.completedPassages} of ${job.totalPassages}`

const chaptersText = (job: JobStateView): string =>
  `${job.completedChapters} of ${job.totalChapters}`

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
  const queryClient = useQueryClient()
  const jobQuery = useQuery({
    queryKey: ['job-state', jobId],
    queryFn: () => client.getJobState({ jobId }),
    refetchInterval: (query) => {
      const result = query.state.data
      return result?.ok === true && result.value?.active === true ? interval : false
    },
    refetchOnMount: 'always',
  })
  // Only fetched while the job is actually resting for review, so a running or finished job pays
  // nothing for it.
  const awaitingReview =
    jobQuery.data?.ok === true && jobQuery.data.value?.state === 'awaiting_review'
  const reviewQuery = useQuery({
    queryKey: ['fallback-review', jobId],
    queryFn: () => client.listFallbackReview({ jobId }),
    enabled: awaitingReview,
    refetchOnMount: 'always',
  })
  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['fallback-review', jobId] }),
      queryClient.invalidateQueries({ queryKey: ['job-state', jobId] }),
    ])
  }
  const approveAll = useMutation({
    mutationFn: () => client.approveAllFallbacks({ jobId }),
    onSuccess: refresh,
  })
  const approveOne = useMutation({
    mutationFn: (segmentId: string) => client.approveFallback({ jobId, segmentId }),
    onSuccess: refresh,
  })
  const approveSelected = useMutation({
    mutationFn: (segmentIds: readonly string[]) =>
      client.approveSelectedFallbacks({ jobId, segmentIds }),
    onSuccess: refresh,
  })
  const revoke = useMutation({
    mutationFn: (segmentId: string) => client.revokeFallback({ jobId, segmentId }),
    onSuccess: refresh,
  })
  const render = useMutation({
    mutationFn: () => client.renderApprovedScript({ jobId }),
    onSuccess: refresh,
  })
  const reviewBusy =
    approveAll.isPending ||
    approveOne.isPending ||
    approveSelected.isPending ||
    revoke.isPending ||
    render.isPending
  const reviewError = [
    approveAll.data,
    approveOne.data,
    approveSelected.data,
    revoke.data,
    render.data,
  ].find((result) => result !== undefined && !result.ok)

  if (jobQuery.isPending) {
    return (
      <section className="panel stack" aria-labelledby="job-heading">
        <h2 id="job-heading">Generation</h2>
        {/* No data-state yet: the neutral base treatment is the honest one until the job's real
            state arrives. The bar is indeterminate because there is no total to show. */}
        <div className="status-block" role="status" aria-live="polite">
          <p className="stage">Loading</p>
          <p className="latest">Loading job state…</p>
          <progress aria-label="Loading job state" />
        </div>
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

      <div
        className="status-block"
        data-state={job.state}
        data-review={job.review?.status ?? undefined}
        role="status"
        aria-live="polite"
      >
        <p className="stage">{stageText(job)}</p>
        <p className="latest">{job.latestMessage}</p>
      </div>

      {job.error !== null && (
        <p className="error" role="alert">
          Generation failed: {job.error}
        </p>
      )}

      {job.stage === 'directing' && job.totalPassages > 0 && (
        <div className="field">
          <label htmlFor={progressId}>Passages directed</label>
          <progress id={progressId} value={job.completedPassages} max={job.totalPassages}>
            {job.directionPercentComplete ?? 0}%
          </progress>
        </div>
      )}

      {job.stage !== 'directing' && job.totalSegments > 0 && (
        <div className="field">
          <label htmlFor={progressId}>Segments rendered</label>
          <progress id={progressId} value={job.completedSegments} max={job.totalSegments}>
            {job.percentComplete ?? 0}%
          </progress>
        </div>
      )}

      {reviewError !== undefined && !reviewError.ok && (
        <p className="error" role="alert">
          {reviewError.error.message}
        </p>
      )}

      {reviewQuery.data?.ok === true && (
        <FallbackReviewPanel
          review={reviewQuery.data.value}
          busy={reviewBusy}
          onApproveAll={() => approveAll.mutate()}
          onApproveSelected={(segmentIds) => approveSelected.mutate(segmentIds)}
          onApprove={(segmentId) => approveOne.mutate(segmentId)}
          onRevoke={(segmentId) => revoke.mutate(segmentId)}
          onRender={() => render.mutate()}
        />
      )}

      {/* Reference material: the pipeline and the counts recede into a recessed box so the live
          status above keeps the eye. */}
      <section className="stack bordered details" aria-labelledby="pipeline-heading">
        <h3 id="pipeline-heading">Pipeline</h3>
        <dl className="summary" aria-label="Audiobook pipeline stages">
          {job.pipelineStages.map((stage) => (
            <Fragment key={stage.stage}>
              <dt>{stage.label}</dt>
              <dd>
                <strong
                  data-status={stage.status}
                  aria-current={stage.status === 'current' ? 'step' : undefined}
                >
                  {stage.status === 'completed'
                    ? 'Completed'
                    : stage.status === 'current'
                      ? 'Current'
                      : 'Upcoming'}
                </strong>
                {stage.summary === null ? null : ` — ${stage.summary}`}
              </dd>
            </Fragment>
          ))}
        </dl>

        <dl className="summary">
          <dt>Chapter</dt>
          <dd className={job.currentChapterLabel === null ? 'empty' : undefined}>
            {chapterText(job)}
          </dd>
          {job.totalChapters > 0 && (
            <>
              <dt>Chapters directed</dt>
              <dd>{chaptersText(job)}</dd>
              <dt>Passages directed</dt>
              <dd>{passagesText(job)}</dd>
            </>
          )}
          <dt>Segments</dt>
          <dd>{segmentsText(job)}</dd>
          <dt>Job</dt>
          <dd>
            <code>{job.jobId}</code>
          </dd>
        </dl>
      </section>

      <FallbackWarningList warnings={job.warnings} />
      {job.output !== null && <ChapterAudioList output={job.output} />}
    </section>
  )
}
