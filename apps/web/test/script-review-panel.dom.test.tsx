// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AudiobookClient } from '../src/client/audiobook-client.js'
import { JobProgressPanel } from '../src/components/job-progress-panel.js'
import { ScriptReviewPanel } from '../src/components/script-review-panel.js'
import type { JobStateView } from '../src/server/job-state-view.js'
import type {
  ScriptChapterListView,
  ScriptChapterView,
  ScriptSegmentView,
} from '../src/server/script-review-view.js'

/**
 * DOM-level proof for the read-only directed-script review (#96 step 6). All prose below is
 * invented fixture text written for these tests — never book content. Assertions are on structure,
 * ARIA, presence and text; jsdom computes no stylesheets, so nothing here asserts rendered colour.
 */

const WAIT = { timeout: 5_000, interval: 25 }

const JOB_ID = 'job-scriptreview00000001'
const BOOK_ID = 'book-scriptreview0000001'
const CH1 = `${BOOK_ID}-ch0001`
const CH2 = `${BOOK_ID}-ch0002`
const CH3 = `${BOOK_ID}-ch0003`

/** A unique sentinel: proves script text reaches the DOM of this view and nowhere else. */
const SENTINEL_LINE = 'SENTINEL-7f3c9a the lantern keeper counts the boats twice.'
const NARRATION_LINE = 'The tide worked at the stones all night without resting.'
const FLAGGED_LINE = 'Then keep the gate until the second bell.'

const segment = (overrides: Partial<ScriptSegmentView>): ScriptSegmentView => ({
  segmentId: `${CH1}-p000001-s0001`,
  order: 1,
  sourceText: NARRATION_LINE,
  kind: 'narration',
  speakerId: null,
  speakerReason: null,
  confidence: 0.99,
  voiceProfileId: 'narrator-even',
  usesFallback: false,
  fallbackReason: null,
  delivery: { emotion: 'neutral', pace: 'normal', volume: 'normal', pauseAfterMs: 320 },
  flags: [],
  ...overrides,
})

const chapterOne: ScriptChapterView = {
  jobId: JOB_ID,
  chapterId: CH1,
  position: 1,
  totalChapters: 3,
  title: 'Fixture Chapter One',
  segmentCount: 3,
  flaggedCount: 1,
  segments: [
    segment({}),
    segment({
      segmentId: `${CH1}-p000002-s0001`,
      order: 2,
      sourceText: SENTINEL_LINE,
      kind: 'narration',
    }),
    segment({
      segmentId: `${CH1}-p000003-s0001`,
      order: 3,
      sourceText: FLAGGED_LINE,
      kind: 'dialogue',
      speakerId: null,
      speakerReason: 'The director could not resolve a speaker for this line.',
      confidence: 0.42,
      voiceProfileId: 'fallback-serena-gentle',
      usesFallback: true,
      fallbackReason: 'unresolved_speaker',
      delivery: { emotion: 'measured', pace: 'normal', volume: 'normal', pauseAfterMs: 180 },
      flags: ['fallback_voice', 'unresolved_speaker', 'low_confidence'],
    }),
  ],
}

const chapterTwo: ScriptChapterView = {
  jobId: JOB_ID,
  chapterId: CH2,
  position: 2,
  totalChapters: 3,
  title: 'Fixture Chapter Two',
  segmentCount: 1,
  flaggedCount: 0,
  segments: [
    segment({
      segmentId: `${CH2}-p000001-s0001`,
      sourceText: 'They walked until the town became a rumour behind them.',
      kind: 'dialogue',
      speakerId: 'mira',
      confidence: 0.93,
      voiceProfileId: 'mira-cast',
    }),
  ],
}

const chapterThree: ScriptChapterView = {
  jobId: JOB_ID,
  chapterId: CH3,
  position: 3,
  totalChapters: 3,
  title: 'Fixture Chapter Three',
  segmentCount: 2,
  flaggedCount: 0,
  segments: [],
}

