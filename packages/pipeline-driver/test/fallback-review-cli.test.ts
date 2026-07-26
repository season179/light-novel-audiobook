import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  AudiobookJob,
  Book,
  Chapter,
  ExactSourceCoverage,
  SourcePassage,
  StableIds,
  VoiceCast,
  VoiceProfile,
} from '@light-novel-audiobook/domain'
import {
  layoutFor,
  migrateSchema,
  openWorkspace,
  SqliteFallbackApprovalRepository,
  SqliteJobRepository,
} from '@light-novel-audiobook/persistence'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type FallbackReviewApprovalNotice,
  runFallbackReviewCommand,
} from '../src/fallback-review-cli.js'

const roots: string[] = []
const run = promisify(execFile)
const CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../scripts/review-fallbacks.ts',
)
const sourceHash = '7'.repeat(64)
const bookId = StableIds.book(sourceHash)
const chapterId = StableIds.chapter(bookId, 1)
const passageId = StableIds.passage(chapterId, 1)
const segmentId = StableIds.segment(passageId, 1)
const secondPassageId = StableIds.passage(chapterId, 2)
const secondSegmentId = StableIds.segment(secondPassageId, 1)
const speakerReason = 'No eligible character was present in the synthetic fixture roster.'
const secondSpeakerReason = 'The synthetic fixture speaker has no assigned voice.'

const voice = (id: string, role: 'narrator' | 'fallback'): VoiceProfile =>
  new VoiceProfile({
    id,
    displayName: id,
    role,
    speakerId: null,
    syntheticSpeaker: role === 'narrator' ? 'Aiden' : 'Ryan',
    instruction: `${id} restrained delivery`,
    seed: 74,
    revision: 1,
  })

