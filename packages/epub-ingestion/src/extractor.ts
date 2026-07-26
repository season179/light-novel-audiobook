import { createHash } from 'node:crypto'
import path from 'node:path'
import { SaxesParser, type SaxesTagPlain } from 'saxes'
import { validateRasterCover } from './cover-validation.js'
import { unzipEpubSafely } from './safe-zip.js'

export const EXTRACTION_IDENTITY = Object.freeze({
  archive_parser: 'fflate@0.8.3',
  xml_parser: 'saxes@6.0.0',
  extraction_rules: 'epub-source-text@2',
  cover_rules: 'm4b-raster-cover@1',
})

export const OFFSET_UNIT = 'unicode-scalar-value' as const

export interface ExtractionIdentity {
  readonly archive_parser: string
  readonly xml_parser: string
  readonly extraction_rules: string
  /** Excluded from source-passage IDs: a decorative-cover policy must not move story identity. */
  readonly cover_rules?: string
}

export interface PublicationTitle {
  readonly value: string
  readonly id: string | null
  readonly type: string | null
  readonly display_sequence: number | null
}

export interface PublicationContributor {
  readonly value: string
  readonly id: string | null
  readonly role: string | null
  readonly file_as: string | null
}

export interface PublicationMetadata {
  readonly title: string | null
  readonly titles: readonly PublicationTitle[]
  readonly authors: readonly string[]
  readonly creators: readonly PublicationContributor[]
  readonly contributors: readonly PublicationContributor[]
  readonly language: string | null
  readonly languages: readonly string[]
  readonly identifiers: readonly string[]
  readonly publisher: string | null
  readonly description: string | null
  readonly rights: string | null
  readonly subjects: readonly string[]
  readonly date: string | null
  readonly modified: string | null
}

export interface ExtractedCover {
  readonly path: string
  readonly media_type: string
  readonly content_sha256: string
  readonly bytes_base64: string
}

export function deriveSourcePassageId(
  publicationContentHash: string,
  locator: string,
  sourceTextHash: string,
  identity: ExtractionIdentity = EXTRACTION_IDENTITY,
): string {
  // Cover rules are deliberately absent: changing a decorative asset policy must not move story
  // identity when parser/source rules, locator, and exact source text are unchanged.
  const versionKey = [
    `archive_parser=${identity.archive_parser}`,
    `xml_parser=${identity.xml_parser}`,
    `extraction_rules=${identity.extraction_rules}`,
  ].join('\0')
  return sha256(
    [
      'source-passage-id@1',
      versionKey,
      `publication_content_sha256=${publicationContentHash}`,
      `locator=${locator}`,
      `source_text_sha256=${sourceTextHash}`,
    ].join('\0'),
  )
}

type TextRole = 'source' | 'layout-whitespace' | 'ruby-annotation' | 'non-story-markup'

interface TextNode {
  readonly type: 'text'
  text: string
  index: number
}

interface ElementNode {
  readonly type: 'element'
  readonly name: string
  readonly qualifiedName: string
  readonly attributes: Readonly<Record<string, string>>
  readonly children: Array<ElementNode | TextNode>
  readonly siblingCounts: Map<string, number>
  textChildCount: number
  readonly index: number
}

export interface EpubXmlLimits {
  readonly maxXmlBytes: number
  readonly maxDecodedCharacters: number
  readonly maxNodes: number
  readonly maxDepth: number
  readonly maxAttributesPerElement: number
}

export const DEFAULT_EPUB_XML_LIMITS: EpubXmlLimits = Object.freeze({
  maxXmlBytes: 16 * 1024 * 1024,
  maxDecodedCharacters: 16 * 1024 * 1024,
  maxNodes: 250_000,
  maxDepth: 256,
  maxAttributesPerElement: 256,
})

export interface SourceAnnotation {
  readonly kind: 'emphasis' | 'strong-emphasis' | 'ruby' | 'line-break' | 'footnote-reference'
  readonly start: number
  readonly end: number
  readonly offset_unit: typeof OFFSET_UNIT
  readonly annotation_text?: string
  readonly fallback_text?: string
  readonly target?: string
}

export interface SourcePassageRecord {
  readonly id: string
  readonly locator: string
  readonly element: string
  readonly source_text: string
  readonly source_text_sha256: string
  readonly annotations: readonly SourceAnnotation[]
  readonly semantic_hints: readonly string[]
}

export interface TextLedgerEntry {
  readonly locator: string
  readonly role: TextRole
  readonly text: string
}

export interface ImageOccurrence {
  readonly locator: string
  readonly source: string
  readonly alt: string | null
  readonly passage_locator: string | null
  readonly source_offset: number | null
  readonly offset_unit: typeof OFFSET_UNIT
  readonly semantic_hints: readonly string[]
}

export interface ExtractedSpineDocument {
  readonly spine_index: number
  readonly idref: string
  readonly path: string
  readonly linear: boolean
  readonly title: string | null
  readonly semantic_hints: readonly string[]
  readonly passages: readonly SourcePassageRecord[]
  readonly text_ledger: readonly TextLedgerEntry[]
  readonly images: readonly ImageOccurrence[]
}

export type NavigationSourceStatus = 'valid' | 'missing' | 'malformed' | 'not-applicable'

export interface NavigationSourceEvidence {
  readonly status: NavigationSourceStatus
  readonly paths: readonly string[]
  readonly error?: string
  readonly error_sha256?: string
}

export interface NavigationEvidence {
  readonly package_version: string
  readonly spine_paths: readonly string[]
  readonly epub3_nav: NavigationSourceEvidence
  readonly ncx: NavigationSourceEvidence
  readonly conflict: boolean
  readonly conflict_sources: readonly ('epub3-nav' | 'ncx')[]
}

export interface ExtractionFinding {
  readonly kind: string
  readonly locators: readonly string[]
  readonly detail: string
}

