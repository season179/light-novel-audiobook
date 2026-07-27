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
  DirectChapterOptions,
  DirectChapterProgress,
  DirectorModel,
  DirectorModelFactory,
  EpubExtractor,
  JobRepository,
  SpeechEngineFactory,
} from './ports.js'
import { createRenderContract } from './render-contract.js'
import { splitDirectedSegments, splitterIdentity } from './split-directed-segments.js'

export interface DirectAudiobookCommand {
  readonly jobId: string
  readonly epubPath: string
  readonly epubSha256: string
  readonly voices: VoiceCast
  /** Operational cancellation/deadline controls; they affect failure, never content identity. */
  readonly directorOptions?: DirectChapterOptions | undefined
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
      epubSha256: command.epubSha256,
      voices: command.voices,
      epubExtractorIdentity: this.epubExtractor.identity,
      directorIdentity: this.directorModelFactory.identity,
      speechEngineIdentity: this.speechEngineFactory.identity,
      audioAssemblerIdentity: this.audioAssembler.identity,
      splitterIdentity: splitterIdentity(),
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

    let resumedBook: Book | undefined
    if (job.state === 'pending') {
      job.start()
    } else {
      if (job.state === 'running') {
        if (command.recoverAbandoned !== true) {
          throw new DomainError('Audiobook job is already running; duplicate request rejected')
        }
        job.markAbandoned()
        await this.jobs.saveJob(job)
      }
      if (job.state === 'abandoned' && command.recoverAbandoned !== true) {
        throw new DomainError('Audiobook job is abandoned; explicit recovery is required')
      }
      if (job.state !== 'failed' && job.state !== 'abandoned') {
        throw new DomainError(`Audiobook job ${command.jobId} cannot continue direction`)
      }
      if (job.stage !== 'extracting' && job.stage !== 'directing') {
        throw new DomainError(
          `Audiobook job ${command.jobId} failed during ${job.stage}; resume that stage instead of direction`,
        )
      }
      if (job.stage === 'directing') {
        if (job.bookId === null) throw new DomainError('A directing job must have an attached book')
        resumedBook = await this.jobs.findBook(job.bookId)
        if (resumedBook === undefined) {
          throw new DomainError(`Directed book ${job.bookId} is not persisted`)
        }
        this.assertSourceIdentity(resumedBook, command.epubSha256)
        const completed = resumedBook.chapters.filter((chapter) => chapter.state === 'approved')
        job.resumeFailedStage({
          stage: 'directing',
          completedChapters: completed.length,
          totalChapters: resumedBook.chapters.length,
          completedPassages: completed.reduce(
            (total, chapter) => total + chapter.sourcePassages.length,
            0,
          ),
          totalPassages: resumedBook.chapters.reduce(
            (total, chapter) => total + chapter.sourcePassages.length,
            0,
          ),
        })
      } else {
        // Extraction has no checkpoint. Even if a save happened just before the failure, rerun the
        // deterministic extractor rather than promoting an artifact the failed stage never closed.
        job.resumeFailedStage({ stage: 'extracting' })
      }
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
      // Resume from the persisted approved script when one exists (issue #54). Direction is an
      // LLM whose delivery and speaker output is hashed into every segment's content address, and
      // it is not bit-deterministic run to run: re-directing a chapter whose script survived
      // re-renders correct audio under new identities and orphans the old WAVs. `findBook` reads
      // back exactly the chapters direction approved — approved chapters are skipped in
      // `directBook`, and only never-directed (draft) chapters cost director calls.
      let book: Book
      if (job.stage === 'directing') {
        if (resumedBook === undefined) {
          throw new DomainError('A direction resume requires its persisted book checkpoint')
        }
        book = resumedBook
      } else {
        book = await this.epubExtractor.extract({ epubPath: command.epubPath })
        if (book.source.sha256 !== command.epubSha256.toLowerCase()) {
          throw new DomainError('Extracted EPUB identity does not match the generation command')
        }
        job.attachBook(book.id)
        await this.jobs.saveBook(book)
        job.beginDirection(
          book.chapters.length,
          book.chapters.reduce((total, chapter) => total + chapter.sourcePassages.length, 0),
        )
        await this.jobs.saveJob(job)
      }

      await this.directBook(book, command.voices, job, command.directorOptions)
      book.assertGloballyUniqueSegmentIds()
      await this.jobs.saveBook(book)

      job.awaitReview()
      await this.jobs.saveJob(job)
      return { job, book, commandIdentity }
    } catch (error) {
      if (job.snapshot().state === 'running') await persistJobFailure(this.jobs, job, error)
      throw error
    }
  }

  private assertSourceIdentity(book: Book, epubSha256: string): void {
    if (book.source.sha256 !== epubSha256.toLowerCase()) {
      throw new DomainError('Persisted book EPUB identity does not match the generation command')
    }
  }

  private async directBook(
    book: Book,
    voices: VoiceCast,
    job: AudiobookJob,
    directorOptions?: DirectChapterOptions,
  ): Promise<void> {
    // Built lazily and only if a chapter actually needs directing: a resume whose script was
    // fully persisted reaches here but must not construct a terminal, GPU-owning adapter at all.
    let directorModel: DirectorModel | undefined
    const director = async (): Promise<DirectorModel> => {
      if (directorModel !== undefined) return directorModel
      const created = await this.directorModelFactory.create()
      if (created.identity !== this.directorModelFactory.identity) {
        // The command identity was already bound to the factory's value. A director that
        // disagrees would direct under inputs the job does not describe.
        await created.release()
        throw new DomainError(
          'Director identity does not match the identity its factory advertised',
        )
      }
      directorModel = created
      return created
    }

    let completedChapters = 0
    let completedPassages = 0
    let failure: unknown
    try {
      for (const chapter of book.chapters) {
        // `findBook` approves exactly the chapters whose script was persisted, so an approved
        // chapter is resumed where it stands, never re-directed. Its fallback warnings are
        // re-recorded from the persisted assignments, because recovery reset the job's warning
        // list and review reads it. Anything else must be freshly extracted (draft); refuse to
        // guess at any other state.
        if (chapter.state === 'approved') {
          for (const segment of chapter.segments) {
            const assignment = segment.voiceAssignment
            if (assignment?.usesFallback === true && assignment.fallbackReason !== null) {
              job.addFallbackWarning({
                segmentId: segment.id,
                speakerId: segment.speakerId,
                voiceProfileId: assignment.voiceProfileId,
                reason: assignment.fallbackReason,
              })
            }
          }
          completedChapters += 1
          completedPassages += chapter.sourcePassages.length
          // A resumed job was already rebased to all persisted approved chapters. Walk them to
          // rebuild warnings and local ordering, but never move its honest durable count backward.
          if (completedChapters >= (job.progress.direction?.completedChapters ?? 0)) {
            job.recordDirectionProgress(
              chapter.id,
              completedChapters,
              completedPassages,
              `Directed chapter ${completedChapters} of ${book.chapters.length}`,
            )
            await this.jobs.saveJob(job)
          }
          continue
        }
        if (chapter.state !== 'draft') {
          throw new DomainError(
            `Chapter ${chapter.id} is ${chapter.state}; only draft chapters can be directed`,
          )
        }
        job.recordDirectionProgress(
          chapter.id,
          completedChapters,
          completedPassages,
          `Directing ${chapter.title}`,
        )
        await this.jobs.saveJob(job)
        const onProgress = async (progress: DirectChapterProgress): Promise<void> => {
          if (
            progress.chapterId !== chapter.id ||
            !Number.isSafeInteger(progress.completedPassages) ||
            progress.completedPassages < 0 ||
            progress.totalPassages !== chapter.sourcePassages.length ||
            progress.completedPassages > progress.totalPassages
          ) {
            throw new DomainError('Director reported invalid passage progress')
          }
          const recordedPassages = job.progress.direction?.completedPassages ?? completedPassages
          job.recordDirectionProgress(
            chapter.id,
            completedChapters,
            Math.max(recordedPassages, completedPassages + progress.completedPassages),
            progress.message,
          )
          await this.jobs.saveJob(job)
          await directorOptions?.onProgress?.(progress)
        }
        const directed = await (await director()).directChapter(book, chapter, {
          ...directorOptions,
          onProgress,
        })
        if (directed.chapterId !== chapter.id) {
          throw new DomainError(
            `Director returned chapter ${directed.chapterId} while directing ${chapter.id}`,
          )
        }

        // Split before source coverage maps positional segment IDs: splitter policy is required in
        // command identity, so changed boundaries cannot reuse work from an older policy.
        const fragments = splitDirectedSegments(directed.segments)
        const segments = ExactSourceCoverage.createSegments(chapter, fragments)
        for (const segment of segments) {
          const resolved = voices.resolve(segment)
          segment.assignVoice(resolved.assignment)
          if (resolved.assignment.usesFallback && resolved.assignment.fallbackReason !== null) {
            job.addFallbackWarning({
              segmentId: segment.id,
              speakerId: segment.speakerId,
              voiceProfileId: resolved.profile.id,
              reason: resolved.assignment.fallbackReason,
              speakerReason:
                segment.speakerReason ??
                (resolved.assignment.fallbackReason === 'unresolved_speaker'
                  ? 'The director could not resolve a speaker from the supplied roster and context.'
                  : `Speaker ${segment.speakerId ?? 'unknown'} has no approved cast voice.`),
            })
          }
        }
        chapter.submitForReview(segments)
        chapter.approve()
        completedChapters += 1
        completedPassages += chapter.sourcePassages.length
        job.recordDirectionProgress(
          chapter.id,
          completedChapters,
          completedPassages,
          `Directed chapter ${completedChapters} of ${book.chapters.length}`,
        )
        book.assertGloballyUniqueSegmentIds()
        await this.jobs.saveBook(book)
        await this.jobs.saveJob(job)
      }
    } catch (error: unknown) {
      failure = error
    }
    // The director is always released once built, but a failing release must not mask why
    // direction failed. A resume that directed nothing never built one.
    if (directorModel !== undefined) {
      try {
        await directorModel.release()
      } catch (error: unknown) {
        failure ??= error
      }
    }
    if (failure !== undefined) throw failure
  }
}

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Preserves the caught object before reducing it to browser-safe prose. Diagnostic persistence is
 * best effort: if the artifact cannot be written, the job still fails and its message names no file.
 */
export const persistJobFailure = async (
  jobs: JobRepository,
  job: AudiobookJob,
  error: unknown,
): Promise<void> => {
  let diagnosticPath: string | undefined
  try {
    diagnosticPath = await jobs.saveFailureDiagnostic(job.id, error)
  } catch {
    // A full disk or unavailable diagnostic directory must not hide the pipeline failure.
  }
  const message =
    diagnosticPath === undefined
      ? errorMessage(error)
      : `${errorMessage(error)} Diagnostic details: ${diagnosticPath}`
  job.fail(message, diagnosticPath ?? null)
  try {
    await jobs.saveJob(job)
  } catch {
    // Preserve the causative pipeline error; the repository already surfaced if it caused the failure.
  }
}
