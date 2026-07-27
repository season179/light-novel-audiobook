import { DirectorError } from './errors.js'
import type { DirectionRequest, DirectorSourcePassage } from './port.js'

/**
 * Passage-window planning for issue #53. One HTTP request per chapter cannot fit the pinned
 * 32,768-token context once the wire schema's verbatim source-text echo is accounted for, so a
 * chapter is directed as an ordered sequence of contiguous passage windows.
 *
 * Everything in this module is pure: given the same passages and settings it derives the same
 * windows, which is what makes the stitched result reproducible and fuzzable.
 */
export interface DirectionChunkingSettings {
  /** Maximum source-text characters carried by one window. */
  readonly windowCharBudget: number
  /** Maximum passages carried by one window. */
  readonly windowPassageBudget: number
  /**
   * Worst-plausible output size one window may produce, in JSON characters. Output is the
   * verbatim echo plus per-fragment overhead, so this bounds the response below maxTokens.
   */
  readonly outputCharsBudget: number
  /** Fragments per passage used for the output estimate (kind-change splits). */
  readonly splitFactorAssumption: number
  /** JSON characters of per-fragment overhead used for the output estimate. */
  readonly overheadPerFragmentChars: number
  /** Tokens reserved off the pinned context for chat-template and tokenizer-estimate error. */
  readonly contextReserveTokens: number
  /** Conservative characters-per-token divisor used for prompt size estimates. */
  readonly charsPerTokenEstimate: number
  /** Halvings applied after a recoverable window-size failure before the window is retried. */
  readonly maxWindowShrinks: number
}

export const DEFAULT_DIRECTION_CHUNKING: DirectionChunkingSettings = Object.freeze({
  windowCharBudget: 6_000,
  windowPassageBudget: 24,
  outputCharsBudget: 26_000,
  splitFactorAssumption: 1.5,
  overheadPerFragmentChars: 450,
  contextReserveTokens: 2_048,
  charsPerTokenEstimate: 3.5,
  maxWindowShrinks: 6,
})

export function resolveChunkingSettings(
  overrides: Partial<DirectionChunkingSettings> | undefined,
): DirectionChunkingSettings {
  const resolved = { ...DEFAULT_DIRECTION_CHUNKING, ...overrides }
  const integers: Array<[string, number]> = [
    ['windowCharBudget', resolved.windowCharBudget],
    ['windowPassageBudget', resolved.windowPassageBudget],
    ['outputCharsBudget', resolved.outputCharsBudget],
    ['overheadPerFragmentChars', resolved.overheadPerFragmentChars],
    ['contextReserveTokens', resolved.contextReserveTokens],
    ['maxWindowShrinks', resolved.maxWindowShrinks],
  ]
  for (const [label, value] of integers) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new DirectorError(
        'configuration',
        `Direction chunking ${label} must be a positive integer`,
      )
    }
  }
  if (
    !Number.isFinite(resolved.splitFactorAssumption) ||
    resolved.splitFactorAssumption < 1 ||
    !Number.isFinite(resolved.charsPerTokenEstimate) ||
    resolved.charsPerTokenEstimate < 1
  ) {
    throw new DirectorError(
      'configuration',
      'Direction chunking split factor and chars-per-token estimate must be numbers of at least one',
    )
  }
  return Object.freeze(resolved)
}

/** One contiguous half-open passage range [start, end) planned for one request. */
export interface PassageWindow {
  readonly start: number
  readonly end: number
}

/**
 * Worst-plausible response size for a window: the verbatim echo of every passage (each fragment
 * carries its text) plus per-fragment JSON overhead, assuming kind-change splitting.
 */
export function estimateWindowOutputChars(
  passageChars: number,
  passageCount: number,
  settings: DirectionChunkingSettings,
): number {
  return Math.ceil(
    settings.splitFactorAssumption * passageChars +
      settings.splitFactorAssumption * settings.overheadPerFragmentChars * passageCount,
  )
}