export interface DeterministicEpubExtraction {
  readonly identity: typeof EXTRACTION_IDENTITY
  readonly offset_unit: typeof OFFSET_UNIT
  readonly publication_content_sha256: string
  readonly metadata: PublicationMetadata
  readonly cover: ExtractedCover | null
  readonly navigation: NavigationEvidence
  readonly documents: readonly ExtractedSpineDocument[]
  readonly findings: readonly ExtractionFinding[]
  readonly extraction_sha256: string
}

interface ManifestItem {
  readonly id: string
  readonly path: string
  readonly mediaType: string
  readonly properties: readonly string[]
}

interface MutableAnnotation {
  kind: SourceAnnotation['kind']
  start: number
  end: number
  offset_unit: typeof OFFSET_UNIT
  annotation_text?: string
  fallback_text?: string
  target?: string
}

const passageElements = new Set([
  'address',
  'aside',
  'blockquote',
  'dd',
  'div',
  'dt',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'p',
  'pre',
])

function isPassageElement(node: ElementNode): boolean {
  return passageElements.has(node.name) || epubType(node).includes('pagebreak')
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function scalarLength(value: string): number {
  return Array.from(value).length
}

function validateArchiveEntryNames(entries: Readonly<Record<string, Uint8Array>>): void {
  for (const entryName of Object.keys(entries)) {
    const segments = entryName.split('/')
    if (
      entryName.length === 0 ||
      entryName.includes('\\') ||
      entryName.includes('\0') ||
      path.posix.isAbsolute(entryName) ||
      path.win32.isAbsolute(entryName) ||
      segments.includes('..')
    ) {
      throw new Error(`Unsafe ZIP entry name: ${JSON.stringify(entryName)}`)
    }
  }
}

function canonicalArchivePath(baseDirectory: string, href: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(href.split('#', 1)[0] ?? '')
  } catch {
    throw new Error(`Invalid percent encoding in EPUB path: ${href}`)
  }
  if (decoded.includes('\\') || decoded.startsWith('/')) {
    throw new Error(`Unsafe EPUB path: ${href}`)
  }
  const normalized = path.posix.normalize(path.posix.join(baseDirectory, decoded))
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`EPUB path escapes the archive root: ${href}`)
  }
  return normalized
}

function decodeXml(bytes: Uint8Array, archivePath: string): string {
  let decoded: string
  try {
    decoded = utf8Decoder.decode(bytes)
  } catch {
    throw new Error(`${archivePath}: source is not valid UTF-8`)
  }
  const declaration = decoded.match(/^\s*<\?xml\s+[^>]*encoding=["']([^"']+)["']/i)
  if (declaration && !/^utf-?8$/i.test(declaration[1] ?? '')) {
    throw new Error(`${archivePath}: only UTF-8 XML is supported by extraction rules v2`)
  }
  return decoded
}

/**
 * The XML 1.0 productions needed to positively recognise a DOCTYPE with no internal subset.
 *
 * `saxes` reports the declaration's text but does not validate the whole `doctypedecl` grammar, so
 * the shape is checked here. This is deliberately a whitelist: anything not matched is rejected,
 * because looking for known-bad markers instead lets malformed declarations through. For example
 * `<!DOCTYPE html <!ENTITY x "value">` contains no `[`, and the `>` that closes the inner construct
 * ends the declaration -- so a "contains a subset delimiter" test sees nothing to object to while an
 * `<!ENTITY`-shaped declaration sails past the rule that is supposed to reject it.
 *
 * `S` is the four XML whitespace characters only; NBSP and other Unicode spaces are not XML
 * whitespace and must not be treated as separators.
 */
const XML_S = '[\\u0020\\u0009\\u000D\\u000A]'
const NAME_START_CHAR =
  ':A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF' +
  '\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD' +
  '\\u{10000}-\\u{EFFFF}'
const NAME_CHAR = `${NAME_START_CHAR}.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040-`
const XML_NAME = `[${NAME_START_CHAR}][${NAME_CHAR}]*`
const SYSTEM_LITERAL = `"[^"]*"|'[^']*'`
/**
 * `PubidChar` minus the apostrophe, which is only legal inside the double-quoted form.
 *
 * The hyphen must stay first so it remains a literal. At the end it pairs with whatever the
 * double-quoted variant appends and silently becomes a range, which drops the leading hyphen that
 * every real public identifier begins with (`-//W3C//DTD XHTML 1.1//EN`).
 */
const PUBID_CHAR = '-\\u0020\\u000D\\u000Aa-zA-Z0-9()+,./:=?;!*#@$_%'
const PUBID_LITERAL = `"[${PUBID_CHAR}']*"|'[${PUBID_CHAR}]*'`
const EXTERNAL_ID =
  `SYSTEM${XML_S}+(?:${SYSTEM_LITERAL})` +
  `|PUBLIC${XML_S}+(?:${PUBID_LITERAL})${XML_S}+(?:${SYSTEM_LITERAL})`

/** `doctypedecl` without the internal-subset clause: `S Name (S ExternalID)? S?`. */
const BARE_DOCTYPE = new RegExp(
  `^${XML_S}+${XML_NAME}(?:${XML_S}+(?:${EXTERNAL_ID}))?${XML_S}*$`,
  'u',
)

/**
 * Only used to choose a clearer message; acceptance is decided solely by `BARE_DOCTYPE`.
 *
 * Quoted spans are removed first because a SYSTEM identifier may legitimately contain a bracket (an
 * IPv6 host literal such as `http://[::1]/x.dtd`), whereas a real subset delimiter is never quoted.
 */
function declaresInternalSubset(doctype: string): boolean {
  return doctype.replace(/"[^"]*"|'[^']*'/gu, '').includes('[')
}

/** `undefined` when the declaration is an acceptable bare DOCTYPE, otherwise why it is rejected. */
function doctypeRejection(doctype: string): string | undefined {
  if (BARE_DOCTYPE.test(doctype)) return undefined
  return declaresInternalSubset(doctype)
    ? 'DOCTYPE internal subsets are not permitted'
    : 'DOCTYPE is not a well-formed declaration without an internal subset'
}

