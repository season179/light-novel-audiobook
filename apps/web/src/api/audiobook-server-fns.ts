import type { SliceLimits } from '@light-novel-audiobook/pipeline-driver'
import { createServerFn } from '@tanstack/react-start'
import type { StartGenerationCommand } from '../client/audiobook-client.js'
import type {
  ChapterAudioListing,
  EpubUploadView,
  FallbackReviewView,
  StartedGeneration,
} from '../server/audiobook-web-api.js'
import { requireIdInput, toWebApiResult, WebApiError, type WebApiResult } from '../server/errors.js'
import type { JobStateView } from '../server/job-state-view.js'
import type { ScriptChapterListView, ScriptChapterView } from '../server/script-review-view.js'

/**
 * The local web API the browser calls. Each server function is a thin adapter over
 * `AudiobookWebApi`; all rules live in the application layer.
 *
 * Every function returns `WebApiResult<T>` — one contract, no exceptions. Validation happens inside
 * the handler rather than in a throwing validator, because a throwing validator rejects the RPC and
 * a caller could not switch on the documented error vocabulary. The composition root is imported
 * dynamically so nothing server-only can reach the client bundle.
 */
const api = async () => (await import('../server/composition-root.js')).getAudiobookWebApi()

export const uploadEpubFn = createServerFn({ method: 'POST' })
  .validator((data: FormData) => data)
  .handler(
    async ({ data }): Promise<WebApiResult<EpubUploadView>> =>
      toWebApiResult('uploadEpub', async () => {
        const file = data.get('file')
        if (!(file instanceof File) || file.name.length === 0) {
          throw new WebApiError('invalid_upload', 'Choose an EPUB file to upload.')
        }
        const bytes = new Uint8Array(await file.arrayBuffer())
        return (await api()).uploadEpub({ fileName: file.name, bytes })
      }),
  )

export const startGenerationFn = createServerFn({ method: 'POST' })
  .validator((data: StartGenerationCommand) => data)
  .handler(
    async ({ data }): Promise<WebApiResult<StartedGeneration>> =>
      toWebApiResult('startGeneration', async () => {
        // Only the three known bounds pass; anything else the payload carried is not a bound.
        // Validation of the values happens where the job ID is derived, so a malformed bound is
        // rejected as `invalid_request`, never silently dropped into a whole-book render.
        const slice: SliceLimits = {
          ...(data.slice?.firstChapter === undefined
            ? {}
            : { firstChapter: data.slice.firstChapter }),
          ...(data.slice?.maxChapters === undefined ? {} : { maxChapters: data.slice.maxChapters }),
          ...(data.slice?.maxPassagesPerChapter === undefined
            ? {}
            : { maxPassagesPerChapter: data.slice.maxPassagesPerChapter }),
        }
        return (await api()).startGeneration({
          uploadId: requireIdInput(data.uploadId, 'Upload ID'),
          recoverAbandoned: data.recoverAbandoned === true,
          slice,
        })
      }),
  )

/** `value: null` means no such job. That is part of the contract, not a failure. */
export const getJobStateFn = createServerFn({ method: 'GET' })
  .validator((data: { jobId: string }) => data)
  .handler(
    async ({ data }): Promise<WebApiResult<JobStateView | null>> =>
      toWebApiResult('getJobState', async () =>
        (await api()).getJobState({ jobId: requireIdInput(data.jobId, 'Job ID') }),
      ),
  )

export const listChapterAudioFn = createServerFn({ method: 'GET' })
  .validator((data: { jobId: string }) => data)
  .handler(
    async ({ data }): Promise<WebApiResult<ChapterAudioListing>> =>
      toWebApiResult('listChapterAudio', async () =>
        (await api()).listChapterAudio({ jobId: requireIdInput(data.jobId, 'Job ID') }),
      ),
  )

export const listUploadsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<WebApiResult<readonly EpubUploadView[]>> =>
    toWebApiResult('listUploads', async () => (await api()).listUploads()),
)

/**
 * The review queue for a job. Each entry carries a short excerpt of the approved line, because
 * nobody can approve a voice for a line they cannot read. That excerpt is story text: it is returned
 * to the browser for the human to read and must never be logged or written into job state.
 */
export const listFallbackReviewFn = createServerFn({ method: 'GET' })
  .validator((data: { jobId: string }) => data)
  .handler(
    async ({ data }): Promise<WebApiResult<FallbackReviewView>> =>
      toWebApiResult('listFallbackReview', async () =>
        (await api()).listFallbackReview({ jobId: requireIdInput(data.jobId, 'Job ID') }),
      ),
  )

/**
 * The M1 book-wide decision. One explicit user action authorizing the fallback voice for every
 * unresolved speaker in this book — a 2,328-passage book must not stop for a click per line — which
 * is then recorded as one durable per-segment approval each, so withdrawing one speaker later
 * invalidates only that speaker's audio.
 */
