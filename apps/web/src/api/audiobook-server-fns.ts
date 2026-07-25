import { createServerFn } from '@tanstack/react-start'
import type {
  ChapterAudioListing,
  EpubUploadView,
  StartedGeneration,
} from '../server/audiobook-web-api.js'
import { requireIdInput, toWebApiResult, WebApiError, type WebApiResult } from '../server/errors.js'
import type { JobStateView } from '../server/job-state-view.js'

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
  .validator((data: { uploadId: string; recoverAbandoned?: boolean }) => data)
  .handler(
    async ({ data }): Promise<WebApiResult<StartedGeneration>> =>
      toWebApiResult('startGeneration', async () =>
        (await api()).startGeneration({
          uploadId: requireIdInput(data.uploadId, 'Upload ID'),
          recoverAbandoned: data.recoverAbandoned === true,
        }),
      ),
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
