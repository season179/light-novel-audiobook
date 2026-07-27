import type {
  AudiobookJob,
  AudiobookOutput,
  Book,
  Chapter,
  Segment,
} from '@light-novel-audiobook/domain'
import { DomainError, type VoiceCast } from '@light-novel-audiobook/domain'
import { CompletedOutputAuthority } from './completed-output.js'
import { validateCompletedSegmentAudioMetadata } from './completed-segment-audio.js'
import { persistJobFailure } from './direct-audiobook.js'
import {
  approvalStillDescribes,
  collectFallbackSubjects,
  type PersistedFallbackApproval,
} from './fallback-approval.js'
import type {
  AssemblyChapter,
  AudioAssembler,
  CompletedSegmentAudio,
  FallbackApprovalRepository,
  JobRepository,
  SpeechEngine,
  SpeechEngineFactory,
} from './ports.js'
import { createRenderContract } from './render-contract.js'
import { createRenderInputIdentity } from './render-input-identity.js'

export interface RenderAudiobookCommand {
  readonly jobId: string
  readonly voices: VoiceCast
}

export interface RenderAudiobookResult {
  readonly job: AudiobookJob
  readonly output: AudiobookOutput
  readonly generatedSegments: number
  readonly reusedSegments: number
}

export interface RenderAudiobookDependencies {
  readonly speechEngineFactory: SpeechEngineFactory
  readonly audioAssembler: AudioAssembler
  readonly jobs: JobRepository
  readonly approvals: FallbackApprovalRepository
  readonly completedOutputs?: CompletedOutputAuthority | undefined
}

interface PlannedSegment {
  readonly chapter: Chapter
  readonly segment: Segment
  readonly inputIdentity: string
  readonly reusable: CompletedSegmentAudio | undefined
}

/**
 * Raised when the approved script still contains unresolved speakers nobody has decided.
 *
 * Carries the segment IDs so a caller can report exactly which decisions are missing, and so
 * revoking one speaker's approval is measurable rather than merely observable as a failure. This is
 * a **completeness** check; it does not replace the speech engine's own per-segment check that a
 * decision matches that segment's speaker, reason and profile.
 */
export class UnapprovedFallbackSegmentsError extends DomainError {
  override readonly name = 'UnapprovedFallbackSegmentsError'
  readonly segmentIds: readonly string[]

  constructor(segmentIds: readonly string[]) {
    const shown = segmentIds.slice(0, 5).join(', ')
    super(
      `${segmentIds.length} unresolved speaker segment(s) have no persisted fallback approval: ${shown}${
        segmentIds.length > 5 ? ', …' : ''
      }`,
    )
    this.segmentIds = Object.freeze([...segmentIds])
  }
}

/**
 * Raised when a human fallback decision moved while this render was in flight, so the audio it
 * produced is no longer the audio the live catalog authorizes.
 */
export class StaleFallbackCatalogError extends DomainError {
  override readonly name = 'StaleFallbackCatalogError'
  readonly claimedRevision: number
  readonly currentRevision: number

  constructor(claimedRevision: number, currentRevision: number) {
    super(
      `Fallback approvals changed during rendering (claimed revision ${claimedRevision}, now ${currentRevision}); this render cannot complete`,
    )
    this.claimedRevision = claimedRevision
    this.currentRevision = currentRevision
  }
}

/**
 * Raised when a standalone continuation was handed different render inputs than direction used.
 */
export class RenderContractMismatchError extends DomainError {
  override readonly name = 'RenderContractMismatchError'

  constructor(jobId: string) {
    super(
      `Audiobook job ${jobId} was directed under a different cast, speech engine or assembler; the supplied render inputs do not match its bound contract`,
    )
  }
}

/**
 * Stage B of PLAN.md's two stages: reviewed script to audiobook.
 *
 * Reads the approved script back from persistence rather than receiving it in memory, so rendering
 * after a review decision never re-runs the director. That is what makes "revoking one speaker's
 * approval invalidates only that speaker's segments" true: nothing else in a segment's content
 * address can move, because nothing else was re-derived.
 *
 * Holds no extractor and no director on purpose — a retained `GemmaDirectorModel` would pin a model
 * on the GPU for a stage that never directs, and its `release()` is terminal.
 */
export class RenderAudiobook {
  private readonly speechEngineFactory: SpeechEngineFactory
  private readonly audioAssembler: AudioAssembler
  private readonly jobs: JobRepository
  private readonly approvals: FallbackApprovalRepository
  private readonly completedOutputs: CompletedOutputAuthority

