import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import {
  type BookLockCoordinator,
  BookLockError,
  FileBookLockCoordinator,
  type HeldBookLock,
} from './book-lock.js'
import {
  type DeterministicEpubExtraction,
  type ExtractedSpineDocument,
  type ExtractionFinding,
  extractEpubDeterministically,
  type ImageOccurrence,
  type NavigationEvidence,
  type PublicationMetadata,
  type SourceAnnotation,
} from './extractor.js'

export const INGESTION_SCHEMA_VERSION = 'epub-ingestion@2' as const

export type EpubIngestionErrorCode =
  | 'INVALID_EPUB'
  | 'INVALID_WORKSPACE'
  | 'STORAGE_CONFLICT'
  | 'STORAGE_FAILURE'

export class EpubIngestionError extends Error {
  readonly code: EpubIngestionErrorCode

  constructor(code: EpubIngestionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'EpubIngestionError'
    this.code = code
  }
}

export interface EpubUpload {
  readonly bytes: Uint8Array
  readonly originalFilename?: string
}

export interface StoredUploadProvenance {
  readonly id: string
  readonly sha256: string
  readonly byteLength: number
  readonly relativePath: string
  readonly originalFilename?: string
}

export interface StoredCover {
  readonly sourceArchivePath: string
  readonly mediaType: string
  readonly sha256: string
  readonly byteLength: number
  readonly relativePath: string
}

export interface IngestedSourcePassage {
  readonly id: string
  readonly chapterId: string
  readonly position: number
  readonly locator: string
  readonly element: string
  readonly sourceText: string
  readonly sourceTextSha256: string
  readonly annotations: readonly SourceAnnotation[]
  readonly semanticHints: readonly string[]
}

export interface IngestedChapterHeading {
  readonly passageId: string
  readonly sourceText: string
  readonly locator: string
}

export type IngestedTitleSource = 'heading' | 'document-title' | 'generated'

export interface IngestedChapter {
  readonly id: string
  readonly position: number
  readonly spinePosition: number
  readonly spineLocator: string
  readonly manifestId: string
  readonly sourceArchivePath: string
  readonly linear: boolean
  readonly documentTitle: string | null
  readonly title: string
  readonly titleSource: IngestedTitleSource
  readonly headings: readonly IngestedChapterHeading[]
  readonly semanticHints: readonly string[]
  readonly passages: readonly IngestedSourcePassage[]
  readonly images: readonly ImageOccurrence[]
}

export interface NonStorySpineDocument {
  readonly id: string
  readonly spinePosition: number
  readonly spineLocator: string
  readonly manifestId: string
  readonly sourceArchivePath: string
  readonly linear: boolean
  readonly documentTitle: string | null
  readonly title: string
  readonly titleSource: Exclude<IngestedTitleSource, 'heading'>
  readonly classification: 'no-source-passages'
  readonly reason: string
  readonly semanticHints: readonly string[]
  readonly images: readonly ImageOccurrence[]
}

export type ExclusionClassification = 'layout-whitespace' | 'ruby-annotation' | 'non-story-markup'

export interface TextExclusionAudit {
  readonly locator: string
  readonly classification: ExclusionClassification
  readonly exactText: string
  readonly exactTextSha256: string
  readonly reason: string
  readonly decisionSource: 'epub-source-text@2'
}

export interface IngestionAudit {
  readonly sourcePassagePolicy: 'retain-all-extracted-source-passages'
  readonly excludedSourcePassageCount: 0
  readonly excludedSpineDocumentCount: number
  readonly nonStoryDocuments: readonly NonStorySpineDocument[]
  readonly textExclusions: readonly TextExclusionAudit[]
  readonly findings: readonly ExtractionFinding[]
}

