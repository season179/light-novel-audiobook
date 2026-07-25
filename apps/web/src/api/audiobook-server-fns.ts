import { createServerFn } from '@tanstack/react-start'
import type {
  ChapterAudioListing,
  EpubUploadView,
  StartGenerationResult,
  UploadEpubResult,
} from '../server/audiobook-web-api.js'
import type { JobStateView } from '../server/job-state-view.js'

/**
 * The local web API the browser calls. Each server function is a thin adapter over
 * `AudiobookWebApi`; all rules live in the application layer. The composition root is imported
 * dynamically so nothing server-only can reach the client bundle.
 */
const api = async () => (await import('../server/composition-root.js')).getAudiobookWebApi()

const requireId = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required`)
  }
  return value
}

export const uploadEpubFn = createServerFn({ method: 'POST' })
  .validator((data: FormData) => data)
  .handler(async ({ data }): Promise<UploadEpubResult> => {
    const file = data.get('file')
    if (!(file instanceof File) || file.name.length === 0) {
      return {
        ok: false,
        error: { code: 'invalid_upload', message: 'Choose an EPUB file to upload.' },
      }
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    return (await api()).uploadEpub({ fileName: file.name, bytes })
  })

export const startGenerationFn = createServerFn({ method: 'POST' })
  .validator((data: { uploadId: string; recoverAbandoned?: boolean }) => ({
    uploadId: requireId(data.uploadId, 'Upload ID'),
    recoverAbandoned: data.recoverAbandoned === true,
  }))
  .handler(
    async ({ data }): Promise<StartGenerationResult> =>
      (await api()).startGeneration({
        uploadId: data.uploadId,
        recoverAbandoned: data.recoverAbandoned,
      }),
  )

export const getJobStateFn = createServerFn({ method: 'GET' })
  .validator((data: { jobId: string }) => ({ jobId: requireId(data.jobId, 'Job ID') }))
  .handler(async ({ data }): Promise<JobStateView | null> => (await api()).getJobState(data))

export const listChapterAudioFn = createServerFn({ method: 'GET' })
  .validator((data: { jobId: string }) => ({ jobId: requireId(data.jobId, 'Job ID') }))
  .handler(async ({ data }): Promise<ChapterAudioListing> => (await api()).listChapterAudio(data))

export const listUploadsFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<readonly EpubUploadView[]> => (await api()).listUploads(),
)
