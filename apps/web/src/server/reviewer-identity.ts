import { userInfo } from 'node:os'

/** Same shape the application layer requires of an actor: non-empty, bounded, no control characters. */
const MAX_LENGTH = 128

export const REVIEWER_ENV_VARIABLE = 'LNA_REVIEWER'

/**
 * Who this server records as the human behind a fallback-voice decision.
 *
 * Issue #45 exists because an approval must be **evidence of a human decision**. Round 2 made
 * `decided_by` a required column and then filled it with the constant `'local-user'` from a React
 * component — which satisfies the column and records nothing, the same lie as the default policy one
 * layer down. Two rules follow, and they are what this module exists to enforce:
 *
 * 1. **The actor is never manufactured.** It comes from configuration (`LNA_REVIEWER`) or, failing
 *    that, from the operating system account that owns this process. Both are facts about the
 *    environment the server was started in, supplied from outside this codebase. There is no literal
 *    fallback: if neither yields a usable value this throws, and the composition root cannot be built.
 * 2. **The actor is never taken from the browser.** A `decidedBy` in a request body is
 *    self-attestation — the client could send anything, or omit it — so the review server functions
 *    deliberately do not accept one. The server decides who it is recording.
 *
 * What this proves and what it does not: it identifies the local account that made the decision, on a
 * single-user local app with no authentication. It is attribution, not authentication. When #21 or
 * later adds real users, `AudiobookWebApiOptions.reviewer` is the seam that carries the authenticated
 * identity instead, and nothing below it changes.
 */
export const resolveReviewerIdentity = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string => {
  const configured = environment[REVIEWER_ENV_VARIABLE]
  const candidate = usable(configured) ?? usable(localAccountName())
  if (candidate === undefined) {
    throw new Error(
      `Cannot record who approves a fallback voice: set ${REVIEWER_ENV_VARIABLE} to the reviewer's name. ` +
        'An approval is evidence of a human decision, so this server will not invent one.',
    )
  }
  return candidate
}

const usable = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_LENGTH) return undefined
  // A control character would end up in a persisted decision and in the review UI.
  if ([...trimmed].some((character) => (character.codePointAt(0) ?? 0) < 0x20)) return undefined
  return trimmed
}

/** `userInfo()` throws when the uid has no passwd entry, which happens in bare containers. */
const localAccountName = (): string | undefined => {
  try {
    return userInfo().username
  } catch {
    return undefined
  }
}
