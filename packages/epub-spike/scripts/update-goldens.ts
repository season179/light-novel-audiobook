import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { extractEpubForSpike } from '../src/extractor.js'
import { buildFixture, fixtureNames } from './build-fixtures.js'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const fixtureRoot = path.join(repositoryRoot, 'tests/fixtures/epub')
const goldenRoot = path.join(repositoryRoot, 'packages/epub-spike/test/golden')

async function fixtureBytes(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path.join(fixtureRoot, `${name}.epub`)))
}

function errorMessage(operation: () => unknown): string {
  try {
    operation()
    return '<accepted>'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function writeJson(name: string, value: unknown) {
  await writeFile(path.join(goldenRoot, name), `${JSON.stringify(value, null, 2)}\n`)
}

for (const name of fixtureNames) await buildFixture(name)

await writeJson(
  'synthetic-complex.json',
  extractEpubForSpike(await fixtureBytes('synthetic-complex')),
)

const navigationCases = Object.fromEntries(
  await Promise.all(
    [
      'synthetic-complex',
      'synthetic-ncx-only',
      'synthetic-missing-nav',
      'synthetic-malformed-nav',
    ].map(async (name) => {
      const result = extractEpubForSpike(await fixtureBytes(name))
      return [
        name,
        {
          navigation: result.navigation,
          finding_kinds: result.findings.map((finding) => finding.kind),
          source_text: result.documents.flatMap((document) =>
            document.passages.map((passage) => passage.source_text),
          ),
        },
      ]
    }),
  ),
)
await writeJson('navigation-cases.json', navigationCases)

const safeEntries = unzipSync(await fixtureBytes('synthetic-ncx-only'))
const unsafeEntryNames = [
  '/unreferenced.txt',
  '../unreferenced.txt',
  'dir\\unreferenced.txt',
  'C:/unreferenced.txt',
]
const unsafeZipEntries = Object.fromEntries(
  unsafeEntryNames.map((entryName) => {
    const archive = zipSync({ ...safeEntries, [entryName]: strToU8('unreferenced') })
    return [entryName, errorMessage(() => extractEpubForSpike(archive))]
  }),
)
const nestedParentBytes = await fixtureBytes('synthetic-nested-parent')
await writeJson('adversarial-errors.json', {
  nested_parent_text: errorMessage(() => extractEpubForSpike(nestedParentBytes)),
  unsafe_zip_entries: unsafeZipEntries,
})
