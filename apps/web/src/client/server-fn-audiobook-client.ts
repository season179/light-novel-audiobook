import {
  approveAllFallbacksFn,
  getJobStateFn,
  listChapterAudioFn,
  listFallbackReviewFn,
  listUploadsFn,
  renderApprovedScriptFn,
  revokeFallbackFn,
  startGenerationFn,
  uploadEpubFn,
} from '../api/audiobook-server-fns.js'
import type { AudiobookClient } from './audiobook-client.js'

/** The browser implementation: one TanStack Start server function per API operation. */
export const serverFnAudiobookClient: AudiobookClient = {
  uploadEpub: ({ file }) => {
    const formData = new FormData()
    formData.append('file', file)
    return uploadEpubFn({ data: formData })
  },
  startGeneration: ({ uploadId, recoverAbandoned }) =>
    startGenerationFn({ data: { uploadId, recoverAbandoned: recoverAbandoned === true } }),
  getJobState: ({ jobId }) => getJobStateFn({ data: { jobId } }),
  listChapterAudio: ({ jobId }) => listChapterAudioFn({ data: { jobId } }),
  listUploads: () => listUploadsFn(),
  listFallbackReview: ({ jobId }) => listFallbackReviewFn({ data: { jobId } }),
  approveAllFallbacks: ({ jobId }) => approveAllFallbacksFn({ data: { jobId } }),
  revokeFallback: ({ jobId, segmentId }) => revokeFallbackFn({ data: { jobId, segmentId } }),
  renderApprovedScript: ({ jobId }) => renderApprovedScriptFn({ data: { jobId } }),
}
