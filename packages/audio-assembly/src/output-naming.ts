import type { OutputVersion } from '@light-novel-audiobook/domain'

const RESERVED_CHARACTERS = new Set([
  '/',
  '\\',
  ':',
  '*',
  '?',
  '"',
  '<',
  '>',
  '|',
  String.fromCharCode(0),
])

const MAX_COMPONENT_LENGTH = 80

/**
 * Turns a book title into one safe filename component. Non-ASCII text is preserved because the
 * workspace lives on a Unicode filesystem; only path separators, shell-hostile punctuation, and
 * control characters are replaced.
 */
export const sanitizeFileNameComponent = (title: string, fallback = 'audiobook'): string => {
  let sanitized = ''
  for (const character of title.normalize('NFC')) {
    const code = character.codePointAt(0) ?? 0
    const unsafe =
      RESERVED_CHARACTERS.has(character) || code < 0x20 || (code >= 0x7f && code <= 0x9f)
    sanitized += unsafe ? '-' : character
  }
  const collapsed = sanitized
    .replace(/\s+/gu, ' ')
    .replace(/-{2,}/gu, '-')
    .slice(0, MAX_COMPONENT_LENGTH)
    .replace(/^[-.\s]+/u, '')
    .replace(/[-.\s]+$/u, '')
  return collapsed.length === 0 ? fallback : collapsed
}

/** `<title>-vNNN.m4b`, the numbered book export named in the plan. */
export const audiobookFileName = (title: string, version: OutputVersion): string =>
  version.fileName(sanitizeFileNameComponent(title), 'm4b')

/** `<title>-vNNN-chNN.flac`, the numbered chapter master named in the plan. */
export const chapterAudioFileName = (
  title: string,
  version: OutputVersion,
  position: number,
  chapterCount: number,
): string => {
  const width = Math.max(2, String(chapterCount).length)
  const numbered = `ch${String(position).padStart(width, '0')}`
  return `${sanitizeFileNameComponent(title)}-${version.label}-${numbered}.flac`
}

/** The manifest sits beside the book export and carries the same version number. */
export const manifestFileNameFor = (m4bFileName: string): string =>
  `${m4bFileName.replace(/\.m4b$/iu, '')}.manifest.json`