const listView: ScriptChapterListView = {
  jobId: JOB_ID,
  bookId: BOOK_ID,
  bookTitle: 'Fixture Book',
  chapterCount: 3,
  totalSegments: 6,
  flaggedSegments: 1,
  chapters: [
    { chapterId: CH1, position: 1, title: 'Fixture Chapter One', segmentCount: 3, flaggedCount: 1 },
    { chapterId: CH2, position: 2, title: 'Fixture Chapter Two', segmentCount: 1, flaggedCount: 0 },
    {
      chapterId: CH3,
      position: 3,
      title: 'Fixture Chapter Three',
      segmentCount: 2,
      flaggedCount: 0,
    },
  ],
}

const chapters: Readonly<Record<string, ScriptChapterView>> = {
  [CH1]: chapterOne,
  [CH2]: chapterTwo,
  [CH3]: chapterThree,
}

const stubClient = (overrides: Partial<AudiobookClient> = {}): AudiobookClient =>
  ({
    listScriptChapters: vi.fn(async () => ({ ok: true as const, value: listView })),
    getScriptChapter: vi.fn(async ({ chapterId }: { readonly chapterId: string }) => {
      const chapter = chapters[chapterId]
      if (chapter === undefined) {
        return {
          ok: false as const,
          error: {
            code: 'invalid_request' as const,
            message: 'That chapter is not part of this audiobook.',
          },
        }
      }
      return { ok: true as const, value: chapter }
    }),
    ...overrides,
  }) as unknown as AudiobookClient

const withQueryClient = (children: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
)

const renderPanel = (client: AudiobookClient) =>
  render(withQueryClient(<ScriptReviewPanel client={client} jobId={JOB_ID} />))

afterEach(cleanup)

