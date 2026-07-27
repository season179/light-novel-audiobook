import {
  AudiobookJob,
  type AudiobookJobSnapshot,
  type AudiobookOutput,
  Book,
  Chapter,
  type DirectedSegment,
  DomainError,
  ExactSourceCoverage,
  OutputVersion,
  Segment,
  SourceCoverageError,
  SourcePassage,
  StableIds,
  VoiceCast,
  VoiceProfile,
} from '@light-novel-audiobook/domain'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type AssembleAudiobookRequest,
  type AudioAssembler,
  type CompletedSegmentAudio,
  collectFallbackSubjects,
  createBookFallbackGrant,
  createGenerationCommandIdentity,
  type DirectChapterOptions,
  type DirectedChapter,
  type DirectionApprovalQuery,
  type DirectionApprovalRepository,
  type DirectorModel,
  type DirectorModelFactory,
  type EpubExtractionRequest,
  type EpubExtractor,
  GenerateAudiobook,
  type GenerateAudiobookCommand,
  type JobRepository,
  type OutputReservation,
  type PersistedDirectionApproval,
  type PersistedFallbackApproval,
  RenderAudiobook,
  type ReusableSegmentQuery,
  ReviewDirection,
  ReviewFallbackApprovals,
  resolveReviewerIdentity,
  type SpeechEngine,
  type SpeechEngineContext,
  type SpeechEngineFactory,
  type SpeechRenderRequest,
  UnconfirmedDirectionError,
  withDirectorContentIdentity,
} from '../src/index.js'
import { splitterIdentity } from '../src/split-directed-segments.js'
import { InMemoryFallbackApprovalRepository } from './support/in-memory-fallback-approvals.js'

const sourceHash = 'b'.repeat(64)
const bookId = StableIds.book(sourceHash)

const makeBook = (): Book => {
  const chapterOneId = StableIds.chapter(bookId, 1)
  const chapterTwoId = StableIds.chapter(bookId, 2)
  return new Book({
    id: bookId,
    title: 'A Small Story',
    author: 'Example Author',
    coverPath: '/workspace/cover.jpg',
    source: { epubPath: '/uploads/story.epub', sha256: sourceHash },
    chapters: [
      new Chapter({
        id: chapterOneId,
        bookId,
        position: 1,
        title: 'Dawn',
        sourcePassages: [
          new SourcePassage({
            id: StableIds.passage(chapterOneId, 1),
            chapterId: chapterOneId,
            sourceText: 'A cold dawn. “Hello,” Alice said.',
          }),
        ],
      }),
      new Chapter({
        id: chapterTwoId,
        bookId,
        position: 2,
        title: 'A Stranger',
        sourcePassages: [
          new SourcePassage({
            id: StableIds.passage(chapterTwoId, 1),
            chapterId: chapterTwoId,
            sourceText: '“Who are you?”',
          }),
        ],
      }),
    ],
  })
}

const delivery = {
  emotion: 'neutral',
  pace: 'normal' as const,
  volume: 'normal' as const,
  pauseAfterMs: 100,
}

const directionFor = (chapter: Chapter): readonly DirectedSegment[] => {
  const passageId = chapter.sourcePassages[0]?.id
  if (passageId === undefined) throw new Error('fixture passage missing')
  if (chapter.position === 1) {
    return [
      {
        sourcePassageId: passageId,
        sourceText: 'A cold dawn. ',
        kind: 'narration',
        speakerId: null,
        confidence: 1,
        delivery,
      },
      {
        sourcePassageId: passageId,
        sourceText: '“Hello,”',
        kind: 'dialogue',
        speakerId: 'alice',
        confidence: 0.99,
        delivery: { ...delivery, emotion: 'warm' },
      },
      {
        sourcePassageId: passageId,
        sourceText: ' Alice said.',
        kind: 'narration',
        speakerId: null,
        confidence: 1,
        delivery,
      },
    ]
  }
  return [
    {
      sourcePassageId: passageId,
      sourceText: '“Who are you?”',
      kind: 'dialogue',
      speakerId: null,
      confidence: 0.4,
      delivery: { ...delivery, emotion: 'wary' },
    },
  ]
}

const voice = (
  id: string,
  role: 'narrator' | 'character' | 'fallback',
  speakerId: string | null,
  revision = 1,
): VoiceProfile =>
  new VoiceProfile({
    id,
    displayName: id,
    role,
    speakerId,
    syntheticSpeaker: role === 'narrator' ? 'Aiden' : 'Ryan',
    instruction: `${id} restrained delivery revision ${revision}`,
    seed: 42,
    revision,
  })

const makeCast = (fallbackRevision = 1): VoiceCast =>
  new VoiceCast(
    voice('narrator-calm', 'narrator', null),
    voice('fallback-dialogue', 'fallback', null, fallbackRevision),
    [voice('alice-voice', 'character', 'alice')],
  )

class FakeExtractor implements EpubExtractor {
  readonly identity: string
  calls: EpubExtractionRequest[] = []

  constructor(identity = 'fake-epub-extractor:version-1:policy-1') {
    this.identity = identity
  }

  async extract(request: EpubExtractionRequest): Promise<Book> {
    this.calls.push(request)
    return makeBook()
  }
}

class FakeDirector implements DirectorModel {
  readonly identity: string
  readonly events: string[]
  readonly corrupt: boolean
  releaseCalls = 0
  failRelease = false
  failOnceOnChapterId: string | null = null
  receivedOptions: (DirectChapterOptions | undefined)[] = []

  constructor(
    events: string[],
    corrupt = false,
    identity = 'fake-gemma:model-1:prompt-1:schema-1:settings-1',
  ) {
    this.events = events
    this.corrupt = corrupt
    this.identity = identity
  }

  async directChapter(
    _book: Book,
    chapter: Chapter,
    options?: DirectChapterOptions,
  ): Promise<DirectedChapter> {
    this.receivedOptions.push(options)
    this.events.push(`direct:${chapter.id}`)
    await options?.onProgress?.({
      chapterId: chapter.id,
      state: 'started',
      completedPassages: 0,
      totalPassages: chapter.sourcePassages.length,
      message: `Started chapter ${chapter.position}`,
    })
    if (this.failOnceOnChapterId === chapter.id) {
      this.failOnceOnChapterId = null
      throw new Error('synthetic direction failure')
    }
    const segments = directionFor(chapter)
    await options?.onProgress?.({
      chapterId: chapter.id,
      state: 'completed',
      completedPassages: chapter.sourcePassages.length,
      totalPassages: chapter.sourcePassages.length,
      message: `Completed chapter ${chapter.position}`,
    })
    if (this.corrupt && chapter.position === 1) {
      const first = segments[0]
      if (first === undefined) throw new Error('fixture direction missing')
      return { chapterId: chapter.id, segments: [{ ...first, sourceText: 'Rewritten. ' }] }
    }
    return { chapterId: chapter.id, segments }
  }

  async release(): Promise<void> {
    this.releaseCalls += 1
    this.events.push('director:release')
    if (this.failRelease) throw new Error('director release failed')
  }
}

/**
 * Faithful to `QwenApplicationSpeechEngine` on the one point this issue is about: a fallback segment
 * is refused unless the catalog this engine was constructed with contains a matching decision. There
 * is deliberately no policy option that would let one through — a permissive fake is exactly what
 * hid #45 in the first place.
 */
