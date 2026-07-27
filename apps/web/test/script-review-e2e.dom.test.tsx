// @vitest-environment jsdom
/**
 * End-to-end proof for #96 step 6: a user looking at a REAL directed book can read its script and
 * see which lines are flagged.
 *
 * The two neighbouring suites each prove half of that: `script-review.test.ts` drives the real API
 * and never renders, and `script-review-panel.dom.test.tsx` renders the component against a stubbed
 * client with hand-built views. This test joins them — real harness, real in-process API, the real
 * `JobProgressPanel` — so the mount condition, the `AudiobookClient` wiring, the disclosures, and
 * the server-computed flags becoming a visible "Flagged:" line are all covered by one path. Every
 * expectation is read back out of the real API, never hardcoded, so the test cannot drift from the
 * fixture. All prose involved is the repo's invented fixture filler — never book content.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { JobProgressPanel } from '../src/components/job-progress-panel.js'
import type { ScriptChapterView } from '../src/server/script-review-view.js'
import { createStubEpubBytes } from './support/stub-epub.js'
import { createTestHarness, type TestHarness } from './support/test-harness.js'

const WAIT = { timeout: 15_000, interval: 25 }

let harness: TestHarness | undefined

afterEach(async () => {
  cleanup()
  await harness?.dispose()
  harness = undefined
})

const renderJobPage = (children: ReactNode) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>,
  )

/** A segment whose text occurs exactly once in its chapter, so screen queries cannot be ambiguous. */
const uniqueSegment = (chapter: ScriptChapterView, flagged: boolean) => {
  const found = chapter.segments.find(
    (segment) =>
      segment.flags.length > 0 === flagged &&
      chapter.segments.filter((candidate) => candidate.sourceText === segment.sourceText).length ===
        1,
  )
  if (found === undefined) {
    throw new Error(
      `fixture chapter has no unique ${flagged ? 'flagged' : 'unflagged'} segment — the fixture no longer exercises this test`,
    )
  }
  return found
}

/**
 * Finds a rendered line. The director's split can leave leading/trailing whitespace on a fragment,
 * while testing-library normalizes node text — so queries match the trimmed text as a substring.
 */
const renderedLines = (sourceText: string) =>
  screen.getAllByText(sourceText.trim(), { exact: false })

const lineItemOf = (sourceText: string): Element => {
  const item = renderedLines(sourceText)[0]?.closest('li')
  if (item == null) throw new Error(`line is not in a list item: ${sourceText}`)
  return item
}

describe('the directed script is readable from the real job page (#96 step 6 e2e)', () => {
  it('shows the persisted script text and its flags through the real API and the real panel', async () => {
    harness = await createTestHarness()
    const api = harness.api
    const upload = await api.uploadEpub({
      fileName: 'script-e2e.epub',
      bytes: createStubEpubBytes('script-e2e'),
    })
    const started = await api.startGeneration({ uploadId: upload.uploadId })
    // Wait on the raw state: no review decision is made for this test.
    const deadline = performance.now() + 45_000
    while (performance.now() < deadline) {
      const job = await api.getJobState({ jobId: started.jobId })
      if (job !== null && !job.active && job.state === 'awaiting_review') break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const resting = await api.getJobState({ jobId: started.jobId })
    expect(resting?.state).toBe('awaiting_review')

    // What the persisted book actually holds — the thing the render gate hashes. Every later
    // expectation is derived from these reads, never hardcoded.
    const index = await api.listScriptChapters({ jobId: started.jobId })
    expect(index.chapters.length).toBeGreaterThan(0)
    // Loud guard, not a skip: if the fixture book ever stops producing flagged segments, this test
    // fails here instead of silently asserting nothing.
    expect(index.flaggedSegments).toBeGreaterThan(0)

    const flaggedSummary = index.chapters.find((chapter) => chapter.flaggedCount > 0)
    if (flaggedSummary === undefined) {
      throw new Error('index reports flagged segments but no chapter holds them')
    }
    const chapter = await api.getScriptChapter({
      jobId: started.jobId,
      chapterId: flaggedSummary.chapterId,
    })
    const flagged = uniqueSegment(chapter, true)
    const unflagged = uniqueSegment(chapter, false)

    // The job page, exactly as the user lands on it.
    const user = userEvent.setup()
    renderJobPage(
      <JobProgressPanel client={harness.client} jobId={started.jobId} pollIntervalMs={60} />,
    )

    // The mount: the panel is offered on the real page (this is what the mount condition gates).
    const disclosure = await screen.findByRole('button', { name: 'Show the script' }, WAIT)
    await user.click(disclosure)

    // The chapter expander is labelled from the persisted book, with its flagged count in words.
    const expander = await screen.findByRole(
      'button',
      {
        name: `Chapter ${flaggedSummary.position} of ${index.chapterCount} — ${flaggedSummary.title}`,
      },
      WAIT,
    )
    const chapterItem = expander.closest('li')
    if (chapterItem === null) throw new Error('chapter expander is not in a list item')
    expect(
      within(chapterItem).getByText(
        new RegExp(`· ${flaggedSummary.flaggedCount} flagged — worth a look`),
      ),
    ).toBeDefined()
    await user.click(expander)

    // Every line of the chapter is on screen, exactly as it will be spoken.
    for (const segment of chapter.segments) {
      await waitFor(() => expect(renderedLines(segment.sourceText).length).toBeGreaterThan(0), WAIT)
    }

    // Both directions of the flag, on elements the server-computed flags produced.
    const flaggedLine = lineItemOf(flagged.sourceText)
    expect(flaggedLine.getAttribute('data-flagged')).toBe('true')
    expect(within(flaggedLine as HTMLElement).getByText(/Flagged:/)).toBeDefined()

    const unflaggedLine = lineItemOf(unflagged.sourceText)
    expect(unflaggedLine.getAttribute('data-flagged')).toBeNull()
    expect(within(unflaggedLine as HTMLElement).queryByText(/Flagged:/)).toBeNull()
  }, 60_000)
})