export interface StoredEpubIngestion {
  readonly schemaVersion: typeof INGESTION_SCHEMA_VERSION
  readonly id: string
  readonly publicationContentSha256: string
  readonly extractionSha256: string
  readonly extractionIdentity: DeterministicEpubExtraction['identity']
  readonly offsetUnit: DeterministicEpubExtraction['offset_unit']
  readonly upload: StoredUploadProvenance
  readonly metadata: PublicationMetadata
  readonly cover: StoredCover | null
  readonly navigation: NavigationEvidence
  readonly chapters: readonly IngestedChapter[]
  readonly audit: IngestionAudit
}

/** Issue #29 can implement this without coupling its domain contracts to EPUB internals. */
export interface EpubIngestionMapper<TDomainBook> {
  map(ingestion: StoredEpubIngestion): TDomainBook
}

export type StorageCommitPoint =
  | 'after-target-rename'
  | 'after-manifest-rename'
  | 'after-discard-ownership-check'
  | 'after-quarantine-rename'

export interface EpubIngestionAdapterOptions {
  readonly workspaceRoot: string
  readonly repositoryRoot: string
  /** Testable one-shot failures at the points where crash behaviour is safety-critical. */
  readonly faultInjector?: (point: StorageCommitPoint) => void | Promise<void>
  /** How long to wait for another process to finish with the same book before failing. */
  readonly lockWaitMs?: number
  /** Overridable only so tests can drive contention; production uses the workspace lock directory. */
  readonly bookLocks?: BookLockCoordinator
}

interface WorkspacePaths {
  readonly root: string
  readonly books: string
  readonly staging: string
  readonly locks: string
  readonly quarantine: string
  readonly target: string
}

const COMMITTED_MANIFEST_FILENAME = 'book.json'
const PENDING_MANIFEST_FILENAME = 'book.pending.json'

/**
 * A book directory holds the pending manifest until its commit is durable, then exactly the
 * committed manifest. Only the committed name may be handed to the domain.
 */
type BookManifestFilename = typeof COMMITTED_MANIFEST_FILENAME | typeof PENDING_MANIFEST_FILENAME