class FakeSpeechEngine implements SpeechEngine {
  readonly identity: string
  readonly events: string[]
  renderCalls: SpeechRenderRequest[] = []
  beginCalls = 0
  endCalls = 0
  failOnceAtRenderCall: number | null = null
  returnWrongIdentity = false
  private approvals = new Map<string, PersistedFallbackApproval>()

  constructor(events: string[], identity = 'fake-qwen:model-revision-1:settings-1') {
    this.events = events
    this.identity = identity
  }

  /** Called by the factory, once per render stage, with the complete catalog for that book. */
  replaceApprovals(records: readonly PersistedFallbackApproval[]): void {
    this.approvals = new Map(records.map((record) => [record.segmentId, record]))
  }

  async beginBatch(): Promise<void> {
    this.beginCalls += 1
    this.events.push('speech:begin')
  }

  async render(request: SpeechRenderRequest): Promise<CompletedSegmentAudio> {
    this.renderCalls.push(request)
    this.events.push(`speech:${request.segment.id}`)
    const assignment = request.segment.voiceAssignment
    if (assignment?.usesFallback === true) {
      const record = this.approvals.get(request.segment.id)
      if (record === undefined) {
        throw new Error(`Fallback segment ${request.segment.id} has no explicit human approval`)
      }
      if (
        record.speakerId !== request.segment.speakerId ||
        record.fallbackReason !== assignment.fallbackReason ||
        record.voiceProfileId !== request.voice.id
      ) {
        throw new Error(
          `Fallback approval for ${request.segment.id} does not match its unresolved speaker decision`,
        )
      }
    }
    if (this.failOnceAtRenderCall === this.renderCalls.length) {
      this.failOnceAtRenderCall = null
      throw new Error('synthetic speech failure')
    }
    return {
      segmentId: request.segment.id,
      inputIdentity: this.returnWrongIdentity ? 'wrong' : request.inputIdentity,
      wavPath: `/workspace/wav/${request.segment.id}-${request.inputIdentity.slice(0, 8)}.wav`,
      sha256: 'c'.repeat(64),
      byteLength: 4096,
    }
  }

  async endBatch(): Promise<void> {
    this.endCalls += 1
    this.events.push('speech:end')
  }
}

/**
 * Shares one engine instance across render stages so per-run counters accumulate, and records every
 * catalog it was handed. `contexts` is what proves construction happened after review rather than
 * alongside the extractor and director.
 */
class FakeSpeechEngineFactory implements SpeechEngineFactory {
  readonly identity: string
  readonly engine: FakeSpeechEngine
  readonly contexts: SpeechEngineContext[] = []
  /** Simulates an adapter that wrongly folds its approval catalog into its own identity. */
  identityMovesWithCatalog = false

  constructor(engine: FakeSpeechEngine) {
    this.engine = engine
    this.identity = engine.identity
  }

  create(context: SpeechEngineContext): SpeechEngine {
    this.contexts.push(context)
    this.engine.replaceApprovals(context.fallbackApprovals)
    if (!this.identityMovesWithCatalog) return this.engine
    return new Proxy(this.engine, {
      get: (target, property, receiver) =>
        property === 'identity'
          ? `${target.identity}:${context.fallbackApprovals.length}`
          : Reflect.get(target, property, receiver),
    })
  }
}

/**
 * Rebuilds a book through the domain constructors, exactly as `SqliteJobRepository.findBook` does:
 * the approved script comes back and chapter *render* state does not. Storing the object by
 * reference instead would let `findBook` hand back chapters still marked `rendered`, which cannot
 * begin rendering again — so the fake would diverge from the adapter on the path #45 depends on.
 */
const rebuildApprovedBook = (book: Book): Book =>
  new Book({
    id: book.id,
    title: book.title,
    author: book.author,
    coverPath: book.coverPath,
    source: { epubPath: book.source.epubPath, sha256: book.source.sha256 },
    chapters: book.chapters.map((chapter) => {
      const rebuilt = new Chapter({
        id: chapter.id,
        bookId: book.id,
        position: chapter.position,
        title: chapter.title,
        sourcePassages: chapter.sourcePassages.map(
          (passage) =>
            new SourcePassage({
              id: passage.id,
              chapterId: chapter.id,
              sourceText: passage.sourceText,
            }),
        ),
      })
      if (chapter.segments.length === 0) return rebuilt
      rebuilt.submitForReview(
        chapter.segments.map((segment, index) => {
          const copy = new Segment({
            id: segment.id,
            chapterId: chapter.id,
            sourcePassageId: segment.sourcePassageId,
            order: index + 1,
            sourceText: segment.sourceText,
            kind: segment.kind,
            speakerId: segment.speakerId,
            confidence: segment.confidence,
            delivery: segment.delivery,
          })
          const assignment = segment.voiceAssignment
          if (assignment !== null) copy.assignVoice(assignment)
          return copy
        }),
      )
      rebuilt.approve()
      return rebuilt
    }),
  })

/**
 * Records how many directors were constructed. That count is the instrument for round 2's HIGH: a
 * director built for a run that turns out to be a render-only review resume is never used and never
 * released, and with Gemma that leaks a GPU-resident model.
 */
class FakeDirectorFactory implements DirectorModelFactory {
  readonly identity: string
  readonly created: DirectorModel[] = []
  private readonly inner: DirectorModel

  constructor(inner: DirectorModel) {
    this.inner = inner
    this.identity = inner.identity
  }

  create(): DirectorModel {
    this.created.push(this.inner)
    return this.inner
  }
}

class FakeAssembler implements AudioAssembler {
  readonly identity: string
  readonly events: string[]
  calls: AssembleAudiobookRequest[] = []
  failOnce = false

  constructor(events: string[], identity = 'fake-ffmpeg:aac-lc-64k:pause-policy-1') {
    this.events = events
    this.identity = identity
  }

  async assemble(request: AssembleAudiobookRequest): Promise<AudiobookOutput> {
    this.calls.push(request)
    this.events.push(`assemble:${request.reservation.version.label}`)
    if (this.failOnce) {
      this.failOnce = false
      throw new Error('synthetic assembly failure')
    }
    return {
      version: request.reservation.version,
      m4bPath: request.reservation.m4bPath,
      chapters: request.reservation.chapters,
    }
  }
}

class InMemoryDirectionApprovals implements DirectionApprovalRepository {
  readonly records: PersistedDirectionApproval[] = []

  async findDirectionApproval(
    query: DirectionApprovalQuery,
  ): Promise<PersistedDirectionApproval | undefined> {
    return this.records.find(
      (record) =>
        record.jobId === query.jobId &&
        record.bookId === query.bookId &&
        record.scriptSha256 === query.scriptSha256,
    )
  }

  async saveDirectionApproval(record: PersistedDirectionApproval): Promise<void> {
    if (!this.records.some((candidate) => candidate.approvalId === record.approvalId)) {
      this.records.push(record)
    }
  }
}

class InMemoryJobRepository implements JobRepository {
  readonly jobs = new Map<string, AudiobookJob>()
  readonly books = new Map<string, Book>()
  readonly audio = new Map<string, CompletedSegmentAudio>()
  readonly completedOutputs = new Map<string, AudiobookOutput>()
  readonly reservations: OutputReservation[] = []
  returnInvalidReusableMetadata = false
  reserveDuplicatePaths = false
  mutateFoundBook: ((book: Book) => void) | undefined
  readonly missingArtifactPaths = new Set<string>()
  readonly corruptArtifactPaths = new Set<string>()
  private readonly versionByBook = new Map<string, number>()
  private readonly reservedPaths = new Set<string>()

