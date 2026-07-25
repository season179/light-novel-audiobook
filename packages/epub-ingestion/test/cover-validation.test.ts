import { crc32, deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { validateRasterCover } from '../src/cover-validation.js'

function ascii(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

function uint32BigEndian(value: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value, false)
  return out
}

function uint32LittleEndian(value: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value, true)
  return out
}

/**
 * The validator now uses `node:zlib`'s `crc32` too, so this is no longer an independent oracle on
 * its own. `pins the CRC oracle ...` below anchors it to the canonical value published in the PNG
 * specification, and `accepts a byte-pinned PNG ...` anchors the whole builder to fixed bytes.
 */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typed = concat(ascii(type), data)
  return concat(uint32BigEndian(data.byteLength), typed, uint32BigEndian(crc32(typed)))
}

const pngSignature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * `declaredWidth`/`declaredHeight` let a test claim dimensions in IHDR without materializing that
 * many pixels, which is how an oversized cover would actually reach us.
 */
function png(width = 1, height = 1, declaredWidth = width, declaredHeight = height): Uint8Array {
  const header = concat(
    uint32BigEndian(declaredWidth),
    uint32BigEndian(declaredHeight),
    new Uint8Array([8, 0, 0, 0, 0]),
  )
  const raw = new Uint8Array(height * (1 + width))
  return concat(
    pngSignature,
    pngChunk('IHDR', header),
    pngChunk('IDAT', new Uint8Array(deflateSync(raw))),
    pngChunk('IEND', new Uint8Array()),
  )
}

function jpeg(width = 1, height = 1): Uint8Array {
  const frame = concat(
    new Uint8Array([0xff, 0xc0, 0x00, 0x0b, 0x08]),
    new Uint8Array([height >>> 8, height & 0xff, width >>> 8, width & 0xff]),
    new Uint8Array([0x01, 0x01, 0x11, 0x00]),
  )
  const scan = new Uint8Array([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])
  return concat(
    new Uint8Array([0xff, 0xd8]),
    frame,
    scan,
    new Uint8Array([0x00, 0x11, 0x22]),
    new Uint8Array([0xff, 0xd9]),
  )
}

function gif(width = 1, height = 1): Uint8Array {
  const screen = new Uint8Array([
    width & 0xff,
    width >>> 8,
    height & 0xff,
    height >>> 8,
    0x00,
    0x00,
    0x00,
  ])
  const descriptor = new Uint8Array([
    0x2c,
    0x00,
    0x00,
    0x00,
    0x00,
    width & 0xff,
    width >>> 8,
    height & 0xff,
    height >>> 8,
    0x00,
  ])
  return concat(
    ascii('GIF89a'),
    screen,
    descriptor,
    new Uint8Array([0x02]),
    new Uint8Array([0x02, 0x44, 0x01, 0x00]),
    new Uint8Array([0x3b]),
  )
}

function webpLossless(width = 1, height = 1): Uint8Array {
  const bits = (width - 1) | ((height - 1) << 14)
  const payload = concat(new Uint8Array([0x2f]), uint32LittleEndian(bits))
  const chunk = concat(
    ascii('VP8L'),
    uint32LittleEndian(payload.byteLength),
    payload,
    new Uint8Array(payload.byteLength & 1),
  )
  const body = concat(ascii('WEBP'), chunk)
  return concat(ascii('RIFF'), uint32LittleEndian(body.byteLength), body)
}

