import {
  approveAllFallbacksFn,
  approveFallbackFn,
  approveSelectedFallbacksFn,
  getJobStateFn,
  listChapterAudioFn,
  listFallbackReviewFn,
  listUploadsFn,
  renderApprovedScriptFn,
  resumeGenerationFn,
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
  // Forward the complete command object. Its required `slice` property and this whole-object seam
  // make silently narrowing the production payload to selected fields impossible.
  startGeneration: (command) => startGenerationFn({ data: command }),
  getJobState: ({ jobId }) => getJobStateFn({ data: { jobId } }),
  listChapterAudio: ({ jobId }) => listChapterAudioFn({ data: { jobId } }),
  listUploads: () => listUploadsFn(),
  listFallbackReview: ({ jobId }) => listFallbackReviewFn({ data: { jobId } }),
  approveAllFallbacks: ({ jobId }) => approveAllFallbacksFn({ data: { jobId } }),
  approveFallback: ({ jobId, segmentId }) => approveFallbackFn({ data: { jobId, segmentId } }),
  approveSelectedFallbacks: ({ jobId, segmentIds }) =>
    approveSelectedFallbacksFn({ data: { jobId, segmentIds: [...segmentIds] } }),
  revokeFallback: ({ jobId, segmentId }) => revokeFallbackFn({ data: { jobId, segmentId } }),
  resumeGeneration: ({ jobId }) => resumeGenerationFn({ data: { jobId } }),
  renderApprovedScript: ({ jobId }) => renderApprovedScriptFn({ data: { jobId } }),
}