function parseXml(
  bytes: Uint8Array,
  archivePath: string,
  limits: EpubXmlLimits = DEFAULT_EPUB_XML_LIMITS,
): ElementNode {
  if (bytes.byteLength > limits.maxXmlBytes) {
    throw new Error(`${archivePath}: XML exceeds the ${limits.maxXmlBytes}-byte limit`)
  }
  const xml = decodeXml(bytes, archivePath)
  if (xml.length > limits.maxDecodedCharacters) {
    throw new Error(
      `${archivePath}: XML exceeds the ${limits.maxDecodedCharacters}-character limit`,
    )
  }
  const parser = new SaxesParser({ xmlns: false })
  const stack: ElementNode[] = []
  let root: ElementNode | undefined
  let parseError: Error | undefined
  let nodeCount = 0

  const countNode = () => {
    nodeCount += 1
    if (nodeCount > limits.maxNodes) {
      throw new Error(`${archivePath}: XML exceeds the ${limits.maxNodes}-node limit`)
    }
  }

  parser.on('doctype', (doctype) => {
    const rejection = doctypeRejection(doctype)
    if (rejection) parseError ??= new Error(`${archivePath}: ${rejection}`)
  })
  parser.on('error', (error) => {
    parseError ??= new Error(`${archivePath}: malformed XML: ${error.message}`)
  })
  parser.on('opentag', (tag: SaxesTagPlain) => {
    countNode()
    if (stack.length + 1 > limits.maxDepth) {
      throw new Error(`${archivePath}: XML exceeds the ${limits.maxDepth}-element depth limit`)
    }
    if (Object.keys(tag.attributes).length > limits.maxAttributesPerElement) {
      throw new Error(
        `${archivePath}: XML element exceeds the ${limits.maxAttributesPerElement}-attribute limit`,
      )
    }
    const parent = stack.at(-1)
    const localName = tag.name.includes(':') ? (tag.name.split(':').at(-1) ?? tag.name) : tag.name
    const siblingIndex = (parent?.siblingCounts.get(localName) ?? 0) + 1
    parent?.siblingCounts.set(localName, siblingIndex)
    const element: ElementNode = {
      type: 'element',
      name: localName,
      qualifiedName: tag.name,
      attributes: Object.freeze({ ...tag.attributes }),
      children: [],
      siblingCounts: new Map(),
      textChildCount: 0,
      index: siblingIndex,
    }
    if (parent) parent.children.push(element)
    else if (root) parseError ??= new Error(`${archivePath}: XML has multiple roots`)
    else root = element
    stack.push(element)
  })
  const appendText = (text: string) => {
    const parent = stack.at(-1)
    if (!parent || text.length === 0) return
    const previous = parent.children.at(-1)
    if (previous?.type === 'text') {
      previous.text += text
      return
    }
    countNode()
    parent.textChildCount += 1
    parent.children.push({
      type: 'text',
      text,
      index: parent.textChildCount,
    })
  }
  parser.on('text', appendText)
  parser.on('cdata', appendText)
  parser.on('closetag', () => {
    stack.pop()?.siblingCounts.clear()
  })
  parser.write(xml).close()

  if (parseError) throw parseError
  if (!root) throw new Error(`${archivePath}: XML has no document element`)
  return root
}

function elementChildren(node: ElementNode, name?: string): ElementNode[] {
  return node.children.filter(
    (child): child is ElementNode => child.type === 'element' && (!name || child.name === name),
  )
}

function descendants(node: ElementNode, name?: string): ElementNode[] {
  const found: ElementNode[] = []
  const pending = elementChildren(node).reverse()
  while (pending.length > 0) {
    const child = pending.pop()
    if (!child) continue
    if (!name || child.name === name) found.push(child)
    const nested = elementChildren(child)
    for (let index = nested.length - 1; index >= 0; index -= 1) {
      const descendant = nested[index]
      if (descendant) pending.push(descendant)
    }
  }
  return found
}

function firstDescendant(node: ElementNode, name: string): ElementNode | undefined {
  const pending = elementChildren(node).reverse()
  while (pending.length > 0) {
    const child = pending.pop()
    if (!child) continue
    if (child.name === name) return child
    const nested = elementChildren(child)
    for (let index = nested.length - 1; index >= 0; index -= 1) {
      const descendant = nested[index]
      if (descendant) pending.push(descendant)
    }
  }
  return undefined
}

function attribute(node: ElementNode, name: string): string | undefined {
  if (node.attributes[name] !== undefined) return node.attributes[name]
  const match = Object.entries(node.attributes).find(([key]) => key.split(':').at(-1) === name)
  return match?.[1]
}

function allText(node: ElementNode): string {
  const chunks: string[] = []
  const pending: Array<ElementNode | TextNode> = [...node.children].reverse()
  while (pending.length > 0) {
    const child = pending.pop()
    if (!child) continue
    if (child.type === 'text') chunks.push(child.text)
    else {
      for (let index = child.children.length - 1; index >= 0; index -= 1) {
        const nested = child.children[index]
        if (nested) pending.push(nested)
      }
    }
  }
  return chunks.join('')
}

function elementPath(ancestors: readonly ElementNode[]): string {
  return `/${ancestors.map((node) => `${node.qualifiedName}[${node.index}]`).join('/')}`
}

function textPath(ancestors: readonly ElementNode[], node: TextNode): string {
  return `${elementPath(ancestors)}/text()[${node.index}]`
}

function epubType(node: ElementNode): readonly string[] {
  return (attribute(node, 'type') ?? '').split(/\s+/).filter(Boolean)
}

function publicationHash(entries: Readonly<Record<string, Uint8Array>>): string {
  const hash = createHash('sha256')
  for (const archivePath of Object.keys(entries).sort()) {
    hash.update(archivePath)
    hash.update('\0')
    hash.update(entries[archivePath] ?? new Uint8Array())
    hash.update('\0')
  }
  return hash.digest('hex')
}

