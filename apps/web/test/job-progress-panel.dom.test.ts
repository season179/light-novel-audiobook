// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AudiobookClient } from '../src/client/audiobook-client.js'
import { JobProgressPanel } from '../src/components/job-progress-panel.js'
import type { FallbackReviewView } from '../src/server/audiobook-web-api.js'
import type { JobStateView } from '../src/server/job-state-view.js'

/**
 * DOM-level proof for epic #9's "the UI shows useful stage/progress/error information". Every test
 * asserts WHAT was rendered — exact stage lines, counts, alert text, element roles — never merely
 * that something rendered. The client is a stub at the `AudiobookClient` interface, so the panel
 * sees exactly the contract the browser's server-function client produces.
 */

const POLL_MS = 60
const WAIT = { timeout: 5_000, interval: 25 }

const JOB_ID = 'job-uitest0000000000000001'

const view = (overrides: Partial<JobStateView>): JobStateView => {
  const stage = overrides.stage ?? 'rendering'
  const stageIndex = ['extracting', 'directing', 'rendering', 'assembling'].indexOf(stage)
  return {
    jobId: JOB_ID,
    state: 'running',
    stage,
    stageLabel: 'Rendering speech',
    bookId: 'book-uitest0000000000000001',
    bookTitle: 'Fixture Book',
    currentChapterId: 'book-uitest0000000000000001-ch0002',
    currentChapterLabel: 'Chapter 2',
    currentChapterTitle: 'A Fixture Chapter',
    completedChapters: 2,
    totalChapters: 2,
    completedPassages: 8,
    totalPassages: 8,
    directionPercentComplete: 100,
    completedSegments: 13,
    totalSegments: 16,
    percentComplete: 81,
    pipelineStages: (
      [
        { stage: 'extracting', label: 'Reading the EPUB' },
        { stage: 'directing', label: 'Directing chapters' },
        { stage: 'rendering', label: 'Rendering speech' },
        { stage: 'assembling', label: 'Assembling the audiobook' },
      ] as const
    ).map((item, index) => ({
      ...item,
      status:
        stage === 'completed' || index < stageIndex
          ? ('completed' as const)
          : index === stageIndex
            ? ('current' as const)
            : ('upcoming' as const),
      summary: null,
    })),
    latestMessage: 'Completed segment 13',
    error: null,
    active: true,
    finished: false,
    warnings: [],
    output: null,
    ...overrides,
    failureDiagnosticPath: overrides.failureDiagnosticPath ?? null,
  }
}

const reviewView = (overrides: Partial<FallbackReviewView> = {}): FallbackReviewView => ({
  jobId: JOB_ID,
  awaitingReview: true,
  grantedBy: null,
  pendingCount: 2,
  items: [
    {
      segmentId: `${JOB_ID.replace('job', 'book')}-ch0001-p000002-s0001`,
      sourcePassageId: `${JOB_ID.replace('job', 'book')}-ch0001-p000002`,
      kind: 'dialogue',
      chapterId: `${JOB_ID.replace('job', 'book')}-ch0001`,
      chapterTitle: 'Fixture Chapter One',
      speakerId: null,
      fallbackReason: 'unresolved_speaker',
      speakerReason: 'No speaker could be identified from the line.',
      proposedVoiceProfileId: 'fallback-serena-gentle',
      sourceTextExcerpt: 'A fixture line, written for this test.',
      decision: 'pending',
      approvalId: null,
      decidedBy: null,
    },
    {
      segmentId: `${JOB_ID.replace('job', 'book')}-ch0002-p000001-s0001`,
      sourcePassageId: `${JOB_ID.replace('job', 'book')}-ch0002-p000001`,
      kind: 'dialogue',
      chapterId: `${JOB_ID.replace('job', 'book')}-ch0002`,
      chapterTitle: 'Fixture Chapter Two',
      speakerId: 'bruno',
      fallbackReason: 'missing_speaker_voice',
      speakerReason: 'This speaker has no cast voice.',
      proposedVoiceProfileId: 'fallback-serena-gentle',
      sourceTextExcerpt: 'Another fixture line, written for this test.',
      decision: 'pending',
      approvalId: null,
      decidedBy: null,
    },
  ],
  ...overrides,
})

