import { extname } from 'node:path'
import type { DirectChapterOptions, JobRepository } from '@light-novel-audiobook/application'
import type { VoiceCast } from '@light-novel-audiobook/domain'
import type { BookReadModelStore } from './book-read-model.js'
import type { EpubUploadStore, StoredEpubUpload } from './epub-upload-store.js'
import { WebApiError } from './errors.js'
import type { GenerationRunner } from './generation-runner.js'
import {
  buildJobStateView,
  type ChapterAudioView,
  fileNameOf,
  type JobStateView,
} from './job-state-view.js'
import type { ContainedFile, LocalWorkspace } from './workspace.js'

export interface EpubUploadView {
  readonly uploadId: string
  readonly fileName: string
  readonly byteLength: number
  readonly sha256: string
  readonly uploadedAt: string
  /** The job this upload will generate into. Stable, so a refresh finds the same job. */
  readonly jobId: string
}

export interface StartedGeneration {
  readonly jobId: string
  readonly job: JobStateView
}

export interface ChapterAudioListing {
  readonly jobId: string
  readonly ready: boolean
  readonly chapters: readonly ChapterAudioView[]
  readonly download: { readonly url: string; readonly fileName: string } | null
}

export interface AudioFileDescriptor {
  readonly path: string
  readonly fileName: string
  readonly contentType: string
  readonly byteLength: number
  readonly attachment: boolean
}

/**
 * A generated file that has been opened and proven to live inside the workspace. Either consume
 * `body()` — which closes the handle when the stream ends — or call `close()`.
 */
export interface OpenAudioFile {
  readonly descriptor: AudioFileDescriptor
  body(): ReadableStream<Uint8Array>
  close(): Promise<void>
}

export interface AudiobookWebApiDependencies {
  readonly workspace: LocalWorkspace
  readonly uploads: EpubUploadStore
  readonly jobs: JobRepository
  readonly books: BookReadModelStore
  readonly runner: GenerationRunner
  readonly voices: VoiceCast
  /** Operational direction options forwarded to every generation command (never persisted). */
  readonly directorOptions?: DirectChapterOptions | undefined
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.mp3': 'audio/mpeg',
}

const STREAM_CHUNK_BYTES = 64 * 1024

export const QUEUED_RUN_MESSAGE = 'Waiting for the current generation to finish'

/** A job is addressed by its EPUB content, so re-opening or refreshing always finds the same run. */
export const deriveJobId = (uploadSha256: string): string => `job-${uploadSha256.slice(0, 24)}`

const toUploadView = (upload: StoredEpubUpload): EpubUploadView => ({
  uploadId: upload.uploadId,
  fileName: upload.originalFileName,
  byteLength: upload.byteLength,
  sha256: upload.sha256,
  uploadedAt: upload.uploadedAt,
  jobId: deriveJobId(upload.sha256),
})

/**
 * The complete local web API for the M1 flow. It depends only on the application ports and the
 * `GenerateAudiobook` use case, holds no domain rules of its own, and answers every read from
 * persisted job state.
 *
 * Every method either returns a value or throws `WebApiError`. Boundaries (server functions, server
 * routes) normalize that into `WebApiResult`, so a caller has one contract to handle.
 */
export class AudiobookWebApi {
  private readonly workspace: LocalWorkspace
  private readonly uploads: EpubUploadStore
  private readonly jobs: JobRepository
  private readonly books: BookReadModelStore
  private readonly runner: GenerationRunner
  private readonly voices: VoiceCast
  private readonly directorOptions: DirectChapterOptions | undefined

  constructor(dependencies: AudiobookWebApiDependencies) {
    this.workspace = dependencies.workspace
    this.uploads = dependencies.uploads
    this.jobs = dependencies.jobs
    this.books = dependencies.books
    this.runner = dependencies.runner
    this.voices = dependencies.voices
    this.directorOptions = dependencies.directorOptions
  }