describe('raster cover validation', () => {
  it('pins the CRC oracle to the value published in the PNG specification', () => {
    // PNG spec, IEND example chunk. If both the validator and this test silently moved to the same
    // wrong CRC implementation, this constant is what still fails.
    expect(crc32(ascii('IEND'))).toBe(0xae426082)
  })

  it('accepts a byte-pinned PNG that no test helper produced', () => {
    // A fixed 1x1 greyscale PNG. Independent of every builder in this file, so a bug in the
    // builders cannot make the acceptance tests vacuous.
    const pinned = new Uint8Array(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==',
        'base64',
      ),
    )
    expect(pinned.byteLength).toBe(67)
    expect(() => validateRasterCover(pinned, 'image/png')).not.toThrow()
    expect(() => validateRasterCover(pinned, 'image/jpeg')).toThrow(/JPEG/u)
  })

  it('accepts a well-formed image of each supported raster format', () => {
    expect(() => validateRasterCover(png(), 'image/png')).not.toThrow()
    expect(() => validateRasterCover(png(7, 3), 'image/png')).not.toThrow()
    expect(() => validateRasterCover(jpeg(), 'image/jpeg')).not.toThrow()
    expect(() => validateRasterCover(jpeg(640, 960), 'image/jpeg')).not.toThrow()
    expect(() => validateRasterCover(gif(), 'image/gif')).not.toThrow()
    expect(() => validateRasterCover(webpLossless(), 'image/webp')).not.toThrow()
    expect(() => validateRasterCover(webpLossless(1200, 1800), 'image/webp')).not.toThrow()
  })

  it('rejects an unsupported media type', () => {
    expect(() => validateRasterCover(png(), 'image/svg+xml')).toThrow(
      /Unsupported raster cover media type/,
    )
    expect(() => validateRasterCover(png(), 'image/tiff')).toThrow(
      /Unsupported raster cover media type/,
    )
  })

  it('rejects bytes whose declared format is a different format', () => {
    expect(() => validateRasterCover(png(), 'image/jpeg')).toThrow(/JPEG/u)
    expect(() => validateRasterCover(jpeg(), 'image/png')).toThrow(/PNG/u)
    expect(() => validateRasterCover(gif(), 'image/webp')).toThrow(/WebP/u)
    expect(() => validateRasterCover(webpLossless(), 'image/gif')).toThrow(/GIF/u)
  })

  it('rejects truncated images rather than trusting a valid-looking header', () => {
    const truncatedPng = png().subarray(0, png().byteLength - 4)
    expect(() => validateRasterCover(truncatedPng, 'image/png')).toThrow(/PNG/u)
    expect(() => validateRasterCover(png().subarray(0, 30), 'image/png')).toThrow(/PNG/u)
    expect(() =>
      validateRasterCover(jpeg().subarray(0, jpeg().byteLength - 2), 'image/jpeg'),
    ).toThrow(/JPEG/u)
    expect(() => validateRasterCover(gif().subarray(0, gif().byteLength - 1), 'image/gif')).toThrow(
      /GIF/u,
    )
    expect(() => validateRasterCover(webpLossless().subarray(0, 18), 'image/webp')).toThrow(/WebP/u)
  })

  it('rejects a PNG whose chunk data was altered without fixing its CRC', () => {
    const corrupted = png(4, 4)
    // Flip a bit inside the IDAT payload, leaving the recorded CRC stale.
    const idatPayload = 8 + 25 + 8
    corrupted[idatPayload] = (corrupted[idatPayload] ?? 0) ^ 0x40
    expect(() => validateRasterCover(corrupted, 'image/png')).toThrow(/failed CRC validation/)
  })

  it('rejects a PNG with no image data before IEND', () => {
    const headerOnly = concat(
      pngSignature,
      pngChunk(
        'IHDR',
        concat(uint32BigEndian(1), uint32BigEndian(1), new Uint8Array([8, 0, 0, 0, 0])),
      ),
      pngChunk('IEND', new Uint8Array()),
    )
    expect(() => validateRasterCover(headerOnly, 'image/png')).toThrow(
      /invalid or non-final IEND chunk/,
    )
  })

  it('rejects trailing bytes after the terminating marker', () => {
    expect(() => validateRasterCover(concat(jpeg(), new Uint8Array([0x00])), 'image/jpeg')).toThrow(
      /JPEG/u,
    )
    expect(() => validateRasterCover(concat(gif(), new Uint8Array([0x00])), 'image/gif')).toThrow(
      /GIF/u,
    )
    expect(() => validateRasterCover(concat(png(), new Uint8Array([0x00])), 'image/png')).toThrow(
      /PNG/u,
    )
  })

  it('rejects a WebP whose RIFF length disagrees with its container', () => {
    const mismatched = webpLossless()
    new DataView(mismatched.buffer).setUint32(4, mismatched.byteLength, true)
    expect(() => validateRasterCover(mismatched, 'image/webp')).toThrow(
      /RIFF length does not match/,
    )
  })

  it('rejects zero and absurd dimensions that would blow up later assembly', () => {
    expect(() => validateRasterCover(png(0, 1), 'image/png')).toThrow(
      /invalid or excessive dimensions/,
    )
    expect(() => validateRasterCover(jpeg(0, 8), 'image/jpeg')).toThrow(
      /invalid or excessive dimensions/,
    )
    expect(() => validateRasterCover(gif(0, 1), 'image/gif')).toThrow(
      /invalid or excessive dimensions/,
    )
    // Past the 100000-pixel side limit and the 100-megapixel area limit respectively.
    expect(() => validateRasterCover(png(1, 1, 100_001, 1), 'image/png')).toThrow(
      /invalid or excessive dimensions/,
    )
    expect(() => validateRasterCover(png(1, 1, 60_000, 60_000), 'image/png')).toThrow(
      /invalid or excessive dimensions/,
    )
    expect(() => validateRasterCover(jpeg(60_000, 60_000), 'image/jpeg')).toThrow(
      /invalid or excessive dimensions/,
    )
    expect(() => validateRasterCover(gif(60_000, 60_000), 'image/gif')).toThrow(
      /invalid or excessive dimensions/,
    )
    expect(() => validateRasterCover(webpLossless(16_384, 16_384), 'image/webp')).toThrow(
      /invalid or excessive dimensions/,
    )
  })

  it('rejects a PNG whose IHDR declares an unsupported bit depth', () => {
    const invalid = concat(
      pngSignature,
      pngChunk(
        'IHDR',
        concat(uint32BigEndian(1), uint32BigEndian(1), new Uint8Array([3, 0, 0, 0, 0])),
      ),
      pngChunk('IDAT', new Uint8Array(deflateSync(new Uint8Array(2)))),
      pngChunk('IEND', new Uint8Array()),
    )
    expect(() => validateRasterCover(invalid, 'image/png')).toThrow(/unsupported IHDR fields/)
  })
})
