import type { Segment } from '@light-novel-audiobook/domain'

/**
 * The suspicion rules for the read-only script review (#96 step 6).
 *
 * The user reading a directed script is hunting for *wrong* lines, not reading every line of a
 * 15-chapter book to find them. These flags are what "wrong" can look like in the persisted
 * direction: a voice that fell back, a spoken line nobody is attributed to, an attribution the
 * director itself was unsure of. They are derived from the persisted segment, never stored, so a
 * segment either flags now or it does not — there is no flag state to go stale.
 *
 * One rule deliberately has no flag: a `narration` segment with no speaker. That is the normal
 * shape of narration, not a suspicion.
 */

/** Below this, the director's own confidence is worth a human glance. */
export const LOW_CONFIDENCE_THRESHOLD = 0.7

export const SCRIPT_SEGMENT_FLAGS = [
  'fallback_voice',
  'unresolved_speaker',
  'missing_speaker_voice',
  'low_confidence',
] as const

export type ScriptSegmentFlag = (typeof SCRIPT_SEGMENT_FLAGS)[number]

/** Short human words for each flag. The flag is carried by these words, never by colour alone. */
export const SCRIPT_SEGMENT_FLAG_LABELS: Readonly<Record<ScriptSegmentFlag, string>> = {
  fallback_voice: 'fallback voice',
  unresolved_speaker: 'no speaker identified',
  missing_speaker_voice: 'speaker has no cast voice',
  low_confidence: 'low confidence',
}

/**
 * Every reason one persisted segment deserves a closer look, in a stable order. A line can carry
 * several at once — an unresolved speaker produces a fallback voice AND (usually) low confidence,
 * and the user benefits from seeing all of it spelled out.
 */
export const scriptSegmentFlags = (segment: Segment): readonly ScriptSegmentFlag[] => {
  const flags: ScriptSegmentFlag[] = []
  const assignment = segment.voiceAssignment
  if (assignment?.usesFallback === true) {
    flags.push('fallback_voice')
    if (assignment.fallbackReason === 'unresolved_speaker') flags.push('unresolved_speaker')
    if (assignment.fallbackReason === 'missing_speaker_voice') flags.push('missing_speaker_voice')
  } else if (
    segment.kind !== 'narration' &&
    segment.kind !== 'sound_cue' &&
    segment.speakerId === null
  ) {
    // Defensive: a character-spoken line with nobody attributed and no fallback marker should not
    // be able to exist, but if a persisted one does, it is exactly what the user is hunting for.
    flags.push('unresolved_speaker')
  }
  if (segment.confidence < LOW_CONFIDENCE_THRESHOLD) flags.push('low_confidence')
  return flags
}
