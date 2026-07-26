#!/usr/bin/env node
/**
 * Builds the M1 acceptance EPUB from `tests/fixtures/epub/acceptance-m1/`, with the same canonical
 * zip layout as `packages/epub-spike/scripts/build-fixtures.ts` (mimetype first and uncompressed,
 * fixed DOS timestamp, stable file order) so the committed `.epub` is byte-reproducible.
 *
 * The prose is original fixture writing — see the package metadata's CC0 rights field — so both
 * the source tree and the built archive are safe to keep in this public repository.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(scriptDirectory, '..')
export const ACCEPTANCE_M1_SOURCE_DIR = path.join(
  repositoryRoot,
  'tests',
  'fixtures',
  'epub',
  'acceptance-m1',
)
export const ACCEPTANCE_M1_EPUB_PATH = path.join(
  repositoryRoot,
  'tests',
  'fixtures',
  'epub',
  'acceptance-m1.epub',
)

// fflate writes DOS local time fields. Construct local components so every timezone writes 00:00.
const fixedTime = new Date(2000, 0, 1, 0, 0, 0, 0)
const canonicalZipAttributes = { os: 3, attrs: 0o100644 * 0x10000 }

/**
 * Resolves fflate from the pnpm store without adding a dependency edge: it is already pinned by the
 * lockfile as a dependency of the epub packages, and this script must not edit any package.json.
 */
const loadFflate = async () => {
  const storeDir = path.join(repositoryRoot, 'node_modules', '.pnpm')
  const entries = await readdir(storeDir)
  const match = entries.find((entry) => entry.startsWith('fflate@'))
  if (match === undefined) {
    throw new Error('fflate is not installed; run pnpm install first')
  }
  return import(
    pathToFileURL(path.join(storeDir, match, 'node_modules', 'fflate', 'esm', 'index.mjs')).href
  )
}

const listFiles = async (directory, prefix = '') => {
  const entries = await readdir(path.join(directory, prefix), { withFileTypes: true })
  const files = []
  for (const entry of entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    const relativePath = path.posix.join(prefix, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listFiles(directory, relativePath)))
    } else {
      files.push(relativePath)
    }
  }
  return files
}

/** The fixture bytes, deterministic for a given source tree. */
export const buildAcceptanceM1EpubBytes = async () => {
  const { zipSync } = await loadFflate()
  const orderedFiles = await listFiles(ACCEPTANCE_M1_SOURCE_DIR)
  orderedFiles.splice(orderedFiles.indexOf('mimetype'), 1)
  orderedFiles.unshift('mimetype')

  const entries = {}
  for (const relativePath of orderedFiles) {
    const bytes = new Uint8Array(await readFile(path.join(ACCEPTANCE_M1_SOURCE_DIR, relativePath)))
    entries[relativePath] = [
      bytes,
      { ...canonicalZipAttributes, level: relativePath === 'mimetype' ? 0 : 9, mtime: fixedTime },
    ]
  }
  return zipSync(entries, canonicalZipAttributes)
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const bytes = await buildAcceptanceM1EpubBytes()
  await writeFile(ACCEPTANCE_M1_EPUB_PATH, bytes)
  console.log(
    `${path.relative(repositoryRoot, ACCEPTANCE_M1_EPUB_PATH)} (${bytes.byteLength} bytes)`,
  )
}
