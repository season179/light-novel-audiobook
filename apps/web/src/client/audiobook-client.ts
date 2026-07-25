import type {
  ChapterAudioListing,
  EpubUploadView,
  StartedGeneration,
} from '../server/audiobook-web-api.js'
import type { WebApiResult } from '../server/errors.js'
import type { JobStateView } from '../server/job-state-view.js'

/**
 * What the pages are allowed to do. Components depend on this interface, never on the transport, so
 * the same components run against the real server functions in the browser and against an in-process
 * API in tests.
 *
 * Every method resolves to `WebApiResult<T>` and never rejects for a failure the user can act on:
 * `ok: false` carries the documented `{ code, message }`. `getJobState` resolving to
 * `{ ok: true, value: null }` means the job does not exist.
 */
export interface AudiobookClient {
  uploadEpub(input: { readonly file: File }): Promise<WebApiResult<EpubUploadView>>
  startGeneration(input: {
    readonly uploadId: string
    readonly recoverAbandoned?: boolean
  }): Promise<WebApiResult<StartedGeneration>>
  getJobState(input: { readonly jobId: string }): Promise<WebApiResult<JobStateView | null>>
  listChapterAudio(input: { readonly jobId: string }): Promise<WebApiResult<ChapterAudioListing>>
  listUploads(): Promise<WebApiResult<readonly EpubUploadView[]>>
}

export type { ChapterAudioListing, EpubUploadView, JobStateView, StartedGeneration, WebApiResult }
