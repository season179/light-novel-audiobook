import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listFiles } from '../scripts/build-fixtures.js'

describe('build-fixtures listFiles ordering (#63)', () => {
  it('orders directory entries by code point, not locale', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'listfiles-locale-'))
    // 'typing-inspection' (- U+002D) < 'typing_extensions' (_ U+005F) by code point; on this Node
    // 'typing-inspection'.localeCompare('typing_extensions') === 1, so localeCompare reverses them.
    // The fixture builder feeds this ordering into the committed EPUB fixtures, so a locale-dependent
    // sort would make the fixtures non-reproducible across environments.
    await writeFile(join(dir, 'typing-inspection'), '')
    await writeFile(join(dir, 'typing_extensions'), '')
    expect(await listFiles(dir)).toEqual(['typing-inspection', 'typing_extensions'])
  })
})
