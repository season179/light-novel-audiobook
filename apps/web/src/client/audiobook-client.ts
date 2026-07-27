import type { SliceLimits } from '@light-novel-audiobook/pipeline-driver'
import type {
  ChapterAudioListing,
  EpubUploadView,
  FallbackReviewView,
  StartedGeneration,
  StopPreview,
} from '../server/audiobook-web-api.js'
import type { WebApiResult } from '../server/errors.js'
import type { JobStateView } from '../server/job-state-view.js'
import type { ScriptChapterListView, ScriptChapterView } from '../server/script-review-view.js'

/**
 * What the pages are allowed to do. Components depend on this interface, never on the transport, so
 * the same components run against the real server functions in the browser and against an in-process
 * API in tests.
 *
 * Every method resolves to `WebApiResult<T>` and never rejects for a failure the user can act on:
 * `ok: false` carries the documented `{ code, message }`. `getJobState` resolving to
 * `{ ok: true, value: null }` means the job does not exist.
 */
export interface StartGenerationCommand {
  readonly uploadId: string
  readonly recoverAbandoned: boolean
  /** Empty bounds generate the whole book; the property itself is required so it cannot be dropped. */
  readonly slice: SliceLimits
}

export interface AudiobookClient {
  uploadEpub(input: { readonly file: File }): Promise<WebApiResult<EpubUploadView>>
  getStopPreview(): Promise<WebApiResult<StopPreview>>
  startGeneration(input: StartGenerationCommand): Promise<WebApiResult<StartedGeneration>>
  getJobState(input: { readonly jobId: string }): Promise<WebApiResult<JobStateView | null>>
  listChapterAudio(input: { readonly jobId: string }): Promise<WebApiResult<ChapterAudioListing>>
  listUploads(): Promise<WebApiResult<readonly EpubUploadView[]>>
  listFallbackReview(input: { readonly jobId: string }): Promise<WebApiResult<FallbackReviewView>>
  /**
   * The one book-wide decision: use the fallback voice for every unresolved speaker in this book.
   *
   * No actor parameter, deliberately — the server records who decided, from its own configuration. A
   * client-supplied actor would be self-attestation, and issue #45 is about approvals being evidence.
   */
  approveAllFallbacks(input: { readonly jobId: string }): Promise<WebApiResult<FallbackReviewView>>
  /** Approves one speaker, which also clears an earlier withdrawal of that same speaker. */
  approveFallback(input: {
    readonly jobId: string
    readonly segmentId: string
  }): Promise<WebApiResult<FallbackReviewView>>
  /**
   * One decision over exactly the selected pending lines; the rest keep blocking. The server
   * rejects the whole set if any line is no longer awaiting a decision, so the answer is always
   * "exactly what you approved", never a silent subset.
   */
  approveSelectedFallbacks(input: {
    readonly jobId: string
    readonly segmentIds: readonly string[]
  }): Promise<WebApiResult<FallbackReviewView>>
  revokeFallback(input: {
    readonly jobId: string
    readonly segmentId: string
  }): Promise<WebApiResult<FallbackReviewView>>
  resumeGeneration(input: { readonly jobId: string }): Promise<WebApiResult<StartedGeneration>>
  renderApprovedScript(input: { readonly jobId: string }): Promise<WebApiResult<StartedGeneration>>
  /**
   * The chapter index of the persisted directed script (#96 step 6): counts per chapter, text for
   * none. Read-only; fetched on demand, never polled.
   */
  listScriptChapters(input: {
    readonly jobId: string
  }): Promise<WebApiResult<ScriptChapterListView>>
  /**
   * One chapter of the directed script, exactly as it will be spoken. The segment text is story
   * content: it is rendered for the reader and must never be logged or persisted by a client.
   */
  getScriptChapter(input: {
    readonly jobId: string
    readonly chapterId: string
  }): Promise<WebApiResult<ScriptChapterView>>
}

export type {
  ChapterAudioListing,
  EpubUploadView,
  FallbackReviewView,
  JobStateView,
  ScriptChapterListView,
  ScriptChapterView,
  SliceLimits,
  StartedGeneration,
  StopPreview,
  WebApiResult,
}