  /** Throws `invalid_upload` with an actionable message when the bytes are not an EPUB. */
  async uploadEpub(input: {
    readonly fileName: string
    readonly bytes: Uint8Array
  }): Promise<EpubUploadView> {
    return toUploadView(await this.uploads.store(input.fileName, input.bytes))
  }

  async listUploads(): Promise<readonly EpubUploadView[]> {
    return (await this.uploads.list()).map(toUploadView)
  }

  /**
   * Starts generation in the background and returns the job to watch. Runs are serialized, so a
   * second job waits rather than competing for the GPU. Throws `generation_rejected` when the user
   * has to make a choice first, and `unknown_upload` when the EPUB is gone.
   */
  async startGeneration(input: {
    readonly uploadId: string
    readonly recoverAbandoned?: boolean | undefined
  }): Promise<StartedGeneration> {
    const upload = await this.uploads.require(input.uploadId)
    const jobId = deriveJobId(upload.sha256)
    const recoverAbandoned = input.recoverAbandoned === true

    if (this.runner.isActive(jobId)) {
      return { jobId, job: await this.requireJobState({ jobId }) }
    }

    const existing = await this.jobs.findJob(jobId)
    if (existing?.state === 'running' && !recoverAbandoned) {
      throw new WebApiError(
        'generation_rejected',
        'This audiobook is already generating. Refresh to see its progress.',
      )
    }
    if (existing?.state === 'abandoned' && !recoverAbandoned) {
      throw new WebApiError(
        'generation_rejected',
        'This job stopped unexpectedly. Choose “Recover and continue” to take it over.',
      )
    }

    this.runner.start({
      jobId,
      epubPath: upload.epubPath,
      epubSha256: upload.sha256,
      voices: this.voices,
      ...(this.directorOptions === undefined ? {} : { directorOptions: this.directorOptions }),
      ...(recoverAbandoned ? { recoverAbandoned: true } : {}),
    })

    return { jobId, job: (await this.getJobState({ jobId })) ?? this.pendingJobView(jobId) }
  }

  /**
   * Reads current job state from stored data. Safe at any time, including after a refresh.
   * `null` means no such job — a deliberate part of the contract, not a failure.
   */
  async getJobState(input: { readonly jobId: string }): Promise<JobStateView | null> {
    const job = await this.jobs.findJob(input.jobId)
    if (job === undefined) {
      if (this.runner.isActive(input.jobId)) return this.pendingJobView(input.jobId)
      const failure = this.runner.startupFailure(input.jobId)
      return failure === undefined ? null : this.rejectedJobView(input.jobId, failure)
    }
    const view = buildJobStateView(job.snapshot(), this.books.find(job.bookId))
    return this.withRunnerStatus(view)
  }

  /**
   * A retry or recovery is queued before the use case has written anything, so the stored snapshot is
   * still the previous terminal one. Reporting that verbatim tells the page the job is inactive, it
   * stops polling, and a run that is about to start looks like a hang. While the runner holds the
   * job, the view therefore reports the pending run and keeps the previous failure for context.
   */
  private withRunnerStatus(view: JobStateView): JobStateView {
    const status = this.runner.status(view.jobId)
    if (status === 'idle' || view.active) return view
    const message = status === 'queued' ? QUEUED_RUN_MESSAGE : 'Starting generation'
    return {
      ...view,
      state: 'pending',
      stageLabel: message,
      latestMessage: message,
      active: true,
      finished: false,
    }
  }

  async requireJobState(input: { readonly jobId: string }): Promise<JobStateView> {
    const job = await this.getJobState(input)
    if (job === null) {
      throw new WebApiError('unknown_job', 'That job is not in the local workspace.')
    }
    return job
  }

  async listChapterAudio(input: { readonly jobId: string }): Promise<ChapterAudioListing> {
    const job = await this.requireJobState(input)
    if (job.output === null) {
      return { jobId: job.jobId, ready: false, chapters: [], download: null }
    }
    return {
      jobId: job.jobId,
      ready: true,
      chapters: job.output.chapters,
      download: { url: job.output.downloadUrl, fileName: job.output.m4bFileName },
    }
  }