/** A full AudiobookClient; tests override the methods under observation. */
const stubClient = (overrides: Partial<AudiobookClient>): AudiobookClient => ({
  uploadEpub: vi.fn(async () => ({
    ok: false as const,
    error: { code: 'invalid_upload' as const, message: 'not used in these tests' },
  })),
  startGeneration: vi.fn(async () => ({
    ok: false as const,
    error: { code: 'generation_rejected' as const, message: 'not used in these tests' },
  })),
  getJobState: vi.fn(async () => ({ ok: true as const, value: null })),
  listChapterAudio: vi.fn(async () => ({
    ok: true as const,
    value: { jobId: JOB_ID, ready: false, chapters: [], download: null },
  })),
  listUploads: vi.fn(async () => ({ ok: true as const, value: [] })),
  listFallbackReview: vi.fn(async () => ({
    ok: true as const,
    value: reviewView({ awaitingReview: false, pendingCount: 0, items: [] }),
  })),
  approveAllFallbacks: vi.fn(async () => ({ ok: true as const, value: reviewView() })),
  approveFallback: vi.fn(async () => ({ ok: true as const, value: reviewView() })),
  revokeFallback: vi.fn(async () => ({ ok: true as const, value: reviewView() })),
  renderApprovedScript: vi.fn(async () => ({
    ok: true as const,
    value: { jobId: JOB_ID, job: view({}) },
  })),
  ...overrides,
})

const withQueryClient = (children: ReactNode) =>
  createElement(
    QueryClientProvider,
    { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
    children,
  )

const renderPanel = (client: AudiobookClient) =>
  render(
    withQueryClient(
      createElement(JobProgressPanel, { client, jobId: JOB_ID, pollIntervalMs: POLL_MS }),
    ),
  )

afterEach(cleanup)

describe('JobProgressPanel — stage and progress on screen', () => {
  it('shows the stage, the state, the chapter, and the exact segment counts while running', async () => {
    const getJobState = vi.fn(async () => ({ ok: true as const, value: view({}) }))
    renderPanel(stubClient({ getJobState }))

    // The exact stage line and the live message, not just "something rendered".
    expect(await screen.findByText('Rendering speech · running', undefined, WAIT)).toBeDefined()
    expect(screen.getByText('Completed segment 13')).toBeDefined()
    expect(screen.getByText('Chapter 2 — A Fixture Chapter')).toBeDefined()
    expect(screen.getByText('13 of 16')).toBeDefined()

    const bar = screen.getByRole('progressbar') as HTMLProgressElement
    expect(bar.value).toBe(13)
    expect(bar.max).toBe(16)
    expect(bar.textContent).toContain('81%')

    // No error is surfaced for a healthy run.
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows each stage in the user-facing words of the stage labels', async () => {
    const stages = [
      { stage: 'extracting', stageLabel: 'Reading the EPUB' },
      { stage: 'directing', stageLabel: 'Directing chapters' },
      { stage: 'assembling', stageLabel: 'Assembling the audiobook' },
    ] as const
    for (const { stage, stageLabel } of stages) {
      const getJobState = vi.fn(async () => ({
        ok: true as const,
        value: view({
          stage,
          stageLabel,
          completedSegments: 0,
          totalSegments: 0,
          percentComplete: null,
        }),
      }))
      const rendered = renderPanel(stubClient({ getJobState }))
      expect(await screen.findByText(`${stageLabel} · running`, undefined, WAIT)).toBeDefined()
      expect(screen.getByText('0 of not yet counted')).toBeDefined()
      rendered.unmount()
      cleanup()
    }
  })

  it('shows passage and chapter progress during direction without using segment counts', async () => {
    const directing = view({
      stage: 'directing',
      stageLabel: 'Directing chapters',
      completedChapters: 3,
      totalChapters: 15,
      completedPassages: 421,
      totalPassages: 2_328,
      directionPercentComplete: 18,
      completedSegments: 0,
      totalSegments: 0,
      percentComplete: null,
    })
    const getJobState = vi.fn(async () => ({ ok: true as const, value: directing }))
    renderPanel(stubClient({ getJobState }))

    expect(await screen.findByText('3 of 15', undefined, WAIT)).toBeDefined()
    expect(screen.getByText('421 of 2328')).toBeDefined()
    expect(screen.getByText('0 of not yet counted')).toBeDefined()
    const bar = screen.getByRole('progressbar') as HTMLProgressElement
    expect(screen.getByText('Passages directed', { selector: 'label' })).toBeDefined()
    expect(bar.value).toBe(421)
    expect(bar.max).toBe(2_328)
    expect(bar.textContent).toContain('18%')
  })

  it('marks exactly the current pipeline stage, not that stage as completed', async () => {
    const getJobState = vi.fn(async () => ({
      ok: true as const,
      value: view({ stage: 'directing', stageLabel: 'Directing chapters' }),
    }))
    renderPanel(stubClient({ getJobState }))

    await screen.findByText('Directing chapters · running', undefined, WAIT)
    const pipeline = screen.getByLabelText('Audiobook pipeline stages')
    expect(pipeline.textContent).toContain('Reading the EPUBCompleted')
    expect(pipeline.textContent).toContain('Directing chaptersCurrent')
    expect(pipeline.textContent).toContain('Rendering speechUpcoming')
    expect(pipeline.querySelectorAll('[aria-current="step"]')).toHaveLength(1)
  })

  it('does not turn a zero passage total into 100% or a divide-by-zero progress bar', async () => {
    const getJobState = vi.fn(async () => ({
      ok: true as const,
      value: view({
        stage: 'directing',
        stageLabel: 'Directing chapters',
        completedChapters: 0,
        totalChapters: 4,
        completedPassages: 0,
        totalPassages: 0,
        directionPercentComplete: null,
        completedSegments: 0,
        totalSegments: 0,
        percentComplete: null,
      }),
    }))
    renderPanel(stubClient({ getJobState }))

    await screen.findByText('Directing chapters · running', undefined, WAIT)
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.getByText('0 of 0')).toBeDefined()
    expect(screen.queryByText('100%')).toBeNull()
  })

  it('keeps polling while the job is active', async () => {
    const getJobState = vi.fn(async () => ({ ok: true as const, value: view({}) }))
    renderPanel(stubClient({ getJobState }))
    await screen.findByText('Rendering speech · running', undefined, WAIT)
    const callsAtSettle = getJobState.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 5))
    expect(getJobState.mock.calls.length).toBeGreaterThan(callsAtSettle)
  })
})