describe('ScriptReviewPanel — the readable directed script (#96 step 6)', () => {
  it('fetches nothing until the reader opens the panel', () => {
    const client = stubClient()
    renderPanel(client)

    expect(screen.getByRole('button', { name: 'Show the script' })).toBeDefined()
    expect(client.listScriptChapters).not.toHaveBeenCalled()
    expect(client.getScriptChapter).not.toHaveBeenCalled()
  })

  it('lists chapters with position-of-total, segment counts and flagged counts — text for none', async () => {
    const user = userEvent.setup()
    renderPanel(stubClient())

    await user.click(screen.getByRole('button', { name: 'Show the script' }))

    expect(
      await screen.findByText('Chapter 1 of 3 — Fixture Chapter One', undefined, WAIT),
    ).toBeDefined()
    expect(screen.getByText('Chapter 2 of 3 — Fixture Chapter Two')).toBeDefined()
    expect(screen.getByText('Chapter 3 of 3 — Fixture Chapter Three')).toBeDefined()
    // Where they are, and where the suspicious lines are, in words.
    expect(screen.getByText(/3 chapters · 6 segments · 1 flagged across the book/)).toBeDefined()
    expect(screen.getByText(/3 segments · 1 flagged — worth a look/)).toBeDefined()
    expect(screen.getAllByText(/none flagged/)).toHaveLength(2)
    // The index ships no story text.
    expect(screen.queryByText(SENTINEL_LINE)).toBeNull()
    expect(screen.queryByText(NARRATION_LINE)).toBeNull()
  })

  it('keeps chapters collapsed until opened, then shows the exact line with its attribution', async () => {
    const user = userEvent.setup()
    const client = stubClient()
    renderPanel(client)

    await user.click(screen.getByRole('button', { name: 'Show the script' }))
    const chapterButton = await screen.findByRole(
      'button',
      { name: 'Chapter 1 of 3 — Fixture Chapter One' },
      WAIT,
    )
    // Collapsed by default: nothing fetched, no segments on screen.
    expect(chapterButton.getAttribute('aria-expanded')).toBe('false')
    expect(client.getScriptChapter).not.toHaveBeenCalled()

    await user.click(chapterButton)

    expect(chapterButton.getAttribute('aria-expanded')).toBe('true')
    // The exact source text, as it will be spoken — the sentinel proves it reached the DOM.
    expect(await screen.findByText(SENTINEL_LINE, undefined, WAIT)).toBeDefined()
    expect(screen.getByText(NARRATION_LINE)).toBeDefined()
    // Narration and dialogue are distinguished, with attribution and voice spelled out.
    expect(screen.getAllByText(/Narration — no speaker \(narration\)/)).toHaveLength(2)
    expect(screen.getByText(/Dialogue — speaker not identified/)).toBeDefined()
    expect(screen.getByText(/Voice: fallback-serena-gentle \(fallback voice\)/)).toBeDefined()
    // Delivery and confidence are readable, in numbers not colour.
    expect(
      screen.getByText(/Confidence 42% · measured · normal pace · normal volume · 180 ms pause/),
    ).toBeDefined()
    expect(
      screen.getByText(/Director note: The director could not resolve a speaker/),
    ).toBeDefined()
  })

  it('marks flagged lines in words and marks up the element, never by colour alone', async () => {
    const user = userEvent.setup()
    renderPanel(stubClient())

    await user.click(screen.getByRole('button', { name: 'Show the script' }))
    await user.click(
      await screen.findByRole('button', { name: 'Chapter 1 of 3 — Fixture Chapter One' }, WAIT),
    )
    await screen.findByText(FLAGGED_LINE, undefined, WAIT)

    const lines = Array.from(document.querySelectorAll('li.script-line'))
    expect(lines).toHaveLength(3)
    const flagged = lines.filter((line) => line.getAttribute('data-flagged') === 'true')
    expect(flagged).toHaveLength(1)
    const flaggedLine = flagged[0]
    if (flaggedLine === undefined) throw new Error('no flagged line rendered')
    const flagText = within(flaggedLine as HTMLElement).getByText(/Flagged:/)
    expect(flagText.textContent).toContain('fallback voice')
    expect(flagText.textContent).toContain('no speaker identified')
    expect(flagText.textContent).toContain('low confidence')
    // The unflagged lines carry no flag wording at all.
    const unflagged = lines.filter((line) => line.getAttribute('data-flagged') !== 'true')
    for (const line of unflagged) {
      expect(within(line as HTMLElement).queryByText(/Flagged:/)).toBeNull()
    }
  })

  it('finds the suspicious lines for the reader: the filter hides every unflagged line', async () => {
    const user = userEvent.setup()
    renderPanel(stubClient())

    await user.click(screen.getByRole('button', { name: 'Show the script' }))
    await user.click(
      await screen.findByRole('button', { name: 'Chapter 1 of 3 — Fixture Chapter One' }, WAIT),
    )
    await screen.findByText(NARRATION_LINE, undefined, WAIT)

    await user.click(screen.getByRole('checkbox', { name: /Show only flagged lines/ }))

    await waitFor(() => expect(screen.queryByText(NARRATION_LINE)).toBeNull(), WAIT)
    expect(screen.queryByText(SENTINEL_LINE)).toBeNull()
    expect(screen.getByText(FLAGGED_LINE)).toBeDefined()
  })

  it('shows the right speaker for each segment — an attribution swap cannot pass silently', async () => {
    const user = userEvent.setup()
    renderPanel(stubClient())

    await user.click(screen.getByRole('button', { name: 'Show the script' }))
    await user.click(
      await screen.findByRole('button', { name: 'Chapter 2 of 3 — Fixture Chapter Two' }, WAIT),
    )

    // The dialogue line is attributed to mira with her cast voice — exactly, on its own line.
    const line = await screen.findByText(
      'They walked until the town became a rumour behind them.',
      undefined,
      WAIT,
    )
    const item = line.closest('li')
    if (item === null) throw new Error('line is not in a list item')
    const meta = within(item).getByText(/Dialogue — spoken by mira/)
    expect(meta.textContent).toContain('Voice: mira-cast')
    expect(meta.textContent).not.toContain('fallback')
    expect(within(item).queryByText(/speaker not identified/)).toBeNull()
  })

  it('is not inside any live region, so polling never re-announces the book', async () => {
    const user = userEvent.setup()
    const { container } = renderPanel(stubClient())

    await user.click(screen.getByRole('button', { name: 'Show the script' }))
    await user.click(
      await screen.findByRole('button', { name: 'Chapter 1 of 3 — Fixture Chapter One' }, WAIT),
    )
    await screen.findByText(SENTINEL_LINE, undefined, WAIT)

    for (const live of container.querySelectorAll('[aria-live]')) {
      expect(live.textContent).not.toContain(SENTINEL_LINE)
    }
    // The whole surface is semantic: a labelled section, chapter headings, and lists of lines.
    expect(screen.getByRole('heading', { name: 'Read the directed script' })).toBeDefined()
    expect(container.querySelectorAll('ol.script-lines li.script-line').length).toBe(3)
  })

  it('reports a chapter read failure as an alert without losing the rest of the index', async () => {
    const user = userEvent.setup()
    const client = stubClient({
      getScriptChapter: vi.fn(async () => ({
        ok: false as const,
        error: {
          code: 'invalid_request' as const,
          message: 'That chapter is not part of this audiobook.',
        },
      })),
    })
    renderPanel(client)

    await user.click(screen.getByRole('button', { name: 'Show the script' }))
    await user.click(
      await screen.findByRole('button', { name: 'Chapter 1 of 3 — Fixture Chapter One' }, WAIT),
    )

    const alert = await screen.findByRole('alert', undefined, WAIT)
    expect(alert.textContent).toContain('That chapter is not part of this audiobook.')
    expect(screen.getByText('Chapter 2 of 3 — Fixture Chapter Two')).toBeDefined()
  })

  it('says so plainly when there is no directed script yet', async () => {
    const user = userEvent.setup()
    const client = stubClient({
      listScriptChapters: vi.fn(async () => ({
        ok: true as const,
        value: { ...listView, chapterCount: 0, totalSegments: 0, flaggedSegments: 0, chapters: [] },
      })),
    })
    renderPanel(client)

    await user.click(screen.getByRole('button', { name: 'Show the script' }))

    expect(await screen.findByText(/No directed script yet/, undefined, WAIT)).toBeDefined()
  })
})

