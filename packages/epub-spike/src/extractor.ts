import { createHash } from 'node:crypto'
import path from 'node:path'
import { unzipSync } from 'fflate'
import { SaxesParser, type SaxesTagPlain } from 'saxes'

export const EXTRACTION_IDENTITY = Object.freeze({
  archive_parser: 'fflate@0.8.3',
  xml_parser: 'saxes@6.0.0',
  extraction_rules: 'epub-source-text@2',
})

export const OFFSET_UNIT = 'unicode-scalar-value' as const

export interface ExtractionIdentity {
  readonly archive_parser: string
  readonly xml_parser: string
  readonly extraction_rules: string
}

export function deriveSourcePassageId(
  publicationContentHash: string,
  locator: string,
  sourceTextHash: string,
  identity: ExtractionIdentity = EXTRACTION_IDENTITY,
): string {
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
  readonly index: number
}

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

export interface EpubSpikeExtraction {
  readonly identity: typeof EXTRACTION_IDENTITY
  readonly offset_unit: typeof OFFSET_UNIT
  readonly publication_content_sha256: string
  readonly metadata_title: string | null
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

function parseXml(bytes: Uint8Array, archivePath: string): ElementNode {
  const xml = decodeXml(bytes, archivePath)
  const parser = new SaxesParser({ xmlns: false })
  const stack: ElementNode[] = []
  let root: ElementNode | undefined
  let parseError: Error | undefined

  parser.on('doctype', () => {
    parseError = new Error(`${archivePath}: DOCTYPE and custom entities are not permitted`)
  })
  parser.on('error', (error) => {
    parseError ??= new Error(`${archivePath}: malformed XML: ${error.message}`)
  })
  parser.on('opentag', (tag: SaxesTagPlain) => {
    const parent = stack.at(-1)
    const localName = tag.name.includes(':') ? (tag.name.split(':').at(-1) ?? tag.name) : tag.name
    const siblings = parent?.children.filter(
      (child): child is ElementNode => child.type === 'element' && child.name === localName,
    )
    const element: ElementNode = {
      type: 'element',
      name: localName,
      qualifiedName: tag.name,
      attributes: Object.freeze({ ...tag.attributes }),
      children: [],
      index: (siblings?.length ?? 0) + 1,
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
    parent.children.push({
      type: 'text',
      text,
      index: parent.children.filter((child) => child.type === 'text').length + 1,
    })
  }
  parser.on('text', appendText)
  parser.on('cdata', appendText)
  parser.on('closetag', () => {
    stack.pop()
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
  for (const child of elementChildren(node)) {
    if (!name || child.name === name) found.push(child)
    found.push(...descendants(child, name))
  }
  return found
}

function firstDescendant(node: ElementNode, name: string): ElementNode | undefined {
  return descendants(node, name)[0]
}

function attribute(node: ElementNode, name: string): string | undefined {
  if (node.attributes[name] !== undefined) return node.attributes[name]
  const match = Object.entries(node.attributes).find(([key]) => key.split(':').at(-1) === name)
  return match?.[1]
}

function allText(node: ElementNode): string {
  let text = ''
  for (const child of node.children) {
    text += child.type === 'text' ? child.text : allText(child)
  }
  return text
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

function parsePackage(entries: Readonly<Record<string, Uint8Array>>) {
  const containerBytes = entries['META-INF/container.xml']
  if (!containerBytes)
    throw new Error('EPUB is missing META-INF/container.xml (paths are case-sensitive)')
  const container = parseXml(containerBytes, 'META-INF/container.xml')
  const rootfile = firstDescendant(container, 'rootfile')
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

  const metadata = firstDescendant(packageRoot, 'metadata')
  const metadataTitle = metadata ? firstDescendant(metadata, 'title') : undefined
  return {
    manifest,
    metadataTitle: metadataTitle ? allText(metadataTitle) : null,
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

export function extractEpubForSpike(archive: Uint8Array): EpubSpikeExtraction {
  const entries = unzipSync(archive)
  validateArchiveEntryNames(entries)
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
    metadata_title: parsedPackage.metadataTitle,
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
