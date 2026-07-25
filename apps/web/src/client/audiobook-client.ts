import type {
  ChapterAudioListing,
  EpubUploadView,
  StartGenerationResult,
  UploadEpubResult,
} from '../server/audiobook-web-api.js'
import type { JobStateView } from '../server/job-state-view.js'

/**
 * What the pages are allowed to do. Components depend on this interface, never on the transport, so
 * the same components run against the real server functions in the browser and against an
 * in-process API in tests.
 */
export interface AudiobookClient {
  uploadEpub(input: { readonly file: File }): Promise<UploadEpubResult>
  startGeneration(input: {
    readonly uploadId: string
    readonly recoverAbandoned?: boolean
  }): Promise<StartGenerationResult>
  getJobState(input: { readonly jobId: string }): Promise<JobStateView | null>
  listChapterAudio(input: { readonly jobId: string }): Promise<ChapterAudioListing>
  listUploads(): Promise<readonly EpubUploadView[]>
}

export type {
  ChapterAudioListing,
  EpubUploadView,
  JobStateView,
  StartGenerationResult,
  UploadEpubResult,
}
