/**
 * Cheap deterministic upload gate. It proves the bytes are an OCF (EPUB) container before anything
 * is stored, so the browser gets a precise message instead of a later adapter crash. The
 * authoritative structural parse belongs to the `EpubExtractor` adapter (issue #28).
 */
export const EPUB_MAX_BYTES = 200 * 1024 * 1024

const ZIP_LOCAL_HEADER = [0x50, 0x4b, 0x03, 0x04] as const
const MIMETYPE_ENTRY_NAME = 'mimetype'
const EPUB_MEDIA_TYPE = 'application/epub+zip'
const CONTAINER_ENTRY_NAME = 'META-INF/container.xml'
const LOCAL_HEADER_SIZE = 30
/** Entry names live in local headers near the start and in the central directory at the end. */
const NAME_SCAN_WINDOW = 128 * 1024

export type EpubValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly message: string }

const invalid = (message: string): EpubValidation => ({ valid: false, message })

const latin1 = new TextDecoder('latin1')

const readUint16 = (bytes: Uint8Array, offset: number): number => {
  const low = bytes[offset]
  const high = bytes[offset + 1]
  if (low === undefined || high === undefined) return Number.NaN
  return low | (high << 8)
}

const readAscii = (bytes: Uint8Array, offset: number, length: number): string => {
  if (length < 0 || offset + length > bytes.byteLength) return ''
  return latin1.decode(bytes.subarray(offset, offset + length))
}

const containsEntryName = (bytes: Uint8Array, name: string): boolean => {
  const head = latin1.decode(bytes.subarray(0, NAME_SCAN_WINDOW))
  if (head.includes(name)) return true
  const tailStart = Math.max(NAME_SCAN_WINDOW, bytes.byteLength - NAME_SCAN_WINDOW)
  return latin1.decode(bytes.subarray(tailStart)).includes(name)
}

export const validateEpubFileName = (fileName: string): EpubValidation => {
  const trimmed = fileName.trim()
  if (trimmed.length === 0) return invalid('Choose an EPUB file to upload.')
  if (!trimmed.toLowerCase().endsWith('.epub')) {
    return invalid(`“${trimmed}” is not an EPUB. Choose a file with a .epub extension.`)
  }
  return { valid: true }
}

export const validateEpubBytes = (bytes: Uint8Array): EpubValidation => {
  if (bytes.byteLength === 0) return invalid('The uploaded file is empty.')
  if (bytes.byteLength > EPUB_MAX_BYTES) {
    return invalid(
      `The uploaded file is larger than the ${Math.floor(EPUB_MAX_BYTES / (1024 * 1024))} MB limit.`,
    )
  }
  if (bytes.byteLength < LOCAL_HEADER_SIZE + MIMETYPE_ENTRY_NAME.length + EPUB_MEDIA_TYPE.length) {
    return invalid('The uploaded file is too small to be an EPUB container.')
  }
  if (ZIP_LOCAL_HEADER.some((expected, index) => bytes[index] !== expected)) {
    return invalid('The uploaded file is not a ZIP container, so it cannot be an EPUB.')
  }

  const compressionMethod = readUint16(bytes, 8)
  const nameLength = readUint16(bytes, 26)
  const extraLength = readUint16(bytes, 28)
  if (readAscii(bytes, LOCAL_HEADER_SIZE, nameLength) !== MIMETYPE_ENTRY_NAME) {
    return invalid('The EPUB container is malformed: its first entry must be “mimetype”.')
  }
  if (compressionMethod !== 0) {
    return invalid('The EPUB container is malformed: its “mimetype” entry must be uncompressed.')
  }

  const mediaTypeOffset = LOCAL_HEADER_SIZE + nameLength + extraLength
  if (readAscii(bytes, mediaTypeOffset, EPUB_MEDIA_TYPE.length) !== EPUB_MEDIA_TYPE) {
    return invalid(`The container does not declare the “${EPUB_MEDIA_TYPE}” media type.`)
  }
  if (!containsEntryName(bytes, CONTAINER_ENTRY_NAME)) {
    return invalid(`The EPUB is missing its required ${CONTAINER_ENTRY_NAME} entry.`)
  }
  return { valid: true }
}

export const validateEpubUpload = (fileName: string, bytes: Uint8Array): EpubValidation => {
  const nameResult = validateEpubFileName(fileName)
  if (!nameResult.valid) return nameResult
  return validateEpubBytes(bytes)
}
