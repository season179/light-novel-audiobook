import type { DirectedChapter, DirectorModel } from '@light-novel-audiobook/application'
import type {
  Book,
  Chapter,
  DeliveryDirection,
  DirectedSegment,
  SegmentKind,
} from '@light-novel-audiobook/domain'

const QUOTED_SPAN = /“[^”]*”/g
/** Speakers the fixture can name. Only some of them are cast, which exercises fallback warnings. */
const KNOWN_SPEAKERS = ['Alice', 'Bruno', 'Mira'] as const

const NARRATION_DELIVERY: DeliveryDirection = {
  emotion: 'neutral',
  pace: 'normal',
  volume: 'normal',
  pauseAfterMs: 320,
}

const DIALOGUE_DELIVERY: DeliveryDirection = {
  emotion: 'measured',
  pace: 'normal',
  volume: 'normal',
  pauseAfterMs: 180,
}

interface Fragment {
  readonly text: string
  readonly kind: SegmentKind
}

/** Splits a passage into quoted and unquoted runs whose concatenation is the exact source text. */
const splitPassage = (sourceText: string): readonly Fragment[] => {
  const fragments: Fragment[] = []
  let cursor = 0
  for (const match of sourceText.matchAll(QUOTED_SPAN)) {
    const start = match.index
    if (start > cursor) {
      fragments.push({ text: sourceText.slice(cursor, start), kind: 'narration' })
    }
    fragments.push({ text: match[0], kind: 'dialogue' })
    cursor = start + match[0].length
  }
  if (cursor < sourceText.length) {
    fragments.push({ text: sourceText.slice(cursor), kind: 'narration' })
  }
  return fragments.length === 0 ? [{ text: sourceText, kind: 'narration' }] : fragments
}

const confidenceFor = (kind: SegmentKind, speakerId: string | null): number => {
  if (kind === 'narration') return 0.99
  return speakerId === null ? 0.42 : 0.93
}

const findSpeaker = (fragments: readonly Fragment[], dialogueIndex: number): string | null => {
  const attribution = fragments
    .slice(dialogueIndex + 1)
    .filter((fragment) => fragment.kind === 'narration')
    .map((fragment) => fragment.text)
    .join(' ')
  const named = KNOWN_SPEAKERS.find((speaker) => new RegExp(`\\b${speaker}\\b`).test(attribution))
  return named === undefined ? null : named.toLowerCase()
}

/**
 * FAKE director. Deterministic, offline, and never rewrites source text: every passage is split
 * into fragments whose concatenation reproduces the passage exactly. Issue #30 replaces it.
 */
export class FakeDirectorModel implements DirectorModel {
  readonly identity = 'fake-director/1'
  private released = false

  get isReleased(): boolean {
    return this.released
  }

  async directChapter(_book: Book, chapter: Chapter): Promise<DirectedChapter> {
    const segments: DirectedSegment[] = []
    for (const passage of chapter.sourcePassages) {
      const fragments = splitPassage(passage.sourceText)
      for (const [index, fragment] of fragments.entries()) {
        const speakerId = fragment.kind === 'dialogue' ? findSpeaker(fragments, index) : null
        segments.push({
          sourcePassageId: passage.id,
          sourceText: fragment.text,
          kind: fragment.kind,
          speakerId,
          confidence: confidenceFor(fragment.kind, speakerId),
          delivery: fragment.kind === 'narration' ? NARRATION_DELIVERY : DIALOGUE_DELIVERY,
        })
      }
    }
    return { chapterId: chapter.id, segments }
  }

  async release(): Promise<void> {
    this.released = true
  }
}