describe('JobProgressPanel — error states are visible, never a silent spinner', () => {
  it('surfaces a failed job as an alert with the failure message and stops polling', async () => {
    const getJobState = vi.fn(async () => ({
      ok: true as const,
      value: view({
        state: 'failed',
        active: false,
        error: 'The speech engine worker exited unexpectedly.',
        latestMessage: 'The speech engine worker exited unexpectedly.',
      }),
    }))
    renderPanel(stubClient({ getJobState }))

    const alert = await screen.findByRole('alert', undefined, WAIT)
    expect(alert.textContent).toContain(
      'Generation failed: The speech engine worker exited unexpectedly.',
    )
    expect(screen.getByRole('status').textContent).toContain('Rendering speech · failed')
    // The partial progress is shown honestly — 13 of 16 rendered before the failure.
    expect(screen.getByText('13 of 16')).toBeDefined()

    // A failed job is not active: polling must stop, not spin forever.
    await waitFor(() => expect(getJobState.mock.calls.length).toBeGreaterThan(0), WAIT)
    const callsAtFailure = getJobState.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 5))
    expect(getJobState.mock.calls.length).toBe(callsAtFailure)
  })

  it('says plainly when the job does not exist', async () => {
    const getJobState = vi.fn(async () => ({ ok: true as const, value: null }))
    renderPanel(stubClient({ getJobState }))
    const alert = await screen.findByRole('alert', undefined, WAIT)
    expect(alert.textContent).toContain(`No job named ${JOB_ID} exists in this workspace.`)
  })

  it('shows the server-supplied error message when the read fails inside the API', async () => {
    const getJobState = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'unknown_job' as const, message: 'That job is not in the local workspace.' },
    }))
    renderPanel(stubClient({ getJobState }))
    const alert = await screen.findByRole('alert', undefined, WAIT)
    expect(alert.textContent).toBe('That job is not in the local workspace.')
  })

  it('shows a generic alert when the transport itself fails', async () => {
    const getJobState = vi.fn(async () => {
      throw new Error('simulated transport failure')
    })
    renderPanel(stubClient({ getJobState }))
    const alert = await screen.findByRole('alert', undefined, WAIT)
    expect(alert.textContent).toBe('Job state could not be read from the local server.')
  })
})

