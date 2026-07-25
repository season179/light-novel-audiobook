import { crc32 } from 'node:zlib'
import { unzipSync } from 'fflate'

export interface EpubArchiveLimits {
  readonly maxArchiveBytes: number
  readonly maxEntries: number
  readonly maxEntryUncompressedBytes: number
  readonly maxTotalUncompressedBytes: number
  readonly maxCompressionRatio: number
}

export const DEFAULT_EPUB_ARCHIVE_LIMITS: EpubArchiveLimits = Object.freeze({
  maxArchiveBytes: 100 * 1024 * 1024,
  maxEntries: 10_000,
  maxEntryUncompressedBytes: 100 * 1024 * 1024,
  maxTotalUncompressedBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 1_000,
})

interface CentralEntry {
  readonly name: string
  readonly crc32: number
  readonly uncompressedSize: number
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

function uint16(view: DataView, offset: number): number {
  if (offset < 0 || offset + 2 > view.byteLength) throw new Error('EPUB ZIP is truncated')
  return view.getUint16(offset, true)
}

function uint32(view: DataView, offset: number): number {
  if (offset < 0 || offset + 4 > view.byteLength) throw new Error('EPUB ZIP is truncated')
  return view.getUint32(offset, true)
}

function decodeEntryName(bytes: Uint8Array, utf8Flag: boolean): string {
  if (!utf8Flag && bytes.some((value) => value > 0x7f)) {
    throw new Error('EPUB ZIP uses an unsupported non-UTF-8 entry name')
  }
  try {
    return utf8.decode(bytes)
  } catch {
    throw new Error('EPUB ZIP contains an invalid UTF-8 entry name')
  }
}

function findEndOfCentralDirectory(archive: Uint8Array, view: DataView): number {
  const minimum = 22
  if (archive.byteLength < minimum) throw new Error('EPUB ZIP is truncated')
  const earliest = Math.max(0, archive.byteLength - 65_557)
  for (let offset = archive.byteLength - minimum; offset >= earliest; offset -= 1) {
    if (uint32(view, offset) !== 0x06054b50) continue
    const commentLength = uint16(view, offset + 20)
    if (offset + minimum + commentLength === archive.byteLength) return offset
  }
  throw new Error('EPUB ZIP has no valid end-of-central-directory record')
}

function inspectCentralDirectory(
  archive: Uint8Array,
  limits: EpubArchiveLimits,
): readonly CentralEntry[] {
  if (archive.byteLength > limits.maxArchiveBytes) {
    throw new Error(`EPUB ZIP exceeds the ${limits.maxArchiveBytes}-byte upload limit`)
  }
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  const endOffset = findEndOfCentralDirectory(archive, view)
  const disk = uint16(view, endOffset + 4)
  const centralDisk = uint16(view, endOffset + 6)
  const diskEntries = uint16(view, endOffset + 8)
  const entryCount = uint16(view, endOffset + 10)
  const centralSize = uint32(view, endOffset + 12)
  const centralOffset = uint32(view, endOffset + 16)
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount) {
    throw new Error('Multi-disk EPUB ZIP archives are unsupported')
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('ZIP64 EPUB archives are unsupported')
  }
  if (entryCount > limits.maxEntries) {
    throw new Error(`EPUB ZIP exceeds the ${limits.maxEntries}-entry limit`)
  }
  if (centralOffset + centralSize !== endOffset) {
    throw new Error('EPUB ZIP central directory is inconsistent')
  }

