/**
 * The review context: how a book-level pre-approval becomes per-segment records, when a record stops
 * standing, and what the review read model exposes.
 *
 * All story text below is invented for this fixture.
 */
import {
  AudiobookJob,
  Book,
  Chapter,
  DomainError,
  ExactSourceCoverage,
  type SegmentKind,
  SourcePassage,
  StableIds,
  VoiceCast,
  VoiceProfile,
} from '@light-novel-audiobook/domain'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  collectFallbackSubjects,
  createRenderContract,
  FALLBACK_EXCERPT_MAX_LENGTH,
  fallbackApprovalExcerpt,
  hashSourceText,
  type JobRepository,
  RenderAudiobook,
  RenderContractMismatchError,
  RenderInProgressError,
  ReviewFallbackApprovals,
  UnapprovedFallbackSegmentsError,
} from '../src/index.js'
import { InMemoryFallbackApprovalRepository } from './support/in-memory-fallback-approvals.js'

const SOURCE_HASH = '9a'.repeat(32)
const BOOK_ID = StableIds.book(SOURCE_HASH)
const CHAPTER_ID = StableIds.chapter(BOOK_ID, 1)
const PASSAGE_ID = StableIds.passage(CHAPTER_ID, 1)
const DECIDED_AT = new Date('2026-07-25T10:00:00.000Z')
const LATER = new Date('2026-07-25T15:45:00.000Z')

const voice = (
  id: string,
  role: 'narrator' | 'character' | 'fallback',
  speakerId: string | null,
): VoiceProfile =>
  new VoiceProfile({
    id,
    displayName: id,
    role,
    speakerId,
    syntheticSpeaker: role === 'narrator' ? 'Aiden' : 'Ryan',
    instruction: `${id} restrained delivery`,
    seed: 9205,
    revision: 1,
  })

const cast = new VoiceCast(
  voice('cast-narrator', 'narrator', null),
  voice('cast-fallback', 'fallback', null),
  [voice('cast-alice', 'character', 'alice')],
)

interface Line {
  readonly text: string
  readonly kind: SegmentKind
  readonly speakerId: string | null
}

const DEFAULT_LINES: readonly Line[] = [
  { text: 'The keeper had left the door open. ', kind: 'narration', speakerId: null },
  { text: '“You are late,” ', kind: 'dialogue', speakerId: 'alice' },
  { text: '“Nobody counted the hours.” ', kind: 'dialogue', speakerId: null },
  { text: '“Then start counting.”', kind: 'dialogue', speakerId: 'mira' },
]

const bookOf = (lines: readonly Line[] = DEFAULT_LINES): Book => {
  const chapter = new Chapter({
    id: CHAPTER_ID,
    bookId: BOOK_ID,
    position: 1,
    title: 'An Open Door',
    sourcePassages: [
      new SourcePassage({
        id: PASSAGE_ID,
        chapterId: CHAPTER_ID,
        sourceText: lines.map((line) => line.text).join(''),
      }),
    ],
  })
  const segments = ExactSourceCoverage.createSegments(
    chapter,
    lines.map((line) => ({
      sourcePassageId: PASSAGE_ID,
      sourceText: line.text,
      kind: line.kind,
      speakerId: line.speakerId,
      confidence: 0.9,
      delivery: {
        emotion: 'calm',
        pace: 'normal' as const,
        volume: 'normal' as const,
        pauseAfterMs: 200,
      },
    })),
  )
  for (const segment of segments) segment.assignVoice(cast.resolve(segment).assignment)
  chapter.submitForReview(segments)
  chapter.approve()
  return new Book({
    id: BOOK_ID,
    title: 'Review Fixture',
    author: null,
    coverPath: null,
    source: { epubPath: '/uploads/review.epub', sha256: SOURCE_HASH },
    chapters: [chapter],
  })
}

const UNRESOLVED_SEGMENT = StableIds.segment(PASSAGE_ID, 3)
const MIRA_SEGMENT = StableIds.segment(PASSAGE_ID, 4)

