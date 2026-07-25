import type { Chapter } from './chapter.js'
import { SourceCoverageError } from './errors.js'
import { type DirectedSegment, Segment } from './segment.js'
import { StableIds } from './stable-ids.js'

const createSegments = (
  chapter: Chapter,
  directed: readonly DirectedSegment[],
): readonly Segment[] => {
  if (directed.length === 0) {
    throw new SourceCoverageError(`Chapter ${chapter.id} has no directed segments`)
  }

  const segments: Segment[] = []
  let directedIndex = 0

  for (const passage of chapter.sourcePassages) {
    const fragments: DirectedSegment[] = []
    while (
      directedIndex < directed.length &&
      directed[directedIndex]?.sourcePassageId === passage.id
    ) {
      const fragment = directed[directedIndex]
      if (fragment === undefined) break
      fragments.push(fragment)
      directedIndex += 1
    }

    if (fragments.length === 0) {
      throw new SourceCoverageError(`Source passage ${passage.id} is missing or out of order`)
    }
    const reconstructed = fragments.map((fragment) => fragment.sourceText).join('')
    if (reconstructed !== passage.sourceText) {
      throw new SourceCoverageError(
        `Source passage ${passage.id} was rewritten, omitted, or duplicated`,
      )
    }

    for (const [fragmentIndex, fragment] of fragments.entries()) {
      segments.push(
        new Segment({
          ...fragment,
          id: StableIds.segment(passage.id, fragmentIndex + 1),
          chapterId: chapter.id,
          order: segments.length + 1,
        }),
      )
    }
  }

  if (directedIndex !== directed.length) {
    const extra = directed[directedIndex]
    throw new SourceCoverageError(
      `Directed output contains unknown, duplicate, or out-of-order passage ${extra?.sourcePassageId ?? ''}`,
    )
  }

  return Object.freeze(segments)
}

/** Proves exact, once-only passage coverage and creates source-relative segment IDs. */
export const ExactSourceCoverage = Object.freeze({ createSegments })
