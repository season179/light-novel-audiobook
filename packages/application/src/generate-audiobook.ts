import {
  AudiobookJob,
  type AudiobookOutput,
  type Book,
  type Chapter,
  DomainError,
  ExactSourceCoverage,
  type Segment,
  type VoiceCast,
} from '@light-novel-audiobook/domain'
import type {
  AssemblyChapter,
  AudioAssembler,
  CompletedSegmentAudio,
  DirectorModel,
  EpubExtractor,
  JobRepository,
  SpeechEngine,
} from './ports.js'
import { createRenderInputIdentity } from './render-input-identity.js'

export interface GenerateAudiobookCommand {
  readonly jobId: string
  readonly epubPath: string
  readonly voices: VoiceCast
}

export interface GenerateAudiobookResult {
  readonly job: AudiobookJob
  readonly output: AudiobookOutput
  readonly generatedSegments: number
  readonly reusedSegments: number
}

export interface GenerateAudiobookDependencies {
  readonly epubExtractor: EpubExtractor
  readonly directorModel: DirectorModel
  readonly speechEngine: SpeechEngine
  readonly audioAssembler: AudioAssembler
  readonly jobs: JobRepository
}

interface PlannedSegment {
  readonly chapter: Chapter
  readonly segment: Segment
  readonly inputIdentity: string
  readonly reusable: CompletedSegmentAudio | undefined
}

/** The single upload-to-M4B application use case. Domain rules stay in domain objects. */
export class GenerateAudiobook {
  private readonly epubExtractor: EpubExtractor
  private readonly directorModel: DirectorModel
  private readonly speechEngine: SpeechEngine
  private readonly audioAssembler: AudioAssembler
  private readonly jobs: JobRepository

  constructor(dependencies: GenerateAudiobookDependencies) {
    this.epubExtractor = dependencies.epubExtractor
    this.directorModel = dependencies.directorModel
    this.speechEngine = dependencies.speechEngine
    this.audioAssembler = dependencies.audioAssembler
    this.jobs = dependencies.jobs
  }

