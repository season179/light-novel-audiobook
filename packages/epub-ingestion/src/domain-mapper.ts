import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { EpubExtractionRequest, EpubExtractor } from '@light-novel-audiobook/application'
import { Book, Chapter, SourcePassage } from '@light-novel-audiobook/domain'
import {
  EpubIngestionAdapter,
  type EpubIngestionAdapterOptions,
  EpubIngestionError,
  type EpubIngestionMapper,
  INGESTION_SCHEMA_VERSION,
  type StoredEpubIngestion,
} from './adapter.js'
import { DEFAULT_EPUB_XML_LIMITS, EXTRACTION_IDENTITY } from './extractor.js'
import { DEFAULT_EPUB_ARCHIVE_LIMITS } from './safe-zip.js'

export const DOMAIN_EPUB_EXTRACTOR_SETTINGS = Object.freeze({
  identity_schema: 'domain-epub-extractor-identity@1',
  parser_and_source_rules: EXTRACTION_IDENTITY,
  archive_limits: DEFAULT_EPUB_ARCHIVE_LIMITS,
  xml_limits: DEFAULT_EPUB_XML_LIMITS,
  ingestion_schema: INGESTION_SCHEMA_VERSION,
  policies: Object.freeze({
    archive_paths: 'case-sensitive-safe-paths@1',
    encryption: 'reject-zip-and-encryption-xml@1',
    cover: 'declared-media-container-validation@1',
    spine_order: 'opf-spine-retain-source@1',
    empty_spine_documents: 'audit-as-non-story@1',
    metadata: 'preserve-opf-refinements@1',
    domain_mapping: 'issue-29-book-mapping@1',
    identifiers: 'stable-ids-book-scoped@1',
  }),
})

export const DOMAIN_EPUB_EXTRACTOR_IDENTITY = `domain-epub-extractor@1:${createHash('sha256')
  .update(JSON.stringify(DOMAIN_EPUB_EXTRACTOR_SETTINGS))
  .digest('hex')}`

export class DomainBookMapper implements EpubIngestionMapper<Book> {
  readonly #workspaceRoot: string

  constructor(workspaceRoot: string) {
    this.#workspaceRoot = path.resolve(workspaceRoot)
  }

  map(ingestion: StoredEpubIngestion): Book {
    if (ingestion.chapters.length === 0) {
      throw new EpubIngestionError(
        'INVALID_EPUB',
        'EPUB has no spine document with source passages; non-story documents remain in the ingestion audit',
      )
    }
    const chapters = ingestion.chapters.map((chapter) => {
      const sourcePassages = chapter.passages.map(
        (passage) =>
          new SourcePassage({
            id: passage.id,
            chapterId: chapter.id,
            sourceText: passage.sourceText,
          }),
      )
      return new Chapter({
        id: chapter.id,
        bookId: ingestion.id,
        position: chapter.position,
        title: chapter.title,
        sourcePassages,
      })
    })
    return new Book({
      id: ingestion.id,
      title:
        ingestion.metadata.title && ingestion.metadata.title.length > 0
          ? ingestion.metadata.title
          : `Untitled EPUB ${ingestion.id.slice(0, 12)}`,
      author: ingestion.metadata.authors[0] ?? null,
      coverPath: ingestion.cover ? this.#artifactPath(ingestion.cover.relativePath) : null,
      source: {
        epubPath: this.#artifactPath(ingestion.upload.relativePath),
        sha256: ingestion.upload.sha256,
      },
      chapters,
    })
  }

  #artifactPath(relativePath: string): string {
    const resolved = path.resolve(this.#workspaceRoot, relativePath)
    const relative = path.relative(this.#workspaceRoot, resolved)
    if (
      relative === '' ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new EpubIngestionError('INVALID_WORKSPACE', 'Mapped EPUB artifact escapes workspace')
    }
    return resolved
  }
}

/** Concrete issue #29 EpubExtractor port backed by deterministic upload ingestion. */
export class DomainEpubExtractor implements EpubExtractor {
  readonly identity = DOMAIN_EPUB_EXTRACTOR_IDENTITY
  readonly #adapter: EpubIngestionAdapter
  readonly #mapper: DomainBookMapper

  constructor(options: EpubIngestionAdapterOptions) {
    this.#adapter = new EpubIngestionAdapter(options)
    this.#mapper = new DomainBookMapper(options.workspaceRoot)
  }

  async extract(request: EpubExtractionRequest): Promise<Book> {
    const bytes = new Uint8Array(await readFile(request.epubPath))
    const ingestion = await this.#adapter.ingest({
      bytes,
      originalFilename: path.basename(request.epubPath),
    })
    return this.#mapper.map(ingestion)
  }
}
