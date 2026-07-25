import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OutputExistsError } from '../src/errors.js'
import {
  assertOutputAbsent,
  assertOutputPresent,
  claimOutputPath,
  pathExists,
} from '../src/no-overwrite.js'

let workspace = ''

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'lna-no-overwrite-'))
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe('assertOutputAbsent', () => {
  it('passes for a path that does not exist', async () => {
    await expect(assertOutputAbsent(join(workspace, 'missing.m4b'))).resolves.toBeUndefined()
  })

  it('refuses an existing output instead of allowing an overwrite', async () => {
    const path = join(workspace, 'book-v001.m4b')
    await writeFile(path, 'previous export', 'utf8')
    await expect(assertOutputAbsent(path)).rejects.toBeInstanceOf(OutputExistsError)
    expect(await readFile(path, 'utf8')).toBe('previous export')
  })
})

describe('claimOutputPath', () => {
  it('moves a staged file onto its reserved path', async () => {
    const staged = join(workspace, 'staged.flac')
    const final = join(workspace, 'chapter-v001-ch01.flac')
    await writeFile(staged, 'assembled', 'utf8')

    await claimOutputPath(staged, final)

    expect(await readFile(final, 'utf8')).toBe('assembled')
    expect(await pathExists(staged)).toBe(false)
  })

  it('never replaces a file that appeared after the preflight check', async () => {
    const staged = join(workspace, 'staged.m4b')
    const final = join(workspace, 'book-v001.m4b')
    await writeFile(staged, 'new export', 'utf8')
    await writeFile(final, 'existing export', 'utf8')

    await expect(claimOutputPath(staged, final)).rejects.toBeInstanceOf(OutputExistsError)
    expect(await readFile(final, 'utf8')).toBe('existing export')
    expect(await readFile(staged, 'utf8')).toBe('new export')
  })
})

describe('assertOutputPresent', () => {
  it('detects the file FFmpeg declined to write', async () => {
    // `ffmpeg -n` exits 0 when it refuses to overwrite, so a missing file is the real signal.
    await expect(
      assertOutputPresent(join(workspace, 'absent.flac'), 'Chapter master'),
    ).rejects.toThrow(/was not produced/u)
  })

  it('rejects an empty output', async () => {
    const path = join(workspace, 'empty.flac')
    await writeFile(path, '', 'utf8')
    await expect(assertOutputPresent(path, 'Chapter master')).rejects.toThrow(/non-empty file/u)
  })

  it('accepts a written output', async () => {
    const path = join(workspace, 'written.flac')
    await writeFile(path, 'audio', 'utf8')
    await expect(assertOutputPresent(path, 'Chapter master')).resolves.toBeUndefined()
  })
})
