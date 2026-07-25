import { crc32 } from 'node:zlib'

const MAX_COVER_DIMENSION = 100_000
const MAX_COVER_PIXELS = 100_000_000

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end))
}

function requireDimensions(width: number, height: number, format: string): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_COVER_DIMENSION ||
    height > MAX_COVER_DIMENSION ||
    width * height > MAX_COVER_PIXELS
  ) {
    throw new Error(`${format} cover has invalid or excessive dimensions`)
  }
}

function validatePng(bytes: Uint8Array): void {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 8 || !signature.every((value, index) => bytes[index] === value)) {
    throw new Error('PNG cover has an invalid signature')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8
  let chunkIndex = 0
  let sawHeader = false
  let sawImageData = false
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error('PNG cover has a truncated chunk')
    const length = view.getUint32(offset, false)
    const typeStart = offset + 4
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    const chunkEnd = dataEnd + 4
    if (dataEnd < dataStart || chunkEnd > bytes.length) {
      throw new Error('PNG cover chunk exceeds its container')
    }
    const type = ascii(bytes, typeStart, dataStart)
    const expectedCrc = view.getUint32(dataEnd, false)
    if (crc32(bytes.subarray(typeStart, dataEnd)) !== expectedCrc) {
      throw new Error(`PNG cover chunk ${type} failed CRC validation`)
    }
    if (chunkIndex === 0 && type !== 'IHDR') throw new Error('PNG cover must start with IHDR')
    if (type === 'IHDR') {
      if (sawHeader || length !== 13) throw new Error('PNG cover has an invalid IHDR chunk')
      const width = view.getUint32(dataStart, false)
      const height = view.getUint32(dataStart + 4, false)
      requireDimensions(width, height, 'PNG')
      const bitDepth = bytes[dataStart + 8]
      const colorType = bytes[dataStart + 9]
      const validDepths: Readonly<Record<number, readonly number[]>> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      }
      if (
        colorType === undefined ||
        bitDepth === undefined ||
        !validDepths[colorType]?.includes(bitDepth) ||
        bytes[dataStart + 10] !== 0 ||
        bytes[dataStart + 11] !== 0 ||
        ![0, 1].includes(bytes[dataStart + 12] ?? -1)
      ) {
        throw new Error('PNG cover has unsupported IHDR fields')
      }
      sawHeader = true
    } else if (type === 'IDAT') {
      if (!sawHeader) throw new Error('PNG cover IDAT precedes IHDR')
      sawImageData = true
    } else if (type === 'IEND') {
      if (length !== 0 || !sawImageData || chunkEnd !== bytes.length) {
        throw new Error('PNG cover has an invalid or non-final IEND chunk')
      }
      return
    }
    offset = chunkEnd
    chunkIndex += 1
  }
  throw new Error('PNG cover is missing IEND')
}

const jpegStartOfFrameMarkers = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
])

function validateJpeg(bytes: Uint8Array): void {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('JPEG cover has an invalid SOI marker')
  }
  let offset = 2
  let sawFrame = false
  let sawScan = false
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error('JPEG cover has data outside a scan')
    while (bytes[offset] === 0xff) offset += 1
    const marker = bytes[offset]
    if (marker === undefined || marker === 0x00) throw new Error('JPEG cover has an invalid marker')
    offset += 1
    if (marker === 0xd9) {
      if (!sawFrame || !sawScan || offset !== bytes.length) {
        throw new Error('JPEG cover has an invalid EOI marker')
      }
      return
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      throw new Error('JPEG cover has an unexpected standalone marker')
    }
    if (offset + 2 > bytes.length) throw new Error('JPEG cover has a truncated segment')
    const length = (bytes[offset] ?? 0) * 256 + (bytes[offset + 1] ?? 0)
    if (length < 2 || offset + length > bytes.length) {
      throw new Error('JPEG cover segment exceeds its container')
    }
    if (jpegStartOfFrameMarkers.has(marker)) {
      if (length < 8) throw new Error('JPEG cover has a truncated frame header')
      const height = (bytes[offset + 3] ?? 0) * 256 + (bytes[offset + 4] ?? 0)
      const width = (bytes[offset + 5] ?? 0) * 256 + (bytes[offset + 6] ?? 0)
      const components = bytes[offset + 7] ?? 0
      requireDimensions(width, height, 'JPEG')
      if (components < 1 || length !== 8 + components * 3) {
        throw new Error('JPEG cover has an invalid frame header')
      }
      sawFrame = true
    }
    const isScan = marker === 0xda
    offset += length
    if (!isScan) continue
    if (!sawFrame) throw new Error('JPEG cover scan precedes its frame header')
    sawScan = true
    let foundMarker = false
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1
        continue
      }
      const markerStart = offset
      while (bytes[offset] === 0xff) offset += 1
      const scanMarker = bytes[offset]
      if (scanMarker === 0x00) {
        offset += 1
        continue
      }
      if (scanMarker !== undefined && scanMarker >= 0xd0 && scanMarker <= 0xd7) {
        offset += 1
        continue
      }
      offset = markerStart
      foundMarker = true
      break
    }
    if (!foundMarker) throw new Error('JPEG cover scan has no terminating marker')
  }
  throw new Error('JPEG cover is missing EOI')
}