  constructor(dependencies: RenderAudiobookDependencies) {
    this.speechEngineFactory = dependencies.speechEngineFactory
    this.audioAssembler = dependencies.audioAssembler
    this.jobs = dependencies.jobs
    this.approvals = dependencies.approvals
    this.completedOutputs =
      dependencies.completedOutputs ??
      new CompletedOutputAuthority(dependencies.approvals, dependencies.jobs)
  }

  async execute(command: RenderAudiobookCommand): Promise<RenderAudiobookResult> {
    const job = await this.jobs.findJob(command.jobId)
    if (job === undefined) {
      throw new DomainError(`Audiobook job ${command.jobId} does not exist`)
    }
    // Captured into a local rather than tested through the getter: narrowing `job.state` here would
    // persist past `resumeApprovedRender()`, and the failure path below really can see 'running'.
    const initialState = job.state
    if (initialState === 'completed') {
      if (job.bookId === null) throw new DomainError('A completed job must have an attached book')
      // The same authority every other consumer uses. It does not expose a raw output: construction
      // of this return value is the authorized consumption and shares a critical section with every
      // approval mutation.
      const authorization = await this.completedOutputs.authorize(
        job,
        (output): RenderAudiobookResult => ({
          job,
          output,
          generatedSegments: 0,
          reusedSegments: job.progress.totalSegments,
        }),
      )
      if (authorization.exposable) return authorization.value
      job.reopenForReview()
      await this.jobs.saveJob(job)
    } else if (initialState !== 'awaiting_review') {
      throw new DomainError(
        `Audiobook job ${command.jobId} is ${initialState}; only a job awaiting review can be rendered`,
      )
    }
    if (job.bookId === null) throw new DomainError('A rendered job must have an attached book')

    // The read path prerequisite 2 exists for. A split render stage cannot reconstruct the approved
    // script from the job snapshot: it holds no source text and no voice assignment.
    const book = await this.jobs.findBook(job.bookId)
    if (book === undefined) {
      throw new DomainError(`Approved script for book ${job.bookId} is not persisted`)
    }
    const unapproved = book.chapters.filter((chapter) => chapter.state !== 'approved')
    if (unapproved.length > 0) {
      throw new DomainError(
        `Persisted script is not approved for chapter(s): ${unapproved.map((chapter) => chapter.id).join(', ')}`,
      )
    }

    // Claimed as one atomic read. The revision is re-checked before anything is published, so a
    // decision that lands mid-render cannot let this render complete under a withdrawn approval.
    const claimed = await this.resolveApprovals(book)
    const approvalsBySegment = claimed.approvals

    // Constructed here and nowhere earlier: the catalog is only complete once review is done, and an
    // engine built alongside the extractor and director would always carry an empty one.
    const speechEngine = await this.speechEngineFactory.create({
      bookId: book.id,
      fallbackApprovals: [...approvalsBySegment.values()],
    })
    if (speechEngine.identity !== this.speechEngineFactory.identity) {
      throw new DomainError(
        'Speech engine identity depends on its approval catalog, which would stale every job on each approval',
      )
    }

    // Verified before the job leaves its resting state, so a mismatched continuation never renders.
    const contract = createRenderContract({
      voices: command.voices,
      speechEngineIdentity: this.speechEngineFactory.identity,
      audioAssemblerIdentity: this.audioAssembler.identity,
    })
    if (job.renderContract !== null && job.renderContract !== contract) {
      throw new RenderContractMismatchError(command.jobId)
    }

    job.resumeApprovedRender()
    job.bindRenderContract(contract)
    await this.jobs.saveJob(job)

    try {
      const planned = await this.planRendering(
        book,
        command.voices,
        speechEngine,
        approvalsBySegment,
      )
      job.beginRendering(planned.length)
      await this.jobs.saveJob(job)

      const { chapters, generatedSegments, reusedSegments } = await this.render(
        book,
        command.voices,
        job,
        planned,
        speechEngine,
      )

      // The barrier, first half: nothing is assembled until the catalog this render claimed is
      // proven unmoved, so a revocation that landed during rendering stops here instead of paying
      // for an assembly it cannot publish.
      await this.assertCatalogUnmoved(book.id, claimed.revision)

      job.beginAssembly()
      await this.jobs.saveJob(job)
      const reservation = await this.jobs.reserveNextOutput(book)
      this.validateReservation(book, reservation)
      const output = await this.audioAssembler.assemble({ book, chapters, reservation })
      this.validateOutput(output, reservation)

      // The barrier, second half: re-checked as late as it can be, immediately before the job is
      // published. The revision is then recorded *with* the output, so a decision that lands in the
      // remaining instant between this check and the commit leaves the output provably stale rather
      // than silently authoritative — see the completed-job path above.
      await this.assertCatalogUnmoved(book.id, claimed.revision)
      job.complete(output, claimed.revision)
      await this.jobs.saveCompletedJob(job, output)
      return { job, output, generatedSegments, reusedSegments }
    } catch (error) {
      if (job.state === 'running') await persistJobFailure(this.jobs, job, error)
      throw error
    }
  }

