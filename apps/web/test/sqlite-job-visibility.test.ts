import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { GenerateAudiobook, PendingFallbackReviewError } from '@light-novel-audiobook/application'
import {
  layoutFor,
  migrateSchema,
  openWorkspace,
  SqliteFallbackApprovalRepository,
  SqliteJobRepository,
} from '@light-novel-audiobook/persistence'
import { afterEach, describe, expect, it } from 'vitest'
import { createAudiobookWebApi } from '../src/server/composition-root.js'
import { FakeAudioAssembler } from '../src/server/fakes/fake-audio-assembler.js'
import {
  FAKE_DIRECTOR_IDENTITY,
  FakeDirectorModel,
} from '../src/server/fakes/fake-director-model.js'
import { FakeEpubExtractor } from '../src/server/fakes/fake-epub-extractor.js'
import { createFakeSpeechEngineFactory } from '../src/server/fakes/fake-speech-engine.js'
import {
  createM1VoiceCast,
  loadPinnedQwenConfig,
  pinnedVoiceMaterial,
} from '../src/server/m1-voice-cast.js'
import { createWorkspace } from '../src/server/workspace.js'
import { createStubEpubBytes } from './support/stub-epub.js'

const JOB_ID = 'job-written-by-the-driver-side'
const WEB_REVIEWER = 'browser-reviewer'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/**
 * Property A of the #21 workspace sharing: a job one process wrote to the SQLite workspace is
 * visible through the web composition root on another connection, and its pending fallback
 * decisions are reviewable in the existing review panel. Identity matching is deliberately NOT
 * part of this property — visibility is about the row, not the resume contract (that is #54's
 * property, with its own coverage).
 *
 * The writer uses the web fakes rather than `NarrationEchoDirectorServer` on purpose: the echo
 * server directs everything as narration and can never produce an unresolved speaker, so no test
 * built on it can reach `awaiting_review`. `FakeDirectorModel` splits dialogue out and leaves the
 * speaker null at 0.42 confidence when it cannot resolve one, which is a genuine stop for review.
 */
describe('a SQLite job written by one side of the workspace', () => {
  it('is visible and reviewable through the web composition root on another connection', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lna-web-sqlite-visibility-'))
    roots.push(root)
    const workspace = await createWorkspace(root)
    const layout = layoutFor(root)

    // --- writer side: persistence opened exactly as packages/pipeline-driver does.
    const writerDb = openWorkspace(layout)
    migrateSchema(writerDb)
    const writerJobs = new SqliteJobRepository(layout, writerDb)
    const writerApprovals = new SqliteFallbackApprovalRepository(writerDb)

    const pinnedConfig = await loadPinnedQwenConfig()
    const voices = createM1VoiceCast(pinnedConfig)
    const useCase = new GenerateAudiobook({
      epubExtractor: new FakeEpubExtractor(),
      directorModelFactory: {
        identity: FAKE_DIRECTOR_IDENTITY,
        create: () => new FakeDirectorModel(),
      },
      speechEngineFactory: createFakeSpeechEngineFactory(workspace, {
        fallbackVoiceProfileId: voices.fallback.id,
        pinnedVoiceProfiles: pinnedVoiceMaterial(pinnedConfig),
      }),
      audioAssembler: new FakeAudioAssembler(),
      jobs: writerJobs,
      approvals: writerApprovals,
    })

    const epubBytes = createStubEpubBytes('sqlite-visibility')
    const epubPath = path.join(workspace.uploadsDir, 'sqlite-visibility.epub')
    await writeFile(epubPath, epubBytes)
    const epubSha256 = createHash('sha256').update(epubBytes).digest('hex')

    // Stopping for review is signalled by throwing: the job is persisted as `awaiting_review`
    // first, then `PendingFallbackReviewError` carries the pending decisions to the caller.
    const stopped = await useCase.execute({ jobId: JOB_ID, epubPath, epubSha256, voices }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(stopped).toBeInstanceOf(PendingFallbackReviewError)
    expect((stopped as PendingFallbackReviewError).pending.length).toBeGreaterThan(0)
    const persisted = await writerJobs.findJob(JOB_ID)
    expect(persisted?.state).toBe('awaiting_review')
    const bookId = persisted?.bookId
    expect(bookId).not.toBeNull()
    writerDb.close()

    // --- reader side: the web composition root over a fresh connection to the same database,
    // exactly the factories #21 supplies for `jobs` and `approvals`.
    const readerDb = openWorkspace(layout)
    const api = await createAudiobookWebApi({
      workspace,
      jobs: new SqliteJobRepository(layout, readerDb),
      approvals: new SqliteFallbackApprovalRepository(readerDb),
      reviewer: WEB_REVIEWER,
    })

    const state = await api.getJobState({ jobId: JOB_ID })
    expect(state?.state).toBe('awaiting_review')

    const review = await api.listFallbackReview({ jobId: JOB_ID })
    expect(review.awaitingReview).toBe(true)
    expect(review.pendingCount).toBeGreaterThan(0)
    expect(review.grantedBy).toBeNull()

    // The human decides through the existing panel operation, on the reader's connection.
    const decided = await api.approveAllFallbacks({ jobId: JOB_ID })
    expect(decided.pendingCount).toBe(0)
    expect(decided.grantedBy).toBe(WEB_REVIEWER)

    // --- and the decision is durable for the writer's side too: a third, independent connection
    // sees the grant and the per-segment records the panel operation wrote.
    const auditDb = openWorkspace(layout)
    try {
      const catalog = await new SqliteFallbackApprovalRepository(auditDb).readCatalog(
        bookId as string,
      )
      expect(catalog.grant?.decidedBy).toBe(WEB_REVIEWER)
      expect(catalog.approvals.length).toBe(review.items.length)
      expect(catalog.approvals.every((record) => record.decidedBy === WEB_REVIEWER)).toBe(true)
    } finally {
      auditDb.close()
      readerDb.close()
    }
  })
})
