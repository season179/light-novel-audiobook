// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EpubUploadPanel } from '../src/components/epub-upload-panel.js'
import { JobProgressPanel } from '../src/components/job-progress-panel.js'
import { createStubEpubBytes } from './support/stub-epub.js'
import {
  createTestHarness,
  RenderGate,
  type TestHarness,
  waitForJobState,
} from './support/test-harness.js'

const POLL_MS = 60
const WAIT = { timeout: 12_000, interval: 25 }

let harness: TestHarness
let gate: RenderGate

const withQueryClient = (children: ReactNode) =>
  createElement(
    QueryClientProvider,
    { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
    children,
  )

const renderUploadPanel = (onStarted: (jobId: string) => void) =>
  render(withQueryClient(createElement(EpubUploadPanel, { client: harness.client, onStarted })))

const renderJobPanel = (jobId: string) =>
  render(
    withQueryClient(
      createElement(JobProgressPanel, {
        client: harness.client,
        jobId,
        pollIntervalMs: POLL_MS,
      }),
    ),
  )

const epubFile = (name = 'the-lantern-courier.epub') =>
  new File([createStubEpubBytes()], name, { type: 'application/epub+zip' })

describe('browser flow: upload, generate, watch, refresh, play, download', () => {
  beforeEach(async () => {
    gate = new RenderGate(3)
    harness = await createTestHarness({ beforeRender: gate.beforeRender })
  })

  afterEach(async () => {
    gate.open()
    cleanup()
    await harness.dispose()
  })

  it('explains an invalid upload instead of starting generation', async () => {
    const user = userEvent.setup()
    renderUploadPanel(() => undefined)

    await user.click(screen.getByRole('button', { name: 'Upload EPUB' }))
    expect((await screen.findByRole('alert', undefined, WAIT)).textContent).toContain(
      'Choose an EPUB file to upload.',
    )

    const broken = new File(['definitely not a container '.repeat(20)], 'broken.epub', {
      type: 'application/epub+zip',
    })
    await user.upload(screen.getByLabelText('EPUB file'), broken)
    await user.click(screen.getByRole('button', { name: 'Upload EPUB' }))

    await waitFor(
      () => expect(screen.getByRole('alert').textContent).toContain('not a ZIP container'),
      WAIT,
    )
    expect(screen.queryByRole('button', { name: 'Generate audiobook' })).toBeNull()
  })

  it('carries an EPUB through generation and keeps state across a page refresh', async () => {
    const user = userEvent.setup()
    let startedJobId: string | null = null
    const uploadView = renderUploadPanel((jobId) => {
      startedJobId = jobId
    })

    await user.upload(screen.getByLabelText('EPUB file'), epubFile())
    await user.click(screen.getByRole('button', { name: 'Upload EPUB' }))

    const generate = await screen.findByRole('button', { name: 'Generate audiobook' }, WAIT)
    expect(screen.getAllByText('the-lantern-courier.epub').length).toBeGreaterThan(0)
    await user.click(generate)
    await waitFor(() => expect(startedJobId).not.toBeNull(), WAIT)
    const jobId = startedJobId ?? ''
    uploadView.unmount()

    // Watching a live job.
    const firstVisit = renderJobPanel(jobId)
    await waitFor(() => expect(screen.getByText('Rendering speech · running')).toBeTruthy(), WAIT)
    await waitFor(() => expect(screen.getByText('2 of 16')).toBeTruthy(), WAIT)
    expect(screen.getByRole('progressbar', { name: 'Segments rendered' })).toBeTruthy()

    // A page refresh mid-generation: nothing is kept in React, so the server answers again.
    firstVisit.unmount()
    const refreshed = renderJobPanel(jobId)
    await waitFor(() => expect(screen.getByText('2 of 16')).toBeTruthy(), WAIT)
    expect(screen.getByText('Rendering speech · running')).toBeTruthy()
    expect(refreshed.container.textContent).toContain('Chapter 1')

    // Let the rest of the book render.
    gate.open()
    await waitForJobState(harness.api, jobId, (job) => job.finished)

    const resultHeading = await screen.findByRole('heading', { name: 'Audiobook v001' }, WAIT)
    const result = resultHeading.closest('section')
    expect(result).not.toBeNull()
    if (result === null) return

    const download = within(result).getByRole('link', {
      name: /Download the M4B \(the-lantern-courier-v001\.m4b\)/,
    })
    expect(download.getAttribute('href')).toBe(`/api/jobs/${jobId}/download`)
    expect(download.getAttribute('download')).toBe('the-lantern-courier-v001.m4b')

    const players = within(result).getAllByLabelText(/^Play Chapter/)
    expect(players).toHaveLength(3)
    expect(players[0]?.getAttribute('src')).toMatch(
      new RegExp(`^/api/jobs/${jobId}/audio/book-[a-f\\d]{24}-ch0001$`),
    )
    expect(within(result).getByText('Chapter 1 — The Lamp on the Bridge')).toBeTruthy()

    // Fallback-speaker warnings are explained, not silent.
    const warnings = screen.getByRole('heading', { name: /Fallback voice warnings \(\d+\)/ })
    expect(warnings.closest('section')?.textContent).toContain('fallback dialogue voice')
    expect(screen.getByText('Completed · completed')).toBeTruthy()
  })
})
