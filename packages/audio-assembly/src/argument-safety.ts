import { isAbsolute, resolve } from 'node:path'
import { AudioAssemblyError } from './errors.js'

const NUL_BYTE = String.fromCharCode(0)

/**
 * Every path handed to FFmpeg is resolved to an absolute path first. That is a safety property, not
 * a convenience: an argument beginning with `-` would be parsed as an FFmpeg option, and a relative
 * name such as `http:file` could be read as a protocol specifier. An absolute POSIX path is neither.
 */
export const safeFileArgument = (label: string, path: string): string => {
  if (typeof path !== 'string' || path.length === 0) {
    throw new AudioAssemblyError(`${label} path is required`)
  }
  if (path.includes(NUL_BYTE)) {
    throw new AudioAssemblyError(`${label} path must not contain a NUL byte`)
  }
  const resolved = resolve(path)
  if (!isAbsolute(resolved) || resolved.startsWith('-')) {
    throw new AudioAssemblyError(`${label} path must resolve to an absolute path: ${path}`)
  }
  return resolved
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
 * Normalizes arbitrary EPUB metadata into a single-line value. Control characters are removed
 * rather than escaped, so the same text is safe as an `argv` element, inside a Vorbis comment, and
 * inside an ffmetadata document. Separators collapse to a space so words never merge.
 */
export const normalizeMetadataValue = (value: string): string => {
  let normalized = ''
  for (const character of value.normalize('NFC')) {
    const code = character.codePointAt(0) ?? 0
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