function manifestLabel(filename: BookManifestFilename): string {
  return filename === PENDING_MANIFEST_FILENAME ? 'pending book manifest' : 'book manifest'
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function taggedId(tag: string, fields: readonly string[]): string {
  return sha256([tag, ...fields].join('\0'))
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

export function deriveBookId(extraction: DeterministicEpubExtraction): string {
  return taggedId('source-book-id@1', [
    `archive_parser=${extraction.identity.archive_parser}`,
    `xml_parser=${extraction.identity.xml_parser}`,
    `extraction_rules=${extraction.identity.extraction_rules}`,
    `publication_content_sha256=${extraction.publication_content_sha256}`,
  ])
}

export function deriveChapterId(
  extraction: DeterministicEpubExtraction,
  document: ExtractedSpineDocument,
): string {
  return taggedId('source-chapter-id@1', [
    `archive_parser=${extraction.identity.archive_parser}`,
    `xml_parser=${extraction.identity.xml_parser}`,
    `extraction_rules=${extraction.identity.extraction_rules}`,
    `publication_content_sha256=${extraction.publication_content_sha256}`,
    `spine_index=${document.spine_index}`,
    `archive_path=${document.path}`,
  ])
}

function exclusionReason(classification: ExclusionClassification): string {
  switch (classification) {
    case 'layout-whitespace':
      return 'Whitespace between passage roots has no story-text owner and remains in the text ledger.'
    case 'ruby-annotation':
      return 'Ruby reading or fallback text is annotation evidence; the ruby base remains source text.'
    case 'non-story-markup':
      return 'Script or style text is retained as non-story markup evidence.'
  }
}

function coverExtension(mediaType: string): string {
  const extensions: Readonly<Record<string, string>> = {
    'image/gif': 'gif',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/svg+xml': 'svg',
    'image/webp': 'webp',
  }
  return extensions[mediaType] ?? 'bin'
}

function mapExtraction(
  extraction: DeterministicEpubExtraction,
  upload: StoredUploadProvenance,
): StoredEpubIngestion {
  const bookId = deriveBookId(extraction)
  const bookDirectory = path.posix.join('books', bookId)
  const chapters: IngestedChapter[] = []
  const nonStoryDocuments: NonStorySpineDocument[] = []
  for (const document of extraction.documents) {
    const chapterId = deriveChapterId(extraction, document)
    const spinePosition = document.spine_index + 1
    const spineLocator = `spine[${document.spine_index.toString().padStart(4, '0')}]::${document.path}`
    if (document.passages.length === 0) {
      const hasDocumentTitle = document.title !== null && document.title.length > 0
      nonStoryDocuments.push({
        id: chapterId,
        spinePosition,
        spineLocator,
        manifestId: document.idref,
        sourceArchivePath: document.path,
        linear: document.linear,
        documentTitle: document.title,
        title: hasDocumentTitle ? document.title : `Untitled spine item ${spinePosition}`,
        titleSource: hasDocumentTitle ? 'document-title' : 'generated',
        classification: 'no-source-passages',
        reason:
          'The authoritative spine item has no source passages; its images, ledger text, hints, and locator remain audited outside the Chapter aggregate.',
        semanticHints: document.semantic_hints,
        images: document.images,
      })
      continue
    }

    const passages = document.passages.map(
      (passage, passageIndex): IngestedSourcePassage => ({
        id: passage.id,
        chapterId,
        position: passageIndex + 1,
        locator: passage.locator,
        element: passage.element,
        sourceText: passage.source_text,
        sourceTextSha256: passage.source_text_sha256,
        annotations: passage.annotations,
        semanticHints: passage.semantic_hints,
      }),
    )
    const headings = passages
      .filter((passage) => passage.semanticHints.includes('heading'))
      .map((passage) => ({
        passageId: passage.id,
        sourceText: passage.sourceText,
        locator: passage.locator,
      }))
    const headingTitle = headings[0]?.sourceText
    const hasDocumentTitle = document.title !== null && document.title.length > 0
    chapters.push({
      id: chapterId,
      position: chapters.length + 1,
      spinePosition,
      spineLocator,
      manifestId: document.idref,
      sourceArchivePath: document.path,
      linear: document.linear,
      documentTitle: document.title,
      title:
        headingTitle ??
        (hasDocumentTitle ? document.title : `Untitled chapter ${chapters.length + 1}`),
      titleSource: headingTitle ? 'heading' : hasDocumentTitle ? 'document-title' : 'generated',
      headings,
      semanticHints: document.semantic_hints,
      passages,
      images: document.images,
    })
  }
  const textExclusions = extraction.documents.flatMap((document) =>
    document.text_ledger.flatMap((entry): readonly TextExclusionAudit[] => {
      if (entry.role === 'source') return []
      return [
        {
          locator: entry.locator,
          classification: entry.role,
          exactText: entry.text,
          exactTextSha256: sha256(entry.text),
          reason: exclusionReason(entry.role),
          decisionSource: 'epub-source-text@2',
        },
      ]
    }),
  )
  const coverBytes = extraction.cover
    ? Buffer.from(extraction.cover.bytes_base64, 'base64')
    : undefined
  const cover: StoredCover | null =
    extraction.cover && coverBytes
      ? {
          sourceArchivePath: extraction.cover.path,
          mediaType: extraction.cover.media_type,
          sha256: extraction.cover.content_sha256,
          byteLength: coverBytes.byteLength,
          relativePath: path.posix.join(
            bookDirectory,
            `cover.${coverExtension(extraction.cover.media_type)}`,
          ),
        }
      : null

  return deepFreeze({
    schemaVersion: INGESTION_SCHEMA_VERSION,
    id: bookId,
    publicationContentSha256: extraction.publication_content_sha256,
    extractionSha256: extraction.extraction_sha256,
    extractionIdentity: extraction.identity,
    offsetUnit: extraction.offset_unit,
    upload,
    metadata: extraction.metadata,
    cover,
    navigation: extraction.navigation,
    chapters,
    audit: {
      sourcePassagePolicy: 'retain-all-extracted-source-passages',
      excludedSourcePassageCount: 0,
      excludedSpineDocumentCount: nonStoryDocuments.length,
      nonStoryDocuments,
      textExclusions,
      findings: extraction.findings,
    },
  })
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

async function writeFileAtomically(filePath: string, bytes: Uint8Array | string): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`
  const handle = await open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporaryPath, filePath)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}

/**
 * Flushes a directory entry so a rename survives a crash.
 *
 * Durability caveat, measured on this project's own layout: on a WSL2 `/mnt/c` workspace (9p or
 * drvfs) this call *returns success* without that being evidence of a metadata flush reaching the
 * NTFS host. There the design degrades from power-loss-safe to process-crash-safe. Process-crash
 * safety -- the interruption the pending-manifest and quarantine machinery actually reasons about
 * -- is fully preserved, because the atomicity of `rename` is provided by the kernel either way.
 * A workspace on ext4 gets both properties.
 */
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function storageError(message: string, cause: unknown): EpubIngestionError {
  return new EpubIngestionError('STORAGE_FAILURE', message, { cause })
}

export class EpubIngestionAdapter {
  readonly #workspaceRoot: string
  readonly #repositoryRoot: string
  readonly #faultInjector: EpubIngestionAdapterOptions['faultInjector']
  readonly #lockWaitMs: number | undefined
  readonly #bookLocks: BookLockCoordinator | undefined

  constructor(options: EpubIngestionAdapterOptions) {
    this.#workspaceRoot = path.resolve(options.workspaceRoot)
    this.#repositoryRoot = path.resolve(options.repositoryRoot)
    this.#faultInjector = options.faultInjector
    this.#lockWaitMs = options.lockWaitMs
    this.#bookLocks = options.bookLocks
  }

  async ingest(upload: EpubUpload): Promise<StoredEpubIngestion> {
    const uploadBytes = Uint8Array.from(upload.bytes)
    let extraction: DeterministicEpubExtraction
    try {
      extraction = extractEpubDeterministically(uploadBytes)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new EpubIngestionError(
        'INVALID_EPUB',
        `EPUB ingestion rejected the upload: ${detail}`,
        { cause: error },
      )
    }

    const bookId = deriveBookId(extraction)
    const uploadHash = sha256(uploadBytes)
    const relativeBookDirectory = path.posix.join('books', bookId)
    const uploadProvenance: StoredUploadProvenance = {
      id: taggedId('epub-upload-id@1', [`upload_sha256=${uploadHash}`]),
      sha256: uploadHash,
      byteLength: uploadBytes.byteLength,
      relativePath: path.posix.join(relativeBookDirectory, 'source.epub'),
      ...(upload.originalFilename === undefined
        ? {}
        : { originalFilename: upload.originalFilename }),
    }
    const ingestion = mapExtraction(extraction, uploadProvenance)
    const workspace = await this.#prepareWorkspace(bookId)
    // Held for the whole transaction below, so ownership cannot lapse between a check and the
    // mutation it guards.
    const lock = await this.#acquireBookLock(workspace, bookId)
    let stored: StoredEpubIngestion
    try {
      const recovered = await this.#recoverTarget(workspace, ingestion, lock)
      stored =
        recovered ??
        (await this.#commitNewTarget(workspace, ingestion, extraction, uploadBytes, lock))
    } catch (error) {
      // A release failure must never mask why ingestion actually failed. Nothing has to be cleaned
      // up either way: the kernel drops the lock when the holder goes.
      await lock.release().catch(() => undefined)
      throw error
    }
    await this.#releaseBookLock(lock)
    return stored
  }

  /**
   * A release that needed force still reports failure, so it must arrive coded: callers switch on
   * `EpubIngestionErrorCode` and a bare `BookLockError` would fall through every branch. The book is
   * already committed and verified at this point, so a retry converges on the stored record.
   */
  async #releaseBookLock(lock: HeldBookLock): Promise<void> {
    try {
      await lock.release()
    } catch (error) {
      if (error instanceof BookLockError) {
        throw new EpubIngestionError('STORAGE_FAILURE', error.message, { cause: error })
      }
      throw storageError('Could not release the EPUB book lock', error)
    }
  }

  async #acquireBookLock(workspace: WorkspacePaths, bookId: string): Promise<HeldBookLock> {
    const coordinator =
      this.#bookLocks ??
      new FileBookLockCoordinator({
        lockDirectory: workspace.locks,
        ...(this.#lockWaitMs === undefined ? {} : { waitMs: this.#lockWaitMs }),
      })
    try {
      return await coordinator.acquire(bookId)
    } catch (error) {
      if (error instanceof BookLockError) {
        throw new EpubIngestionError(
          error.code === 'busy' ? 'STORAGE_CONFLICT' : 'STORAGE_FAILURE',
          error.message,
          { cause: error },
        )
      }
      throw storageError(`Could not acquire the EPUB book lock for ${bookId}`, error)
    }
  }

  async #prepareWorkspace(bookId: string): Promise<WorkspacePaths> {
    try {
      const repository = await realpath(this.#repositoryRoot)
      const workspaceInfo = await lstat(this.#workspaceRoot)
      if (workspaceInfo.isSymbolicLink() || !workspaceInfo.isDirectory()) {
        throw new EpubIngestionError(
          'INVALID_WORKSPACE',
          'EPUB workspace must be an existing non-symlink directory',
        )
      }
      const workspace = await realpath(this.#workspaceRoot)
      if (isWithin(repository, workspace)) {
        throw new EpubIngestionError(
          'INVALID_WORKSPACE',
          `EPUB workspace must be outside the Git worktree: ${workspace}`,
        )
      }

      const books = path.join(workspace, 'books')
      const staging = path.join(workspace, '.staging')
      const locks = path.join(workspace, '.book-locks')
      const quarantine = path.join(workspace, '.quarantine')
      const children = [
        [books, 'books'],
        [staging, '.staging'],
        [locks, '.book-locks'],
        [quarantine, '.quarantine'],
      ] as const
      const existing = await Promise.all(
        children.map(([candidate, label]) =>
          this.#optionalSafeDirectory(candidate, workspace, label),
        ),
      )
      const target = path.join(books, bookId)
      if (existing[0]) await this.#optionalSafeDirectory(target, books, 'book target')

      let createdChild = false
      for (const [index, [candidate, label]] of children.entries()) {
        if (!existing[index]) {
          await this.#createDirectoryConcurrently(candidate)
          createdChild = true
        }
        await this.#assertSafeDirectory(candidate, workspace, label)
      }
      if (createdChild) await syncDirectory(workspace)
      return {
        root: workspace,
        books,
        staging,
        locks,
        quarantine,
        target,
      }
    } catch (error) {
      if (error instanceof EpubIngestionError) throw error
      throw new EpubIngestionError('INVALID_WORKSPACE', 'EPUB workspace cannot be prepared', {
        cause: error,
      })
    }
  }

  async #createDirectoryConcurrently(candidate: string): Promise<void> {
    try {
      await mkdir(candidate, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }

  async #optionalSafeDirectory(
    candidate: string,
    parent: string,
    label: string,
  ): Promise<string | undefined> {
    try {
      return await this.#assertSafeDirectory(candidate, parent, label)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async #assertSafeDirectory(candidate: string, parent: string, label: string): Promise<string> {
    const info = await lstat(candidate)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new EpubIngestionError(
        'INVALID_WORKSPACE',
        `EPUB workspace ${label} must be a non-symlink directory`,
      )
    }
    const resolved = await realpath(candidate)
    if (resolved === parent || !isWithin(parent, resolved)) {
      throw new EpubIngestionError(
        'INVALID_WORKSPACE',
        `EPUB workspace ${label} escapes its parent directory`,
      )
    }
    return resolved
  }

  async #assertSafeFile(candidate: string, parent: string, label: string): Promise<void> {
    const info = await lstat(candidate)
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new EpubIngestionError(
        'INVALID_WORKSPACE',
        `EPUB workspace ${label} must be a non-symlink regular file`,
      )
    }
    const resolved = await realpath(candidate)
    if (!isWithin(parent, resolved)) {
      throw new EpubIngestionError('INVALID_WORKSPACE', `EPUB workspace ${label} escapes its book`)
    }
  }

  async #optionalSafeFile(candidate: string, parent: string, label: string): Promise<boolean> {
    try {
      await this.#assertSafeFile(candidate, parent, label)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  async #recoverTarget(
    workspace: WorkspacePaths,
    expected: StoredEpubIngestion,
    lock: HeldBookLock,
  ): Promise<StoredEpubIngestion | undefined> {
    const target = await this.#optionalSafeDirectory(
      workspace.target,
      workspace.books,
      'book target',
    )
    if (!target) return undefined

    const committed = await this.#optionalSafeFile(
      path.join(workspace.target, COMMITTED_MANIFEST_FILENAME),
      workspace.target,
      manifestLabel(COMMITTED_MANIFEST_FILENAME),
    )
    if (committed) {
      // A committed record is authoritative and is never destroyed here, whatever the reason it
      // failed to verify. Anything `#verifyExisting` rejects -- a transient EIO reading
      // `source.epub`, a truncated upload, a cover-hash mismatch, a schema-version bump -- is
      // indistinguishable from real corruption, and this directory holds the only stored copy of
      // the user's EPUB. Fail closed and leave it for an operator to inspect.
      await syncDirectory(workspace.target)
      await syncDirectory(workspace.books)
      return await this.#verifyExisting(workspace, expected, COMMITTED_MANIFEST_FILENAME)
    }

    const pending = await this.#optionalSafeFile(
      path.join(workspace.target, PENDING_MANIFEST_FILENAME),
      workspace.target,
      manifestLabel(PENDING_MANIFEST_FILENAME),
    )
    if (pending) {
      // An interrupted commit left a complete book behind under its pending name; promote it only
      // after it is proven identical to what this upload produces.
      try {
        await this.#verifyExisting(workspace, expected, PENDING_MANIFEST_FILENAME)
        await syncDirectory(workspace.target)
        await syncDirectory(workspace.books)
        await rename(
          path.join(workspace.target, PENDING_MANIFEST_FILENAME),
          path.join(workspace.target, COMMITTED_MANIFEST_FILENAME),
        )
        await syncDirectory(workspace.target)
        return await this.#verifyExisting(workspace, expected, COMMITTED_MANIFEST_FILENAME)
      } catch {
        // A pending record was never handed to the domain, so discarding it and re-committing
        // from the authoritative upload loses nothing.
        await this.#discardTarget(workspace, lock, 'unusable-recovered-record')
        return undefined
      }
    }

    // The staging rename landed but no manifest survived: nothing here can be trusted.
    await this.#discardTarget(workspace, lock, 'unusable-recovered-record')
    return undefined
  }

  async #commitNewTarget(
    workspace: WorkspacePaths,
    ingestion: StoredEpubIngestion,
    extraction: DeterministicEpubExtraction,
    uploadBytes: Uint8Array,
    lock: HeldBookLock,
  ): Promise<StoredEpubIngestion> {
    const stagingDirectory = path.join(workspace.staging, `${ingestion.id}.${lock.token}`)
    let ownsTarget = false
    try {
      lock.assertHeld()
      await mkdir(stagingDirectory, { mode: 0o700 })
      await syncDirectory(workspace.staging)
      await this.#assertSafeDirectory(stagingDirectory, workspace.staging, 'staging book')
      await writeFileAtomically(path.join(stagingDirectory, 'source.epub'), uploadBytes)
      if (extraction.cover && ingestion.cover) {
        await writeFileAtomically(
          path.join(stagingDirectory, path.basename(ingestion.cover.relativePath)),
          Buffer.from(extraction.cover.bytes_base64, 'base64'),
        )
      }
      await writeFileAtomically(
        path.join(stagingDirectory, PENDING_MANIFEST_FILENAME),
        `${JSON.stringify(ingestion, null, 2)}\n`,
      )
      await syncDirectory(stagingDirectory)

      lock.assertHeld()
      await this.#assertSafeDirectory(workspace.books, workspace.root, 'books')
      await this.#assertSafeDirectory(workspace.staging, workspace.root, '.staging')
      await rename(stagingDirectory, workspace.target)
      ownsTarget = true
      await this.#injectFault('after-target-rename')
      await syncDirectory(workspace.staging)
      await syncDirectory(workspace.books)
      lock.assertHeld()
      await this.#assertSafeDirectory(workspace.target, workspace.books, 'book target')
      await rename(
        path.join(workspace.target, PENDING_MANIFEST_FILENAME),
        path.join(workspace.target, COMMITTED_MANIFEST_FILENAME),
      )
      await this.#injectFault('after-manifest-rename')
      await syncDirectory(workspace.target)
      return ingestion
    } catch (error) {
      let rollbackError: unknown
      if (ownsTarget) {
        try {
          await this.#discardTarget(workspace, lock, 'rolled-back-commit')
        } catch (candidate) {
          rollbackError = candidate
        }
      }
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined)
      await syncDirectory(workspace.staging).catch(() => undefined)
      if (rollbackError) {
        throw storageError(
          `Could not roll back failed EPUB book ${ingestion.id}; no committed manifest should be trusted`,
          rollbackError,
        )
      }
      if (error instanceof EpubIngestionError) throw error
      throw storageError(`Could not atomically store EPUB book ${ingestion.id}`, error)
    }
  }

  /**
   * Removes an untrustworthy book directory on behalf of the lock holder that is entitled to it:
   * either a partially committed target this run created, or an unusable record recovery found.
   * A single rename clears `books/` first, so an interruption can only ever leave residue under
   * `.quarantine`, which nothing reads.
   *
   * `reason` exists so this is not guarded by lock liveness alone. `assertHeld()` asks the kernel
   * whether the holder group still exists, which is honest but not instantaneous -- an exited,
   * unreaped group member still counts as present. For the recovery discards the precondition can
   * be re-established directly instead: the directory was judged unusable *because* it had no
   * committed manifest, so if one exists now, something outside this transaction produced it and it
   * must not be destroyed. Rolling back a commit this run made is different: that target's contents
   * are this run's own, so a committed manifest there is expected.
   */
  async #discardTarget(
    workspace: WorkspacePaths,
    lock: HeldBookLock,
    reason: 'unusable-recovered-record' | 'rolled-back-commit',
  ): Promise<void> {
    lock.assertHeld()
    await this.#injectFault('after-discard-ownership-check')
    await this.#assertSafeDirectory(workspace.target, workspace.books, 'book target')
    if (reason === 'unusable-recovered-record') {
      const committed = await this.#optionalSafeFile(
        path.join(workspace.target, COMMITTED_MANIFEST_FILENAME),
        workspace.target,
        manifestLabel(COMMITTED_MANIFEST_FILENAME),
      )
      if (committed) {
        throw new EpubIngestionError(
          'STORAGE_CONFLICT',
          `Refusing to discard EPUB book ${path.basename(workspace.target)}: a committed manifest exists where an unusable record was expected`,
        )
      }
    }
    // Re-asserted immediately before the destructive rename, after the checks above.
    lock.assertHeld()
    const quarantined = path.join(
      workspace.quarantine,
      `${path.basename(workspace.target)}.${lock.token}`,
    )
    await rename(workspace.target, quarantined)
    await this.#injectFault('after-quarantine-rename')
    await syncDirectory(workspace.books)
    await syncDirectory(workspace.quarantine)
    await rm(quarantined, { recursive: true, force: true })
    await syncDirectory(workspace.quarantine)
  }

  /**
   * Proves a manifest already on disk is byte-for-byte the record this upload would produce,
   * together with its stored EPUB and cover. Callers name the manifest explicitly so a pending
   * record is never mistaken for a committed one.
   */
  async #verifyExisting(
    workspace: WorkspacePaths,
    expected: StoredEpubIngestion,
    manifestFilename: BookManifestFilename,
  ): Promise<StoredEpubIngestion> {
    const label = manifestLabel(manifestFilename)
    try {
      await this.#assertSafeDirectory(workspace.target, workspace.books, 'book target')
      const manifestPath = path.join(workspace.target, manifestFilename)
      const sourcePath = path.join(workspace.target, 'source.epub')
      await Promise.all([
        this.#assertSafeFile(manifestPath, workspace.target, label),
        this.#assertSafeFile(sourcePath, workspace.target, 'source EPUB'),
      ])
      const [manifestBytes, sourceBytes] = await Promise.all([
        readFile(manifestPath),
        readFile(sourcePath),
      ])
      const manifest = JSON.parse(manifestBytes.toString('utf8')) as Partial<StoredEpubIngestion>
      const storedOriginalFilename = manifest.upload?.originalFilename
      const { originalFilename: _expectedOriginalFilename, ...expectedUpload } = expected.upload
      const expectedStoredManifest: StoredEpubIngestion = {
        ...expected,
        upload: {
          ...expectedUpload,
          ...(storedOriginalFilename === undefined
            ? {}
            : { originalFilename: storedOriginalFilename }),
        },
      }
      // Checked before the content comparison: a version mismatch is an upgrade problem, not a
      // fidelity problem, and the generic conflict message sends operators hunting for corruption.
      if (manifest.schemaVersion !== INGESTION_SCHEMA_VERSION) {
        throw new EpubIngestionError(
          'STORAGE_CONFLICT',
          `Stored EPUB book ${expected.id} ${label} was written by schema ${JSON.stringify(manifest.schemaVersion)}, but this build reads ${INGESTION_SCHEMA_VERSION}; re-ingest the book after removing its directory under books/`,
        )
      }
      if (
        manifest.id !== expected.id ||
        manifest.publicationContentSha256 !== expected.publicationContentSha256 ||
        manifest.extractionSha256 !== expected.extractionSha256 ||
        manifest.upload?.sha256 !== expected.upload.sha256 ||
        (storedOriginalFilename !== undefined && typeof storedOriginalFilename !== 'string') ||
        JSON.stringify(manifest) !== JSON.stringify(expectedStoredManifest) ||
        sha256(sourceBytes) !== expected.upload.sha256
      ) {
        throw new EpubIngestionError(
          'STORAGE_CONFLICT',
          `Stored EPUB book ${expected.id} ${label} conflicts with the uploaded content`,
        )
      }
      if (expected.cover) {
        const coverPath = path.join(workspace.target, path.basename(expected.cover.relativePath))
        await this.#assertSafeFile(coverPath, workspace.target, 'cover')
        const coverBytes = await readFile(coverPath)
        if (sha256(coverBytes) !== expected.cover.sha256) {
          throw new EpubIngestionError(
            'STORAGE_CONFLICT',
            `Stored cover for EPUB book ${expected.id} failed hash validation`,
          )
        }
      }
      return deepFreeze(manifest as StoredEpubIngestion)
    } catch (error) {
      if (error instanceof EpubIngestionError) throw error
      throw storageError(
        `Stored EPUB book ${expected.id} ${label} is incomplete or unreadable`,
        error,
      )
    }
  }

  async #injectFault(point: StorageCommitPoint): Promise<void> {
    await this.#faultInjector?.(point)
  }
}