  private async assertCatalogUnmoved(bookId: string, claimedRevision: number): Promise<void> {
    const current = await this.approvals.readCatalog(bookId)
    if (current.revision !== claimedRevision) {
      throw new StaleFallbackCatalogError(claimedRevision, current.revision)
    }
  }

  /**
   * The live decision for every fallback segment, refusing to start when any is missing or no
   * longer describes its segment. Failing here rather than mid-render matters: an unapproved segment
   * discovered by the engine after an hour of rendering has already burned that hour.
   */
  private async resolveApprovals(book: Book): Promise<{
    readonly revision: number
    readonly approvals: Map<string, PersistedFallbackApproval>
  }> {
    const subjects = collectFallbackSubjects(book)
    const catalog = await this.approvals.readCatalog(book.id)
    if (subjects.length === 0) {
      return { revision: catalog.revision, approvals: new Map() }
    }
    const live = new Map(catalog.approvals.map((record) => [record.segmentId, record]))
    const resolved = new Map<string, PersistedFallbackApproval>()
    const missing: string[] = []
    for (const subject of subjects) {
      const record = live.get(subject.segment.id)
      if (record === undefined || !approvalStillDescribes(record, subject)) {
        missing.push(subject.segment.id)
        continue
      }
      resolved.set(subject.segment.id, record)
    }
    if (missing.length > 0) throw new UnapprovedFallbackSegmentsError(missing)
    return { revision: catalog.revision, approvals: resolved }
  }

  private async planRendering(
    book: Book,
    voices: VoiceCast,
    speechEngine: SpeechEngine,
    approvals: ReadonlyMap<string, PersistedFallbackApproval>,
  ): Promise<readonly PlannedSegment[]> {
    const planned: PlannedSegment[] = []
    const segmentIds = new Set<string>()
    for (const chapter of book.chapters) {
      for (const segment of chapter.segments) {
        if (segmentIds.has(segment.id)) {
          throw new DomainError(`Duplicate segment map key would misassemble audio: ${segment.id}`)
        }
        segmentIds.add(segment.id)
        const assignment = segment.voiceAssignment
        if (assignment === null) throw new DomainError(`Segment ${segment.id} has no voice`)
        const voice = voices.profile(assignment.voiceProfileId)
        const inputIdentity = createRenderInputIdentity(
          segment,
          voice,
          speechEngine.identity,
          approvals.get(segment.id) ?? null,
        )
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
    speechEngine: SpeechEngine,
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
        await speechEngine.beginBatch()
        batchStarted = true
      }

      for (const chapter of book.chapters) {
        chapter.beginRendering()
        job.report(chapter.id, `Rendering ${chapter.title}`)
        await this.jobs.saveJob(job)

        const chapterItems = planned.filter((item) => item.chapter.id === chapter.id)
        try {
          for (const item of chapterItems) {
            let audio = item.reusable
            if (audio === undefined) {
              const assignment = item.segment.voiceAssignment
              if (assignment === null)
                throw new DomainError(`Segment ${item.segment.id} has no voice`)
              audio = await speechEngine.render({
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
            if (audioBySegment.has(item.segment.id)) {
              throw new DomainError(`Duplicate segment audio map key: ${item.segment.id}`)
            }
            audioBySegment.set(item.segment.id, audio)
            job.recordSegmentCompleted(item.segment.id)
            await this.jobs.saveJob(job)
          }
          chapter.markRendered()
        } catch (error) {
          if (chapter.state === 'rendering') chapter.renderingFailed()
          throw error
        }
      }
    } finally {
      if (batchStarted) await speechEngine.endBatch()
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
    if (audio.segmentId !== segmentId || audio.inputIdentity !== inputIdentity) {
      throw new DomainError(`Speech output identity mismatch for segment ${segmentId}`)
    }
    validateCompletedSegmentAudioMetadata(audio)
  }

  private validateReservation(
    book: Book,
    reservation: Awaited<ReturnType<JobRepository['reserveNextOutput']>>,
  ): void {
    const chapterIds = reservation.chapters.map((chapter) => chapter.chapterId)
    const paths = [reservation.m4bPath, ...reservation.chapters.map((chapter) => chapter.path)]
    if (
      reservation.bookId !== book.id ||
      paths.some((path) => path.trim().length === 0) ||
      new Set(paths).size !== paths.length ||
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
}