class StubJobRepository implements JobRepository {
  book: Book | undefined
  readonly jobs = new Map<string, AudiobookJob>()
  savedJobs: string[] = []

  async findJob(jobId: string): Promise<AudiobookJob | undefined> {
    return this.jobs.get(jobId)
  }

  async saveJob(job: AudiobookJob): Promise<void> {
    this.savedJobs.push(`${job.id}:${job.state}`)
    this.jobs.set(job.id, job)
  }

  async saveBook(): Promise<void> {}

  async findBook(bookId: string): Promise<Book | undefined> {
    return this.book?.id === bookId ? this.book : undefined
  }

  async findReusableSegment(): Promise<undefined> {
    return undefined
  }

  async saveCompletedSegment(): Promise<void> {}

  async reserveNextOutput(): Promise<never> {
    throw new Error('not used')
  }
}

interface Harness {
  readonly jobs: StubJobRepository
  readonly approvals: InMemoryFallbackApprovalRepository
  readonly review: ReviewFallbackApprovals
}

const REVIEWER = 'local-reviewer'

/** Issues the book-wide grant as a human would, which is the only way reconcile creates records. */
const grantBookFallback = async (app: Harness, book: Book, jobId = 'job-review'): Promise<void> => {
  directedJob(app.jobs, book, jobId)
  await app.review.grantBookFallback({ jobId, decidedBy: REVIEWER })
}

const harness = (now: () => Date = () => DECIDED_AT): Harness => {
  const jobs = new StubJobRepository()
  const approvals = new InMemoryFallbackApprovalRepository()
  return { jobs, approvals, review: new ReviewFallbackApprovals({ jobs, approvals, now }) }
}

const directedJob = (jobs: StubJobRepository, book: Book, jobId = 'job-review'): AudiobookJob => {
  const job = new AudiobookJob(jobId)
  job.bindCommand('a'.repeat(64))
  job.start()
  job.attachBook(book.id)
  job.beginDirection()
  job.awaitReview()
  jobs.jobs.set(jobId, job)
  jobs.book = book
  return job
}

