import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  metadataArguments,
  normalizeMetadataValue,
  safeFileArgument,
  safeMetadataKey,
} from '../src/argument-safety.js'
import { AudioAssemblyError } from '../src/errors.js'
import { buildFfmetadata, escapeFfmetadata } from '../src/ffmetadata.js'
import { HOSTILE_AUTHOR, HOSTILE_CHAPTER_TITLE, HOSTILE_TITLE } from './fixtures.js'

const NUL = String.fromCharCode(0)

describe('safeFileArgument', () => {
  it('resolves a relative path so it can never be read as an FFmpeg option', () => {
    expect(safeFileArgument('Segment audio', '-y.wav')).toBe(resolve('-y.wav'))
    expect(safeFileArgument('Segment audio', '-y.wav').startsWith('/')).toBe(true)
  })

  it('keeps an absolute path with hostile characters intact', () => {
    const path = '/work/out/A "book"; #1 = x\\y.m4b'
    expect(safeFileArgument('Audiobook', path)).toBe(path)
  })

  it('rejects an empty path and a NUL byte', () => {
    expect(() => safeFileArgument('Segment audio', '')).toThrow(AudioAssemblyError)
    expect(() => safeFileArgument('Segment audio', `/tmp/a${NUL}b.wav`)).toThrow(
      /must not contain a NUL byte/u,
    )
  })
})

describe('normalizeMetadataValue', () => {
  it('collapses line breaks and tabs into single spaces', () => {
    expect(normalizeMetadataValue('a\nb\r\nc\td')).toBe('a b c d')
  })

  it('removes control characters that would truncate or corrupt an argument', () => {
    expect(normalizeMetadataValue(`Ti${NUL}tle[31m`)).toBe('Title[31m')
  })

  it('preserves punctuation and non-ASCII text', () => {
    expect(normalizeMetadataValue(HOSTILE_TITLE)).toBe('The "Book"; #1 = a\\path/name と日本語 ★')
  })
})

describe('safeMetadataKey', () => {
  it('rejects any key that could split a metadata assignment', () => {
    for (const key of ['ti=tle', 'ti tle', '-title', 'TITLE', '']) {
      expect(() => safeMetadataKey(key)).toThrow(AudioAssemblyError)
    }
    expect(safeMetadataKey('album_artist')).toBe('album_artist')
  })
})

describe('metadataArguments', () => {
  it('emits one argv element per tag so a value cannot become an option', () => {
    const args = metadataArguments([
      ['title', '-y --metadata title=injected'],
      ['artist', HOSTILE_AUTHOR],
    ])
    expect([...args]).toStrictEqual([
      '-metadata',
      'title=-y --metadata title=injected',
      '-metadata',
      'artist=A. Author; = #ghost\\writer',
    ])
    expect(args.filter((arg) => arg.startsWith('-'))).toStrictEqual(['-metadata', '-metadata'])
  })

  it('drops tags whose value normalizes to nothing', () => {
    expect([...metadataArguments([['title', ` ${NUL} `]])]).toStrictEqual([])
  })
})

describe('escapeFfmetadata', () => {
  it('escapes every character ffmetadata treats as syntax', () => {
    expect(escapeFfmetadata('a=b;c#d\\e')).toBe('a\\=b\\;c\\#d\\\\e')
  })

  it('escapes the backslash before anything else so escapes cannot be forged', () => {
    // A raw `\=` must not survive as an escaped `=`; it is a literal backslash plus a literal `=`.
    expect(escapeFfmetadata('\\=')).toBe('\\\\\\=')
  })

  it('escapes a newline with a trailing backslash the way FFmpeg writes it', () => {
    expect(escapeFfmetadata('a\nb')).toBe('a\\\nb')
    expect(escapeFfmetadata('a\r\nb')).toBe('a\\\nb')
  })
})

describe('buildFfmetadata', () => {
  it('writes hostile book and chapter metadata as escaped single-line values', () => {
    const document = buildFfmetadata({
      tags: [
        ['title', HOSTILE_TITLE],
        ['artist', HOSTILE_AUTHOR],
      ],
      chapters: [
        { startMs: 0, endMs: 1500, title: HOSTILE_CHAPTER_TITLE },
        { startMs: 1500, endMs: 4000, title: 'Plain\nTitle' },
      ],
    })

    expect(document).toBe(
      [
        ';FFMETADATA1',
        'title=The "Book"\\; \\#1 \\= a\\\\path/name と日本語 ★',
        'artist=A. Author\\; \\= \\#ghost\\\\writer',
        '[CHAPTER]',
        'TIMEBASE=1/1000',
        'START=0',
        'END=1500',
        'title=Ch\\=1\\; \\#wait\\\\stop -y --metadata',
        '[CHAPTER]',
        'TIMEBASE=1/1000',
        'START=1500',
        'END=4000',
        'title=Plain Title',
        '',
      ].join('\n'),
    )
  })

  it('never emits an unescaped assignment or comment character inside a value', () => {
    const document = buildFfmetadata({
      tags: [['title', 'x=1;y#2\\z']],
      chapters: [{ startMs: 0, endMs: 10, title: '=;#\\' }],
    })
    for (const line of document.split('\n')) {
      if (!line.includes('=') || line.startsWith('[') || line.startsWith(';FFMETADATA')) continue
      const value = line.slice(line.indexOf('=') + 1)
      // Every special character inside a value must be preceded by a backslash.
      expect(value.replace(/\\./gu, '')).not.toMatch(/[=;#\\]/u)
    }
  })

  it('rejects chapter markers that are not ordered positive integer spans', () => {
    expect(() =>
      buildFfmetadata({ tags: [], chapters: [{ startMs: 0, endMs: 0, title: 'x' }] }),
    ).toThrow(/positive duration/u)
    expect(() =>
      buildFfmetadata({ tags: [], chapters: [{ startMs: 0.5, endMs: 10, title: 'x' }] }),
    ).toThrow(/integer milliseconds/u)
    expect(() =>
      buildFfmetadata({
        tags: [],
        chapters: [
          { startMs: 0, endMs: 2000, title: 'a' },
          { startMs: 1000, endMs: 3000, title: 'b' },
        ],
      }),
    ).toThrow(/overlaps/u)
  })
})
