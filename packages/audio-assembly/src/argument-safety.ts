import { isAbsolute, resolve } from 'node:path'
import { AudioAssemblyError } from './errors.js'

const NUL_BYTE = String.fromCharCode(0)

/**
 * Every path handed to FFmpeg is resolved before it becomes an argument. `resolve` is what provides
 * the safety property, not a check after it: its result is always absolute, so it can never begin
 * with `-` and be parsed as an FFmpeg option, and can never look like a `protocol:` specifier.
 *
 * Resolving is only correct for a path this adapter is free to interpret. A path the adapter must
 * honour exactly — anything reserved by the persistence layer — goes through
 * `assertAbsoluteCanonicalPath` first, so resolving it is a no-op rather than a silent rewrite.
 */
export const safeFileArgument = (label: string, path: string): string => {
  if (typeof path !== 'string' || path.length === 0) {
    throw new AudioAssemblyError(`${label} path is required`)
  }
  if (path.includes(NUL_BYTE)) {
    throw new AudioAssemblyError(`${label} path must not contain a NUL byte`)
  }
  return resolve(path)
}

/**
 * Rejects a reserved path this adapter must write verbatim. A relative path would place the export in
 * the worker's working directory, and a non-canonical one (`//`, `./`, a `..` segment) would be
 * written at its resolved location while the application compares the string it reserved — the run
 * would fail after a complete encode with four files already on disk, which no retry can clear.
 */
export const assertAbsoluteCanonicalPath = (label: string, path: string): string => {
  if (typeof path !== 'string' || path.length === 0) {
    throw new AudioAssemblyError(`${label} path is required`)
  }
  if (path.includes(NUL_BYTE)) {
    throw new AudioAssemblyError(`${label} path must not contain a NUL byte`)
  }
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new AudioAssemblyError(
      `${label} path must be an absolute canonical path: ${JSON.stringify(path)}`,
    )
  }
  return path
}

const METADATA_KEY_PATTERN = /^[a-z_][a-z0-9_]*$/

/**
 * Keys come from this adapter, never from a book, so an invalid key is a programming error. The
 * check still runs because a key containing `=` would silently split a metadata assignment.
 */
export const safeMetadataKey = (key: string): string => {
  if (!METADATA_KEY_PATTERN.test(key)) {
    throw new AudioAssemblyError(`Unsupported metadata key: ${JSON.stringify(key)}`)
  }
  return key
}

const LINE_SEPARATORS = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x85, 0x2028, 0x2029])

const isControlCodePoint = (code: number): boolean =>
  code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029

/**
 * Bidirectional formatting controls. FFmpeg passes them through happily, but a title carrying an
 * RTL override renders in a player or review UI as text it does not contain, so they are dropped.
 * Other invisible format characters that carry linguistic meaning, such as ZWJ and ZWNJ, are kept.
 */
const isBidiControlCodePoint = (code: number): boolean =>
  code === 0x200e ||
  code === 0x200f ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069)

/**
 * Normalizes arbitrary EPUB metadata into a single-line value. Control characters are removed
 * rather than escaped, so the same text is safe as an `argv` element, inside a Vorbis comment, and
 * inside an ffmetadata document. Separators collapse to a space so words never merge.
 */
export const normalizeMetadataValue = (value: string): string => {
  let normalized = ''
  for (const character of value.normalize('NFC')) {
    const code = character.codePointAt(0) ?? 0
    if (isBidiControlCodePoint(code)) continue
    if (!isControlCodePoint(code)) {
      normalized += character
      continue
    }
    if (LINE_SEPARATORS.has(code)) normalized += ' '
  }
  return normalized.replace(/ {2,}/gu, ' ').trim()
}

/**
 * Builds `['-metadata', 'key=value']` pairs. Each pair is a single `argv` element, so a value
 * containing spaces, quotes, or a leading `-` cannot become another FFmpeg option. Empty values are
 * dropped instead of writing a blank tag.
 */
export const metadataArguments = (
  tags: readonly (readonly [key: string, value: string])[],
): readonly string[] => {
  const args: string[] = []
  for (const [key, value] of tags) {
    const normalized = normalizeMetadataValue(value)
    if (normalized.length === 0) continue
    args.push('-metadata', `${safeMetadataKey(key)}=${normalized}`)
  }
  return args
}