  async findJob(jobId: string): Promise<AudiobookJob | undefined> {
    return this.jobs.get(jobId)
  }

  async saveJob(job: AudiobookJob): Promise<void> {
    this.jobs.set(job.id, AudiobookJob.reconstitute(job.snapshot()))
    if (job.state !== 'completed') this.completedOutputs.delete(job.id)
  }

  async saveFailureDiagnostic(): Promise<undefined> {
    return undefined
  }

  async saveCompletedJob(job: AudiobookJob, output: AudiobookOutput): Promise<void> {
    this.jobs.set(job.id, AudiobookJob.reconstitute(job.snapshot()))
    this.completedOutputs.set(job.id, output)
  }

  async findCompletedOutput(jobId: string): Promise<AudiobookOutput | undefined> {
    return this.completedOutputs.get(jobId)
  }

  async saveBook(book: Book): Promise<void> {
    this.books.set(book.id, rebuildApprovedBook(book))
  }

  async findBook(bookId: string): Promise<Book | undefined> {
    const stored = this.books.get(bookId)
    if (stored === undefined) return undefined
    const rebuilt = rebuildApprovedBook(stored)
    this.mutateFoundBook?.(rebuilt)
    return rebuilt
  }

  async findReusableSegment(
    query: ReusableSegmentQuery,
  ): Promise<CompletedSegmentAudio | undefined> {
    const reusable = this.audio.get(this.audioKey(query.segmentId, query.inputIdentity))
    if (
      reusable === undefined ||
      this.missingArtifactPaths.has(reusable.wavPath) ||
      this.corruptArtifactPaths.has(reusable.wavPath)
    ) {
      return undefined
    }
    if (!this.returnInvalidReusableMetadata) return reusable
    return { ...reusable, sha256: 'invalid-hash' }
  }

  async saveCompletedSegment(segment: CompletedSegmentAudio): Promise<void> {
    this.audio.set(this.audioKey(segment.segmentId, segment.inputIdentity), segment)
  }

  async reserveNextOutput(book: Book): Promise<OutputReservation> {
    const next = (this.versionByBook.get(book.id) ?? 0) + 1
    this.versionByBook.set(book.id, next)
    const version = new OutputVersion(next)
    const base = book.title.replaceAll(' ', '-')
    const reservation: OutputReservation = {
      bookId: book.id,
      version,
      m4bPath: `/workspace/${version.fileName(base, 'm4b')}`,
      chapters: book.chapters.map((chapter) => ({
        chapterId: chapter.id,
        path: this.reserveDuplicatePaths
          ? `/workspace/${version.fileName(base, 'm4b')}`
          : `/workspace/${base}-${version.label}-ch${String(chapter.position).padStart(2, '0')}.flac`,
      })),
    }
    const paths = [reservation.m4bPath, ...reservation.chapters.map((chapter) => chapter.path)]
    if (paths.some((path) => this.reservedPaths.has(path))) throw new Error('output overwrite')
    for (const path of paths) this.reservedPaths.add(path)
    this.reservations.push(reservation)
    return reservation
  }

  private audioKey(segmentId: string, inputIdentity: string): string {
    return `${segmentId}:${inputIdentity}`
  }
}

interface Harness {
  readonly events: string[]
  readonly extractor: FakeExtractor
  readonly director: FakeDirector
  readonly directorFactory: FakeDirectorFactory
  readonly speech: FakeSpeechEngine
  readonly speechFactory: FakeSpeechEngineFactory
  readonly assembler: FakeAssembler
  readonly repository: InMemoryJobRepository
  readonly approvals: InMemoryFallbackApprovalRepository
  readonly directionApprovals: InMemoryDirectionApprovals
  readonly review: ReviewFallbackApprovals
  readonly directionReview: ReviewDirection
  readonly rendering: RenderAudiobook
  readonly useCase: GenerateAudiobook
}

const REVIEWER = resolveReviewerIdentity({ LNA_REVIEWER: 'local-reviewer' })

/** Test-only composition of the now-separate user actions. Production has no such one-call path. */
const generate = async (app: Harness, command: GenerateAudiobookCommand) => {
  let job = await app.repository.findJob(command.jobId)
  if (
    job?.commandIdentity !== null &&
    job?.commandIdentity !== undefined &&
    job.commandIdentity !== app.useCase.commandIdentity(command)
  ) {
    throw new DomainError('Audiobook job result is stale for the requested generation inputs')
  }
  let recordedFallbackApprovals = 0
  if (job?.state !== 'awaiting_review' && job?.state !== 'completed') {
    const directed = await app.useCase.execute(command)
    job = directed.job
    recordedFallbackApprovals += directed.recordedFallbackApprovals.length
  }
  if (job === undefined) throw new Error('direction did not persist a job')
  if (job.state === 'awaiting_review') {
    const items = await app.review.list(command.jobId)
    if (items.some((item) => item.decision !== 'approved')) {
      const reconciled = await app.review.grantBookFallback({
        jobId: command.jobId,
        decidedBy: REVIEWER,
      })
      recordedFallbackApprovals += reconciled.created.length
    }
    await app.directionReview.confirm({ jobId: command.jobId, decidedBy: REVIEWER })
  }
  const rendered = await app.rendering.execute({ jobId: command.jobId, voices: command.voices })
  return { ...rendered, recordedFallbackApprovals }
}

/** Fixed so a recorded decision time is reproducible and identities are stable across runs. */
const DECIDED_AT = new Date('2026-07-25T09:00:00.000Z')

const harness = (
  options: {
    corruptDirection?: boolean
    extractorIdentity?: string
    directorIdentity?: string
    speechIdentity?: string
    assemblerIdentity?: string
    now?: () => Date
  } = {},
): Harness => {
  const events: string[] = []
  const extractor = new FakeExtractor(options.extractorIdentity)
  const director = new FakeDirector(events, options.corruptDirection, options.directorIdentity)
  const directorFactory = new FakeDirectorFactory(director)
  const speech = new FakeSpeechEngine(events, options.speechIdentity)
  const speechFactory = new FakeSpeechEngineFactory(speech)
  const assembler = new FakeAssembler(events, options.assemblerIdentity)
  const repository = new InMemoryJobRepository()
  const approvals = new InMemoryFallbackApprovalRepository()
  const directionApprovals = new InMemoryDirectionApprovals()
  const review = new ReviewFallbackApprovals({
    jobs: repository,
    approvals,
    now: options.now ?? ((): Date => DECIDED_AT),
  })
  const directionReview = new ReviewDirection({
    jobs: repository,
    approvals: directionApprovals,
    now: options.now ?? ((): Date => DECIDED_AT),
  })
  return {
    events,
    extractor,
    director,
    directorFactory,
    speech,
    speechFactory,
    assembler,
    repository,
    approvals,
    directionApprovals,
    review,
    directionReview,
    rendering: new RenderAudiobook({
      speechEngineFactory: speechFactory,
      audioAssembler: assembler,
      jobs: repository,
      approvals,
      directionApprovals,
    }),
    useCase: new GenerateAudiobook({
      epubExtractor: extractor,
      directorModelFactory: directorFactory,
      speechEngineFactory: speechFactory,
      audioAssembler: assembler,
      jobs: repository,
      approvals,
      now: options.now ?? ((): Date => DECIDED_AT),
    }),
  }
}