/**
 * Returns `undefined` when the cover is usable by the downstream M4B assembler, or the reason it
 * is not. A cover is decorative metadata: a publication whose story text extracted perfectly must
 * not become un-ingestable because of one trailing byte after `IEND`, a stale CRC in an ancillary
 * chunk, an animated WebP, or a vector format the pinned FFmpeg build cannot rasterize.
 *
 * This is intentionally the extractor's contract. It already owns byte-level cover validation and
 * runs before direction or rendering; passing an XML-valid SVG onward only to discover after every
 * TTS render that FFmpeg sees but cannot decode it is both too late and too weak. Rasterization would
 * require a new pinned tool, so unsupported vector covers degrade to the existing unusable-cover
 * finding instead. The caller records that finding and continues without a cover.
 */
function coverRejection(
  bytes: Uint8Array,
  mediaType: string,
  archivePath: string,
): string | undefined {
  try {
    validateRasterCover(bytes, mediaType)
    return undefined
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return `EPUB cover is not a supported M4B raster cover (${mediaType}): ${archivePath}: ${detail}`
  }
}

function parsePackage(entries: Readonly<Record<string, Uint8Array>>) {
  const containerBytes = entries['META-INF/container.xml']
  if (!containerBytes)
    throw new Error('EPUB is missing META-INF/container.xml (paths are case-sensitive)')
  const container = parseXml(containerBytes, 'META-INF/container.xml')
  const rootfiles = descendants(container, 'rootfile')
  if (rootfiles.length !== 1) {
    throw new Error(`EPUB container must declare exactly one rootfile; found ${rootfiles.length}`)
  }
  const rootfile = rootfiles[0]
  const packagePathValue = rootfile && attribute(rootfile, 'full-path')
  if (!packagePathValue) throw new Error('EPUB container has no rootfile full-path')
  const packagePath = canonicalArchivePath('', packagePathValue)
  const packageBytes = entries[packagePath]
  if (!packageBytes) throw new Error(`EPUB rootfile does not exist: ${packagePath}`)
  const packageRoot = parseXml(packageBytes, packagePath)
  const packageVersion = attribute(packageRoot, 'version') ?? 'unknown'
  const packageDirectory = path.posix.dirname(packagePath)
  const manifestElement = firstDescendant(packageRoot, 'manifest')
  const spineElement = firstDescendant(packageRoot, 'spine')
  if (!manifestElement || !spineElement) throw new Error('EPUB package requires manifest and spine')

  const manifest = new Map<string, ManifestItem>()
  for (const item of elementChildren(manifestElement, 'item')) {
    const id = attribute(item, 'id')
    const href = attribute(item, 'href')
    const mediaType = attribute(item, 'media-type')
    if (!id || !href || !mediaType)
      throw new Error('EPUB manifest item lacks id, href, or media-type')
    if (manifest.has(id)) throw new Error(`EPUB manifest repeats id: ${id}`)
    manifest.set(id, {
      id,
      path: canonicalArchivePath(packageDirectory, href),
      mediaType,
      properties: (attribute(item, 'properties') ?? '').split(/\s+/).filter(Boolean),
    })
  }

  const spine = elementChildren(spineElement, 'itemref').map((itemref, spineIndex) => {
    const idref = attribute(itemref, 'idref')
    const item = idref && manifest.get(idref)
    if (!idref || !item)
      throw new Error(`EPUB spine item ${spineIndex} has unknown idref: ${idref ?? ''}`)
    if (item.mediaType !== 'application/xhtml+xml') {
      throw new Error(`EPUB spine item is not XHTML: ${idref}`)
    }
    return { item, linear: attribute(itemref, 'linear') !== 'no', spineIndex }
  })

  if (spine.length === 0) throw new Error('EPUB package spine is empty')

  const metadataElement = firstDescendant(packageRoot, 'metadata')
  const metadataChildren = (name: string): ElementNode[] =>
    metadataElement ? elementChildren(metadataElement, name) : []
  const metadataIds = new Set<string>()
  for (const element of metadataElement ? elementChildren(metadataElement) : []) {
    const id = attribute(element, 'id')
    if (!id) continue
    if (metadataIds.has(id)) throw new Error(`EPUB metadata repeats id: ${id}`)
    metadataIds.add(id)
  }
  const metadataValues = (name: string): string[] =>
    metadataChildren(name).map((element) => allText(element))
  const refinements = new Map<string, Map<string, string[]>>()
  for (const meta of metadataChildren('meta')) {
    const target = attribute(meta, 'refines')
    const property = attribute(meta, 'property')
    if (!target?.startsWith('#') || !property) continue
    const byProperty = refinements.get(target.slice(1)) ?? new Map<string, string[]>()
    const values = byProperty.get(property) ?? []
    values.push(allText(meta))
    byProperty.set(property, values)
    refinements.set(target.slice(1), byProperty)
  }
  const refinement = (element: ElementNode, property: string): string | null => {
    const id = attribute(element, 'id')
    const values = id ? refinements.get(id)?.get(property) : undefined
    if (values && values.length > 1) {
      throw new Error(`EPUB metadata ${id} repeats refinement property: ${property}`)
    }
    return values?.[0] ?? null
  }
  const titles: PublicationTitle[] = metadataChildren('title').map((element) => {
    const displaySequenceValue = refinement(element, 'display-seq')
    const displaySequence = displaySequenceValue === null ? null : Number(displaySequenceValue)
    if (
      displaySequence !== null &&
      (!Number.isSafeInteger(displaySequence) || displaySequence < 1)
    ) {
      throw new Error(`EPUB title has invalid display-seq: ${displaySequenceValue}`)
    }
    return {
      value: allText(element),
      id: attribute(element, 'id') ?? null,
      type: refinement(element, 'title-type'),
      display_sequence: displaySequence,
    }
  })
  const contributorRecord = (element: ElementNode): PublicationContributor => ({
    value: allText(element),
    id: attribute(element, 'id') ?? null,
    role: attribute(element, 'role') ?? refinement(element, 'role'),
    file_as: attribute(element, 'file-as') ?? refinement(element, 'file-as'),
  })
  const creators = metadataChildren('creator').map(contributorRecord)
  const contributors = metadataChildren('contributor').map(contributorRecord)
  const selectedTitle =
    titles.find((title) => title.type === 'main') ??
    [...titles]
      .filter((title) => title.display_sequence !== null)
      .sort(
        (left, right) =>
          (left.display_sequence ?? Number.MAX_SAFE_INTEGER) -
          (right.display_sequence ?? Number.MAX_SAFE_INTEGER),
      )[0] ??
    titles[0]
  const authors = creators
    .filter((creator) => creator.role === null || ['aut', 'author'].includes(creator.role))
    .map((creator) => creator.value)
  const languages = metadataValues('language')
  const publisherValues = metadataValues('publisher')
  const descriptionValues = metadataValues('description')
  const rightsValues = metadataValues('rights')
  const dateValues = metadataValues('date')
  const modifiedValues = metadataChildren('meta')
    .filter((element) => attribute(element, 'property') === 'dcterms:modified')
    .map((element) => allText(element))
  const metadata: PublicationMetadata = {
    title: selectedTitle?.value ?? null,
    titles,
    authors,
    creators,
    contributors,
    language: languages[0] ?? null,
    languages,
    identifiers: metadataValues('identifier'),
    publisher: publisherValues[0] ?? null,
    description: descriptionValues[0] ?? null,
    rights: rightsValues[0] ?? null,
    subjects: metadataValues('subject'),
    date: dateValues[0] ?? null,
    modified: modifiedValues[0] ?? null,
  }

  const propertyCovers = [...manifest.values()].filter((item) =>
    item.properties.includes('cover-image'),
  )
  const legacyCoverIds = metadataElement
    ? elementChildren(metadataElement, 'meta')
        .filter((element) => attribute(element, 'name') === 'cover')
        .flatMap((element) => {
          const content = attribute(element, 'content')
          return content ? [content] : []
        })
    : []
  const legacyCovers = legacyCoverIds.map((id) => {
    const item = manifest.get(id)
    if (!item) throw new Error(`EPUB legacy cover metadata references unknown manifest id: ${id}`)
    return item
  })
  const coverCandidates = [...propertyCovers, ...legacyCovers].filter(
    (item, index, values) => values.findIndex((value) => value.id === item.id) === index,
  )
  if (coverCandidates.length > 1) {
    throw new Error(
      `EPUB package declares multiple cover images: ${coverCandidates.map((item) => item.id).join(', ')}`,
    )
  }
  const coverItem = coverCandidates[0]
  const coverBytes = coverItem ? entries[coverItem.path] : undefined
  if (coverItem && !coverBytes)
    throw new Error(`EPUB cover resource does not exist: ${coverItem.path}`)
  const coverRejectionDetail =
    coverItem && coverBytes
      ? coverRejection(coverBytes, coverItem.mediaType, coverItem.path)
      : undefined
  const cover: ExtractedCover | null =
    coverItem && coverBytes && !coverRejectionDetail
      ? {
          path: coverItem.path,
          media_type: coverItem.mediaType,
          content_sha256: sha256(coverBytes),
          bytes_base64: Buffer.from(coverBytes).toString('base64'),
        }
      : null

  return {
    manifest,
    metadata,
    cover,
    coverRejection: coverRejectionDetail,
    rejectedCoverPath: coverRejectionDetail ? coverItem?.path : undefined,
    packageDirectory,
    packageVersion,
    spine,
    tocId: attribute(spineElement, 'toc'),
  }
}

