import type { Chapter } from './chapter.js'
import { SourceCoverageError } from './errors.js'
import { type DirectedSegment, Segment } from './segment.js'
import { StableIds } from './stable-ids.js'

interface SourceFragment {
  readonly sourcePassageId: string
  readonly sourceText: string
}

const groupExactFragments = <Fragment extends SourceFragment>(
  chapter: Chapter,
  directed: readonly Fragment[],
): readonly (readonly Fragment[])[] => {
  if (directed.length === 0) {
    throw new SourceCoverageError(`Chapter ${chapter.id} has no directed segments`)
  }

  const grouped: Fragment[][] = []
  let directedIndex = 0

  for (const passage of chapter.sourcePassages) {
    const fragments: Fragment[] = []
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
    grouped.push(fragments)
  }

  if (directedIndex !== directed.length) {
    const extra = directed[directedIndex]
    throw new SourceCoverageError(
      `Directed output contains unknown, duplicate, or out-of-order passage ${extra?.sourcePassageId ?? ''}`,
    )
  }

  return grouped
}

const createSegments = (
  chapter: Chapter,
  directed: readonly DirectedSegment[],
): readonly Segment[] => {
  const segments: Segment[] = []
  for (const [passageIndex, fragments] of groupExactFragments(chapter, directed).entries()) {
    const passage = chapter.sourcePassages[passageIndex]
    if (passage === undefined) throw new SourceCoverageError('Source passage grouping is invalid')
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
  return Object.freeze(segments)
}

const assertSegments = (chapter: Chapter, segments: readonly Segment[]): void => {
  groupExactFragments(chapter, segments)
}

/** Proves exact, once-only passage coverage and creates or validates chapter segments. */
export const ExactSourceCoverage = Object.freeze({ createSegments, assertSegments })