describe('GenerateAudiobook with in-memory boundary fakes', () => {
  let app: Harness

  beforeEach(() => {
    app = harness()
  })

  it('orchestrates the complete exact-text happy path and exposes useful progress', async () => {
    const result = await generate(app, {
      jobId: 'job-001',
      epubPath: '/uploads/story.epub',
      epubSha256: sourceHash,
      voices: makeCast(),
    })

    expect(result.job.state).toBe('completed')
    expect(result.job.stage).toBe('completed')
    expect(result.job.progress).toMatchObject({ completedSegments: 4, totalSegments: 4 })
    expect(result.generatedSegments).toBe(4)
    expect(result.reusedSegments).toBe(0)
    expect(result.output.version.label).toBe('v001')
    expect(result.output.m4bPath).toBe('/workspace/A-Small-Story-v001.m4b')
    expect(result.job.warnings).toEqual([
      expect.objectContaining({
        speakerId: null,
        voiceProfileId: 'fallback-dialogue',
        reason: 'unresolved_speaker',
      }),
    ])

    expect(app.extractor.calls).toEqual([{ epubPath: '/uploads/story.epub' }])
    expect(app.director.releaseCalls).toBe(1)
    expect(app.speech.beginCalls).toBe(1)
    expect(app.speech.endCalls).toBe(1)
    expect(app.events.indexOf('director:release')).toBeLessThan(app.events.indexOf('speech:begin'))
    expect(app.assembler.calls).toHaveLength(1)

    const assembled = app.assembler.calls[0]
    expect(assembled?.chapters.map((chapter) => chapter.chapter.state)).toEqual([
      'rendered',
      'rendered',
    ])
    expect(
      assembled?.chapters.flatMap((chapter) =>
        chapter.segments.map((item) => item.segment.sourceText),
      ),
    ).toEqual(['A cold dawn. ', '“Hello,”', ' Alice said.', '“Who are you?”'])
    expect(
      assembled?.chapters.flatMap((chapter) =>
        chapter.segments.map((item) => item.audio.segmentId),
      ),
    ).toEqual(
      assembled?.chapters.flatMap((chapter) => chapter.segments.map((item) => item.segment.id)),
    )
  })

  it('resolving the final fallback decision does not start audio', async () => {
    const command = {
      jobId: 'job-last-fallback-still-rests',
      epubPath: '/uploads/story.epub',
      epubSha256: sourceHash,
      voices: makeCast(),
    }
    const directed = await app.useCase.execute(command)
    expect(directed.pendingFallbackApprovals).toHaveLength(1)

    const decided = await app.review.grantBookFallback({
      jobId: command.jobId,
      decidedBy: REVIEWER,
    })

    expect(decided.pending).toEqual([])
    expect((await app.repository.findJob(command.jobId))?.state).toBe('awaiting_review')
    expect(app.speech.renderCalls).toHaveLength(0)
    expect(app.assembler.calls).toHaveLength(0)
  })

  it('refuses direct application-service rendering without exact-script confirmation', async () => {
    const command = {
      jobId: 'job-unconfirmed-application-call',
      epubPath: '/uploads/story.epub',
      epubSha256: sourceHash,
      voices: makeCast(),
    }
    await app.useCase.execute(command)
    await app.review.grantBookFallback({ jobId: command.jobId, decidedBy: REVIEWER })

    await expect(
      app.rendering.execute({ jobId: command.jobId, voices: command.voices }),
    ).rejects.toThrow(UnconfirmedDirectionError)
    expect((await app.repository.findJob(command.jobId))?.state).toBe('awaiting_review')
    expect(app.speech.renderCalls).toHaveLength(0)
  })

  it('invalidates confirmation when one reviewed segment changes', async () => {
    const command = {
      jobId: 'job-stale-direction-confirmation',
      epubPath: '/uploads/story.epub',
      epubSha256: sourceHash,
      voices: makeCast(),
    }
    await app.useCase.execute(command)
    await app.review.grantBookFallback({ jobId: command.jobId, decidedBy: REVIEWER })
    await app.directionReview.confirm({ jobId: command.jobId, decidedBy: REVIEWER })
    const stored = app.repository.books.get(bookId)
    const segment = stored?.chapters[0]?.segments[0]
    if (segment === undefined) throw new Error('fixture segment missing')
    Object.defineProperty(segment, 'delivery', {
      value: Object.freeze({ ...segment.delivery, emotion: 'changed-review-direction' }),
    })

    await expect(
      app.rendering.execute({ jobId: command.jobId, voices: command.voices }),
    ).rejects.toThrow(UnconfirmedDirectionError)
    expect(app.speech.renderCalls).toHaveLength(0)
  })

  it('never lets a confirmation waive source-fidelity failure', async () => {
    const command = {
      jobId: 'job-confirmed-but-not-faithful',
      epubPath: '/uploads/story.epub',
      epubSha256: sourceHash,
      voices: makeCast(),
    }
    await app.useCase.execute(command)
    await app.review.grantBookFallback({ jobId: command.jobId, decidedBy: REVIEWER })
    await app.directionReview.confirm({ jobId: command.jobId, decidedBy: REVIEWER })
    app.repository.mutateFoundBook = (book) => {
      const segment = book.chapters[0]?.segments[0]
      if (segment === undefined) throw new Error('fixture segment missing')
      Object.defineProperty(segment, 'sourceText', { value: 'Invented replacement.' })
    }

    await expect(
      app.rendering.execute({ jobId: command.jobId, voices: command.voices }),
    ).rejects.toBeInstanceOf(SourceCoverageError)
    expect(app.speech.renderCalls).toHaveLength(0)
  })

  it('makes no approval decision but materializes records from an existing human grant', async () => {
    const command: GenerateAudiobookCommand = {
      jobId: 'job-existing-human-grant',
      epubPath: '/uploads/story.epub',
      epubSha256: sourceHash,
      voices: makeCast(),
    }

    const directed = await app.useCase.execute(command)
    expect(directed.job.state).toBe('awaiting_review')
    expect(directed.pendingFallbackApprovals).toHaveLength(1)
    const undecided = await app.approvals.readCatalog(bookId)
    expect(undecided.grant).toBeUndefined()
    expect(undecided.approvals).toEqual([])

    const storedBook = await app.repository.findBook(bookId)
    if (storedBook === undefined) throw new Error('directed fixture book missing')
    const subjects = collectFallbackSubjects(storedBook).map((subject) => ({
      segmentId: subject.segment.id,
      speakerId: subject.speakerId,
      fallbackReason: subject.fallbackReason,
      voiceProfileId: subject.voiceProfileId,
      sourceTextSha256: subject.sourceTextSha256,
    }))
    await app.approvals.saveBookGrant(
      createBookFallbackGrant({
        bookId,
        decidedBy: REVIEWER,
        decidedAt: DECIDED_AT.toISOString(),
        subjects,
      }),
    )
    const result = await app.review.reconcile({ book: storedBook, warnings: directed.job.warnings })
    expect(result.created).toHaveLength(1)
    const materialized = await app.approvals.readCatalog(bookId)
    expect(materialized.grant?.decidedBy).toBe(REVIEWER)
    expect(materialized.approvals).toHaveLength(1)
    expect(materialized.approvals[0]?.decidedBy).toBe(REVIEWER)
  })

  it('forwards operational director options and records passage progress, not segments', async () => {
    const controller = new AbortController()
    const progressEvents: number[] = []
    const command: GenerateAudiobookCommand = {
      jobId: 'job-options',
      epubPath: '/uploads/story.epub',
      epubSha256: sourceHash,
      voices: makeCast(),
      directorOptions: {
        signal: controller.signal,
        timeoutMs: 42_000,
        onProgress: (progress) => {
          progressEvents.push(progress.completedPassages)
        },
      },
    }
    const result = await generate(app, command)

    expect(result.job.state).toBe('completed')
    expect(result.job.progress.direction).toEqual({
      completedChapters: 2,
      totalChapters: 2,
      completedPassages: 2,
      totalPassages: 2,
    })
    expect(result.job.progress.totalSegments).toBe(4)
    expect(progressEvents).toEqual([0, 1, 0, 1])
    expect(app.director.receivedOptions).toHaveLength(2)
    for (const received of app.director.receivedOptions) {
      expect(received?.timeoutMs).toBe(42_000)
      expect(received?.signal).toBe(controller.signal)
    }
    const repeat = await generate(app, { ...command, directorOptions: undefined })
    expect(repeat.output.m4bPath).toBe(result.output.m4bPath)
  })

  it('reuses every unchanged completed segment and reserves successive outputs without overwrite', async () => {
    const first = await generate(app, {
      jobId: 'job-first',
      epubPath: '/uploads/story.epub',
      epubSha256: sourceHash,
      voices: makeCast(),
    })
    const renderCallsAfterFirst = app.speech.renderCalls.length
    const second = await generate(app, {
      jobId: 'job-second',
      epubPath: '/uploads/story.epub',
      epubSha256: sourceHash,
      voices: makeCast(),
    })

    expect(first.output.version.label).toBe('v001')
    expect(second.output.version.label).toBe('v002')
    expect(second.generatedSegments).toBe(0)
    expect(second.reusedSegments).toBe(4)
    expect(app.speech.renderCalls).toHaveLength(renderCallsAfterFirst)
    expect(app.speech.beginCalls).toBe(1)
    expect(app.repository.reservations.map((item) => item.m4bPath)).toEqual([
      '/workspace/A-Small-Story-v001.m4b',
      '/workspace/A-Small-Story-v002.m4b',
    ])
    expect(new Set(app.repository.reservations.map((item) => item.m4bPath)).size).toBe(2)
  })

  it('does not rerun or reserve another output when the same completed job is requested again', async () => {
    const first = await generate(app, {
      jobId: 'job-idempotent',
      epubPath: '/uploads/story.epub',
      epubSha256: sourceHash,
      voices: makeCast(),
    })
    const calls = {
      extract: app.extractor.calls.length,
      direct: app.events.filter((event) => event.startsWith('direct:')).length,
      render: app.speech.renderCalls.length,
      assemble: app.assembler.calls.length,
    }
    const repeated = await generate(app, {
      jobId: 'job-idempotent',
      epubPath: '/uploads/story.epub',
      epubSha256: sourceHash,
      voices: makeCast(),
    })

    expect(repeated.output.m4bPath).toBe(first.output.m4bPath)
    expect(app.extractor.calls).toHaveLength(calls.extract)
    expect(app.events.filter((event) => event.startsWith('direct:'))).toHaveLength(calls.direct)
    expect(app.speech.renderCalls).toHaveLength(calls.render)
    expect(app.assembler.calls).toHaveLength(calls.assemble)
    expect(app.repository.reservations).toHaveLength(1)
  })

  it('does not expose a completed output after its approval catalog moves', async () => {
    const command: GenerateAudiobookCommand = {
      jobId: 'job-revoked-completed-fast-path',
      epubPath: '/uploads/story.epub',
      epubSha256: sourceHash,
      voices: makeCast(),
    }
    await generate(app, command)
    const review = await app.review.list(command.jobId)
    const fallback = review.find((item) => item.decision === 'approved')
    if (fallback === undefined) throw new Error('fixture produced no approved fallback segment')
    const assembliesBeforeRevocation = app.assembler.calls.length

    // Construct the durable residue of a catalog commit whose best-effort job reopen did not land.
    // The public render operation must refuse it even when no web projection ran first.
    await app.approvals.revoke(bookId, fallback.segmentId, {
      reason: 'human-withdrawal',
      decidedBy: REVIEWER,
      decidedAt: DECIDED_AT.toISOString(),
    })

    await expect(
      app.rendering.execute({ jobId: command.jobId, voices: command.voices }),
    ).rejects.toThrow('no persisted fallback approval')
    const reopened = await app.repository.findJob(command.jobId)
    expect(reopened?.state).toBe('awaiting_review')
    expect(reopened?.catalogRevision).toBeNull()
    expect(app.assembler.calls).toHaveLength(assembliesBeforeRevocation)
  })

  it('resumes a completed job when only the upload path changes, and still rejects changed inputs', async () => {
    await generate(app, {
      jobId: 'job-bound-inputs',
      epubPath: '/uploads/story.epub',
      epubSha256: sourceHash,
      voices: makeCast(),
    })
    const extractionCount = app.extractor.calls.length

    // Issue #54 item 3: the upload path is where the EPUB sat, not what it is. A web upload that
    // lands in a fresh temp path per attempt must resume, not wedge. Pre-fix this rejected with
    // 'stale for the requested generation inputs'.
    const renamed = await generate(app, {
      jobId: 'job-bound-inputs',
      epubPath: '/tmp/upload-9f2k1-renamed.epub',
      epubSha256: sourceHash,
      voices: makeCast(),
    })
    expect(renamed.job.state).toBe('completed')
    expect(renamed.output.m4bPath).toBe('/workspace/A-Small-Story-v001.m4b')
    expect(renamed.reusedSegments).toBe(4)
    expect(app.extractor.calls).toHaveLength(extractionCount)

    // The content hash still binds: a different EPUB under the same job stays stale.
    await expect(
      generate(app, {
        jobId: 'job-bound-inputs',
        epubPath: '/uploads/story.epub',
        epubSha256: 'e'.repeat(64),
        voices: makeCast(),
      }),
    ).rejects.toThrow('stale for the requested generation inputs')
    await expect(
      generate(app, {
        jobId: 'job-bound-inputs',
        epubPath: '/uploads/story.epub',
        epubSha256: sourceHash,
        voices: makeCast(2),
      }),
    ).rejects.toThrow('stale for the requested generation inputs')

    const changedExtractor = new FakeExtractor('fake-epub-extractor:version-2:policy-1')
    const changedExtractorUseCase = new GenerateAudiobook({
      epubExtractor: changedExtractor,
      directorModelFactory: app.directorFactory,
      speechEngineFactory: app.speechFactory,
      audioAssembler: app.assembler,
      jobs: app.repository,
      approvals: app.approvals,
    })
    await expect(
      changedExtractorUseCase.execute({
        jobId: 'job-bound-inputs',
        epubPath: '/uploads/story.epub',
        epubSha256: sourceHash,
        voices: makeCast(),
      }),
    ).rejects.toThrow('stale for the requested generation inputs')
    expect(changedExtractor.calls).toHaveLength(0)

    const changedSpeech = new FakeSpeechEngine(app.events, 'fake-qwen:model-revision-2:settings-1')
    const changedUseCase = new GenerateAudiobook({
      epubExtractor: app.extractor,
      directorModelFactory: app.directorFactory,
      speechEngineFactory: new FakeSpeechEngineFactory(changedSpeech),
      audioAssembler: app.assembler,
      jobs: app.repository,
      approvals: app.approvals,
    })
    await expect(
      changedUseCase.execute({
        jobId: 'job-bound-inputs',
        epubPath: '/uploads/story.epub',
        epubSha256: sourceHash,
        voices: makeCast(),
      }),
    ).rejects.toThrow('stale for the requested generation inputs')

    expect(app.extractor.calls).toHaveLength(extractionCount)
    expect(app.repository.reservations).toHaveLength(1)
  })

  it('includes extractor, director, and assembly settings in deterministic command identity', () => {
    const identity = (
      epubExtractorIdentity: string,
      directorIdentity: string,
      audioAssemblerIdentity: string,
    ) =>
      createGenerationCommandIdentity({
        epubSha256: sourceHash,
        voices: makeCast(),
        epubExtractorIdentity,
        directorIdentity,
        speechEngineIdentity: app.speech.identity,
        audioAssemblerIdentity,
        splitterIdentity: splitterIdentity(),
      })
    const original = identity(app.extractor.identity, app.director.identity, app.assembler.identity)
    expect(
      identity('changed-extractor-policy', app.director.identity, app.assembler.identity),
    ).not.toBe(original)
    expect(
      identity(app.extractor.identity, 'changed-director-settings', app.assembler.identity),
    ).not.toBe(original)
    expect(
      identity(app.extractor.identity, app.director.identity, 'changed-assembly-settings'),
    ).not.toBe(original)
  })

  it('excludes the upload path from the command identity while still binding the content hash', () => {
    const base = {
      epubSha256: sourceHash,
      voices: makeCast(),
      epubExtractorIdentity: app.extractor.identity,
      directorIdentity: app.director.identity,
      speechEngineIdentity: app.speech.identity,
      audioAssemblerIdentity: app.assembler.identity,
      splitterIdentity: splitterIdentity(),
    }
    const identity = createGenerationCommandIdentity(base)
    // No path input exists to vary; the same content inputs must hash identically across calls.
    expect(createGenerationCommandIdentity({ ...base })).toBe(identity)
    expect(createGenerationCommandIdentity({ ...base, epubSha256: 'e'.repeat(64) })).not.toBe(
      identity,
    )
    expect(
      createGenerationCommandIdentity({ ...base, directorIdentity: 'other-director' }),
    ).not.toBe(identity)
  })

  it('rejects an active duplicate request and only recovers with explicit abandonment', async () => {
    const voices = makeCast()
    const identity = createGenerationCommandIdentity({
      epubSha256: sourceHash,
      voices,
      epubExtractorIdentity: app.extractor.identity,
      directorIdentity: app.director.identity,
      speechEngineIdentity: app.speech.identity,
      audioAssemblerIdentity: app.assembler.identity,
      splitterIdentity: splitterIdentity(),
    })
    const active = new AudiobookJob('job-active')
    active.bindCommand(identity)
    active.start()
    await app.repository.saveJob(active)

    await expect(
      generate(app, {
        jobId: 'job-active',
        epubPath: '/uploads/story.epub',
        epubSha256: sourceHash,
        voices,
      }),
    ).rejects.toThrow('already running; duplicate request rejected')
    expect(app.extractor.calls).toHaveLength(0)

    const recovered = await generate(app, {
      jobId: 'job-active',
      epubPath: '/uploads/story.epub',
      epubSha256: sourceHash,
      voices,
      recoverAbandoned: true,
    })
    expect(recovered.job.state).toBe('completed')
    expect(app.extractor.calls).toHaveLength(1)
  })

  it('invalidates only audio whose approved voice inputs changed', async () => {
    await generate(app, {
      jobId: 'job-original-cast',
      epubPath: '/uploads/story.epub',
      epubSha256: sourceHash,
      voices: makeCast(1),
    })
    const changed = await generate(app, {
      jobId: 'job-changed-fallback',
      epubPath: '/uploads/story.epub',
      epubSha256: sourceHash,
      voices: makeCast(2),
    })

    expect(changed.generatedSegments).toBe(1)
    expect(changed.reusedSegments).toBe(3)
    expect(app.speech.renderCalls).toHaveLength(5)
    expect(app.speech.renderCalls.at(-1)?.voice.id).toBe('fallback-dialogue')
  })

  it('resumes after a render failure and reuses segments completed before the failure', async () => {
    app.speech.failOnceAtRenderCall = 3
    await expect(
      generate(app, {
        jobId: 'job-resume',
        epubPath: '/uploads/story.epub',
        epubSha256: sourceHash,
        voices: makeCast(),
      }),
    ).rejects.toThrow('synthetic speech failure')

    const failedJob = app.repository.jobs.get('job-resume')
    expect(failedJob?.state).toBe('failed')
    expect(failedJob?.progress.completedSegments).toBe(2)
    expect(app.repository.audio.size).toBe(2)
    expect(app.speech.endCalls).toBe(1)

    const resumed = await generate(app, {
      jobId: 'job-resume',
      epubPath: '/uploads/story.epub',
      epubSha256: sourceHash,
      voices: makeCast(),
    })
    expect(resumed.job.state).toBe('completed')
    expect(resumed.reusedSegments).toBe(2)
    expect(resumed.generatedSegments).toBe(2)
    expect(app.speech.endCalls).toBe(2)
  })

  it('resumes assembly with zero TTS and a new numbered reservation', async () => {
    const command = {
      jobId: 'job-resume-assembly',
      epubPath: '/uploads/story.epub',
      epubSha256: sourceHash,
      voices: makeCast(),
    }
    app.assembler.failOnce = true
    await expect(generate(app, command)).rejects.toThrow('synthetic assembly failure')
    const failed = await app.repository.findJob(command.jobId)
    expect(failed?.stage).toBe('assembling')
    const speechCalls = app.speech.renderCalls.length
    const engineConstructions = app.speechFactory.contexts.length
    expect(app.repository.reservations.map((item) => item.version.value)).toEqual([1])

    const resumed = await app.rendering.execute({ jobId: command.jobId, voices: command.voices })

    expect(resumed.job.state).toBe('completed')
    expect(resumed.generatedSegments).toBe(0)
    expect(resumed.reusedSegments).toBe(4)
    expect(app.speech.renderCalls).toHaveLength(speechCalls)
    expect(app.speechFactory.contexts).toHaveLength(engineConstructions)
    expect(app.repository.reservations.map((item) => item.version.value)).toEqual([1, 2])
    expect(resumed.output.m4bPath).not.toBe(app.repository.reservations[0]?.m4bPath)
  })

  it('refuses a rendering resume after its exact-script confirmation is gone', async () => {
    const command = {
      jobId: 'job-resume-render-unconfirmed',
      epubPath: '/uploads/story.epub',
      epubSha256: sourceHash,
      voices: makeCast(),
    }
    app.speech.failOnceAtRenderCall = 3
    await expect(generate(app, command)).rejects.toThrow('synthetic speech failure')
    expect((await app.repository.findJob(command.jobId))?.stage).toBe('rendering')
    const speechCalls = app.speech.renderCalls.length
    app.directionApprovals.records.splice(0)

    await expect(
      app.rendering.execute({ jobId: command.jobId, voices: command.voices }),
    ).rejects.toThrow(UnconfirmedDirectionError)
    expect(app.speech.renderCalls).toHaveLength(speechCalls)
    expect((await app.repository.findJob(command.jobId))?.state).toBe('failed')
  })

  it('resumes when the director moved hosts, and still stales when its content identity moved', async () => {
    // Issue #54 item 2: a real director hashes its baseUrl and GPU lease lock path into its
    // self-reported identity. The composition root wraps it with a content-only identity, so a
    // brain-port move or lock-file move between crash and resume must not wedge the job.
    const voices = makeCast()
    const contentIdentity = 'gemma-content:model-1:prompt-1:schema-1:settings-1'
    const wrapped = (adapterIdentity: string): DirectorModel & { inner: FakeDirector } => {
      const inner = new FakeDirector(app.events, false, adapterIdentity)
      return Object.assign(withDirectorContentIdentity(inner, contentIdentity), { inner })
    }
    const makeUseCase = (directorModel: DirectorModel): GenerateAudiobook =>
      new GenerateAudiobook({
        epubExtractor: app.extractor,
        directorModelFactory: new FakeDirectorFactory(directorModel),
        speechEngineFactory: app.speechFactory,
        audioAssembler: app.assembler,
        jobs: app.repository,
        approvals: app.approvals,
      })

    app.speech.failOnceAtRenderCall = 3
    const command = {
      jobId: 'job-moved-director',
      epubPath: '/uploads/story.epub',
      epubSha256: sourceHash,
      voices,
      directorOptions: { timeoutMs: 42_000 },
    }
    const firstDirector = wrapped('gemma-self-hash:http://gpu-box:8080:/run/lease-a.lock')
    const firstUseCase = makeUseCase(firstDirector)
    // Direction always stops; the human decisions then let the separate render operation run.
    const firstDirection = await firstUseCase.execute(command)
    expect(firstDirection.job.state).toBe('awaiting_review')
    expect(firstDirector.inner.receivedOptions).toHaveLength(2)
    expect(firstDirector.inner.receivedOptions.every((item) => item?.timeoutMs === 42_000)).toBe(
      true,
    )
    await app.review.grantBookFallback({ jobId: command.jobId, decidedBy: REVIEWER })
    await app.directionReview.confirm({ jobId: command.jobId, decidedBy: REVIEWER })
    await expect(app.rendering.execute({ jobId: command.jobId, voices })).rejects.toThrow(
      'synthetic speech failure',
    )

    // Same content, different self-reported adapter identity (host/port/lock path moved): resumes.
    await makeUseCase(
      wrapped('gemma-self-hash:http://localhost:9999:/var/lock/lease-b.lock'),
    ).execute(command)
    const resumed = await app.rendering.execute({ jobId: command.jobId, voices })
    expect(resumed.job.state).toBe('completed')
    expect(resumed.reusedSegments).toBe(2)

    // A genuinely different direction content identity still stales the job.
    const redirected = withDirectorContentIdentity(
      new FakeDirector(app.events),
      'gemma-content:model-2:prompt-2:schema-1:settings-1',
    )
    await expect(makeUseCase(redirected).execute(command)).rejects.toThrow(
      'stale for the requested generation inputs',
    )
  })

  // Issue #54 item 1. Pre-fix (#45 without this patch), the resume below re-extracted and
  // re-directed BOTH chapters before rendering reused anything: this test then fails with 2 new
  // direct events, 1 new extractor call and 1 new director construction.
  it('resumes a render-stage crash without re-extracting or re-directing any chapter', async () => {
    const command = {
      jobId: 'job-resume-render',
      epubPath: '/uploads/story.epub',
      epubSha256: sourceHash,
      voices: makeCast(),
    }
    app.speech.failOnceAtRenderCall = 3
    await expect(generate(app, command)).rejects.toThrow('synthetic speech failure')
    expect(app.repository.jobs.get(command.jobId)?.state).toBe('failed')
    const directCalls = app.events.filter((event) => event.startsWith('direct:')).length
    const extractCalls = app.extractor.calls.length
    const directorBuilds = app.directorFactory.created.length
    expect({ directCalls, extractCalls, directorBuilds }).toEqual({
      directCalls: 2,
      extractCalls: 1,
      directorBuilds: 1,
    })

    const resumed = await generate(app, command)

    expect(resumed.job.state).toBe('completed')
    expect(resumed.reusedSegments).toBe(2)
    expect(resumed.generatedSegments).toBe(2)
    // The whole point, measured by director calls rather than log lines: zero new directions, zero
    // extractions — and the terminal, GPU-owning adapter is not even constructed, because
    // direction's output is hashed into every segment's content address and re-running it would
    // restale audio the ledger already holds (llama.cpp is not bit-deterministic run to run).
    expect(app.events.filter((event) => event.startsWith('direct:'))).toHaveLength(2)
    expect(app.extractor.calls).toHaveLength(1)
    expect(app.directorFactory.created).toHaveLength(1)
  })

  // Issue #54 item 1, mid-direction axis: a crash while directing chapter 2 of 2 must resume by
  // directing ONLY chapter 2 — chapter 1's approved script is persisted and skipped.
  it('resumes a direction-stage crash directing only the chapters never directed', async () => {
    const command = {
      jobId: 'job-resume-direction',
      epubPath: '/uploads/story.epub',
      epubSha256: sourceHash,
      voices: makeCast(),
    }
    const chapterTwoId = StableIds.chapter(bookId, 2)
    app.director.failOnceOnChapterId = chapterTwoId
    await expect(generate(app, command)).rejects.toThrow('synthetic direction failure')
    expect(app.repository.jobs.get(command.jobId)?.state).toBe('failed')
    expect(app.events.filter((event) => event.startsWith('direct:'))).toHaveLength(2)
    expect(app.extractor.calls).toHaveLength(1)
    expect(app.directorFactory.created).toHaveLength(1)

    const resumed = await generate(app, command)

    expect(resumed.job.state).toBe('completed')
    // One new director call (chapter 2), never a second crack at chapter 1, no re-extraction.
    expect(app.events.filter((event) => event.startsWith('direct:'))).toHaveLength(3)
    expect(
      app.events.filter((event) => event === `direct:${StableIds.chapter(bookId, 1)}`),
    ).toHaveLength(1)
    expect(app.extractor.calls).toHaveLength(1)
    expect(app.directorFactory.created).toHaveLength(2)
  })

  it('loads and resumes a hand-built schema-v4 failed-direction checkpoint', async () => {
    const base = makeBook()
    const chapters = [...base.chapters]
    for (const position of [3, 4]) {
      const chapterId = StableIds.chapter(bookId, position)
      chapters.push(
        new Chapter({
          id: chapterId,
          bookId,
          position,
          title: `Synthetic chapter ${position}`,
          sourcePassages: [
            new SourcePassage({
              id: StableIds.passage(chapterId, 1),
              chapterId,
              sourceText: '“Who are you?”',
            }),
          ],
        }),
      )
    }
    const partial = new Book({
      id: base.id,
      title: base.title,
      author: base.author,
      coverPath: base.coverPath,
      source: base.source,
      chapters,
    })
    const voices = makeCast()
    for (const chapter of partial.chapters.slice(0, 3)) {
      const segments = ExactSourceCoverage.createSegments(chapter, directionFor(chapter))
      for (const segment of segments) segment.assignVoice(voices.resolve(segment).assignment)
      chapter.submitForReview(segments)
      chapter.approve()
    }
    await app.repository.saveBook(partial)
    const command = {
      jobId: 'job-legacy-v4-partial-direction',
      epubPath: '/uploads/story.epub',
      epubSha256: sourceHash,
      voices,
    }
    const legacySnapshot = {
      schemaVersion: 4,
      id: command.jobId,
      state: 'failed',
      stage: 'directing',
      commandIdentity: app.useCase.commandIdentity(command),
      renderContract: null,
      catalogRevision: null,
      bookId,
      progress: {
        currentChapterId: partial.chapters[3]?.id ?? null,
        completedSegments: 0,
        totalSegments: 0,
        latestMessage: 'Synthetic direction interruption',
      },
      warnings: [],
      error: 'Synthetic direction interruption',
    } as const
    app.repository.jobs.set(
      command.jobId,
      AudiobookJob.reconstitute(legacySnapshot as unknown as AudiobookJobSnapshot),
    )
    const loadedLegacy = await app.repository.findJob(command.jobId)
    expect(loadedLegacy?.stage).toBe('directing')
    expect(loadedLegacy?.progress.direction).toBeNull()

    const resumed = await app.useCase.execute(command)

    expect(resumed.job.state).toBe('awaiting_review')
    expect(resumed.job.progress.direction?.completedChapters).toBe(4)
    expect(app.extractor.calls).toHaveLength(0)
    expect(app.events.filter((event) => event.startsWith('direct:'))).toEqual([
      `direct:${partial.chapters[3]?.id}`,
    ])
    expect(await app.directionReview.findCurrent(command.jobId)).toBeUndefined()
  })

  // Issue #54 item 1 meets the review gate: the resumed direction must still STOP at
  // awaiting_review when decisions are missing — skipping direction is not skipping review.
  it('stops a resumed direction at the review gate when decisions are still missing', async () => {
    const chapterTwoId = StableIds.chapter(bookId, 2)
    app.director.failOnceOnChapterId = chapterTwoId
    const command = {
      jobId: 'job-resume-into-gate',
      epubPath: '/uploads/story.epub',
      epubSha256: sourceHash,
      voices: makeCast(),
    }
    await expect(app.useCase.execute(command)).rejects.toThrow('synthetic direction failure')

    const stopped = await app.useCase.execute(command)
    expect(stopped.job.state).toBe('awaiting_review')
    expect(stopped.pendingFallbackApprovals).toHaveLength(1)
    expect(app.repository.jobs.get(command.jobId)?.state).toBe('awaiting_review')
    // Chapter 1 was directed once, before the crash; the resume directed only chapter 2.
    expect(
      app.events.filter((event) => event === `direct:${StableIds.chapter(bookId, 1)}`),
    ).toHaveLength(1)
  })

  it('rejects an extractor result whose content hash differs from the bound EPUB', async () => {
    await expect(
      generate(app, {
        jobId: 'job-epub-mismatch',
        epubPath: '/uploads/story.epub',
        epubSha256: 'f'.repeat(64),
        voices: makeCast(),
      }),
    ).rejects.toThrow('Extracted EPUB identity does not match')
    expect(app.repository.jobs.get('job-epub-mismatch')?.state).toBe('failed')
    expect(app.director.releaseCalls).toBe(0)
  })

  it('rejects malformed reusable artifact metadata before speech', async () => {
    await generate(app, {
      jobId: 'job-valid-artifacts',
      epubPath: '/uploads/story.epub',
      epubSha256: sourceHash,
      voices: makeCast(),
    })
    const renderCalls = app.speech.renderCalls.length
    app.repository.returnInvalidReusableMetadata = true

    await expect(
      generate(app, {
        jobId: 'job-invalid-artifact-metadata',
        epubPath: '/uploads/story.epub',
        epubSha256: sourceHash,
        voices: makeCast(),
      }),
    ).rejects.toThrow('SHA-256 is invalid')
    expect(app.speech.renderCalls).toHaveLength(renderCalls)
    expect(app.repository.jobs.get('job-invalid-artifact-metadata')?.state).toBe('failed')
  })

  it('regenerates artifacts the repository reports physically missing or corrupt', async () => {
    await generate(app, {
      jobId: 'job-physical-artifacts',
      epubPath: '/uploads/story.epub',
      epubSha256: sourceHash,
      voices: makeCast(),
    })
    const artifacts = [...app.repository.audio.values()]
    const missing = artifacts[0]
    const corrupt = artifacts[1]
    if (missing === undefined || corrupt === undefined) throw new Error('fixture artifacts missing')
    app.repository.missingArtifactPaths.add(missing.wavPath)
    app.repository.corruptArtifactPaths.add(corrupt.wavPath)

    const recovered = await generate(app, {
      jobId: 'job-physical-artifacts-recovered',
      epubPath: '/uploads/story.epub',
      epubSha256: sourceHash,
      voices: makeCast(),
    })
    expect(recovered.generatedSegments).toBe(2)
    expect(recovered.reusedSegments).toBe(2)
  })

  it('rejects output reservations with colliding M4B and chapter paths', async () => {
    app.repository.reserveDuplicatePaths = true
    await expect(
      generate(app, {
        jobId: 'job-duplicate-paths',
        epubPath: '/uploads/story.epub',
        epubSha256: sourceHash,
        voices: makeCast(),
      }),
    ).rejects.toThrow('Invalid numbered output reservation')
    expect(app.assembler.calls).toHaveLength(0)
    expect(app.repository.jobs.get('job-duplicate-paths')?.state).toBe('failed')
  })

  it('rejects source fidelity failures before speech and persists a failed job', async () => {
    app = harness({ corruptDirection: true })
    await expect(
      generate(app, {
        jobId: 'job-bad-source',
        epubPath: '/uploads/story.epub',
        epubSha256: sourceHash,
        voices: makeCast(),
      }),
    ).rejects.toBeInstanceOf(SourceCoverageError)

    expect(app.director.releaseCalls).toBe(1)
    expect(app.speech.beginCalls).toBe(0)
    expect(app.speech.renderCalls).toHaveLength(0)
    expect(app.assembler.calls).toHaveLength(0)
    expect(app.repository.jobs.get('job-bad-source')?.state).toBe('failed')
    expect(app.repository.jobs.get('job-bad-source')?.error).toContain(
      'rewritten, omitted, or duplicated',
    )
  })

  it('keeps the causative direction failure when releasing the director also fails', async () => {
    app = harness({ corruptDirection: true })
    app.director.failRelease = true
    await expect(
      generate(app, {
        jobId: 'job-release-failure',
        epubPath: '/uploads/story.epub',
        epubSha256: sourceHash,
        voices: makeCast(),
      }),
    ).rejects.toBeInstanceOf(SourceCoverageError)

    expect(app.director.releaseCalls).toBe(1)
    expect(app.repository.jobs.get('job-release-failure')?.error).toContain(
      'rewritten, omitted, or duplicated',
    )
  })

  it('rejects mismatched speech artifacts, ends the batch, and never assembles them', async () => {
    app.speech.returnWrongIdentity = true
    await expect(
      generate(app, {
        jobId: 'job-bad-audio',
        epubPath: '/uploads/story.epub',
        epubSha256: sourceHash,
        voices: makeCast(),
      }),
    ).rejects.toThrow('Speech output identity mismatch')

    expect(app.speech.endCalls).toBe(1)
    expect(app.repository.audio.size).toBe(0)
    expect(app.assembler.calls).toHaveLength(0)
    expect(app.repository.jobs.get('job-bad-audio')?.state).toBe('failed')
  })
})