function malformedNavigation(error: unknown): NavigationSourceEvidence {
  const message = error instanceof Error ? error.message : String(error)
  return { status: 'malformed', paths: [], error: message, error_sha256: sha256(message) }
}

function navigationPaths(
  entries: Readonly<Record<string, Uint8Array>>,
  manifest: ReadonlyMap<string, ManifestItem>,
  tocId: string | undefined,
  packageVersion: string,
): { epub3: NavigationSourceEvidence; ncx: NavigationSourceEvidence } {
  const navItems = [...manifest.values()].filter((item) => item.properties.includes('nav'))
  let epub3: NavigationSourceEvidence
  if (navItems.length === 0) {
    epub3 = {
      status: packageVersion.startsWith('3') ? 'missing' : 'not-applicable',
      paths: [],
    }
  } else if (navItems.length > 1) {
    epub3 = malformedNavigation(new Error('EPUB manifest contains multiple navigation documents'))
  } else {
    const navItem = navItems[0]
    try {
      if (!navItem) throw new Error('EPUB navigation manifest item is missing')
      const navBytes = entries[navItem.path]
      if (!navBytes) throw new Error(`EPUB navigation resource does not exist: ${navItem.path}`)
      const root = parseXml(navBytes, navItem.path)
      const nav = descendants(root, 'nav').find((node) => epubType(node).includes('toc'))
      if (!nav) throw new Error(`${navItem.path}: no nav element with epub:type="toc"`)
      const base = path.posix.dirname(navItem.path)
      const paths = descendants(nav, 'a').flatMap((link) => {
        const href = attribute(link, 'href')
        return href ? [canonicalArchivePath(base, href)] : []
      })
      epub3 = { status: 'valid', paths }
    } catch (error) {
      epub3 = malformedNavigation(error)
    }
  }

  let ncx: NavigationSourceEvidence
  if (!tocId) {
    ncx = { status: 'missing', paths: [] }
  } else {
    try {
      const ncxItem = manifest.get(tocId)
      if (!ncxItem) throw new Error(`NCX manifest item does not exist: ${tocId}`)
      const ncxBytes = entries[ncxItem.path]
      if (!ncxBytes) throw new Error(`NCX resource does not exist: ${ncxItem.path}`)
      const root = parseXml(ncxBytes, ncxItem.path)
      const base = path.posix.dirname(ncxItem.path)
      const paths = descendants(root, 'content').flatMap((content) => {
        const source = attribute(content, 'src')
        return source ? [canonicalArchivePath(base, source)] : []
      })
      ncx = { status: 'valid', paths }
    } catch (error) {
      ncx = malformedNavigation(error)
    }
  }
  return { epub3, ncx }
}

