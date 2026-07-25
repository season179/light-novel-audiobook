import { normalizeMetadataValue, safeMetadataKey } from './argument-safety.js'
import { AudioAssemblyError } from './errors.js'

/**
 * FFmpeg's ffmetadata format gives `=`, `;`, `#`, `\` and a newline special meaning, and requires
 * each of them to be escaped with a backslash. Escaping the backslash first is what keeps a title
 * such as `a\=b` from turning into an unescaped `=` and splitting the assignment.
 *
 * A newline is escaped as a backslash followed by the newline, matching FFmpeg's own writer. Values
 * reaching this function are already single-line, so that branch is defence in depth.
 */
export const escapeFfmetadata = (text: string): string => {
  let escaped = ''
  for (const character of text) {
    if (character === '\\' || character === '=' || character === ';' || character === '#') {
      escaped += `\\${character}`
      continue
    }
    if (character === '\n') {
      escaped += '\\\n'
      continue
    }
    if (character === '\r') continue
    escaped += character
  }
  return escaped
}

export interface FfmetadataChapter {
  readonly startMs: number
  readonly endMs: number
  readonly title: string
}

export interface FfmetadataDocument {
  readonly tags: readonly (readonly [key: string, value: string])[]
  readonly chapters: readonly FfmetadataChapter[]
}

const CHAPTER_TIMEBASE = '1/1000'

/**
 * Renders a complete ffmetadata document. Chapter times use a millisecond timebase so the written
 * boundaries are exactly the measured chapter durations rather than a re-derived float.
 */
export const buildFfmetadata = (document: FfmetadataDocument): string => {
  const lines: string[] = [';FFMETADATA1']

  for (const [key, value] of document.tags) {
    const normalized = normalizeMetadataValue(value)
    if (normalized.length === 0) continue
    lines.push(`${escapeFfmetadata(safeMetadataKey(key))}=${escapeFfmetadata(normalized)}`)
  }

  let previousEnd = -1
  for (const [index, chapter] of document.chapters.entries()) {
    if (!Number.isSafeInteger(chapter.startMs) || !Number.isSafeInteger(chapter.endMs)) {
      throw new AudioAssemblyError('Chapter marker boundaries must be integer milliseconds')
    }
    if (chapter.startMs < 0 || chapter.endMs <= chapter.startMs) {
      throw new AudioAssemblyError(
        `Chapter marker ${index + 1} must cover a positive duration: ${chapter.startMs}..${chapter.endMs}`,
      )
    }
    if (chapter.startMs < previousEnd) {
      throw new AudioAssemblyError(`Chapter marker ${index + 1} overlaps the previous chapter`)
    }
    previousEnd = chapter.endMs
    lines.push(
      '[CHAPTER]',
      `TIMEBASE=${CHAPTER_TIMEBASE}`,
      `START=${chapter.startMs}`,
      `END=${chapter.endMs}`,
      `title=${escapeFfmetadata(normalizeMetadataValue(chapter.title))}`,
    )
  }

  return `${lines.join('\n')}\n`
}
