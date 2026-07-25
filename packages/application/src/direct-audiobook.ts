import {
  AudiobookJob,
  type Book,
  DomainError,
  ExactSourceCoverage,
  type VoiceCast,
} from '@light-novel-audiobook/domain'
import { createGenerationCommandIdentity } from './generation-command-identity.js'
import type {
  AudioAssembler,
  DirectorModelFactory,
  EpubExtractor,
  JobRepository,
  SpeechEngineFactory,
} from './ports.js'
import { createRenderContract } from './render-contract.js'

export interface DirectAudiobookCommand {
  readonly jobId: string
  readonly epubPath: string
  readonly epubSha256: string
  readonly voices: VoiceCast
  /** Explicitly takes over a job known to have lost its worker; never use for an active request. */
  readonly recoverAbandoned?: boolean
}

export interface DirectAudiobookResult {
  readonly job: AudiobookJob
  /** The directed, voice-assigned, persisted script. */
  readonly book: Book
  readonly commandIdentity: string
}

export interface DirectAudiobookDependencies {
  readonly epubExtractor: EpubExtractor
  /**
   * Built only if direction actually runs. A director is a terminal, GPU-owning adapter, so one
   * constructed for a run that turns out to be a render-only resume would leak.
   */
  readonly directorModelFactory: DirectorModelFactory
  /**
   * Present only for its `identity`, which the command identity must bind. The engine itself is
   * built by `RenderAudiobook`, after review: at this point the approval catalog does not exist yet.
   */
  readonly speechEngineFactory: SpeechEngineFactory
  readonly audioAssembler: AudioAssembler
  readonly jobs: JobRepository
}

/**
 * Stage A of PLAN.md's two stages: EPUB to reviewed script. Extracts, directs, assigns voices from
 * the approved cast, records every fallback, persists the approved script, and leaves the job
 * **awaiting review** — it never renders.
 *
 * Direction assigns the fallback voice itself and does not stop short of assignment. That is the
 * decision recorded for prerequisite 4 in the #45 report: review approves the fallback that
 * direction chose, and `Segment.assignVoice()`'s refusal to reassign stays exactly as it is.
 */
export class DirectAudiobook {
  private readonly epubExtractor: EpubExtractor
  private readonly directorModelFactory: DirectorModelFactory
  private readonly speechEngineFactory: SpeechEngineFactory
  private readonly audioAssembler: AudioAssembler
  private readonly jobs: JobRepository

  constructor(dependencies: DirectAudiobookDependencies) {
    this.epubExtractor = dependencies.epubExtractor
    this.directorModelFactory = dependencies.directorModelFactory
    this.speechEngineFactory = dependencies.speechEngineFactory
    this.audioAssembler = dependencies.audioAssembler
    this.jobs = dependencies.jobs
  }

  commandIdentity(command: DirectAudiobookCommand): string {
    return createGenerationCommandIdentity({
      epubPath: command.epubPath,
      epubSha256: command.epubSha256,
      voices: command.voices,
      epubExtractorIdentity: this.epubExtractor.identity,
      directorIdentity: this.directorModelFactory.identity,
      speechEngineIdentity: this.speechEngineFactory.identity,
      audioAssemblerIdentity: this.audioAssembler.identity,
    })
  }

