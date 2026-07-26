#!/usr/bin/env node
/**
 * Generates the M1 acceptance fixture's cover art: a plain gradient PNG, original by construction,
 * with no font dependency and deterministic bytes. The PNG is hand-assembled (signature, IHDR,
 * one IDAT, IEND, CRC32 from node:zlib) so the output depends on nothing but this script — no
 * image library, no ffmpeg — and passes the strict raster-cover validation in
 * packages/epub-ingestion (truecolor RGB, bit depth 8, CRC-correct chunks).
 *
 * The cover is a fixture work like the prose and is waived under the same CC0 declaration (see
 * package.opf's dc:rights). Re-running this script must produce byte-identical output; the EPUB
 * build's byte-reproducibility depends on it.
 */
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(scriptDirectory, '..')
export const ACCEPTANCE_M1_COVER_PATH = path.join(
  repositoryRoot,
  'tests',
  'fixtures',
  'epub',
  'acceptance-m1',
  'EPUB',
  'images',
  'cover.png',
)

const WIDTH = 600
const HEIGHT = 900

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const chunk = (type, data) => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeBytes = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])) >>> 0)
  return Buffer.concat([length, typeBytes, data, crc])
}

/** A northlight gradient: deep blue up top fading to pale ice, with one horizon band. */
const pixelAt = (y) => {
  const t = y / (HEIGHT - 1)
  const red = Math.round(11 + (168 - 11) * t)
  const green = Math.round(31 + (190 - 31) * t)
  const blue = Math.round(58 + (214 - 58) * t)
  if (y >= 640 && y < 656) return [232, 224, 209]
  return [red, green, blue]
}

/** The fixture cover bytes, deterministic for every run and host. */
export const buildAcceptanceM1CoverBytes = () => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(WIDTH, 0)
  ihdr.writeUInt32BE(HEIGHT, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor RGB
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // no interlace

  const raw = Buffer.alloc(HEIGHT * (1 + WIDTH * 3))
  let offset = 0
  for (let y = 0; y < HEIGHT; y += 1) {
    raw[offset] = 0 // filter: none
    offset += 1
    for (let x = 0; x < WIDTH; x += 1) {
      const [red, green, blue] = pixelAt(y)
      raw[offset] = red
      raw[offset + 1] = green
      raw[offset + 2] = blue
      offset += 3
    }
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const bytes = buildAcceptanceM1CoverBytes()
  await writeFile(ACCEPTANCE_M1_COVER_PATH, bytes)
  console.log(
    `${path.relative(repositoryRoot, ACCEPTANCE_M1_COVER_PATH)} (${bytes.byteLength} bytes)`,
  )
}