  async execute(command: GenerateAudiobookCommand): Promise<GenerateAudiobookResult> {
    let job = await this.jobs.findJob(command.jobId)
    if (job?.state === 'completed') {
      if (job.output === null) throw new DomainError('Completed job has no audiobook output')
      return {
        job,
        output: job.output,
        generatedSegments: 0,
        reusedSegments: job.progress.totalSegments,
      }
    }

    if (job === undefined) {
      job = new AudiobookJob(command.jobId)
      await this.jobs.saveJob(job)
    }
    if (job.state === 'pending') job.start()
    else job.restart()
    await this.jobs.saveJob(job)

    try {
      const book = await this.epubExtractor.extract({ epubPath: command.epubPath })
      job.attachBook(book.id)
      await this.jobs.saveBook(book)
      job.beginDirection()
      await this.jobs.saveJob(job)

      await this.directBook(book, command.voices, job)
      await this.jobs.saveBook(book)

      const planned = await this.planRendering(book, command.voices)
      job.beginRendering(planned.length)
      await this.jobs.saveJob(job)

      const { chapters, generatedSegments, reusedSegments } = await this.render(
        book,
        command.voices,
        job,
        planned,
      )

      job.beginAssembly()
      await this.jobs.saveJob(job)
      const reservation = await this.jobs.reserveNextOutput(book)
      this.validateReservation(book, reservation)
      const output = await this.audioAssembler.assemble({ book, chapters, reservation })
      this.validateOutput(output, reservation)

      job.complete(output)
      await this.jobs.saveBook(book)
      await this.jobs.saveJob(job)
      return { job, output, generatedSegments, reusedSegments }
    } catch (error) {
      if (job.state === 'running') {
        job.fail(this.errorMessage(error))
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
    try {
      for (const chapter of book.chapters) {
        job.report(chapter.id, `Directing ${chapter.title}`)
        await this.jobs.saveJob(job)
        const directed = await this.directorModel.directChapter(book, chapter)
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
        await this.jobs.saveBook(book)
        await this.jobs.saveJob(job)
      }
    } finally {
      await this.directorModel.release()
    }
  }

  private async planRendering(book: Book, voices: VoiceCast): Promise<readonly PlannedSegment[]> {
    const planned: PlannedSegment[] = []
    for (const chapter of book.chapters) {
      for (const segment of chapter.segments) {
        const assignment = segment.voiceAssignment
        if (assignment === null) throw new DomainError(`Segment ${segment.id} has no voice`)
        const voice = voices.profile(assignment.voiceProfileId)
        const inputIdentity = createRenderInputIdentity(segment, voice, this.speechEngine.identity)
        const reusable = await this.jobs.findReusableSegment({
          segmentId: segment.id,
          inputIdentity,
        })
        if (reusable !== undefined) this.validateAudio(reusable, segment.id, inputIdentity)
        planned.push({ chapter, segment, inputIdentity, reusable })
      }
    }
    return planned
  }

  private async render(
    book: Book,
    voices: VoiceCast,
    job: AudiobookJob,
    planned: readonly PlannedSegment[],
  ): Promise<{
    readonly chapters: readonly AssemblyChapter[]
    readonly generatedSegments: number
    readonly reusedSegments: number
  }> {
    const audioBySegment = new Map<string, CompletedSegmentAudio>()
    const missingCount = planned.filter((item) => item.reusable === undefined).length
    let batchStarted = false
    let generatedSegments = 0
    let reusedSegments = 0

    try {
      if (missingCount > 0) {
        await this.speechEngine.beginBatch()
        batchStarted = true
      }

      for (const chapter of book.chapters) {
        chapter.beginRendering()
        job.report(chapter.id, `Rendering ${chapter.title}`)
        await this.jobs.saveBook(book)
        await this.jobs.saveJob(job)

        const chapterItems = planned.filter((item) => item.chapter.id === chapter.id)
        try {
          for (const item of chapterItems) {
            let audio = item.reusable
            if (audio === undefined) {
              const assignment = item.segment.voiceAssignment
              if (assignment === null)
                throw new DomainError(`Segment ${item.segment.id} has no voice`)
              audio = await this.speechEngine.render({
                segment: item.segment,
                voice: voices.profile(assignment.voiceProfileId),
                inputIdentity: item.inputIdentity,
              })
              this.validateAudio(audio, item.segment.id, item.inputIdentity)
              await this.jobs.saveCompletedSegment(audio)
              generatedSegments += 1
            } else {
              reusedSegments += 1
            }
            audioBySegment.set(item.segment.id, audio)
            job.recordSegmentCompleted(item.segment.id)
            await this.jobs.saveJob(job)
          }
          chapter.markRendered()
          await this.jobs.saveBook(book)
        } catch (error) {
          if (chapter.state === 'rendering') chapter.renderingFailed()
          throw error
        }
      }
    } finally {
      if (batchStarted) await this.speechEngine.endBatch()
    }

    const chapters = book.chapters.map((chapter): AssemblyChapter => {
      const segments = chapter.segments.map((segment) => {
        const audio = audioBySegment.get(segment.id)
        if (audio === undefined) throw new DomainError(`Missing audio for segment ${segment.id}`)
        return { segment, audio }
      })
      return { chapter, segments }
    })
    return { chapters, generatedSegments, reusedSegments }
  }

  private validateAudio(
    audio: CompletedSegmentAudio,
    segmentId: string,
    inputIdentity: string,
  ): void {
    if (
      audio.segmentId !== segmentId ||
      audio.inputIdentity !== inputIdentity ||
      audio.wavPath.length === 0
    ) {
      throw new DomainError(`Speech output identity mismatch for segment ${segmentId}`)
    }
  }

  private validateReservation(
    book: Book,
    reservation: Awaited<ReturnType<JobRepository['reserveNextOutput']>>,
  ): void {
    const chapterIds = reservation.chapters.map((chapter) => chapter.chapterId)
    if (
      reservation.bookId !== book.id ||
      reservation.m4bPath.length === 0 ||
      chapterIds.length !== book.chapters.length ||
      chapterIds.some((id, index) => id !== book.chapters[index]?.id) ||
      reservation.chapters.some((chapter) => chapter.path.length === 0)
    ) {
      throw new DomainError('Invalid numbered output reservation')
    }
  }

  private validateOutput(
    output: AudiobookOutput,
    reservation: Awaited<ReturnType<JobRepository['reserveNextOutput']>>,
  ): void {
    if (
      output.version.value !== reservation.version.value ||
      output.m4bPath !== reservation.m4bPath ||
      output.chapters.length !== reservation.chapters.length ||
      output.chapters.some(
        (chapter, index) =>
          chapter.chapterId !== reservation.chapters[index]?.chapterId ||
          chapter.path !== reservation.chapters[index]?.path,
      )
    ) {
      throw new DomainError('Assembler did not honor its numbered output reservation')
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}