function skipGifSubBlocks(bytes: Uint8Array, initialOffset: number): number {
  let offset = initialOffset
  while (offset < bytes.length) {
    const length = bytes[offset]
    if (length === undefined) break
    offset += 1
    if (length === 0) return offset
    if (offset + length > bytes.length) throw new Error('GIF cover has a truncated data block')
    offset += length
  }
  throw new Error('GIF cover has unterminated data blocks')
}

function validateGif(bytes: Uint8Array): void {
  if (bytes.length < 14 || !['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6))) {
    throw new Error('GIF cover has an invalid header')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  requireDimensions(view.getUint16(6, true), view.getUint16(8, true), 'GIF')
  const packed = bytes[10] ?? 0
  let offset = 13
  if ((packed & 0x80) !== 0) offset += 3 * 2 ** ((packed & 0x07) + 1)
  if (offset > bytes.length) throw new Error('GIF cover has a truncated global color table')
  let sawImage = false
  while (offset < bytes.length) {
    const introducer = bytes[offset]
    offset += 1
    if (introducer === 0x3b) {
      if (!sawImage || offset !== bytes.length) throw new Error('GIF cover has an invalid trailer')
      return
    }
    if (introducer === 0x21) {
      if (offset >= bytes.length) throw new Error('GIF cover has a truncated extension')
      offset += 1
      offset = skipGifSubBlocks(bytes, offset)
      continue
    }
    if (introducer !== 0x2c || offset + 9 > bytes.length) {
      throw new Error('GIF cover has an invalid block introducer')
    }
    const width = view.getUint16(offset + 4, true)
    const height = view.getUint16(offset + 6, true)
    requireDimensions(width, height, 'GIF image')
    const imagePacked = bytes[offset + 8] ?? 0
    offset += 9
    if ((imagePacked & 0x80) !== 0) offset += 3 * 2 ** ((imagePacked & 0x07) + 1)
    if (offset >= bytes.length) throw new Error('GIF cover has truncated image data')
    const lzwMinimumCodeSize = bytes[offset] ?? 0
    if (lzwMinimumCodeSize < 2 || lzwMinimumCodeSize > 8) {
      throw new Error('GIF cover has an invalid LZW code size')
    }
    offset = skipGifSubBlocks(bytes, offset + 1)
    sawImage = true
  }
  throw new Error('GIF cover is missing its trailer')
}

function uint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) + (bytes[offset + 1] ?? 0) * 256 + (bytes[offset + 2] ?? 0) * 65_536
}

function validateWebp(bytes: Uint8Array): void {
  if (bytes.length < 20 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 12) !== 'WEBP') {
    throw new Error('WebP cover has an invalid RIFF header')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(4, true) + 8 !== bytes.length) {
    throw new Error('WebP cover RIFF length does not match its container')
  }
  let offset = 12
  let dimensionsFound = false
  let sawBitstream = false
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error('WebP cover has a truncated chunk')
    const type = ascii(bytes, offset, offset + 4)
    const length = view.getUint32(offset + 4, true)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    const chunkEnd = dataEnd + (length & 1)
    if (dataEnd < dataStart || chunkEnd > bytes.length) {
      throw new Error('WebP cover chunk exceeds its RIFF container')
    }
    if (type === 'VP8X') {
      if (length !== 10 || ((bytes[dataStart] ?? 0) & 0xc1) !== 0) {
        throw new Error('WebP cover has an invalid VP8X chunk')
      }
      requireDimensions(
        uint24LittleEndian(bytes, dataStart + 4) + 1,
        uint24LittleEndian(bytes, dataStart + 7) + 1,
        'WebP',
      )
      dimensionsFound = true
    } else if (type === 'VP8 ') {
      if (
        length < 10 ||
        bytes[dataStart + 3] !== 0x9d ||
        bytes[dataStart + 4] !== 0x01 ||
        bytes[dataStart + 5] !== 0x2a
      ) {
        throw new Error('WebP cover has an invalid VP8 frame header')
      }
      requireDimensions(
        ((bytes[dataStart + 7] ?? 0) * 256 + (bytes[dataStart + 6] ?? 0)) & 0x3fff,
        ((bytes[dataStart + 9] ?? 0) * 256 + (bytes[dataStart + 8] ?? 0)) & 0x3fff,
        'WebP',
      )
      dimensionsFound = true
      sawBitstream = true
    } else if (type === 'VP8L') {
      if (length < 5 || bytes[dataStart] !== 0x2f) {
        throw new Error('WebP cover has an invalid VP8L frame header')
      }
      const bits = view.getUint32(dataStart + 1, true)
      requireDimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, 'WebP')
      if (bits >>> 28 !== 0) throw new Error('WebP cover has invalid VP8L reserved bits')
      dimensionsFound = true
      sawBitstream = true
    }
    offset = chunkEnd
  }
  if (offset !== bytes.length || !dimensionsFound || !sawBitstream) {
    throw new Error('WebP cover has no complete image dimensions')
  }
}

export function validateRasterCover(bytes: Uint8Array, mediaType: string): void {
  switch (mediaType) {
    case 'image/png':
      validatePng(bytes)
      return
    case 'image/jpeg':
      validateJpeg(bytes)
      return
    case 'image/gif':
      validateGif(bytes)
      return
    case 'image/webp':
      validateWebp(bytes)
      return
    default:
      throw new Error(`Unsupported raster cover media type: ${mediaType}`)
  }
}
