import { crc32 } from 'node:zlib'

/**
 * Builds a real stored-only ZIP so tests exercise the upload gate against a genuine OCF container
 * instead of a hand-waved buffer. No EPUB is ever committed to the repository.
 */
interface ZipEntry {
  readonly name: string
  readonly content: Buffer
}

const LOCAL_SIGNATURE = 0x04034b50
const CENTRAL_SIGNATURE = 0x02014b50
const EOCD_SIGNATURE = 0x06054b50
const DOS_DATE = 0x21 // 1 January 1980, so archives are byte-for-byte reproducible.

const createZip = (entries: readonly ZipEntry[]): Buffer => {
  const body: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const checksum = crc32(entry.content)

    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(LOCAL_SIGNATURE, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(entry.content.length, 18)
    local.writeUInt32LE(entry.content.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)

    const directory = Buffer.alloc(46 + name.length)
    directory.writeUInt32LE(CENTRAL_SIGNATURE, 0)
    directory.writeUInt16LE(20, 4)
    directory.writeUInt16LE(20, 6)
    directory.writeUInt16LE(0, 8)
    directory.writeUInt16LE(0, 10)
    directory.writeUInt16LE(0, 12)
    directory.writeUInt16LE(DOS_DATE, 14)
    directory.writeUInt32LE(checksum, 16)
    directory.writeUInt32LE(entry.content.length, 20)
    directory.writeUInt32LE(entry.content.length, 24)
    directory.writeUInt16LE(name.length, 28)
    directory.writeUInt32LE(offset, 42)
    name.copy(directory, 46)

    body.push(local, entry.content)
    central.push(directory)
    offset += local.length + entry.content.length
  }

  const centralDirectory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(EOCD_SIGNATURE, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...body, centralDirectory, end])
}

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`

/** Copied into its own ArrayBuffer so the bytes can go straight into a browser `File`. */
const detach = (zip: Buffer): Uint8Array<ArrayBuffer> => new Uint8Array(zip)

export const createStubEpubBytes = (marker = 'stub'): Uint8Array<ArrayBuffer> =>
  detach(
    createZip([
      { name: 'mimetype', content: Buffer.from('application/epub+zip', 'latin1') },
      { name: 'META-INF/container.xml', content: Buffer.from(CONTAINER_XML, 'utf8') },
      {
        name: 'OEBPS/content.opf',
        content: Buffer.from(
          `<package><metadata><title>${marker}</title></metadata></package>`,
          'utf8',
        ),
      },
    ]),
  )

/** A ZIP that is not an EPUB: the first entry is not the required stored `mimetype`. */
export const createNonEpubZipBytes = (): Uint8Array<ArrayBuffer> =>
  detach(createZip([{ name: 'notes.txt', content: Buffer.from('not a book', 'utf8') }]))
