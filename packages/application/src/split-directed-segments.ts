import { type DirectedSegment, DomainError } from '@light-novel-audiobook/domain'

/**
 * Maximum code-point length of a single render fragment (#55). Real Qwen3-TTS renders crossed the
 * 30 s `maximumDurationSeconds` ceiling between 470 and 486 characters (content-dependent), so this
 * sits well below the crossing to leave headroom rather than riding the measured line.
 */
export const MAX_FRAGMENT_CHARACTERS = 400

/**
 * Bounded allowance by which one piece may exceed `MAX_FRAGMENT_CHARACTERS` to absorb an otherwise
 * isolated separator (#55 r2, MEDIUM 1). A separator is a few characters, not a re-budget: this
 * absorbs any realistic inter-token whitespace (single/double/triple space, tabs, small indent)
 * while using only a small slice of the ~70-character margin to the measured 470–486 crossing, so a
 * maxed-out piece is still ≤ 408. A whitespace run too long to attach within this throws.
 */
export const SEPARATOR_OVERSHOOT = 8

/**
 * Policy version for the deterministic split (#55 r2, MEDIUM 2). Bumped when the boundary algorithm
 * or separator handling changes, so a changed splitter invalidates the generation command identity.
 */
export const SPLITTER_POLICY_VERSION = 1

export interface SplitterPolicy {
  readonly maxFragmentCharacters: number
  readonly separatorOvershoot: number
}

export const DEFAULT_SPLITTER_POLICY: SplitterPolicy = Object.freeze({
  maxFragmentCharacters: MAX_FRAGMENT_CHARACTERS,
  separatorOvershoot: SEPARATOR_OVERSHOOT,
})

/**
 * Stable identity for the splitter policy, folded into the generation command identity (#55 r2) so
 * that changing the budget, the overshoot, or the boundary algorithm invalidates affected work.
 */
export function splitterIdentity(policy: SplitterPolicy = DEFAULT_SPLITTER_POLICY): string {
  return JSON.stringify({
    schema: SPLITTER_POLICY_VERSION,
    maxFragmentCharacters: policy.maxFragmentCharacters,
    separatorOvershoot: policy.separatorOvershoot,
  })
}

const SENTENCE_TERMINATORS = new Set(['.', '!', '?', '…', '。'])
const CLAUSE_TERMINATORS = new Set([',', ';', ':', '—', '–', '、'])
// Closing quotes/brackets that may follow a terminator before the separating whitespace; skipped
// when classifying a boundary so `.” ` still reads as a sentence end.
const CLOSING_PUNCTUATION = new Set(['"', '“', '’', "'", ')', ']', '}', '»', '」', '』'])

type BoundaryTier = 'sentence' | 'clause' | 'word'

function isWhitespace(cluster: string): boolean {
  return /\s/u.test(cluster)
}

/** Splits `text` into its grapheme clusters (astral characters, combining marks, and emoji/ZWJ
 * sequences survive intact), so any boundary between clusters is grapheme-safe. */
function graphemes(text: string): string[] {
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
  return Array.from(segmenter.segment(text), (segment) => segment.segment)
}

/** Code-point length, matching the character counts measured in #55. */
function codePointLength(text: string): number {
  return Array.from(text).length
}

/**
 * Classifies a candidate split point `end` (the piece would be clusters[start..end)) by the tiered
 * preference in #55. Returns `undefined` when the point is mid-word, so a caller that only splits
 * at classified points can never break a word.
 */
function classifyBoundary(clusters: readonly string[], end: number): BoundaryTier | undefined {
  if (end <= 0 || end > clusters.length) return undefined
  const previous = clusters.at(end - 1)
  if (previous === undefined) return undefined
  const next = end < clusters.length ? clusters.at(end) : undefined
  const atWordBoundary = isWhitespace(previous) || (next !== undefined && isWhitespace(next))
  if (!atWordBoundary) return undefined
  // The triggering punctuation is the last non-whitespace, non-closing cluster before `end`.
  for (let k = end - 1; k >= 0; k -= 1) {
    const cluster = clusters.at(k)
    if (cluster !== undefined && !isWhitespace(cluster) && !CLOSING_PUNCTUATION.has(cluster)) {
      if (SENTENCE_TERMINATORS.has(cluster)) return 'sentence'
      if (CLAUSE_TERMINATORS.has(cluster)) return 'clause'
      return 'word'
    }
  }
  return 'word'
}

function latestBoundary(
  clusters: readonly string[],
  start: number,
  maxEnd: number,
  tier: BoundaryTier,
): number | undefined {
  // A split point must be > start (the piece has to be non-empty), so never consider boundaries at
  // or before `start` -- doing so would return a point in already-consumed text and stall the loop.
  for (let end = maxEnd; end > start; end -= 1) {
    if (classifyBoundary(clusters, end) === tier) return end
  }
  return undefined
}

/** Code points in `clusterCodePoints` over the half-open range [start, end). */
function rangeCodePoints(clusterCodePoints: readonly number[], start: number, end: number): number {
  let total = 0
  for (let i = start; i < end; i += 1) total += clusterCodePoints.at(i) ?? 0
  return total
}

/**
 * Partitions `text` into pieces no longer than `maxCharacters` code points. Pieces are contiguous
 * ranges of the grapheme-cluster array, so concatenating them reproduces `text` exactly. Prefers
 * sentence boundaries, falls back to clause, then word; never breaks a grapheme or a word. A run
 * with no boundary within the budget (a single long whitespace-free token) throws rather than
 * truncate or emit an over-budget piece.
 */