function windowFits(
  passageChars: number,
  passageCount: number,
  settings: DirectionChunkingSettings,
): boolean {
  return (
    passageChars <= settings.windowCharBudget &&
    passageCount <= settings.windowPassageBudget &&
    estimateWindowOutputChars(passageChars, passageCount, settings) <= settings.outputCharsBudget
  )
}

/**
 * The largest window starting at `start` that satisfies all budgets. A passage that exceeds the
 * budgets on its own is emitted as a solo window: it can never be split across requests (the
 * wire contract requires full per-passage coverage in every request), so the solo window is the
 * only possible plan, and the caller's budget pre-flight decides whether it may be sent.
 */
export function planWindow(
  passages: readonly DirectorSourcePassage[],
  start: number,
  settings: DirectionChunkingSettings,
): PassageWindow {
  if (!Number.isSafeInteger(start) || start < 0 || start >= passages.length) {
    throw new DirectorError('configuration', `Window start ${start} is outside the chapter`)
  }
  let end = start
  let chars = 0
  while (end < passages.length) {
    const next = passages[end]
    if (next === undefined) break
    const count = end - start + 1
    if (count > 1 && !windowFits(chars + next.text.length, count, settings)) break
    chars += next.text.length
    end += 1
  }
  return { start, end }
}

/**
 * The full ordered partition for a chapter, used by tests and by the stitch assertion. The
 * runtime loop plans lazily with `planWindow` so adaptive shrinking only re-plans unsent ranges.
 */
export function planChapterWindows(
  passages: readonly DirectorSourcePassage[],
  settings: DirectionChunkingSettings,
): readonly PassageWindow[] {
  const windows: PassageWindow[] = []
  let start = 0
  while (start < passages.length) {
    const window = planWindow(passages, start, settings)
    windows.push(window)
    start = window.end
  }
  return Object.freeze(windows)
}

/**
 * A window smaller than the current one after a recoverable size-related failure. Both dimensions
 * halve because failure can come from source volume (chars) or fragment overhead (count); the floor
 * keeps a single passage sendable, which is the escape hatch the solo-window rule relies on.
 */
export function shrinkSettings(settings: DirectionChunkingSettings): DirectionChunkingSettings {
  return Object.freeze({
    ...settings,
    windowCharBudget: Math.max(500, Math.floor(settings.windowCharBudget / 2)),
    windowPassageBudget: Math.max(1, Math.floor(settings.windowPassageBudget / 2)),
  })
}

export interface WindowPromptEstimate {
  readonly promptChars: number
  readonly estimatedPromptTokens: number
  readonly promptTokenBudget: number
}

/**
 * Pre-flight prompt budget for one concrete window request. Every component is measured from the
 * actual request payload: the system prompt, the JSON envelope, the speaker roster, the carried
 * story context, and the window's passage payload.
 */
export function estimateWindowPrompt(
  fixedPromptChars: number,
  window: DirectionRequest,
  contextSizeTokens: number,
  maxOutputTokens: number,
  settings: DirectionChunkingSettings,
): WindowPromptEstimate {
  const promptChars =
    fixedPromptChars +
    window.passages.reduce(
      (total, passage) => total + passage.id.length + passage.text.length + 40,
      0,
    )
  const estimatedPromptTokens = Math.ceil(promptChars / settings.charsPerTokenEstimate)
  const promptTokenBudget = contextSizeTokens - settings.contextReserveTokens - maxOutputTokens
  return Object.freeze({ promptChars, estimatedPromptTokens, promptTokenBudget })
}

/**
 * The one situation no window plan can fix: the request is already a single passage and it still
 * cannot fit. This must be loud, because the only alternative is silently truncating source text.
 */
export function windowBudgetError(message: string, passageIds: readonly string[]): DirectorError {
  return new DirectorError(
    'configuration',
    `${message} (window passages: ${passageIds.join(', ').slice(0, 200)})`,
  )
}
