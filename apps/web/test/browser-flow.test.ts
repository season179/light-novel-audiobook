// @vitest-environment jsdom

import { AudiobookJob } from '@light-novel-audiobook/domain'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createElement, type ReactNode, useState } from 'react'
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

const BrowserSurface = () => {
  const [jobId, setJobId] = useState<string | null>(null)
  return jobId === null
    ? createElement(EpubUploadPanel, { client: harness.client, onStarted: setJobId })
    : createElement(JobProgressPanel, {
        client: harness.client,
        jobId,
        pollIntervalMs: POLL_MS,
      })
}

const renderBrowserSurface = () => render(withQueryClient(createElement(BrowserSurface)))

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

  it('starts a bounded slice from the upload form', async () => {
    const user = userEvent.setup()
    let startedJobId: string | null = null
    renderUploadPanel((jobId) => {
      startedJobId = jobId
    })

    await user.upload(screen.getByLabelText('EPUB file'), epubFile())
    await user.click(screen.getByRole('button', { name: 'Upload EPUB' }))
    await screen.findByRole('button', { name: 'Generate audiobook' }, WAIT)

    await user.type(screen.getByLabelText('Number of chapters'), '1')
    await user.click(screen.getByRole('button', { name: 'Generate this slice' }))

    await waitFor(() => expect(startedJobId).not.toBeNull(), WAIT)
    const jobId = startedJobId ?? ''
    expect(jobId).toContain('-slice-maxChapters=1')
    await waitForJobState(harness.api, jobId, (job) => job.state === 'awaiting_review')
    const job = await harness.api.getJobState({ jobId })
    expect(job?.state).toBe('awaiting_review')
  })

  it('reopens a genuinely failed bounded start with the same slice bounds', async () => {
    await harness.dispose()
    let renderAttempts = 0
    harness = await createTestHarness({
      beforeRender: async () => {
        renderAttempts += 1
        if (renderAttempts === 1) throw new Error('Injected bounded render failure')
      },
    })
    const user = userEvent.setup()
    let startedJobId: string | null = null
    renderUploadPanel((jobId) => {
      startedJobId = jobId
    })

    await user.upload(screen.getByLabelText('EPUB file'), epubFile('bounded-resume.epub'))
    await user.click(screen.getByRole('button', { name: 'Upload EPUB' }))
    await screen.findByRole('button', { name: 'Generate audiobook' }, WAIT)

    await user.type(screen.getByLabelText('Start at chapter'), '2')
    await user.type(screen.getByLabelText('Number of chapters'), '1')
    await user.type(screen.getByLabelText('Passages per chapter'), '1')
    await user.click(screen.getByRole('button', { name: 'Generate this slice' }))
    await waitFor(() => expect(startedJobId).not.toBeNull(), WAIT)
    const failedJobId = startedJobId ?? ''
    await waitForJobState(harness.api, failedJobId, (job) => job.state === 'failed')
    expect(failedJobId).toContain('-slice-firstChapter=2,maxChapters=1,maxPassagesPerChapter=1')

    startedJobId = null
    const directors = harness.directors.length
    const speechCalls = harness.speechEngine.rendered
    await user.click(screen.getByRole('button', { name: 'Generate this slice' }))

    await waitFor(() => expect(startedJobId).toBe(failedJobId), WAIT)
    expect((await harness.api.getJobState({ jobId: failedJobId }))?.state).toBe('failed')
    expect(harness.directors).toHaveLength(directors)
    expect(harness.speechEngine.rendered).toBe(speechCalls)
    expect(screen.queryByRole('button', { name: 'Recover and continue' })).toBeNull()
  })

  it.each(['failed', 'abandoned'] as const)(
    'opens a %s job from recent uploads and resumes it explicitly',
    async (restingState) => {
      await harness.dispose()
      let renderAttempts = 0
      harness = await createTestHarness({
        beforeRender: async () => {
          renderAttempts += 1
          if (renderAttempts === 6) throw new Error('Injected resume reachability failure')
        },
      })
      const stored = await harness.api.uploadEpub({
        fileName: `resume-${restingState}.epub`,
        bytes: createStubEpubBytes(`resume-${restingState}`),
      })
      const started = await harness.api.startGeneration({ uploadId: stored.uploadId })
      await waitForJobState(harness.api, started.jobId, (job) => job.state === 'failed')

      if (restingState === 'abandoned') {
        const failedJob = await harness.jobs.findJob(started.jobId)
        if (failedJob === undefined) throw new Error('Failed job fixture disappeared')
        const snapshot = failedJob.snapshot()
        await harness.jobs.saveJob(
          AudiobookJob.reconstitute({
            ...snapshot,
            state: 'abandoned',
            error: null,
            failureDiagnosticPath: null,
            progress: { ...snapshot.progress, latestMessage: 'Job marked abandoned' },
          }),
        )
      }

      const directorsBeforeOpen = harness.directors.length
      const speechBeforeOpen = harness.speechEngine.rendered
      const user = userEvent.setup()
      renderBrowserSurface()
      await user.click(
        await screen.findByRole(
          'button',
          {
            name: `Generate or resume the audiobook for resume-${restingState}.epub`,
          },
          WAIT,
        ),
      )

      expect(
        await screen.findByText(
          'Recheck saved segment audio and render only the missing segments.',
          undefined,
          WAIT,
        ),
      ).toBeTruthy()
      expect(harness.directors).toHaveLength(directorsBeforeOpen)
      expect(harness.speechEngine.rendered).toBe(speechBeforeOpen)
      expect(screen.queryByRole('button', { name: 'Recover and continue' })).toBeNull()

      await user.click(screen.getByRole('button', { name: 'Resume' }))
      await waitForJobState(harness.api, started.jobId, (job) => job.finished)
      expect(await screen.findByText('Completed · completed', undefined, WAIT)).toBeTruthy()
      expect(harness.directors).toHaveLength(directorsBeforeOpen)
    },
  )

  it('rejects an unparseable bound in the form instead of starting a whole-book render', async () => {
    const user = userEvent.setup()
    renderUploadPanel(() => undefined)

    await user.upload(screen.getByLabelText('EPUB file'), epubFile())
    await user.click(screen.getByRole('button', { name: 'Upload EPUB' }))
    await screen.findByRole('button', { name: 'Generate audiobook' }, WAIT)

    await user.type(screen.getByLabelText('Number of chapters'), '0')
    await user.click(screen.getByRole('button', { name: 'Generate this slice' }))

    await waitFor(
      () => expect(screen.getByRole('alert').textContent).toContain('positive whole numbers'),
      WAIT,
    )
    expect(await harness.api.listUploads()).toHaveLength(1)
    expect(harness.directors).toHaveLength(0)
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

    // The review stop. The fixture book has unresolved speakers, and nothing renders until the user
    // decides — there is no policy or default that approves them. One click covers the whole book.
    const firstVisit = renderJobPanel(jobId)
    await waitFor(
      () =>
        expect(
          screen.getByText(/Waiting for fallback voice review — \d+ lines need a decision\./),
        ).toBeTruthy(),
      WAIT,
    )
    const approveAll = await screen.findByRole(
      'button',
      { name: /Use the fallback voice for all \d+ unresolved speakers/ },
      WAIT,
    )
    // Nothing has been rendered at this point: direction may be 100%, but there is no segment
    // rendering bar or audio.
    expect(screen.queryByRole('progressbar', { name: 'Segments rendered' })).toBeNull()
    await user.click(approveAll)
    await waitFor(
      () =>
        expect(
          screen.getByText(
            'Direction finished and nothing needs a decision. Confirming starts speech rendering.',
          ),
        ).toBeTruthy(),
      WAIT,
    )

    // Refresh while resting at the hard boundary. The same confirmation action remains visible and
    // no browser mount, query cache, or polling tick starts audio by itself.
    firstVisit.unmount()
    const boundaryRefresh = renderJobPanel(jobId)
    const renderButton = await screen.findByRole('button', { name: 'Render approved script' }, WAIT)
    expect(harness.speechEngine.rendered).toBe(0)
    expect((await harness.api.getJobState({ jobId }))?.state).toBe('awaiting_review')
    await user.click(renderButton)

    // Watching a live job.
    await waitFor(() => expect(screen.getByText('Rendering speech · running')).toBeTruthy(), WAIT)
    await waitFor(() => expect(screen.getByText('2 of 16')).toBeTruthy(), WAIT)
    expect(screen.getByRole('progressbar', { name: 'Segments rendered' })).toBeTruthy()

    // A page refresh mid-generation: nothing is kept in React, so the server answers again.
    boundaryRefresh.unmount()
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

    // A book whose title collides with another one gets v002 as its first export, so the numbering
    // is explained where the version is shown rather than looking like a bug.
    expect(result.textContent).toContain('counts output files, not books')

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