describe('ScriptReviewPanel inside the job view', () => {
  const jobView = (overrides: Partial<JobStateView>): JobStateView =>
    ({
      jobId: JOB_ID,
      state: 'awaiting_review',
      stage: 'directing',
      stageLabel: 'Directing chapters',
      bookId: BOOK_ID,
      bookTitle: 'Fixture Book',
      currentChapterId: null,
      currentChapterLabel: null,
      currentChapterTitle: null,
      completedChapters: 3,
      totalChapters: 3,
      completedPassages: 11,
      totalPassages: 11,
      directionPercentComplete: 100,
      completedSegments: 0,
      totalSegments: 0,
      percentComplete: null,
      pipelineStages: [],
      latestMessage: 'Awaiting fallback approval review',
      error: null,
      failureDiagnosticPath: null,
      active: false,
      finished: false,
      review: { status: 'ready_to_confirm', blockers: 0, total: 0 },
      warnings: [],
      output: null,
      ...overrides,
    }) as JobStateView

  const fullClient = (job: JobStateView): AudiobookClient =>
    ({
      ...stubClient(),
      getJobState: vi.fn(async () => ({ ok: true as const, value: job })),
      listFallbackReview: vi.fn(async () => ({
        ok: true as const,
        value: {
          jobId: JOB_ID,
          awaitingReview: true,
          grantedBy: null,
          pendingCount: 0,
          items: [],
        },
      })),
    }) as unknown as AudiobookClient

  it('is offered on the job page once a book exists — and readable there', async () => {
    const user = userEvent.setup()
    render(
      withQueryClient(
        <JobProgressPanel client={fullClient(jobView({}))} jobId={JOB_ID} pollIntervalMs={60} />,
      ),
    )

    const toggle = await screen.findByRole('button', { name: 'Show the script' }, WAIT)
    await user.click(toggle)
    await user.click(
      await screen.findByRole('button', { name: 'Chapter 1 of 3 — Fixture Chapter One' }, WAIT),
    )
    expect(await screen.findByText(SENTINEL_LINE, undefined, WAIT)).toBeDefined()
  })

  it('is absent while the job has no book', async () => {
    render(
      withQueryClient(
        <JobProgressPanel
          client={fullClient(jobView({ bookId: null, bookTitle: null }))}
          jobId={JOB_ID}
          pollIntervalMs={60}
        />,
      ),
    )

    await screen.findByText('Awaiting fallback approval review', undefined, WAIT)
    expect(screen.queryByRole('button', { name: 'Show the script' })).toBeNull()
    expect(screen.queryByText('Read the directed script')).toBeNull()
  })
})
