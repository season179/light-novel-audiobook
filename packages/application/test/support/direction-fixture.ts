import {
  Book,
  Chapter,
  ExactSourceCoverage,
  SourcePassage,
  StableIds,
} from '@light-novel-audiobook/domain'

export const DIRECTION_FIXTURE_BOOK_ID = StableIds.book('1'.repeat(64))

/** Fully directed, voice-assigned fixture with two chapters and two segments in the first chapter. */
export const createDirectionFixtureBook = (): Book => {
  const chapterTexts = [
    ['Invented fixture alpha.', 'Invented fixture beta.'],
    ['Invented fixture gamma.'],
  ] as const
  const chapters = chapterTexts.map((fragments, chapterIndex) => {
    const chapterId = StableIds.chapter(DIRECTION_FIXTURE_BOOK_ID, chapterIndex + 1)
    const passage = new SourcePassage({
      id: StableIds.passage(chapterId, 1),
      chapterId,
      sourceText: fragments.join(''),
    })
    const chapter = new Chapter({
      id: chapterId,
      bookId: DIRECTION_FIXTURE_BOOK_ID,
      position: chapterIndex + 1,
      title: `fixture-chapter-${chapterIndex + 1}`,
      sourcePassages: [passage],
    })
    const segments = ExactSourceCoverage.createSegments(
      chapter,
      fragments.map((sourceText, segmentIndex) => ({
        sourcePassageId: passage.id,
        sourceText,
        kind: segmentIndex === 0 ? ('dialogue' as const) : ('narration' as const),
        speakerId: segmentIndex === 0 ? 'speaker-01' : null,
        confidence: segmentIndex === 0 ? 0.75 : 0.95,
        delivery: {
          emotion: segmentIndex === 0 ? 'restrained' : 'neutral',
          pace: segmentIndex === 0 ? ('slow' as const) : ('normal' as const),
          volume: segmentIndex === 0 ? ('soft' as const) : ('normal' as const),
          pauseAfterMs: segmentIndex === 0 ? 125 : 250,
        },
      })),
    )
    for (const segment of segments) {
      segment.assignVoice({
        voiceProfileId: segment.speakerId === null ? 'voice-narrator' : 'voice-01',
        usesFallback: false,
        fallbackReason: null,
      })
    }
    chapter.submitForReview(segments)
    chapter.approve()
    return chapter
  })
  return new Book({
    id: DIRECTION_FIXTURE_BOOK_ID,
    title: 'fixture-book',
    author: null,
    coverPath: null,
    source: { epubPath: '/tmp/invented-fixture.epub', sha256: '1'.repeat(64) },
    chapters,
  })
}