function splitText(text: string, maxCharacters: number, sourcePassageId: string): string[] {
  if (codePointLength(text) <= maxCharacters) {
    return attachOrphanSeparators([text], maxCharacters, sourcePassageId)
  }

  const clusters = graphemes(text)
  const clusterCodePoints = clusters.map((cluster) => codePointLength(cluster))

  const pieces: string[] = []
  let start = 0
  while (start < clusters.length) {
    if (rangeCodePoints(clusterCodePoints, start, clusters.length) <= maxCharacters) {
      pieces.push(clusters.slice(start).join(''))
      break
    }
    // maxEnd: the largest end > start whose piece still fits the budget (running accumulator, O(n)).
    let maxEnd = start
    let accumulated = 0
    while (maxEnd + 1 <= clusters.length) {
      const next = clusterCodePoints.at(maxEnd) ?? 0
      if (accumulated + next > maxCharacters) break
      accumulated += next
      maxEnd += 1
    }
    if (maxEnd === start) {
      // A single grapheme cluster exceeds the budget. Impossible at sane budgets, but fail closed.
      throw new DomainError(
        `Directed segment for source passage ${sourcePassageId} cannot be split: a grapheme cluster exceeds the ${maxCharacters}-character render budget`,
      )
    }
    let end: number | undefined
    for (const tier of ['sentence', 'clause', 'word'] as const) {
      end = latestBoundary(clusters, start, maxEnd, tier)
      if (end !== undefined) break
    }
    if (end === undefined || end <= start) {
      throw new DomainError(
        `Directed segment for source passage ${sourcePassageId} cannot be split: a run longer than the ${maxCharacters}-character render budget has no sentence, clause, or word boundary to split on, and splitting it would break a word`,
      )
    }
    pieces.push(clusters.slice(start, end).join(''))
    start = end
  }
  return attachOrphanSeparators(pieces, maxCharacters, sourcePassageId)
}

/**
 * Merges any whitespace-only piece into a neighbour so the splitter never emits a piece whose
 * `trim()` is empty (`QwenTtsSpeechEngine.validateRequest` rejects those). A separator attaches to
 * the preceding piece by default, or to the following piece if that is where it fits; the piece may
 * overshoot `maxCharacters` by at most `SEPARATOR_OVERSHOOT`. A run too long to attach within that
 * ceiling -- or an all-whitespace fragment -- throws rather than silently truncate or emit an
 * unrenderable piece. Merging adjacent pieces keeps the partition exact.
 */
function attachOrphanSeparators(
  pieces: readonly string[],
  maxCharacters: number,
  sourcePassageId: string,
): string[] {
  const ceiling = maxCharacters + SEPARATOR_OVERSHOOT
  const attached: string[] = []
  let pendingSeparator = ''
  const flush = (token: string): void => {
    const merged = pendingSeparator + token
    if (codePointLength(merged) > ceiling) {
      throw new DomainError(
        `Directed segment for source passage ${sourcePassageId} cannot be split: a whitespace run longer than the ${SEPARATOR_OVERSHOOT}-character separator allowance cannot attach to a neighbouring piece within the ${ceiling}-character ceiling`,
      )
    }
    attached.push(merged)
    pendingSeparator = ''
  }
  for (const piece of pieces) {
    if (piece.trim().length === 0) {
      const previous = attached.at(-1)
      if (previous !== undefined && codePointLength(previous) + codePointLength(piece) <= ceiling) {
        attached[attached.length - 1] = previous + piece
      } else {
        // No preceding piece, or it is already at the ceiling: defer to the following piece.
        pendingSeparator += piece
      }
    } else {
      flush(piece)
    }
  }
  if (pendingSeparator !== '') {
    const previous = attached.at(-1)
    if (previous === undefined) {
      throw new DomainError(
        `Directed segment for source passage ${sourcePassageId} cannot be split: the fragment is whitespace-only`,
      )
    }
    if (codePointLength(previous) + codePointLength(pendingSeparator) > ceiling) {
      throw new DomainError(
        `Directed segment for source passage ${sourcePassageId} cannot be split: a trailing whitespace run longer than the ${SEPARATOR_OVERSHOOT}-character separator allowance cannot attach within the ${ceiling}-character ceiling`,
      )
    }
    attached[attached.length - 1] = previous + pendingSeparator
  }
  return attached
}

/**
 * Deterministically splits over-long directed fragments into a partition (#55). Each output
 * fragment inherits the original's passage id, kind, speaker, confidence, and delivery; only the
 * `sourceText` differs (and, downstream, the positionally-derived segment id). The fragments
 * concatenate to the original fragment's `sourceText` exactly, so `ExactSourceCoverage.createSegments`
 * still proves once-only passage coverage.
 */
export function splitDirectedSegments(
  directed: readonly DirectedSegment[],
  maxCharacters: number = MAX_FRAGMENT_CHARACTERS,
): DirectedSegment[] {
  const result: DirectedSegment[] = []
  for (const fragment of directed) {
    for (const piece of splitText(fragment.sourceText, maxCharacters, fragment.sourcePassageId)) {
      result.push({ ...fragment, sourceText: piece })
    }
  }
  return result
}