function extractDocument(
  root: ElementNode,
  item: ManifestItem,
  spineIndex: number,
  linear: boolean,
  publicationContentHash: string,
): ExtractedSpineDocument {
  const body = firstDescendant(root, 'body')
  if (!body) throw new Error(`${item.path}: XHTML has no body`)
  const head = firstDescendant(root, 'head')
  const titleElement = head && firstDescendant(head, 'title')
  const ledger: Array<TextLedgerEntry & { node: TextNode }> = []
  const textOrder = new Map<TextNode, number>()
  const indexTextNodes = (node: ElementNode) => {
    for (const child of node.children) {
      if (child.type === 'text') textOrder.set(child, textOrder.size)
      else indexTextNodes(child)
    }
  }
  indexTextNodes(body)
  const images: ImageOccurrence[] = []
  const capturedImageNodes = new Set<ElementNode>()
  const passages: SourcePassageRecord[] = []
  const visitedBlocks = new Set<ElementNode>()
  const documentPrefix = `spine[${spineIndex.toString().padStart(4, '0')}]::${item.path}::`

  const parentOwnedTextAndNestedRoot = (
    block: ElementNode,
  ): { text: string; nestedRoot?: ElementNode } => {
    let text = ''
    let nestedRoot: ElementNode | undefined
    const collect = (node: ElementNode) => {
      for (const child of node.children) {
        if (child.type === 'text') {
          text += child.text
        } else {
          const isNonSource =
            child.name === 'script' ||
            child.name === 'style' ||
            child.name === 'rt' ||
            child.name === 'rp'
          if (isNonSource) continue
          if (isPassageElement(child)) nestedRoot ??= child
          else collect(child)
        }
      }
    }
    collect(block)
    return nestedRoot ? { text, nestedRoot } : { text }
  }

  const validateNestedPassageOrder = (node: ElementNode, ancestors: ElementNode[]) => {
    for (const child of elementChildren(node)) {
      const childAncestors = [...ancestors, child]
      if (isPassageElement(child)) {
        const ownership = parentOwnedTextAndNestedRoot(child)
        if (ownership.nestedRoot && !/^\s*$/u.test(ownership.text)) {
          throw new Error(
            `${item.path}: nested passage root would reorder parent-owned text at ${documentPrefix}${elementPath(childAncestors)}`,
          )
        }
      }
      validateNestedPassageOrder(child, childAncestors)
    }
  }

  const recordUnclaimed = (node: ElementNode, ancestors: ElementNode[]) => {
    for (const child of node.children) {
      if (child.type === 'text') {
        ledger.push({
          locator: documentPrefix + textPath(ancestors, child),
          role: 'non-story-markup',
          text: child.text,
          node: child,
        })
      } else {
        recordUnclaimed(child, [...ancestors, child])
      }
    }
  }

  const extractBlock = (block: ElementNode, ancestors: ElementNode[]) => {
    if (visitedBlocks.has(block)) return
    visitedBlocks.add(block)
    const locator = documentPrefix + elementPath(ancestors)
    let sourceText = ''
    const annotations: MutableAnnotation[] = []
    const sourceNodes: Array<{ node: TextNode; locator: string }> = []
    const blockImages: ImageOccurrence[] = []

    const walk = (node: ElementNode, nodeAncestors: ElementNode[]) => {
      for (const child of node.children) {
        if (child.type === 'text') {
          sourceNodes.push({
            node: child,
            locator: documentPrefix + textPath(nodeAncestors, child),
          })
          sourceText += child.text
          continue
        }
        if (child !== block && isPassageElement(child)) continue
        if (child.name === 'script' || child.name === 'style') {
          recordUnclaimed(child, [...nodeAncestors, child])
          continue
        }
        if (child.name === 'rt' || child.name === 'rp') continue

        const start = scalarLength(sourceText)
        if (child.name === 'img' || child.name === 'image') {
          capturedImageNodes.add(child)
          blockImages.push({
            locator: documentPrefix + elementPath([...nodeAncestors, child]),
            source: attribute(child, 'src') ?? attribute(child, 'href') ?? '',
            alt: attribute(child, 'alt') ?? null,
            passage_locator: locator,
            source_offset: start,
            offset_unit: OFFSET_UNIT,
            semantic_hints: [],
          })
        }
        if (child.name === 'br') {
          annotations.push({ kind: 'line-break', start, end: start, offset_unit: OFFSET_UNIT })
        } else if (child.name === 'ruby') {
          let reading = ''
          let fallback = ''
          for (const rubyChild of child.children) {
            if (rubyChild.type === 'element' && rubyChild.name === 'rt')
              reading += allText(rubyChild)
            else if (rubyChild.type === 'element' && rubyChild.name === 'rp')
              fallback += allText(rubyChild)
            else if (rubyChild.type === 'text') {
              sourceNodes.push({
                node: rubyChild,
                locator: documentPrefix + textPath([...nodeAncestors, child], rubyChild),
              })
              sourceText += rubyChild.text
            } else if (rubyChild.type === 'element') {
              walk(rubyChild, [...nodeAncestors, child, rubyChild])
            }
          }
          const end = scalarLength(sourceText)
          annotations.push({
            kind: 'ruby',
            start,
            end,
            offset_unit: OFFSET_UNIT,
            annotation_text: reading,
            fallback_text: fallback,
          })
          const markRubyText = (rubyNode: ElementNode, rubyAncestors: ElementNode[]) => {
            for (const rubyChild of rubyNode.children) {
              if (rubyChild.type === 'text') {
                ledger.push({
                  locator: documentPrefix + textPath(rubyAncestors, rubyChild),
                  role: 'ruby-annotation',
                  text: rubyChild.text,
                  node: rubyChild,
                })
              } else markRubyText(rubyChild, [...rubyAncestors, rubyChild])
            }
          }
          for (const rubyChild of elementChildren(child).filter(
            (node) => node.name === 'rt' || node.name === 'rp',
          )) {
            markRubyText(rubyChild, [...nodeAncestors, child, rubyChild])
          }
          continue
        } else {
          walk(child, [...nodeAncestors, child])
        }
        const end = scalarLength(sourceText)
        if (child.name === 'em' || child.name === 'i') {
          annotations.push({ kind: 'emphasis', start, end, offset_unit: OFFSET_UNIT })
        }
        if (child.name === 'strong' || child.name === 'b') {
          annotations.push({ kind: 'strong-emphasis', start, end, offset_unit: OFFSET_UNIT })
        }
        if (child.name === 'a' && epubType(child).includes('noteref')) {
          annotations.push({
            kind: 'footnote-reference',
            start,
            end,
            offset_unit: OFFSET_UNIT,
            target: attribute(child, 'href') ?? '',
          })
        }
      }
    }

    walk(block, ancestors)
    if (/^\s*$/u.test(sourceText)) {
      images.push(
        ...blockImages.map((image) => ({
          ...image,
          semantic_hints: ['passage-root-without-source-text'],
        })),
      )
      for (const sourceNode of sourceNodes) {
        ledger.push({ ...sourceNode, role: 'layout-whitespace', text: sourceNode.node.text })
      }
      return
    }
    images.push(...blockImages)
    for (const sourceNode of sourceNodes) {
      ledger.push({ ...sourceNode, role: 'source', text: sourceNode.node.text })
    }

    const semanticHints: string[] = []
    const semanticContext = ancestors
    if (/^h[1-6]$/.test(block.name)) semanticHints.push('heading')
    if (
      semanticContext.some((node) =>
        epubType(node).some((type) => type === 'footnote' || type === 'endnote'),
      )
    ) {
      semanticHints.push('footnote')
    }
    const classTokens = (attribute(block, 'class') ?? '').split(/\s+/)
    if (
      semanticContext.some((node) => epubType(node).includes('pagebreak')) ||
      classTokens.some((token) =>
        ['running-head', 'running-foot', 'page-header', 'page-footer'].includes(token),
      )
    ) {
      semanticHints.push('page-furniture')
    }
    if (
      semanticContext.some((node) => node.name === 'aside') &&
      !semanticHints.includes('footnote')
    ) {
      semanticHints.push('ambiguous')
    }
    if (scalarLength(sourceText.trim()) <= 1 && !semanticHints.includes('page-furniture')) {
      semanticHints.push('low-text')
    }

    const sourceTextHash = sha256(sourceText)
    passages.push({
      id: deriveSourcePassageId(publicationContentHash, locator, sourceTextHash),
      locator,
      element: block.name,
      source_text: sourceText,
      source_text_sha256: sourceTextHash,
      annotations,
      semantic_hints: semanticHints,
    })
  }

  const visit = (node: ElementNode, ancestors: ElementNode[]) => {
    for (const child of node.children) {
      if (child.type === 'text') continue
      const nextAncestors = [...ancestors, child]
      if (isPassageElement(child)) extractBlock(child, nextAncestors)
      visit(child, nextAncestors)
    }
  }
  const rootPath: ElementNode[] = [root]
  const bodyAncestors = (() => {
    const findPath = (node: ElementNode, current: ElementNode[]): ElementNode[] | undefined => {
      if (node === body) return current
      for (const child of elementChildren(node)) {
        const found = findPath(child, [...current, child])
        if (found) return found
      }
      return undefined
    }
    return findPath(root, rootPath) ?? [root, body]
  })()
  validateNestedPassageOrder(body, bodyAncestors)
  visit(body, bodyAncestors)

  const imageOrder = new Map<string, number>()
  const captureImages = (node: ElementNode, ancestors: ElementNode[]) => {
    for (const child of elementChildren(node)) {
      const childAncestors = [...ancestors, child]
      if (child.name === 'img' || child.name === 'image') {
        const locator = documentPrefix + elementPath(childAncestors)
        imageOrder.set(locator, imageOrder.size)
        if (!capturedImageNodes.has(child)) {
          capturedImageNodes.add(child)
          images.push({
            locator,
            source: attribute(child, 'src') ?? attribute(child, 'href') ?? '',
            alt: attribute(child, 'alt') ?? null,
            passage_locator: null,
            source_offset: null,
            offset_unit: OFFSET_UNIT,
            semantic_hints: ['outside-passage-root', 'requires-review'],
          })
        }
      }
      captureImages(child, childAncestors)
    }
  }
  captureImages(body, bodyAncestors)
  images.sort(
    (left, right) =>
      (imageOrder.get(left.locator) ?? Number.MAX_SAFE_INTEGER) -
      (imageOrder.get(right.locator) ?? Number.MAX_SAFE_INTEGER),
  )

  const seenLedgerNodes = new Set(ledger.map((entry) => entry.node))
  const captureSpecial = (node: ElementNode, ancestors: ElementNode[]) => {
    for (const child of node.children) {
      if (child.type === 'text') {
        if (!seenLedgerNodes.has(child)) {
          const locator = documentPrefix + textPath(ancestors, child)
          const isMarkup = ancestors.some(
            (ancestor) => ancestor.name === 'script' || ancestor.name === 'style',
          )
          if (!isMarkup && !/^\s*$/u.test(child.text)) {
            throw new Error(
              `${item.path}: non-whitespace body text has no passage root at ${locator}`,
            )
          }
          ledger.push({
            locator,
            role: isMarkup ? 'non-story-markup' : 'layout-whitespace',
            text: child.text,
            node: child,
          })
          seenLedgerNodes.add(child)
        }
      } else captureSpecial(child, [...ancestors, child])
    }
  }
  captureSpecial(body, bodyAncestors)
  ledger.sort(
    (left, right) =>
      (textOrder.get(left.node) ?? Number.MAX_SAFE_INTEGER) -
      (textOrder.get(right.node) ?? Number.MAX_SAFE_INTEGER),
  )

  const documentHints: string[] = []
  if (item.properties.includes('nav')) {
    documentHints.push('navigation-document', 'requires-review')
  }
  if (!linear) documentHints.push('nonlinear-spine-item', 'requires-review')
  if (images.some((image) => image.semantic_hints.includes('outside-passage-root'))) {
    documentHints.push('unanchored-image', 'requires-review')
  }
  if (images.length > 0 && passages.every((passage) => /^\s*$/u.test(passage.source_text))) {
    documentHints.push('image-only', 'requires-review')
  }
  if (passages.some((passage) => passage.semantic_hints.includes('low-text'))) {
    documentHints.push('low-text', 'requires-review')
  }
  if (passages.some((passage) => passage.semantic_hints.includes('ambiguous'))) {
    documentHints.push('ambiguous-content', 'requires-review')
  }

  return {
    spine_index: spineIndex,
    idref: item.id,
    path: item.path,
    linear,
    title: titleElement ? allText(titleElement) : null,
    semantic_hints: [...new Set(documentHints)],
    passages,
    text_ledger: ledger.map(({ node: _node, ...entry }) => entry),
    images,
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

export function extractEpubDeterministically(archive: Uint8Array): DeterministicEpubExtraction {
  const entries = unzipEpubSafely(archive)
  validateArchiveEntryNames(entries)
  if (entries['META-INF/encryption.xml']) {
    throw new Error(
      'EPUB encrypted or obfuscated resources declared by META-INF/encryption.xml are unsupported',
    )
  }
  const mime = entries.mimetype
  if (!mime || utf8Decoder.decode(mime) !== 'application/epub+zip') {
    throw new Error('EPUB mimetype must be exactly application/epub+zip')
  }
  const contentHash = publicationHash(entries)
  const parsedPackage = parsePackage(entries)
  const nav = navigationPaths(
    entries,
    parsedPackage.manifest,
    parsedPackage.tocId,
    parsedPackage.packageVersion,
  )
  const documents = parsedPackage.spine.map(({ item, linear, spineIndex }) => {
    const bytes = entries[item.path]
    if (!bytes) throw new Error(`Spine resource does not exist: ${item.path}`)
    return extractDocument(parseXml(bytes, item.path), item, spineIndex, linear, contentHash)
  })
  const spinePaths = documents.map((document) => document.path)
  const sourceConflictsWithSpine = (source: NavigationSourceEvidence): boolean => {
    if (source.status !== 'valid') return false
    const referenced = source.paths.filter((value) => spinePaths.includes(value))
    const expected = spinePaths.filter((value) => referenced.includes(value))
    return JSON.stringify(referenced) !== JSON.stringify(expected)
  }
  const conflictSources: Array<'epub3-nav' | 'ncx'> = []
  if (sourceConflictsWithSpine(nav.epub3)) conflictSources.push('epub3-nav')
  if (sourceConflictsWithSpine(nav.ncx)) conflictSources.push('ncx')
  const navigationConflict = conflictSources.length > 0

  const findings: ExtractionFinding[] = []
  if (parsedPackage.coverRejection) {
    findings.push({
      kind: 'unusable-cover',
      locators: parsedPackage.rejectedCoverPath ? [parsedPackage.rejectedCoverPath] : [],
      detail: `${parsedPackage.coverRejection} The publication was ingested without a cover; M4B assembly will continue without it unless a supported cover is supplied.`,
    })
  }
  if (nav.epub3.status === 'missing') {
    findings.push({
      kind: 'missing-epub3-navigation',
      locators: [],
      detail: 'EPUB 3 package has no manifest item with the nav property.',
    })
  } else if (nav.epub3.status === 'malformed') {
    findings.push({
      kind: 'malformed-epub3-navigation',
      locators: [],
      detail: nav.epub3.error ?? 'EPUB 3 navigation is malformed.',
    })
  }
  if (nav.ncx.status === 'malformed') {
    findings.push({
      kind: 'malformed-ncx-navigation',
      locators: [],
      detail: nav.ncx.error ?? 'NCX navigation is malformed.',
    })
  }
  if (nav.epub3.status === 'not-applicable' && nav.ncx.status === 'missing') {
    findings.push({
      kind: 'missing-navigation',
      locators: [],
      detail: 'Publication has neither applicable EPUB 3 navigation nor an NCX.',
    })
  }
  if (navigationConflict) {
    findings.push({
      kind: 'navigation-spine-conflict',
      locators: [],
      detail: `Spine order is authoritative; conflicting sources: ${conflictSources.join(', ')}.`,
    })
  }
  const headings = new Map<string, string[]>()
  for (const passage of documents.flatMap((document) => document.passages)) {
    if (passage.semantic_hints.includes('heading')) {
      const occurrences = headings.get(passage.source_text) ?? []
      occurrences.push(passage.locator)
      headings.set(passage.source_text, occurrences)
    }
  }
  for (const [heading, locators] of headings) {
    if (locators.length > 1) {
      findings.push({
        kind: 'duplicate-heading',
        locators,
        detail: `Heading is retained ${locators.length} times: ${JSON.stringify(heading)}`,
      })
    }
  }
  for (const document of documents) {
    const unanchoredImages = document.images.filter((image) =>
      image.semantic_hints.includes('outside-passage-root'),
    )
    if (unanchoredImages.length > 0) {
      findings.push({
        kind: 'image-outside-passage-root',
        locators: unanchoredImages.map((image) => image.locator),
        detail: `${unanchoredImages.length} image occurrence(s) require structural review.`,
      })
    }
  }
  for (const document of documents.filter((value) =>
    value.semantic_hints.includes('requires-review'),
  )) {
    findings.push({
      kind: 'ambiguous-spine-content',
      locators: [`spine[${document.spine_index.toString().padStart(4, '0')}]::${document.path}`],
      detail: `Retained with hints: ${document.semantic_hints.join(', ')}`,
    })
  }

  const withoutHash = {
    identity: EXTRACTION_IDENTITY,
    offset_unit: OFFSET_UNIT,
    publication_content_sha256: contentHash,
    metadata: parsedPackage.metadata,
    cover: parsedPackage.cover,
    navigation: {
      package_version: parsedPackage.packageVersion,
      spine_paths: spinePaths,
      epub3_nav: nav.epub3,
      ncx: nav.ncx,
      conflict: navigationConflict,
      conflict_sources: conflictSources,
    },
    documents,
    findings,
  }
  return deepFreeze({
    ...withoutHash,
    extraction_sha256: sha256(JSON.stringify(withoutHash)),
  })
}

/** Compatibility name retained for the completed parser-comparison spike. */
export const extractEpubForSpike = extractEpubDeterministically
export type EpubSpikeExtraction = DeterministicEpubExtraction
