import { userInfo } from 'node:os'

/** Same shape the application layer requires of an actor: non-empty, bounded, no controls. */
const MAX_LENGTH = 128

export const REVIEWER_ENV_VARIABLE = 'LNA_REVIEWER'

/**
 * A reviewer identity that can only originate from `resolveReviewerIdentity`.
 *
 * A nominal brand over `string`: erased at runtime, so the value serialises and compares as a plain
 * string downstream, but a slot typed `ReviewerIdentity` cannot be filled with a manufactured
 * constant or a local fork — only the canonical resolver produces this type. This is the structural
 * half of issue #87: the web composition root's reviewer slot is `ReviewerIdentity`, so a
 * `?? 'local-user'` fork at the consumption site does not typecheck. The behavioural half is the
 * test that exercises resolution without a supplied reviewer.
 */
declare const reviewerIdentityBrand: unique symbol
export type ReviewerIdentity = string & { readonly [reviewerIdentityBrand]: true }

/**
 * Resolves the local human account recorded on a fallback-voice decision.
 *
 * The actor is never manufactured: configuration wins, then the operating-system account, and if
 * neither is usable this throws. This is attribution for a local single-user tool, not
 * authentication. Browser and CLI review paths share this function so neither can drift back to a
 * hardcoded actor.
 */
export const resolveReviewerIdentity = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  accountName: () => string | undefined = localAccountName,
): ReviewerIdentity => {
  const configured = environment[REVIEWER_ENV_VARIABLE]
  const candidate =
    normalizeReviewerIdentity(configured) ?? normalizeReviewerIdentity(accountName())
  if (candidate === undefined) {
    throw new Error(
      `Cannot record who approves a fallback voice: set ${REVIEWER_ENV_VARIABLE} to the reviewer's name. ` +
        'An approval is evidence of a human decision, so this application will not invent one.',
    )
  }
  return candidate as ReviewerIdentity
}

export const normalizeReviewerIdentity = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_LENGTH) return undefined
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