  const entries: CentralEntry[] = []
  const names = new Set<string>()
  const foldedNames = new Map<string, string>()
  let totalUncompressed = 0
  let offset = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (uint32(view, offset) !== 0x02014b50) {
      throw new Error(`EPUB ZIP has an invalid central-directory entry at index ${index}`)
    }
    const flags = uint16(view, offset + 8)
    const compression = uint16(view, offset + 10)
    const expectedCrc = uint32(view, offset + 16)
    const compressedSize = uint32(view, offset + 20)
    const uncompressedSize = uint32(view, offset + 24)
    const nameLength = uint16(view, offset + 28)
    const extraLength = uint16(view, offset + 30)
    const commentLength = uint16(view, offset + 32)
    const externalAttributes = uint32(view, offset + 38)
    const localHeaderOffset = uint32(view, offset + 42)
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength
    if (nextOffset > endOffset) throw new Error('EPUB ZIP central directory is truncated')
    const name = decodeEntryName(
      archive.subarray(offset + 46, offset + 46 + nameLength),
      (flags & 0x0800) !== 0,
    )
    if ((flags & 0x0001) !== 0) throw new Error(`Encrypted EPUB ZIP entry is unsupported: ${name}`)
    if (compression !== 0 && compression !== 8) {
      throw new Error(`Unsupported EPUB ZIP compression method ${compression}: ${name}`)
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new Error(`ZIP64 EPUB entry is unsupported: ${name}`)
    }
    if (uncompressedSize > limits.maxEntryUncompressedBytes) {
      throw new Error(`EPUB ZIP entry exceeds the uncompressed size limit: ${name}`)
    }
    const ratio = uncompressedSize / Math.max(1, compressedSize)
    if (ratio > limits.maxCompressionRatio) {
      throw new Error(`EPUB ZIP entry exceeds the compression-ratio limit: ${name}`)
    }
    totalUncompressed += uncompressedSize
    if (totalUncompressed > limits.maxTotalUncompressedBytes) {
      throw new Error('EPUB ZIP exceeds the total uncompressed size limit')
    }
    if (names.has(name)) throw new Error(`EPUB ZIP repeats entry name: ${name}`)
    names.add(name)
    const folded = name.toLocaleLowerCase('en-US')
    const collision = foldedNames.get(folded)
    if (collision && collision !== name) {
      throw new Error(`EPUB ZIP has case-colliding entry names: ${collision}, ${name}`)
    }
    foldedNames.set(folded, name)
    const unixMode = externalAttributes >>> 16
    if ((unixMode & 0xf000) === 0xa000) {
      throw new Error(`EPUB ZIP symbolic links are unsupported: ${name}`)
    }

    if (uint32(view, localHeaderOffset) !== 0x04034b50) {
      throw new Error(`EPUB ZIP entry has no valid local header: ${name}`)
    }
    const localFlags = uint16(view, localHeaderOffset + 6)
    const localCompression = uint16(view, localHeaderOffset + 8)
    const localNameLength = uint16(view, localHeaderOffset + 26)
    const localExtraLength = uint16(view, localHeaderOffset + 28)
    const localName = decodeEntryName(
      archive.subarray(localHeaderOffset + 30, localHeaderOffset + 30 + localNameLength),
      (localFlags & 0x0800) !== 0,
    )
    if (localName !== name || localCompression !== compression || localFlags !== flags) {
      throw new Error(`EPUB ZIP local and central headers disagree: ${name}`)
    }
    const dataEnd = localHeaderOffset + 30 + localNameLength + localExtraLength + compressedSize
    if (dataEnd > centralOffset) throw new Error(`EPUB ZIP entry data is truncated: ${name}`)

    entries.push({
      name,
      crc32: expectedCrc,
      uncompressedSize,
    })
    offset = nextOffset
  }
  if (offset !== endOffset) throw new Error('EPUB ZIP central-directory size is inconsistent')
  return entries
}

export function unzipEpubSafely(
  archive: Uint8Array,
  limits: EpubArchiveLimits = DEFAULT_EPUB_ARCHIVE_LIMITS,
): Readonly<Record<string, Uint8Array>> {
  const metadata = inspectCentralDirectory(archive, limits)
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(archive)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`EPUB ZIP cannot be decompressed: ${detail}`)
  }
  if (Object.keys(entries).length !== metadata.length) {
    throw new Error('EPUB ZIP entry map does not match its central directory')
  }
  for (const expected of metadata) {
    const bytes = entries[expected.name]
    if (!bytes) throw new Error(`EPUB ZIP entry was not decompressed: ${expected.name}`)
    if (bytes.byteLength !== expected.uncompressedSize) {
      throw new Error(`EPUB ZIP entry has an invalid uncompressed size: ${expected.name}`)
    }
    if (crc32(bytes) !== expected.crc32) {
      throw new Error(`EPUB ZIP entry failed CRC validation: ${expected.name}`)
    }
  }
  return entries
}