export const approveAllFallbacksFn = createServerFn({ method: 'POST' })
  .validator((data: { jobId: string }) => data)
  .handler(
    async ({ data }): Promise<WebApiResult<FallbackReviewView>> =>
      toWebApiResult('approveAllFallbacks', async () =>
        // No `decidedBy` in the payload, deliberately. The actor is what makes an approval evidence of
        // a human decision, so it is resolved server-side once at composition; a client-supplied one
        // would be self-attestation the server simply believed.
        (await api()).approveAllFallbacks({ jobId: requireIdInput(data.jobId, 'Job ID') }),
      ),
  )

/**
 * Approves one speaker. Needed as its own action because an explicit withdrawal deliberately outranks
 * the book-wide grant — without this, withdrawing a speaker would be a dead end no UI could undo.
 */
export const approveFallbackFn = createServerFn({ method: 'POST' })
  .validator((data: { jobId: string; segmentId: string }) => data)
  .handler(
    async ({ data }): Promise<WebApiResult<FallbackReviewView>> =>
      toWebApiResult('approveFallback', async () =>
        (await api()).approveFallback({
          jobId: requireIdInput(data.jobId, 'Job ID'),
          segmentId: requireIdInput(data.segmentId, 'Segment ID'),
        }),
      ),
  )

/**
 * One decision over exactly the selected lines (issue #96 step 4): the 190-of-200 case. The server
 * rejects the whole set when any line is no longer awaiting a decision — the queue moves between
 * reading it and clicking, and a silent subset would report success the user never granted.
 */
export const approveSelectedFallbacksFn = createServerFn({ method: 'POST' })
  .validator((data: { jobId: string; segmentIds: string[] }) => data)
  .handler(
    async ({ data }): Promise<WebApiResult<FallbackReviewView>> =>
      toWebApiResult('approveSelectedFallbacks', async () => {
        const jobId = requireIdInput(data.jobId, 'Job ID')
        if (!Array.isArray(data.segmentIds) || data.segmentIds.length === 0) {
          throw new WebApiError('invalid_request', 'Choose at least one line to approve.')
        }
        const segmentIds = data.segmentIds.map((segmentId) =>
          requireIdInput(segmentId, 'Segment ID'),
        )
        return (await api()).approveSelectedFallbacks({ jobId, segmentIds })
      }),
  )

export const revokeFallbackFn = createServerFn({ method: 'POST' })
  .validator((data: { jobId: string; segmentId: string }) => data)
  .handler(
    async ({ data }): Promise<WebApiResult<FallbackReviewView>> =>
      toWebApiResult('revokeFallback', async () =>
        (await api()).revokeFallback({
          jobId: requireIdInput(data.jobId, 'Job ID'),
          segmentId: requireIdInput(data.segmentId, 'Segment ID'),
        }),
      ),
  )

/** Continues the exact failed/abandoned stage without inventing a new review confirmation. */
export const resumeGenerationFn = createServerFn({ method: 'POST' })
  .validator((data: { jobId: string }) => data)
  .handler(
    async ({ data }): Promise<WebApiResult<StartedGeneration>> =>
      toWebApiResult('resumeGeneration', async () =>
        (await api()).resumeGeneration({ jobId: requireIdInput(data.jobId, 'Job ID') }),
      ),
  )

/** Continues a reviewed job from its persisted script, without re-extracting or re-directing. */
export const renderApprovedScriptFn = createServerFn({ method: 'POST' })
  .validator((data: { jobId: string }) => data)
  .handler(
    async ({ data }): Promise<WebApiResult<StartedGeneration>> =>
      toWebApiResult('renderApprovedScript', async () =>
        (await api()).renderApprovedScript({ jobId: requireIdInput(data.jobId, 'Job ID') }),
      ),
  )

/**
 * The chapter index of the persisted directed script (#96 step 6): counts and titles only, so the
 * reader can find the flagged chapters without the server shipping a whole book of story text.
 */
export const listScriptChaptersFn = createServerFn({ method: 'GET' })
  .validator((data: { jobId: string }) => data)
  .handler(
    async ({ data }): Promise<WebApiResult<ScriptChapterListView>> =>
      toWebApiResult('listScriptChapters', async () =>
        (await api()).listScriptChapters({ jobId: requireIdInput(data.jobId, 'Job ID') }),
      ),
  )

/**
 * One chapter of the directed script, exactly as it will be spoken. The segment text in this
 * answer is story content: it exists so the user can read what they are confirming, and it must
 * never be logged or written into job state.
 */
export const getScriptChapterFn = createServerFn({ method: 'GET' })
  .validator((data: { jobId: string; chapterId: string }) => data)
  .handler(
    async ({ data }): Promise<WebApiResult<ScriptChapterView>> =>
      toWebApiResult('getScriptChapter', async () =>
        (await api()).getScriptChapter({
          jobId: requireIdInput(data.jobId, 'Job ID'),
          chapterId: requireIdInput(data.chapterId, 'Chapter ID'),
        }),
      ),
  )
