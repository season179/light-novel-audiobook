import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Zippable, zipSync } from 'fflate'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const fixtureRoot = path.join(repositoryRoot, 'tests/fixtures/epub')
const fixedTime = new Date('2000-01-01T00:00:00.000Z')
export const fixtureNames = [
  'synthetic-complex',
  'synthetic-malformed',
  'synthetic-malformed-nav',
  'synthetic-missing-nav',
  'synthetic-ncx-only',
  'synthetic-nested-parent',
] as const

async function listFiles(directory: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(path.join(directory, prefix), { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = path.posix.join(prefix, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listFiles(directory, relativePath)))
    } else {
      files.push(relativePath)
    }
  }
  return files
}

export async function buildFixtureArchive(name: string): Promise<Uint8Array> {
  const sourceDirectory = path.join(fixtureRoot, name)
  const entries: Zippable = {}
  const orderedFiles = await listFiles(sourceDirectory)
  orderedFiles.splice(orderedFiles.indexOf('mimetype'), 1)
  orderedFiles.unshift('mimetype')

  for (const relativePath of orderedFiles) {
    const bytes = new Uint8Array(await readFile(path.join(sourceDirectory, relativePath)))
    entries[relativePath] = [
      bytes,
      { level: relativePath === 'mimetype' ? 0 : 9, mtime: fixedTime },
    ]
  }

  return zipSync(entries)
}

export async function buildFixture(name: string): Promise<string> {
  const outputPath = path.join(fixtureRoot, `${name}.epub`)
  await writeFile(outputPath, await buildFixtureArchive(name))
  return outputPath
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  for (const name of fixtureNames) {
    const outputPath = await buildFixture(name)
    console.log(path.relative(repositoryRoot, outputPath))
  }
}
