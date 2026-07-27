// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JobProgressPanel } from '../src/components/job-progress-panel.js'
import { QUEUED_RUN_MESSAGE } from '../src/server/audiobook-web-api.js'
import { createStubEpubBytes } from './support/stub-epub.js'
import {
  createTestHarness,
  RenderGate,
  type TestHarness,
  waitForJobState,
} from './support/test-harness.js'

/**
 * Regression for the round-2 MEDIUM: a retry or recovery is queued before the use case writes
 * anything, so the repository still holds the previous terminal snapshot. Reporting that verbatim
 * told the page the job was inactive, it stopped polling, and a run that was about to start looked
 * like a hang. This drives the real component through exactly that sequence.
 */
const POLL_MS = 40
const WAIT = { timeout: 15_000, interval: 25 }

let harness: TestHarness
let behavior: (segmentId: string) => Promise<void>

const renderJobPanel = (jobId: string): ReactNode =>
  render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(JobProgressPanel, { client: harness.client, jobId, pollIntervalMs: POLL_MS }),
    ),
  ) as unknown as ReactNode

describe('a queued retry keeps the progress page live', () => {
  beforeEach(async () => {
    behavior = async () => undefined
    harness = await createTestHarness({ beforeRender: (segmentId) => behavior(segmentId) })
  })

  afterEach(async () => {
    behavior = async () => undefined
    cleanup()
    await harness.dispose()
    vi.restoreAllMocks()
  })

  it('polls a retry that is queued behind another job through to completion', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const retried = await harness.api.uploadEpub({
      fileName: 'retried-book.epub',
      bytes: createStubEpubBytes('retried'),
    })
    const blocking = await harness.api.uploadEpub({
      fileName: 'blocking-book.epub',
      bytes: createStubEpubBytes('blocking'),
    })

    // 1. The book fails, leaving a terminal snapshot behind.
    behavior = async () => {
      throw new Error('injected render failure')
    }
    const firstAttempt = await harness.api.startGeneration({ uploadId: retried.uploadId })
    await waitForJobState(harness.api, firstAttempt.jobId, (job) => job.state === 'failed')

    // 2. Another job takes the runner and holds it.
    const gate = new RenderGate(1)
    behavior = gate.beforeRender
    const blockingRun = await harness.api.startGeneration({ uploadId: blocking.uploadId })
    await waitForJobState(harness.api, blockingRun.jobId, (job) => job.stage === 'rendering')

    // 3. The user resumes the failed rendering stage; it queues behind the blocking job.
    const retryRun = await harness.api.resumeGeneration({ jobId: firstAttempt.jobId })
    expect(retryRun.jobId).toBe(firstAttempt.jobId)
    expect(retryRun.job.active).toBe(true)
    expect(retryRun.job.state).toBe('pending')
    expect(retryRun.job.latestMessage).toBe(QUEUED_RUN_MESSAGE)

    // 4. The page the user lands on must report the queued run and keep polling.
    renderJobPanel(firstAttempt.jobId)
    await waitFor(() => expect(screen.getByText(QUEUED_RUN_MESSAGE)).toBeTruthy(), WAIT)

    // 5. Once the runner frees up, the same page reaches the finished audiobook with no refresh.
    behavior = async () => undefined
    gate.open()
    await waitForJobState(harness.api, blockingRun.jobId, (job) => job.finished)

    const heading = await screen.findByRole('heading', { name: 'Audiobook v001' }, WAIT)
    expect(heading).toBeTruthy()
    expect(screen.getByText('Completed · completed')).toBeTruthy()
    expect(screen.getByText('16 of 16')).toBeTruthy()
  })
})