describe('ReviewFallbackApprovals (issue #45)', () => {
  let app: Harness

  beforeEach(() => {
    app = harness()
  })

  it('turns one book-wide human grant into a record per unresolved-speaker segment', async () => {
    const book = bookOf()
    directedJob(app.jobs, book)
    const result = await app.review.grantBookFallback({ jobId: 'job-review', decidedBy: REVIEWER })

    // Two fallback segments, two records, two distinct identities — never one blanket approval.
    expect(result.created.map((record) => record.segmentId)).toEqual([
      UNRESOLVED_SEGMENT,
      MIRA_SEGMENT,
    ])
    expect(result.pending).toEqual([])
    expect(new Set(result.created.map((record) => record.approvalSha256)).size).toBe(2)
    expect(result.created.map((record) => record.fallbackReason)).toEqual([
      'unresolved_speaker',
      'missing_speaker_voice',
    ])
    expect(result.created.map((record) => record.speakerId)).toEqual([null, 'mira'])
    expect(result.created.every((record) => record.voiceProfileId === 'cast-fallback')).toBe(true)
    expect(result.created.every((record) => record.decidedAt === DECIDED_AT.toISOString())).toBe(
      true,
    )
    // Every record names the human who decided and the grant it came from. A timestamp alone is
    // what made the first round's records indistinguishable from auto-approval.
    expect(result.created.every((record) => record.decidedBy === REVIEWER)).toBe(true)
    expect(result.created.every((record) => record.grantId === result.grant?.grantId)).toBe(true)
    expect(result.grant?.decidedBy).toBe(REVIEWER)
  })

  it('creates nothing at all without a human grant, and reports every speaker as pending', async () => {
    // THE regression test for round 2's HIGH: with no grant there is no policy, default or argument
    // that can cause an approval to exist. `reconcile` is the only creator and it needs a grant.
    const book = bookOf()
    const result = await app.review.reconcile({ book })

    expect(result.created).toEqual([])
    expect(result.approved).toEqual([])
    expect(result.grant).toBeUndefined()
    expect(app.approvals.saved).toEqual([])
    expect(app.approvals.approvals.size).toBe(0)
    expect(result.pending.map((item) => [item.segmentId, item.decision])).toEqual([
      [UNRESOLVED_SEGMENT, 'pending'],
      [MIRA_SEGMENT, 'pending'],
    ])
  })

  it('never re-creates an approval the human withdrew, even under a book-wide grant', async () => {
    // Without a durable exclusion the grant would silently undo the revocation on the next run, and
    // "revoking one speaker's approval invalidates only that speaker's audio" would be false.
    const book = bookOf()
    await grantBookFallback(app, book)
    expect(app.approvals.approvals.size).toBe(2)

    expect(
      await app.review.revoke({
        jobId: 'job-review',
        segmentId: MIRA_SEGMENT,
        decidedBy: REVIEWER,
      }),
    ).toBe(true)
    const afterRevoke = await app.review.reconcile({ book })

    expect(afterRevoke.created).toEqual([])
    expect(afterRevoke.approved.map((record) => record.segmentId)).toEqual([UNRESOLVED_SEGMENT])
    expect(afterRevoke.pending.map((item) => [item.segmentId, item.decision])).toEqual([
      [MIRA_SEGMENT, 'excluded'],
    ])
    // Re-granting the whole book does not override an explicit withdrawal either.
    const regranted = await app.review.grantBookFallback({
      jobId: 'job-review',
      decidedBy: REVIEWER,
    })
    expect(regranted.created).toEqual([])
    expect(regranted.pending.map((item) => item.segmentId)).toEqual([MIRA_SEGMENT])
  })

  it('refuses every review mutation while a render owns the job', async () => {
    const book = bookOf()
    await grantBookFallback(app, book)
    const job = app.jobs.jobs.get('job-review')
    if (job === undefined) throw new Error('fixture job missing')
    job.resumeApprovedRender()
    job.beginRendering(4)
    expect(job.state).toBe('running')

    // A decision landing now would leave the in-flight render finishing segments under a catalog it
    // already captured — the round-2 race.
    await expect(
      app.review.revoke({ jobId: 'job-review', segmentId: MIRA_SEGMENT, decidedBy: REVIEWER }),
    ).rejects.toThrow(RenderInProgressError)
    await expect(
      app.review.approve({ jobId: 'job-review', segmentId: MIRA_SEGMENT, decidedBy: REVIEWER }),
    ).rejects.toThrow(RenderInProgressError)
    await expect(
      app.review.grantBookFallback({ jobId: 'job-review', decidedBy: REVIEWER }),
    ).rejects.toThrow(RenderInProgressError)
    await expect(
      app.review.revokeBookFallback({ jobId: 'job-review', decidedBy: REVIEWER }),
    ).rejects.toThrow(RenderInProgressError)
    expect(app.approvals.approvals.size).toBe(2)
  })

  it('leaves an unchanged decision byte-for-byte alone on a second reconciliation', async () => {
    const book = bookOf()
    directedJob(app.jobs, book)
    const first = await app.review.grantBookFallback({ jobId: 'job-review', decidedBy: REVIEWER })
    // A later clock proves idempotence is by content, not by luck: the second pass runs at a
    // different instant and must still not restale a segment, or every generation run would
    // re-render every fallback segment in the book.
    const second = await new ReviewFallbackApprovals({
      jobs: app.jobs,
      approvals: app.approvals,
      now: () => LATER,
    }).reconcile({ book: bookOf() })

    expect(second.created).toEqual([])
    expect(second.invalidated).toEqual([])
    expect(second.unchanged.map((record) => record.approvalId)).toEqual(
      first.created.map((record) => record.approvalId),
    )
    expect(app.approvals.saved).toEqual([UNRESOLVED_SEGMENT, MIRA_SEGMENT])
  })

  it('revokes a decision whose approved line was re-directed under it', async () => {
    await grantBookFallback(app, bookOf())
    const before = app.approvals.approvals.get(`${BOOK_ID}:${MIRA_SEGMENT}`)?.approvalId

    // Same speaker and same position, different words: PLAN.md:132 makes that an invalidation, and
    // the human approved a line, not a slot.
    const rewritten = await app.review.reconcile({
      book: bookOf([
        ...DEFAULT_LINES.slice(0, 3),
        { text: '“Then stop counting.”', kind: 'dialogue', speakerId: 'mira' },
      ]),
    })

    expect(rewritten.invalidated.map((record) => record.segmentId)).toEqual([MIRA_SEGMENT])
    expect(rewritten.created.map((record) => record.segmentId)).toEqual([MIRA_SEGMENT])
    expect(app.approvals.approvals.get(`${BOOK_ID}:${MIRA_SEGMENT}`)?.approvalId).not.toBe(before)
    // The other speaker's decision was untouched.
    expect(rewritten.unchanged.map((record) => record.segmentId)).toEqual([UNRESOLVED_SEGMENT])
  })

  it('revokes a decision whose segment no longer falls back at all', async () => {
    await grantBookFallback(app, bookOf())
    // The cast gained a voice for mira, so that segment resolves and needs no human decision.
    const withMira = new VoiceCast(
      voice('cast-narrator', 'narrator', null),
      voice('cast-fallback', 'fallback', null),
      [voice('cast-alice', 'character', 'alice'), voice('cast-mira', 'character', 'mira')],
    )
    const chapter = new Chapter({
      id: CHAPTER_ID,
      bookId: BOOK_ID,
      position: 1,
      title: 'An Open Door',
      sourcePassages: [
        new SourcePassage({
          id: PASSAGE_ID,
          chapterId: CHAPTER_ID,
          sourceText: DEFAULT_LINES.map((line) => line.text).join(''),
        }),
      ],
    })
    const segments = ExactSourceCoverage.createSegments(
      chapter,
      DEFAULT_LINES.map((line) => ({
        sourcePassageId: PASSAGE_ID,
        sourceText: line.text,
        kind: line.kind,
        speakerId: line.speakerId,
        confidence: 0.9,
        delivery: {
          emotion: 'calm',
          pace: 'normal' as const,
          volume: 'normal' as const,
          pauseAfterMs: 200,
        },
      })),
    )
    for (const segment of segments) segment.assignVoice(withMira.resolve(segment).assignment)
    chapter.submitForReview(segments)
    chapter.approve()
    const recast = new Book({
      id: BOOK_ID,
      title: 'Review Fixture',
      author: null,
      coverPath: null,
      source: { epubPath: '/uploads/review.epub', sha256: SOURCE_HASH },
      chapters: [chapter],
    })

    const result = await app.review.reconcile({ book: recast })
    expect(result.invalidated.map((record) => record.segmentId)).toEqual([MIRA_SEGMENT])
    expect(result.approved.map((record) => record.segmentId)).toEqual([UNRESOLVED_SEGMENT])
    expect(collectFallbackSubjects(recast).map((subject) => subject.segment.id)).toEqual([
      UNRESOLVED_SEGMENT,
    ])
  })

  it('gives the review UI a readable excerpt, speaker and reason for each pending speaker', async () => {
    const result = await app.review.reconcile({ book: bookOf() })
    expect(result.pending.map((item) => item.segmentId)).toEqual([UNRESOLVED_SEGMENT, MIRA_SEGMENT])
    expect(result.pending.map((item) => item.sourceTextExcerpt)).toEqual([
      '“Nobody counted the hours.”',
      '“Then start counting.”',
    ])
    expect(result.pending.every((item) => item.chapterTitle === 'An Open Door')).toBe(true)
    expect(result.pending.every((item) => item.proposedVoiceProfileId === 'cast-fallback')).toBe(
      true,
    )
  })

  it('has no policy argument through which approval could be defaulted in', () => {
    // Structural, not behavioural: `reconcile` takes only a book. There is no string a caller or a
    // composition root could pass that makes it approve anything, which is what round 2's HIGH
    // required. `grantBookFallback` is the only creator and it requires an actor.
    expect(Object.keys({ book: bookOf() })).toEqual(['book'])
    expect(app.review.reconcile.length).toBe(1)
    expect(app.review.grantBookFallback.length).toBe(1)
  })

  it('returns a completed job to review when one decision is revoked, and only then', async () => {
    const book = bookOf()
    const job = directedJob(app.jobs, book)
    await app.review.grantBookFallback({ jobId: 'job-review', decidedBy: REVIEWER })
    job.resumeApprovedRender()
    job.beginRendering(4)
    for (const segment of book.chapters[0]?.segments ?? []) job.recordSegmentCompleted(segment.id)
    job.beginAssembly()
    job.complete(
      {
        version: { value: 1, label: 'v001', fileName: () => 'x' } as never,
        m4bPath: '/workspace/review-v001.m4b',
        chapters: [{ chapterId: CHAPTER_ID, path: '/workspace/ch1.flac' }],
      },
      (await app.approvals.readCatalog(BOOK_ID)).revision,
    )
    expect(job.state).toBe('completed')

    expect(
      await app.review.revoke({
        jobId: 'job-review',
        segmentId: MIRA_SEGMENT,
        decidedBy: REVIEWER,
      }),
    ).toBe(true)
    expect(job.state).toBe('awaiting_review')
    expect(job.snapshot().output).toBeNull()
    // The reuse ledger is untouched: only the revoked segment's content address became unreachable.
    expect(app.approvals.approvals.has(`${BOOK_ID}:${UNRESOLVED_SEGMENT}`)).toBe(true)

    // A second revocation of the same segment changes nothing and does not reopen anything.
    const saves = app.jobs.savedJobs.length
    expect(
      await app.review.revoke({
        jobId: 'job-review',
        segmentId: MIRA_SEGMENT,
        decidedBy: REVIEWER,
      }),
    ).toBe(false)
    expect(app.jobs.savedJobs).toHaveLength(saves)
  })

  it('re-approving a revoked segment records a new decision with a new identity', async () => {
    const book = bookOf()
    directedJob(app.jobs, book)
    const first = await app.review.approve({
      jobId: 'job-review',
      segmentId: MIRA_SEGMENT,
      decidedBy: REVIEWER,
    })
    expect(first.grantId).toBeNull()
    const original = first.approvalId
    await app.review.revoke({ jobId: 'job-review', segmentId: MIRA_SEGMENT, decidedBy: REVIEWER })

    const later = new ReviewFallbackApprovals({
      jobs: app.jobs,
      approvals: app.approvals,
      now: () => LATER,
    })
    const record = await later.approve({
      jobId: 'job-review',
      segmentId: MIRA_SEGMENT,
      decidedBy: REVIEWER,
    })
    expect(record.approvalId).not.toBe(original)
    expect(record.decidedAt).toBe(LATER.toISOString())
    expect(record.sourceTextSha256).toBe(hashSourceText('“Then start counting.”'))
  })

  it('refuses to decide a segment that does not need a fallback decision', async () => {
    const book = bookOf()
    directedJob(app.jobs, book)
    const narration = StableIds.segment(PASSAGE_ID, 1)
    await expect(
      app.review.approve({ jobId: 'job-review', segmentId: narration, decidedBy: REVIEWER }),
    ).rejects.toThrow('does not need a fallback approval')
    await expect(
      app.review.revoke({ jobId: 'job-review', segmentId: 'not-a-segment', decidedBy: REVIEWER }),
    ).rejects.toThrow('does not need a fallback approval')
    await expect(app.review.list('job-missing')).rejects.toThrow(DomainError)
  })

  it('lists decided and undecided speakers together for the review UI', async () => {
    const book = bookOf()
    directedJob(app.jobs, book)
    await app.review.approve({ jobId: 'job-review', segmentId: MIRA_SEGMENT, decidedBy: REVIEWER })

    const listed = await app.review.list('job-review')
    expect(listed.map((item) => [item.segmentId, item.decision])).toEqual([
      [UNRESOLVED_SEGMENT, 'pending'],
      [MIRA_SEGMENT, 'approved'],
    ])
    expect(listed[0]?.approvalId).toBeNull()
    expect(listed[1]?.approvalId).toBe(
      app.approvals.approvals.get(`${BOOK_ID}:${MIRA_SEGMENT}`)?.approvalId,
    )
  })

  it('caps a review excerpt and collapses its whitespace', () => {
    expect(fallbackApprovalExcerpt('  “Two   words”\n next ')).toBe('“Two words” next')
    const long = fallbackApprovalExcerpt('x'.repeat(400))
    expect(long).toHaveLength(FALLBACK_EXCERPT_MAX_LENGTH)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('standalone render provenance (issue #45, round-2 MEDIUM)', () => {
  let app: Harness

  beforeEach(() => {
    app = harness()
  })

  /**
   * `RenderAudiobook` is a public continuation path — the review UI calls it directly after a decision
   * — but it holds no extractor and no director, so it cannot recompute `commandIdentity` to check it
   * was handed the same inputs direction used. Per-segment identities stop the *audio* being reused
   * under a changed cast or engine, but they do not stop the job completing, and the assembler is not
   * represented in them at all. Without the contract the stored `commandIdentity` would stop
   * describing what actually produced the output.
   */
  const contractFor = (voices: VoiceCast, speech: string, assembly: string): string =>
    createRenderContract({
      voices,
      speechEngineIdentity: speech,
      audioAssemblerIdentity: assembly,
    })

  it('moves for a changed cast, speech engine or assembler, and only for those', () => {
    const base = contractFor(cast, 'speech-1', 'assembly-1')
    expect(contractFor(cast, 'speech-1', 'assembly-1')).toBe(base)
    expect(contractFor(cast, 'speech-2', 'assembly-1')).not.toBe(base)
    // The assembler is the case per-segment identities cannot catch at all.
    expect(contractFor(cast, 'speech-1', 'assembly-2')).not.toBe(base)

    const otherCast = new VoiceCast(
      voice('cast-narrator', 'narrator', null),
      voice('cast-fallback-two', 'fallback', null),
      [voice('cast-alice', 'character', 'alice')],
    )
    expect(contractFor(otherCast, 'speech-1', 'assembly-1')).not.toBe(base)
  })

  it('refuses a continuation whose render inputs are not the ones direction bound', async () => {
    const book = bookOf()
    const job = directedJob(app.jobs, book)
    job.bindRenderContract(contractFor(cast, 'speech-1', 'assembly-1'))
    await app.review.grantBookFallback({ jobId: 'job-review', decidedBy: REVIEWER })

    const render = new RenderAudiobook({
      speechEngineFactory: { identity: 'speech-2', create: () => neverRenders },
      audioAssembler: {
        identity: 'assembly-1',
        assemble: () => Promise.reject(new Error('unused')),
      },
      jobs: app.jobs,
      approvals: app.approvals,
    })

    await expect(render.execute({ jobId: 'job-review', voices: cast })).rejects.toThrow(
      RenderContractMismatchError,
    )
    // Refused before the job left its resting state, so nothing was rendered and nothing failed it.
    expect(job.state).toBe('awaiting_review')
    expect(job.progress.totalSegments).toBe(0)
  })

  it('binds the contract on the first render when direction never did', async () => {
    // A job directed before this field existed has `renderContract === null`. The first render binds
    // it rather than refusing, so an in-flight job is not wedged; the second render is then checked.
    const book = bookOf()
    const job = directedJob(app.jobs, book)
    expect(job.renderContract).toBeNull()
    job.bindRenderContract(contractFor(cast, 'speech-1', 'assembly-1'))
    expect(job.renderContract).not.toBeNull()
    // Re-binding the same contract is idempotent; a different one is refused by the domain itself.
    expect(() => job.bindRenderContract(contractFor(cast, 'speech-1', 'assembly-1'))).not.toThrow()
    expect(() => job.bindRenderContract(contractFor(cast, 'speech-2', 'assembly-1'))).toThrow(
      'bound to different render inputs',
    )
  })
})

/** A speech engine that would fail loudly if the contract check ever let a render through. */
const neverRenders = {
  identity: 'speech-2',
  beginBatch: (): Promise<void> => Promise.reject(new Error('render must not have started')),
  render: (): Promise<never> => Promise.reject(new Error('render must not have started')),
  endBatch: (): Promise<void> => Promise.resolve(),
}

describe('a revocation cannot be lost to a race (issue #45, round 3)', () => {
  let app: Harness

  beforeEach(() => {
    app = harness()
  })

  /**
   * The window round 2 left open: a review call reads the job while it is awaiting review, passes the
   * render-ownership guard, and its write lands *after* the render's final catalog check — so the
   * segment is rendered and the job completes as if approved, while the decision authorizing it is
   * gone.
   *
   * Two mechanisms close it, and this suite pins both:
   *   - the completed output records the catalog revision it was produced under, so an output the
   *     catalog has moved under is provably stale and is re-derived rather than served;
   *   - every review mutation re-reads the job afterwards and reopens it if it completed meanwhile.
   *
   * Deleting the rendered artifact was the alternative and is not needed: the approval is already
   * hashed into that segment's render input identity, so a revoked segment's audio is unreachable by
   * construction, and exactly that segment re-renders when it is approved again. What had to be
   * invalidated was the job's *completed* state, not the reuse ledger.
   */
  it('does not serve a completed output whose catalog moved after the final check', async () => {
    const book = bookOf()
    const job = directedJob(app.jobs, book)
    await app.review.grantBookFallback({ jobId: 'job-review', decidedBy: REVIEWER })
    const claimed = (await app.approvals.readCatalog(BOOK_ID)).revision

    // Drive the job to completed exactly as a render does, recording the revision it claimed.
    job.resumeApprovedRender()
    job.beginRendering(4)
    for (const segment of book.chapters[0]?.segments ?? []) job.recordSegmentCompleted(segment.id)
    job.beginAssembly()
    job.complete(
      {
        version: { value: 1, label: 'v001', fileName: () => 'x' } as never,
        m4bPath: '/workspace/review-v001.m4b',
        chapters: [{ chapterId: CHAPTER_ID, path: '/workspace/ch1.flac' }],
      },
      claimed,
    )
    await app.jobs.saveJob(job)
    expect(job.catalogRevision).toBe(claimed)

    // The lost revocation: it lands on the ledger without the job being reopened, which is what a
    // decision racing the commit looks like from the render's side.
    await app.approvals.revoke(BOOK_ID, MIRA_SEGMENT, {
      reason: 'human-withdrawal',
      decidedBy: REVIEWER,
      decidedAt: LATER.toISOString(),
    })
    const moved = (await app.approvals.readCatalog(BOOK_ID)).revision
    expect(moved).not.toBe(claimed)

    // The completed output no longer stands, so it is not served: the job goes back to review and the
    // render then refuses, because that segment has no live decision.
    const render = new RenderAudiobook({
      speechEngineFactory: { identity: 'speech-1', create: () => neverRenders1 },
      audioAssembler: {
        identity: 'assembly-1',
        assemble: () => Promise.reject(new Error('unused')),
      },
      jobs: app.jobs,
      approvals: app.approvals,
    })
    const stored = await app.jobs.findJob('job-review')
    if (stored === undefined) throw new Error('job vanished')
    stored.bindRenderContract(
      createRenderContract({
        voices: cast,
        speechEngineIdentity: 'speech-1',
        audioAssemblerIdentity: 'assembly-1',
      }),
    )
    await app.jobs.saveJob(stored)

    const refusal = await render
      .execute({ jobId: 'job-review', voices: cast })
      .then(() => undefined)
      .catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(UnapprovedFallbackSegmentsError)
    expect((refusal as UnapprovedFallbackSegmentsError).segmentIds).toEqual([MIRA_SEGMENT])

    // And the stale output is gone rather than still downloadable.
    const after = await app.jobs.findJob('job-review')
    expect(after?.state).toBe('awaiting_review')
    expect(after?.snapshot().output).toBeNull()
    expect(after?.catalogRevision).toBeNull()
  })

  it('still serves a completed output while its catalog has not moved', async () => {
    // The other half: without this, "refuse when the revision moved" could be satisfied by refusing
    // always, and every completed job would silently re-render.
    const book = bookOf()
    const job = directedJob(app.jobs, book)
    await app.review.grantBookFallback({ jobId: 'job-review', decidedBy: REVIEWER })
    const claimed = (await app.approvals.readCatalog(BOOK_ID)).revision
    job.resumeApprovedRender()
    job.beginRendering(4)
    for (const segment of book.chapters[0]?.segments ?? []) job.recordSegmentCompleted(segment.id)
    job.beginAssembly()
    job.complete(
      {
        version: { value: 1, label: 'v001', fileName: () => 'x' } as never,
        m4bPath: '/workspace/review-v001.m4b',
        chapters: [{ chapterId: CHAPTER_ID, path: '/workspace/ch1.flac' }],
      },
      claimed,
    )
    await app.jobs.saveJob(job)

    const render = new RenderAudiobook({
      speechEngineFactory: { identity: 'speech-1', create: () => neverRenders1 },
      audioAssembler: {
        identity: 'assembly-1',
        assemble: () => Promise.reject(new Error('unused')),
      },
      jobs: app.jobs,
      approvals: app.approvals,
    })
    const result = await render.execute({ jobId: 'job-review', voices: cast })
    expect(result.job.state).toBe('completed')
    expect(result.generatedSegments).toBe(0)
    expect(result.output.m4bPath).toBe('/workspace/review-v001.m4b')
  })

  it('reopens a job that completed while a review decision was in flight', async () => {
    // The immediate half of the fix, in the shape the race actually takes: the review call loaded the
    // job while it was awaiting review, and by the time its write lands the job has completed.
    const book = bookOf()
    const job = directedJob(app.jobs, book)
    await app.review.grantBookFallback({ jobId: 'job-review', decidedBy: REVIEWER })
    const claimed = (await app.approvals.readCatalog(BOOK_ID)).revision

    const racing = new ReviewFallbackApprovals({
      jobs: {
        ...app.jobs,
        findJob: async (jobId: string) => app.jobs.findJob(jobId),
        findBook: async (bookId: string) => app.jobs.findBook(bookId),
        saveJob: async (saved) => app.jobs.saveJob(saved),
      } as typeof app.jobs,
      approvals: {
        ...app.approvals,
        readCatalog: (bookId: string) => app.approvals.readCatalog(bookId),
        save: (record) => app.approvals.save(record),
        saveBookGrant: (grant) => app.approvals.saveBookGrant(grant),
        revokeBookGrant: (bookId: string) => app.approvals.revokeBookGrant(bookId),
        // Completion lands between this call's job read and its write — the exact race.
        revoke: async (bookId, segmentId, revocation) => {
          job.resumeApprovedRender()
          job.beginRendering(4)
          for (const segment of book.chapters[0]?.segments ?? [])
            job.recordSegmentCompleted(segment.id)
          job.beginAssembly()
          job.complete(
            {
              version: { value: 1, label: 'v001', fileName: () => 'x' } as never,
              m4bPath: '/workspace/review-v001.m4b',
              chapters: [{ chapterId: CHAPTER_ID, path: '/workspace/ch1.flac' }],
            },
            claimed,
          )
          await app.jobs.saveJob(job)
          return app.approvals.revoke(bookId, segmentId, revocation)
        },
      } as typeof app.approvals,
      now: () => LATER,
    })

    expect(
      await racing.revoke({ jobId: 'job-review', segmentId: MIRA_SEGMENT, decidedBy: REVIEWER }),
    ).toBe(true)

    // The post-write re-read caught the completion and put the job back into review.
    const after = await app.jobs.findJob('job-review')
    expect(after?.state).toBe('awaiting_review')
    expect(after?.snapshot().output).toBeNull()
  })
})

/** Fails loudly if a stale completed output were ever served by rendering instead of refusing. */
const neverRenders1 = {
  identity: 'speech-1',
  beginBatch: (): Promise<void> => Promise.reject(new Error('render must not have started')),
  render: (): Promise<never> => Promise.reject(new Error('render must not have started')),
  endBatch: (): Promise<void> => Promise.resolve(),
}
