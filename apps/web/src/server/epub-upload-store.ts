import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { validateEpubUpload } from './epub-validation.js'
import { WebApiError } from './errors.js'
import type { LocalWorkspace } from './workspace.js'

export interface StoredEpubUpload {
  readonly uploadId: string
  readonly originalFileName: string
  readonly storedFileName: string
  readonly epubPath: string
  readonly sha256: string
  readonly byteLength: number
  readonly uploadedAt: string
}

const METADATA_FILE = 'upload.json'
const MAX_STORED_NAME_LENGTH = 120

/** Keeps a browser-supplied name from ever influencing the path we write to. */
const safeStoredName = (fileName: string): string => {
  const withoutDirectories = basename(fileName).replace(/\.epub$/i, '')
  const cleaned = withoutDirectories.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
  const truncated = cleaned.slice(0, MAX_STORED_NAME_LENGTH)
  return `${truncated.length === 0 ? 'book' : truncated}.epub`
}

const isStoredEpubUpload = (value: unknown): value is StoredEpubUpload => {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<StoredEpubUpload>
  return (
    typeof candidate.uploadId === 'string' &&
    typeof candidate.originalFileName === 'string' &&
    typeof candidate.storedFileName === 'string' &&
    typeof candidate.epubPath === 'string' &&
    typeof candidate.sha256 === 'string' &&
    typeof candidate.byteLength === 'number' &&
    typeof candidate.uploadedAt === 'string'
  )
}

/**
 * Stores uploaded EPUBs in the external workspace, addressed by content hash. Metadata is written
 * next to the file so an upload stays discoverable across page refreshes and server restarts.
 */
export class EpubUploadStore {
  private readonly workspace: LocalWorkspace

  constructor(workspace: LocalWorkspace) {
    this.workspace = workspace
  }

  async store(fileName: string, bytes: Uint8Array): Promise<StoredEpubUpload> {
    const validation = validateEpubUpload(fileName, bytes)
    if (!validation.valid) throw new WebApiError('invalid_upload', validation.message)

    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const directory = join(this.workspace.uploadsDir, sha256)
    const storedFileName = safeStoredName(fileName)
    const upload: StoredEpubUpload = {
      uploadId: sha256,
      originalFileName: basename(fileName),
      storedFileName,
      epubPath: join(directory, storedFileName),
      sha256,
      byteLength: bytes.byteLength,
      uploadedAt: new Date().toISOString(),
    }

    await mkdir(directory, { recursive: true })
    await writeFile(upload.epubPath, bytes)
    await writeFile(join(directory, METADATA_FILE), `${JSON.stringify(upload, null, 2)}\n`, 'utf8')
    return upload
  }

  async find(uploadId: string): Promise<StoredEpubUpload | undefined> {
    if (!/^[a-f\d]{64}$/i.test(uploadId)) return undefined
    try {
      const raw = await readFile(join(this.workspace.uploadsDir, uploadId, METADATA_FILE), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!isStoredEpubUpload(parsed) || !this.workspace.contains(parsed.epubPath)) return undefined
      return parsed
    } catch {
      return undefined
    }
  }

  async require(uploadId: string): Promise<StoredEpubUpload> {
    const upload = await this.find(uploadId)
    if (upload === undefined) {
      throw new WebApiError('unknown_upload', 'That upload is no longer in the local workspace.')
    }
    return upload
  }

  /** Newest first, so the home page can offer recent books after a refresh. */
  async list(): Promise<readonly StoredEpubUpload[]> {
    let entries: readonly string[]
    try {
      entries = await readdir(this.workspace.uploadsDir)
    } catch {
      return []
    }
    const uploads: StoredEpubUpload[] = []
    for (const entry of entries) {
      const upload = await this.find(entry)
      if (upload !== undefined) uploads.push(upload)
    }
    return uploads.sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt))
  }
}