describe('JobProgressPanel — review gate and completed output on screen', () => {
  it('stops at the review gate with the exact decision the human must make', async () => {
    const getJobState = vi.fn(async () => ({
      ok: true as const,
      value: view({
        state: 'awaiting_review',
        stage: 'directing',
        stageLabel: 'Directing chapters',
        completedSegments: 0,
        totalSegments: 0,
        percentComplete: null,
        active: false,
        latestMessage: 'Awaiting fallback approval review',
      }),
    }))
    const listFallbackReview = vi.fn(async () => ({ ok: true as const, value: reviewView() }))
    const approvedReview = reviewView({
      grantedBy: 'ui-test-reviewer',
      pendingCount: 0,
      items: reviewView().items.map((item) => ({
        ...item,
        decision: 'approved' as const,
        decidedBy: 'ui-test-reviewer',
        approvalId: 'approval-ui-test-0001',
      })),
    })
    const approveAllFallbacks = vi.fn(async () => ({ ok: true as const, value: approvedReview }))
    const renderApprovedScript = vi.fn(async () => ({
      ok: true as const,
      value: { jobId: JOB_ID, job: view({}) },
    }))
    const listFallbackReviewSequence = vi
      .fn()
      .mockImplementationOnce(listFallbackReview)
      .mockImplementation(async () => ({ ok: true as const, value: approvedReview }))

    const user = userEvent.setup()
    renderPanel(
      stubClient({
        getJobState,
        listFallbackReview: listFallbackReviewSequence,
        approveAllFallbacks,
        renderApprovedScript,
      }),
    )

    expect(
      await screen.findByText(
        'Waiting for fallback voice review. Continuing starts speech rendering.',
        undefined,
        WAIT,
      ),
    ).toBeDefined()
    expect(
      await screen.findByRole(
        'heading',
        { name: 'Unresolved speakers need your decision (2)' },
        WAIT,
      ),
    ).toBeDefined()
    expect(screen.getByText(/2 of 2 lines have no cast voice/)).toBeDefined()

    // The render button is disabled until every speaker has a decision.
    const renderButton = screen.getByRole('button', { name: 'Render approved script' })
    expect((renderButton as HTMLButtonElement).disabled).toBe(true)

    await user.click(
      screen.getByRole('button', { name: 'Use the fallback voice for all 2 unresolved speakers' }),
    )
    expect(approveAllFallbacks).toHaveBeenCalledWith({ jobId: JOB_ID })

    expect(
      await screen.findByText('Approved for this whole book by ui-test-reviewer.', undefined, WAIT),
    ).toBeDefined()
    expect(
      (screen.getByRole('button', { name: 'Render approved script' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false)

    await user.click(screen.getByRole('button', { name: 'Render approved script' }))
    expect(renderApprovedScript).toHaveBeenCalledWith({ jobId: JOB_ID })
  })

  it('lists chapter audio and the numbered M4B for a completed job, with warnings', async () => {
    const getJobState = vi.fn(async () => ({
      ok: true as const,
      value: view({
        state: 'completed',
        stage: 'completed',
        stageLabel: 'Completed',
        completedSegments: 16,
        percentComplete: 100,
        active: false,
        finished: true,
        latestMessage: 'Audiobook completed',
        warnings: [
          {
            segmentId: 'book-uitest0000000000000001-ch0001-p000002-s0001',
            chapterLabel: 'Chapter 1',
            speakerId: null,
            voiceProfileId: 'fallback-serena-gentle',
            reason: 'unresolved_speaker',
            message: 'No speaker could be identified, so the fallback dialogue voice was used.',
          },
        ],
        output: {
          version: 1,
          versionLabel: 'v001',
          m4bFileName: 'fixture-book-v001.m4b',
          downloadUrl: `/api/jobs/${JOB_ID}/download`,
          chapters: [
            {
              chapterId: 'book-uitest0000000000000001-ch0001',
              chapterLabel: 'Chapter 1',
              title: 'Fixture Chapter One',
              position: 1,
              fileName: 'fixture-book-v001-ch01.wav',
              audioUrl: `/api/jobs/${JOB_ID}/audio/book-uitest0000000000000001-ch0001`,
            },
            {
              chapterId: 'book-uitest0000000000000001-ch0002',
              chapterLabel: 'Chapter 2',
              title: 'Fixture Chapter Two',
              position: 2,
              fileName: 'fixture-book-v001-ch02.wav',
              audioUrl: `/api/jobs/${JOB_ID}/audio/book-uitest0000000000000001-ch0002`,
            },
          ],
        },
      }),
    }))
    renderPanel(stubClient({ getJobState }))

    expect(await screen.findByText('Completed · completed', undefined, WAIT)).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Audiobook v001' })).toBeDefined()

    const download = screen.getByRole('link', {
      name: 'Download the M4B (fixture-book-v001.m4b)',
    }) as HTMLAnchorElement
    expect(download.getAttribute('href')).toBe(`/api/jobs/${JOB_ID}/download`)
    expect(download.getAttribute('download')).toBe('fixture-book-v001.m4b')

    const players = document.querySelectorAll('audio')
    expect(players.length).toBe(2)
    expect(players[0]?.getAttribute('src')).toBe(
      `/api/jobs/${JOB_ID}/audio/book-uitest0000000000000001-ch0001`,
    )
    expect(players[0]?.getAttribute('aria-label')).toBe('Play Chapter 1 — Fixture Chapter One')
    expect(players[1]?.getAttribute('src')).toBe(
      `/api/jobs/${JOB_ID}/audio/book-uitest0000000000000001-ch0002`,
    )

    expect(screen.getByRole('heading', { name: 'Fallback voice warnings (1)' })).toBeDefined()
    expect(screen.getByText(/fallback dialogue voice was used/)).toBeDefined()
    expect(screen.getByText(/fallback-serena-gentle/)).toBeDefined()
  })
})
