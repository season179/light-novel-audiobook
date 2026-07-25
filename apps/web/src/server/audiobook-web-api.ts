import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import type { JobRepository } from '@light-novel-audiobook/application'
import type { VoiceCast } from '@light-novel-audiobook/domain'
import type { BookReadModelStore } from './book-read-model.js'
import type { EpubUploadStore, StoredEpubUpload } from './epub-upload-store.js'
import { toWebApiFailure, WebApiError, type WebApiFailure } from './errors.js'
import type { GenerationRunner } from './generation-runner.js'
import {
  buildJobStateView,
  type ChapterAudioView,
  fileNameOf,
  type JobStateView,
} from './job-state-view.js'
import type { LocalWorkspace } from './workspace.js'

export interface EpubUploadView {
  readonly uploadId: string
  readonly fileName: string
  readonly byteLength: number
  readonly sha256: string
  readonly uploadedAt: string
  /** The job this upload will generate into. Stable, so a refresh finds the same job. */
  readonly jobId: string
}

export type UploadEpubResult =
  | { readonly ok: true; readonly upload: EpubUploadView }
  | { readonly ok: false; readonly error: WebApiFailure }

export type StartGenerationResult =
  | { readonly ok: true; readonly jobId: string; readonly job: JobStateView }
  | { readonly ok: false; readonly error: WebApiFailure }

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

export interface AudiobookWebApiDependencies {
  readonly workspace: LocalWorkspace
  readonly uploads: EpubUploadStore
  readonly jobs: JobRepository
  readonly books: BookReadModelStore
  readonly runner: GenerationRunner
  readonly voices: VoiceCast
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.mp3': 'audio/mpeg',
}

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
 */
export class AudiobookWebApi {
  private readonly workspace: LocalWorkspace
  private readonly uploads: EpubUploadStore
  private readonly jobs: JobRepository
  private readonly books: BookReadModelStore
  private readonly runner: GenerationRunner
  private readonly voices: VoiceCast

  constructor(dependencies: AudiobookWebApiDependencies) {
    this.workspace = dependencies.workspace
    this.uploads = dependencies.uploads
    this.jobs = dependencies.jobs
    this.books = dependencies.books
    this.runner = dependencies.runner
    this.voices = dependencies.voices
  }

  async uploadEpub(input: {
    readonly fileName: string
    readonly bytes: Uint8Array
  }): Promise<UploadEpubResult> {
    try {
      const upload = await this.uploads.store(input.fileName, input.bytes)
      return { ok: true, upload: toUploadView(upload) }
    } catch (error) {
      return { ok: false, error: toWebApiFailure(error) }
    }
  }

  async listUploads(): Promise<readonly EpubUploadView[]> {
    return (await this.uploads.list()).map(toUploadView)
  }

  /**
   * Starts generation in the background and returns immediately with the job to watch. Rejections
   * the user can act on (unknown upload, a run already in flight) come back as failures rather than
   * thrown errors; anything the use case rejects later appears in the job state.
   */
  async startGeneration(input: {
    readonly uploadId: string
    readonly recoverAbandoned?: boolean | undefined
  }): Promise<StartGenerationResult> {
    try {
      const upload = await this.uploads.require(input.uploadId)
      const jobId = deriveJobId(upload.sha256)
      const recoverAbandoned = input.recoverAbandoned === true
      const existing = await this.jobs.findJob(jobId)

      if (this.runner.isActive(jobId)) {
        const job = await this.getJobState({ jobId })
        if (job === null) throw new WebApiError('internal', 'Generation state is unavailable.')
        return { ok: true, jobId, job }
      }
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
        ...(recoverAbandoned ? { recoverAbandoned: true } : {}),
      })

      const job = await this.getJobState({ jobId })
      return {
        ok: true,
        jobId,
        job: job ?? this.pendingJobView(jobId),
      }
    } catch (error) {
      return { ok: false, error: toWebApiFailure(error) }
    }
  }

  /** Reads current job state from stored data. Safe to call at any time, including after a refresh. */
  async getJobState(input: { readonly jobId: string }): Promise<JobStateView | null> {
    const job = await this.jobs.findJob(input.jobId)
    if (job === undefined) {
      if (this.runner.isActive(input.jobId)) return this.pendingJobView(input.jobId)
      const failure = this.runner.startupFailure(input.jobId)
      return failure === undefined ? null : this.rejectedJobView(input.jobId, failure)
    }
    return buildJobStateView(job.snapshot(), this.books.find(job.bookId))
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

  async readChapterAudioFile(input: {
    readonly jobId: string
    readonly chapterId: string
  }): Promise<AudioFileDescriptor> {
    const path = await this.outputPath(input.jobId, input.chapterId)
    return this.describeFile(path, fileNameOf(path), false)
  }

  async readAudiobookFile(input: { readonly jobId: string }): Promise<AudioFileDescriptor> {
    const path = await this.outputPath(input.jobId, null)
    return this.describeFile(path, fileNameOf(path), true)
  }

  /** Paths only ever come from the persisted job output, never from the request. */
  private async outputPath(jobId: string, chapterId: string | null): Promise<string> {
    const job = await this.jobs.findJob(jobId)
    if (job === undefined) {
      throw new WebApiError('unknown_job', 'That job is not in the local workspace.')
    }
    const output = job.output
    if (output === null) {
      throw new WebApiError('output_unavailable', 'This audiobook has not been assembled yet.')
    }
    if (chapterId === null) return this.workspace.assertContains(output.m4bPath)
    const chapter = output.chapters.find((entry) => entry.chapterId === chapterId)
    if (chapter === undefined) {
      throw new WebApiError('output_unavailable', 'That chapter has no generated audio yet.')
    }
    return this.workspace.assertContains(chapter.path)
  }

  private async describeFile(
    path: string,
    fileName: string,
    attachment: boolean,
  ): Promise<AudioFileDescriptor> {
    let byteLength: number
    try {
      byteLength = (await stat(path)).size
    } catch {
      throw new WebApiError(
        'output_unavailable',
        'The generated file is missing from the workspace.',
      )
    }
    return {
      path,
      fileName,
      contentType: CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
      byteLength,
      attachment,
    }
  }

  private pendingJobView(jobId: string): JobStateView {
    return {
      jobId,
      state: 'pending',
      stage: 'extracting',
      stageLabel: 'Starting generation',
      bookId: null,
      bookTitle: null,
      currentChapterId: null,
      currentChapterLabel: null,
      currentChapterTitle: null,
      completedSegments: 0,
      totalSegments: 0,
      percentComplete: null,
      latestMessage: 'Starting generation',
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