  async execute(command: DirectAudiobookCommand): Promise<DirectAudiobookResult> {
    const commandIdentity = this.commandIdentity(command)
    let job = await this.jobs.findJob(command.jobId)
    if (
      job !== undefined &&
      job.commandIdentity !== null &&
      job.commandIdentity !== commandIdentity
    ) {
      throw new DomainError('Audiobook job result is stale for the requested generation inputs')
    }
    if (job?.state === 'completed' || job?.state === 'awaiting_review') {
      throw new DomainError(
        `Audiobook job ${command.jobId} is already directed; render the approved script instead`,
      )
    }

    if (job === undefined) {
      job = new AudiobookJob(command.jobId)
      job.bindCommand(commandIdentity)
      await this.jobs.saveJob(job)
    } else if (job.commandIdentity === null) {
      job.bindCommand(commandIdentity)
    }

    if (job.state === 'pending') {
      job.start()
    } else if (job.state === 'failed') {
      job.retry()
    } else if (job.state === 'running') {
      if (command.recoverAbandoned !== true) {
        throw new DomainError('Audiobook job is already running; duplicate request rejected')
      }
      job.markAbandoned()
      await this.jobs.saveJob(job)
      job.recoverAbandoned()
    } else if (job.state === 'abandoned') {
      if (command.recoverAbandoned !== true) {
        throw new DomainError('Audiobook job is abandoned; explicit recovery is required')
      }
      job.recoverAbandoned()
    }
    // Bound before anything is produced, so a later standalone render can prove it was handed the
    // same cast, speech engine and assembler that direction ran under.
    job.bindRenderContract(
      createRenderContract({
        voices: command.voices,
        speechEngineIdentity: this.speechEngineFactory.identity,
        audioAssemblerIdentity: this.audioAssembler.identity,
      }),
    )
    await this.jobs.saveJob(job)

    try {
      const book = await this.epubExtractor.extract({ epubPath: command.epubPath })
      if (book.source.sha256 !== command.epubSha256.toLowerCase()) {
        throw new DomainError('Extracted EPUB identity does not match the generation command')
      }
      job.attachBook(book.id)
      await this.jobs.saveBook(book)
      job.beginDirection()
      await this.jobs.saveJob(job)

      await this.directBook(book, command.voices, job)
      book.assertGloballyUniqueSegmentIds()
      await this.jobs.saveBook(book)

      job.awaitReview()
      await this.jobs.saveJob(job)
      return { job, book, commandIdentity }
    } catch (error) {
      if (job.state === 'running') {
        job.fail(errorMessage(error))
        try {
          await this.jobs.saveJob(job)
        } catch {
          // Preserve the causative pipeline error; the repository already surfaced if it caused the failure.
        }
      }
      throw error
    }
  }

  private async directBook(book: Book, voices: VoiceCast, job: AudiobookJob): Promise<void> {
    // Constructed here and not in the constructor: this is the only place a director is used, and a
    // render-only resume never reaches it.
    const directorModel = await this.directorModelFactory.create()
    if (directorModel.identity !== this.directorModelFactory.identity) {
      // The command identity was already bound to the factory's value. A director that disagrees
      // would direct under inputs the job does not describe.
      await directorModel.release()
      throw new DomainError('Director identity does not match the identity its factory advertised')
    }
    let failure: unknown
    try {
      for (const chapter of book.chapters) {
        job.report(chapter.id, `Directing ${chapter.title}`)
        await this.jobs.saveJob(job)
        const directed = await directorModel.directChapter(book, chapter)
        if (directed.chapterId !== chapter.id) {
          throw new DomainError(
            `Director returned chapter ${directed.chapterId} while directing ${chapter.id}`,
          )
        }

        const segments = ExactSourceCoverage.createSegments(chapter, directed.segments)
        for (const segment of segments) {
          const resolved = voices.resolve(segment)
          segment.assignVoice(resolved.assignment)
          if (resolved.assignment.usesFallback && resolved.assignment.fallbackReason !== null) {
            job.addFallbackWarning({
              segmentId: segment.id,
              speakerId: segment.speakerId,
              voiceProfileId: resolved.profile.id,
              reason: resolved.assignment.fallbackReason,
            })
          }
        }
        chapter.submitForReview(segments)
        chapter.approve()
        book.assertGloballyUniqueSegmentIds()
        await this.jobs.saveBook(book)
        await this.jobs.saveJob(job)
      }
    } catch (error: unknown) {
      failure = error
    }
    // The director is always released, but a failing release must not mask why direction failed.
    try {
      await directorModel.release()
    } catch (error: unknown) {
      failure ??= error
    }
    if (failure !== undefined) throw failure
  }
}

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