async function preparedWorkspace(
  jobId: string,
  options: { readonly heterogeneous?: boolean } = {},
): Promise<{ root: string; book: Book }> {
  const root = await mkdtemp(path.join(tmpdir(), 'fallback-review-cli-'))
  roots.push(root)
  const chapter = new Chapter({
    id: chapterId,
    bookId,
    position: 1,
    title: 'Synthetic Review Chapter',
    sourcePassages: [
      new SourcePassage({
        id: passageId,
        chapterId,
        sourceText: '“Is anyone there?”',
      }),
      ...(options.heterogeneous === true
        ? [
            new SourcePassage({
              id: secondPassageId,
              chapterId,
              sourceText: '“The second fixture line.”',
            }),
          ]
        : []),
    ],
  })
  const segments = ExactSourceCoverage.createSegments(chapter, [
    {
      sourcePassageId: passageId,
      sourceText: '“Is anyone there?”',
      kind: 'dialogue',
      speakerId: null,
      speakerReason,
      confidence: 0.4,
      delivery: {
        emotion: 'uncertain',
        pace: 'normal',
        volume: 'normal',
        pauseAfterMs: 100,
      },
    },
    ...(options.heterogeneous === true
      ? [
          {
            sourcePassageId: secondPassageId,
            sourceText: '“The second fixture line.”',
            kind: 'dialogue' as const,
            speakerId: 'fixture-unvoiced',
            speakerReason: secondSpeakerReason,
            confidence: 0.8,
            delivery: {
              emotion: 'calm',
              pace: 'normal' as const,
              volume: 'normal' as const,
              pauseAfterMs: 100,
            },
          },
        ]
      : []),
  ])
  const cast = new VoiceCast(voice('narrator', 'narrator'), voice('fallback', 'fallback'), [])
  for (const segment of segments) segment.assignVoice(cast.resolve(segment).assignment)
  chapter.submitForReview(segments)
  chapter.approve()
  const book = new Book({
    id: bookId,
    title: 'Synthetic Review Book',
    author: null,
    coverPath: null,
    source: { epubPath: '/synthetic/review.epub', sha256: sourceHash },
    chapters: [chapter],
  })
  const job = new AudiobookJob(jobId)
  job.bindCommand('d'.repeat(64))
  job.start()
  job.attachBook(book.id)
  job.beginDirection()
  for (const segment of segments) {
    const unresolved = segment.speakerId === null
    job.addFallbackWarning({
      segmentId: segment.id,
      speakerId: segment.speakerId,
      voiceProfileId: cast.fallback.id,
      reason: unresolved ? 'unresolved_speaker' : 'missing_speaker_voice',
      speakerReason: unresolved ? speakerReason : secondSpeakerReason,
    })
  }
  job.awaitReview()

  const layout = layoutFor(root)
  const db = openWorkspace(layout)
  migrateSchema(db)
  const jobs = new SqliteJobRepository(layout, db)
  await jobs.saveBook(book)
  await jobs.saveJob(job)
  db.close()
  return { root, book }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('fallback review CLI', () => {
  it('lists without resolving an actor or changing the approval catalog', async () => {
    const { root, book } = await preparedWorkspace('job-list-fallbacks')
    const database = openWorkspace(layoutFor(root))
    const approvals = new SqliteFallbackApprovalRepository(database)
    const before = await approvals.readCatalog(book.id)
    database.close()

    const report = await runFallbackReviewCommand({
      action: 'list',
      workspaceRoot: root,
      jobId: 'job-list-fallbacks',
      resolveReviewer: () => {
        throw new Error('list must not resolve a reviewer')
      },
    })

    expect(report).toEqual({
      action: 'list',
      jobId: 'job-list-fallbacks',
      pendingCount: 1,
      items: [
        {
          segmentId,
          sourcePassageId: passageId,
          kind: 'dialogue',
          speakerId: null,
          fallbackReason: 'unresolved_speaker',
          speakerReason,
          proposedVoiceProfileId: 'fallback',
        },
      ],
    })
    expect(JSON.stringify(report)).not.toContain('Is anyone there')

    const afterDatabase = openWorkspace(layoutFor(root))
    const after = await new SqliteFallbackApprovalRepository(afterDatabase).readCatalog(book.id)
    afterDatabase.close()
    expect(after).toEqual(before)
  })

  it('bulk-approves only after an explicit command and records the resolved human actor', async () => {
    const { root, book } = await preparedWorkspace('job-approve-fallbacks')
    const notices: FallbackReviewApprovalNotice[] = []

    const report = await runFallbackReviewCommand({
      action: 'approve',
      workspaceRoot: root,
      jobId: 'job-approve-fallbacks',
      resolveReviewer: () => 'Ada Lovelace',
      announceApproval: (notice) => notices.push(notice),
    })

    expect(notices).toEqual([
      {
        actor: 'Ada Lovelace',
        jobId: 'job-approve-fallbacks',
        decision:
          'approve one homogeneous fallback decision group for every listed pending segment',
        items: [
          {
            segmentId,
            sourcePassageId: passageId,
            kind: 'dialogue',
            speakerId: null,
            fallbackReason: 'unresolved_speaker',
            speakerReason,
            proposedVoiceProfileId: 'fallback',
          },
        ],
      },
    ])
    expect(report).toMatchObject({
      action: 'approve',
      jobId: 'job-approve-fallbacks',
      actor: 'Ada Lovelace',
      approvedCount: 1,
    })

    const db = openWorkspace(layoutFor(root))
    const catalog = await new SqliteFallbackApprovalRepository(db).readCatalog(book.id)
    db.close()
    expect(catalog.grant?.decidedBy).toBe('Ada Lovelace')
    expect(catalog.approvals).toHaveLength(1)
    expect(catalog.approvals[0]?.decidedBy).toBe('Ada Lovelace')
  })

  it('surfaces decision fields and refuses a heterogeneous book-wide grant', async () => {
    const { root, book } = await preparedWorkspace('job-heterogeneous-fallbacks', {
      heterogeneous: true,
    })

    const listed = await runFallbackReviewCommand({
      action: 'list',
      workspaceRoot: root,
      jobId: 'job-heterogeneous-fallbacks',
    })
    expect(
      listed.items.map((item) => [
        item.segmentId,
        item.speakerId,
        item.fallbackReason,
        item.proposedVoiceProfileId,
      ]),
    ).toEqual([
      [segmentId, null, 'unresolved_speaker', 'fallback'],
      [secondSegmentId, 'fixture-unvoiced', 'missing_speaker_voice', 'fallback'],
    ])
    expect(JSON.stringify(listed)).not.toContain('The second fixture line')

    await expect(
      runFallbackReviewCommand({
        action: 'approve',
        workspaceRoot: root,
        jobId: 'job-heterogeneous-fallbacks',
        resolveReviewer: () => 'Synthetic Reviewer',
      }),
    ).rejects.toThrow('heterogeneous fallback decisions')

    const database = openWorkspace(layoutFor(root))
    const catalog = await new SqliteFallbackApprovalRepository(database).readCatalog(book.id)
    database.close()
    expect(catalog.grant).toBeUndefined()
    expect(catalog.approvals).toEqual([])
  })

  it('exposes separate list and approve CLI invocations without printing story text', async () => {
    const { root } = await preparedWorkspace('job-process-cli')
    const common = ['--workspace', root, '--job-id', 'job-process-cli']

    const listed = await run(process.execPath, ['--import', 'tsx', CLI, '--', 'list', ...common])
    expect(listed.stdout).toContain('"status":"pending-fallback-review"')
    expect(listed.stdout).toContain(`"sourcePassageId":"${passageId}"`)
    expect(listed.stdout).toContain(`"speakerReason":"${speakerReason}"`)
    expect(listed.stdout).not.toContain('Is anyone there')

    const approved = await run(process.execPath, ['--import', 'tsx', CLI, 'approve', ...common], {
      env: { ...process.env, LNA_REVIEWER: 'Grace Hopper' },
    })
    const outputLines = approved.stdout.trim().split('\n')
    expect(outputLines[0]).toContain('"status":"approving"')
    expect(outputLines[0]).toContain('"actor":"Grace Hopper"')
    expect(outputLines.at(-1)).toContain('"status":"approved"')
    expect(outputLines.at(-1)).toContain('"approvedCount":1')
    expect(approved.stdout).not.toContain('Is anyone there')
  })

  it('fails closed before approval when no real reviewer identity can be resolved', async () => {
    const { root } = await preparedWorkspace('job-no-reviewer')

    await expect(
      runFallbackReviewCommand({
        action: 'approve',
        workspaceRoot: root,
        jobId: 'job-no-reviewer',
        resolveReviewer: () => {
          throw new Error('Cannot record who approves a fallback voice')
        },
      }),
    ).rejects.toThrow('Cannot record who approves a fallback voice')

    const listed = await runFallbackReviewCommand({
      action: 'list',
      workspaceRoot: root,
      jobId: 'job-no-reviewer',
    })
    expect(listed.action).toBe('list')
    if (listed.action !== 'list') throw new Error('list command returned an approval report')
    expect(listed.pendingCount).toBe(1)
  })
})