  async openChapterAudioFile(input: {
    readonly jobId: string
    readonly chapterId: string
  }): Promise<OpenAudioFile> {
    return this.openOutputFile(input.jobId, input.chapterId, false)
  }

  async openAudiobookFile(input: { readonly jobId: string }): Promise<OpenAudioFile> {
    return this.openOutputFile(input.jobId, null, true)
  }

  private async openOutputFile(
    jobId: string,
    chapterId: string | null,
    attachment: boolean,
  ): Promise<OpenAudioFile> {
    const path = await this.persistedOutputPath(jobId, chapterId)
    const file = await this.workspace.openContainedFile(path)
    return this.toOpenAudioFile(file, attachment)
  }

  /** Paths only ever come from the persisted job output, never from the request. */
  private async persistedOutputPath(jobId: string, chapterId: string | null): Promise<string> {
    const job = await this.jobs.findJob(jobId)
    if (job === undefined) {
      throw new WebApiError('unknown_job', 'That job is not in the local workspace.')
    }
    const output = job.output
    if (output === null) {
      throw new WebApiError('output_unavailable', 'This audiobook has not been assembled yet.')
    }
    if (chapterId === null) return output.m4bPath
    const chapter = output.chapters.find((entry) => entry.chapterId === chapterId)
    if (chapter === undefined) {
      throw new WebApiError('output_unavailable', 'That chapter has no generated audio yet.')
    }
    return chapter.path
  }

  private toOpenAudioFile(file: ContainedFile, attachment: boolean): OpenAudioFile {
    let closed = false
    const close = async (): Promise<void> => {
      if (closed) return
      closed = true
      await file.handle.close()
    }

    /**
     * Read straight from the validated handle rather than wrapping a Node stream: end-of-file,
     * error, and client cancellation each close the handle on a path this code owns, instead of
     * depending on which events a stream adapter happens to forward.
     */
    const body = (): ReadableStream<Uint8Array> => {
      let position = 0
      return new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          try {
            const chunk = Buffer.allocUnsafe(STREAM_CHUNK_BYTES)
            const { bytesRead } = await file.handle.read(chunk, 0, STREAM_CHUNK_BYTES, position)
            if (bytesRead === 0) {
              await close()
              controller.close()
              return
            }
            position += bytesRead
            controller.enqueue(chunk.subarray(0, bytesRead))
          } catch (error) {
            await close()
            controller.error(error)
          }
        },
        cancel: async () => {
          await close()
        },
      })
    }

    return {
      descriptor: {
        path: file.path,
        fileName: fileNameOf(file.path),
        contentType: CONTENT_TYPES[extname(file.path).toLowerCase()] ?? 'application/octet-stream',
        byteLength: file.byteLength,
        attachment,
      },
      body,
      close,
    }
  }

  private pendingJobView(jobId: string): JobStateView {
    const queued = this.runner.status(jobId) === 'queued'
    const message = queued ? QUEUED_RUN_MESSAGE : 'Starting generation'
    return {
      jobId,
      state: 'pending',
      stage: 'extracting',
      stageLabel: message,
      bookId: null,
      bookTitle: null,
      currentChapterId: null,
      currentChapterLabel: null,
      currentChapterTitle: null,
      completedSegments: 0,
      totalSegments: 0,
      percentComplete: null,
      latestMessage: message,
      error: null,
      active: true,
      finished: false,
      warnings: [],
      output: null,
    }
  }

  private rejectedJobView(jobId: string, message: string): JobStateView {
    return {
      ...this.pendingJobView(jobId),
      state: 'failed',
      stageLabel: 'Generation rejected',
      latestMessage: message,
      error: message,
      active: false,
    }
  }
}

export type { JobStateView }
