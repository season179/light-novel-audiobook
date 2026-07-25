import { describe, expect, it } from 'vitest'
import { validateEpubUpload } from '../src/server/epub-validation.js'
import { createNonEpubZipBytes, createStubEpubBytes } from './support/stub-epub.js'

describe('EPUB upload validation', () => {
  it('accepts a well-formed OCF container', () => {
    expect(validateEpubUpload('story.epub', createStubEpubBytes())).toEqual({ valid: true })
  })

  it('rejects a file that is not named as an EPUB', () => {
    expect(validateEpubUpload('story.txt', createStubEpubBytes())).toEqual({
      valid: false,
      message: expect.stringContaining('.epub'),
    })
  })

  it('rejects an empty file', () => {
    expect(validateEpubUpload('story.epub', new Uint8Array())).toEqual({
      valid: false,
      message: 'The uploaded file is empty.',
    })
  })

  it('rejects bytes that are not a ZIP container', () => {
    expect(validateEpubUpload('story.epub', new TextEncoder().encode('x'.repeat(200)))).toEqual({
      valid: false,
      message: expect.stringContaining('not a ZIP container'),
    })
  })

  it('rejects a ZIP whose first entry is not the stored mimetype file', () => {
    expect(validateEpubUpload('story.epub', createNonEpubZipBytes())).toEqual({
      valid: false,
      message: expect.stringContaining('mimetype'),
    })
  })
})
