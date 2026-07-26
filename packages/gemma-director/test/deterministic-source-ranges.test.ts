import { describe, expect, it } from 'vitest'
import {
  type DirectionRequest,
  DirectorFidelityError,
  validateDirectionOutput,
} from '../src/index.js'

const requestFor = (...passages: readonly string[]): DirectionRequest => ({
  requestId: 'deterministic-ranges',
  bookId: 'book-fixture',
  bookTitle: 'Synthetic Fixture',
  bookAuthor: null,
  bookSourceSha256: 'a'.repeat(64),
  chapterId: 'chapter-fixture',
  chapterPosition: 1,
  chapterTitle: 'Fixture',
  passages: passages.map((text, index) => ({ id: `passage-${index + 1}`, text })),
  speakers: [],
  narratorSpeakerId: 'narrator',
  fallbackSpeakerId: 'fallback',
})

const segment = (sourcePassageId: string, sourceText: string) => ({
  source_passage_id: sourcePassageId,
  source_text: sourceText,
  kind: 'narration' as const,
  confidence: 1,
  delivery: {
    emotion: 'neutral' as const,
    pace: 'normal' as const,
    volume: 'normal' as const,
    pause_after_ms: 0,
  },
})

const findingCodes = (run: () => unknown): readonly string[] => {
  try {
    run()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(DirectorFidelityError)
    return (error as DirectorFidelityError).findings.map((finding) => finding.code)
  }
  throw new Error('Expected deterministic source validation to fail')
}

describe('deterministic source ranges', () => {
  it('derives the range from exact immutable text without model offsets', () => {
    const request = requestFor('Alpha beta.')
    const validated = validateDirectionOutput(
      { segments: [segment('passage-1', 'Alpha beta.')] },
      request,
      0.5,
    )

    expect(validated.annotations).toEqual([
      expect.objectContaining({
        sourcePassageId: 'passage-1',
        sourceStart: 0,
        sourceEnd: 11,
        sourceText: request.passages[0]?.text,
      }),
    ])
  })

  it('classifies a one-code-point substitution as genuine text corruption', () => {
    const request = requestFor('Alpha beta.')
    expect(
      findingCodes(() =>
        validateDirectionOutput({ segments: [segment('passage-1', 'Alpha zeta.')] }, request, 0.5),
      ),
    ).toContain('text_substitution')
  })

  it('classifies a one-code-point insertion as genuine text insertion', () => {
    const request = requestFor('Alpha beta.')
    expect(
      findingCodes(() =>
        validateDirectionOutput({ segments: [segment('passage-1', 'Alpha xbeta.')] }, request, 0.5),
      ),
    ).toContain('text_insertion')
  })

  it('classifies a one-code-point omission as genuine text omission', () => {
    const request = requestFor('Alpha beta.')
    expect(
      findingCodes(() =>
        validateDirectionOutput({ segments: [segment('passage-1', 'Alpha bet.')] }, request, 0.5),
      ),
    ).toContain('text_omission')
  })

  it('classifies a repeated fragment as genuine text duplication', () => {
    const request = requestFor('Echo. Next.')
    expect(
      findingCodes(() =>
        validateDirectionOutput(
          {
            segments: [
              segment('passage-1', 'Echo. '),
              segment('passage-1', 'Echo. '),
              segment('passage-1', 'Next.'),
            ],
          },
          request,
          0.5,
        ),
      ),
    ).toContain('text_duplication')
  })

  it('rejects passage reorder with a truthful passage-order code', () => {
    const request = requestFor('First.', 'Second.')
    expect(
      findingCodes(() =>
        validateDirectionOutput(
          {
            segments: [segment('passage-2', 'Second.'), segment('passage-1', 'First.')],
          },
          request,
          0.5,
        ),
      ),
    ).toContain('passage_reorder')
  })

  it('maps repeated substrings by the sequential cursor rather than global search', () => {
    const request = requestFor('Echo Echo')
    const validated = validateDirectionOutput(
      {
        segments: [segment('passage-1', 'Echo '), segment('passage-1', 'Echo')],
      },
      request,
      0.5,
    )

    expect(
      validated.annotations.map(({ sourceStart, sourceEnd, sourceText }) => ({
        sourceStart,
        sourceEnd,
        sourceText,
      })),
    ).toEqual([
      { sourceStart: 0, sourceEnd: 5, sourceText: 'Echo ' },
      { sourceStart: 5, sourceEnd: 9, sourceText: 'Echo' },
    ])
  })

  it('derives UTF-16 boundaries for astral text and still rejects a split surrogate pair', () => {
    const text = 'A\u{1f600}B'
    const request = requestFor(text)
    const valid = validateDirectionOutput(
      {
        segments: [segment('passage-1', 'A\u{1f600}'), segment('passage-1', 'B')],
      },
      request,
      0.5,
    )
    expect(valid.annotations.map(({ sourceStart, sourceEnd }) => [sourceStart, sourceEnd])).toEqual(
      [
        [0, 3],
        [3, 4],
      ],
    )

    expect(
      findingCodes(() =>
        validateDirectionOutput(
          {
            segments: [segment('passage-1', text.slice(0, 2)), segment('passage-1', text.slice(2))],
          },
          request,
          0.5,
        ),
      ),
    ).toContain('split_grapheme')
  })
})
