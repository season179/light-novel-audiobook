import { OutputVersion } from '@light-novel-audiobook/domain'
import { describe, expect, it } from 'vitest'
import {
  audiobookFileName,
  chapterAudioFileName,
  manifestFileNameFor,
  sanitizeFileNameComponent,
} from '../src/output-naming.js'

describe('sanitizeFileNameComponent', () => {
  it('replaces path separators and control characters', () => {
    expect(sanitizeFileNameComponent('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j')
    expect(sanitizeFileNameComponent(`x${String.fromCharCode(0)}y`)).toBe('x-y')
  })

  it('keeps non-ASCII titles readable', () => {
    expect(sanitizeFileNameComponent('とある魔術の Index')).toBe('とある魔術の Index')
  })

  it('never produces a name that starts with a dot or dash', () => {
    expect(sanitizeFileNameComponent('../../etc/passwd')).toBe('etc-passwd')
    expect(sanitizeFileNameComponent('-y')).toBe('y')
  })

  it('falls back when nothing usable is left', () => {
    expect(sanitizeFileNameComponent('///')).toBe('audiobook')
    expect(sanitizeFileNameComponent('   ', 'book')).toBe('book')
  })

  it('bounds the length so a long title cannot exceed filesystem limits', () => {
    expect(sanitizeFileNameComponent('t'.repeat(500))).toHaveLength(80)
  })
})

describe('audiobookFileName', () => {
  it('numbers the export as <title>-vNNN.m4b', () => {
    expect(audiobookFileName('A Small Story', new OutputVersion(1))).toBe('A Small Story-v001.m4b')
    expect(audiobookFileName('A Small Story', new OutputVersion(42))).toBe('A Small Story-v042.m4b')
    expect(audiobookFileName('A Small Story', new OutputVersion(1234))).toBe(
      'A Small Story-v1234.m4b',
    )
  })
})

describe('chapterAudioFileName', () => {
  it('numbers chapter masters as <title>-vNNN-chNN.flac', () => {
    const version = new OutputVersion(3)
    expect(chapterAudioFileName('A Small Story', version, 1, 12)).toBe(
      'A Small Story-v003-ch01.flac',
    )
    expect(chapterAudioFileName('A Small Story', version, 12, 12)).toBe(
      'A Small Story-v003-ch12.flac',
    )
  })

  it('widens the chapter number for long books so ordering stays lexicographic', () => {
    expect(chapterAudioFileName('Long', new OutputVersion(1), 7, 120)).toBe('Long-v001-ch007.flac')
  })
})

describe('manifestFileNameFor', () => {
  it('places the manifest beside the export with the same version', () => {
    expect(manifestFileNameFor('/out/A Small Story-v002.m4b')).toBe(
      '/out/A Small Story-v002.manifest.json',
    )
  })
})
