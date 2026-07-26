/**
 * `fakeDirectorSpeakers` exists so the fake director can be made to emit an uncast speaker and fire
 * a real review gate (#21). It must never reach real transports: in real mode it would silently
 * change what Gemma is told the cast is, so a real book would be directed against speakers the
 * render cannot produce — a corrupted run that still looks successful.
 *
 * The guard was added with that feature and had no cover: replacing its condition with `false` left
 * the whole suite green. This file is the cover. It asserts the two properties that matter — that
 * real mode is refused, and that the refusal happens *before* any work — and it deliberately does
 * not construct real transports, because the guard must fire without them.
 */
import { runPipeline } from '@light-novel-audiobook/pipeline-driver'
import { describe, expect, it, vi } from 'vitest'

/**
 * Only `mode` is read before the guard, so a mode-carrying stub is the whole fixture. Anything the
 * guard lets past would immediately fail on the missing rest, which is itself part of the proof:
 * the error below can only be the guard's.
 */
const transportsWithMode = (mode: 'fake' | 'real') =>
  ({ mode }) as unknown as Parameters<typeof runPipeline>[0]['transports']

const optionsFor = (mode: 'fake' | 'real', epubPath: string) =>
  ({
    transports: transportsWithMode(mode),
    epubPath,
    workspaceRoot: '/nonexistent/workspace-that-must-never-be-touched',
    jobId: 'job-guard-probe',
    fakeDirectorSpeakers: [{ id: 'speaker-not-in-the-cast', aliases: [] }],
  }) as unknown as Parameters<typeof runPipeline>[0]

describe('the fake director speaker override is fake-mode only', () => {
  it('refuses real transports', async () => {
    await expect(runPipeline(optionsFor('real', '/nonexistent/book.epub'))).rejects.toThrow(
      'A fake director speaker override cannot be used with real transports',
    )
  })

  it('refuses before reading the EPUB, so no real work can precede the refusal', async () => {
    const readFile = vi.fn()
    vi.doMock('node:fs/promises', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:fs/promises')>()),
      readFile,
    }))

    await expect(runPipeline(optionsFor('real', '/nonexistent/book.epub'))).rejects.toThrow(
      'cannot be used with real transports',
    )
    expect(readFile).not.toHaveBeenCalled()

    vi.doUnmock('node:fs/promises')
  })

  it('lets fake mode past the guard, so the guard is not simply refusing everything', async () => {
    // Fake mode must reach real work and fail on the missing EPUB instead — otherwise a guard that
    // rejected unconditionally would pass the two tests above while breaking the feature.
    await expect(runPipeline(optionsFor('fake', '/nonexistent/book.epub'))).rejects.not.toThrow(
      'cannot be used with real transports',
    )
  })
})
