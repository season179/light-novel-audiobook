import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { extractEpubDeterministically } from '../src/index.js'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const fixtureRoot = path.join(repositoryRoot, 'tests/fixtures/epub')

/**
 * All archives here are built in memory from a committed synthetic fixture, so no new binary
 * fixture is added and no real book is involved. Only the spine document's markup varies.
 */
async function fixtureEntries(): Promise<Record<string, Uint8Array>> {
  return unzipSync(
    new Uint8Array(await readFile(path.join(fixtureRoot, 'synthetic-ncx-only.epub'))),
  )
}

const SPINE_DOCUMENT = 'EPUB/one.xhtml'

/** Rebuilds the fixture with `prologue` in front of the spine document, and `body` as its content. */
async function archiveWith(prologue: string, body = '<p>Retained.</p>'): Promise<Uint8Array> {
  const entries = await fixtureEntries()
  entries[SPINE_DOCUMENT] = strToU8(
    `${prologue}<html><head><title>One</title></head><body>${body}</body></html>`,
  )
  return zipSync(entries)
}

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        }),
    ),
  )
})

describe('DOCTYPE rule (ADR 0001 rule 4, narrowed)', () => {
  it.each([
    [
      'XHTML 1.1, the form carried by real EPUB 2 content documents',
      '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">\n',
    ],
    [
      'NCX 2005-1, the form carried by real EPUB 2 navigation',
      '<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">\n',
    ],
    ['name only, no external identifier', '<!DOCTYPE html>\n'],
    ['SYSTEM identifier only', '<!DOCTYPE html SYSTEM "http://example.invalid/x.dtd">\n'],
    [
      'declaration split across lines',
      '<!DOCTYPE html\n  PUBLIC "-//W3C//DTD XHTML 1.1//EN"\n  "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">\n',
    ],
    [
      'SYSTEM identifier containing a bracketed IPv6 host, which is not an internal subset',
      '<!DOCTYPE html SYSTEM "http://[::1]/x.dtd">\n',
    ],
  ])('accepts a DOCTYPE with no internal subset: %s', async (_label, prologue) => {
    const extraction = extractEpubDeterministically(await archiveWith(prologue))
    // Accepted, and the story text is extracted normally rather than merely tolerated.
    expect(
      extraction.documents.flatMap((document) =>
        document.passages.map((passage) => passage.source_text),
      ),
    ).toContain('Retained.')
  })

  it.each([
    ['an empty internal subset', '<!DOCTYPE html [ ]>\n', '<p>Retained.</p>'],
    [
      'an internal subset declaring an entity',
      '<!DOCTYPE html [ <!ENTITY harmless "text"> ]>\n',
      '<p>Retained.</p>',
    ],
    [
      'an external general entity declaration (the XXE shape)',
      '<!DOCTYPE html [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>\n',
      '<p>Retained.</p>',
    ],
    [
      'nested entity declarations (the billion-laughs shape)',
      '<!DOCTYPE html [ <!ENTITY a "aa"> <!ENTITY b "&a;&a;"> ]>\n',
      '<p>Retained.</p>',
    ],
    [
      'a subset whose declaration contains a bracket inside a quoted value',
      '<!DOCTYPE html [ <!ENTITY a "]"> ]>\n',
      '<p>Retained.</p>',
    ],
  ])('still rejects %s', async (_label, prologue, body) => {
    const archive = await archiveWith(prologue, body)
    expect(() => extractEpubDeterministically(archive)).toThrow(
      /internal subsets are not permitted/,
    )
  })

  it.each([
    ['an undeclared named entity', '<p>a&nbsp;b</p>'],
    ['a malformed character reference', '<p>a&#xZZ;b</p>'],
    ['an unterminated reference', '<p>a&amp b</p>'],
  ])('still rejects %s even with a permitted DOCTYPE present', async (_label, body) => {
    const archive = await archiveWith(
      '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">\n',
      body,
    )
    expect(() => extractEpubDeterministically(archive)).toThrow(/malformed XML/)
  })

  it('still decodes predefined and numeric references exactly, with a DOCTYPE present', async () => {
    const archive = await archiveWith(
      '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">\n',
      '<p>A &amp; B&#160;end &#x1F642;</p>',
    )
    const extraction = extractEpubDeterministically(archive)
    expect(
      extraction.documents.flatMap((document) =>
        document.passages.map((passage) => passage.source_text),
      ),
    ).toContain('A & B end \u{1f642}')
  })
})

describe('DOCTYPE external identifiers are never resolved', () => {
  /**
   * The entire safety argument for permitting a bare DOCTYPE is that the parser does not fetch the
   * external identifier. That is asserted here against a *reachable* server rather than assumed:
   * the declaration points at a real listening socket that would serve a malicious DTD, and the
   * server must observe zero requests.
   */
  async function listeningDtdServer(): Promise<{ url: string; requests: string[] }> {
    const requests: string[] = []
    const server = createServer((request, response) => {
      requests.push(request.url ?? '')
      response.writeHead(200, { 'content-type': 'application/xml-dtd' })
      response.end('<!ENTITY injected "SHOULD NEVER BE FETCHED">')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const { port } = server.address() as AddressInfo
    return { url: `http://127.0.0.1:${port}/external.dtd`, requests }
  }

  it('does not request a reachable SYSTEM identifier', async () => {
    const { url, requests } = await listeningDtdServer()

    const extraction = extractEpubDeterministically(
      await archiveWith(`<!DOCTYPE html SYSTEM "${url}">\n`),
    )

    expect(
      extraction.documents.flatMap((document) =>
        document.passages.map((passage) => passage.source_text),
      ),
    ).toContain('Retained.')
    // Give any stray asynchronous fetch a chance to arrive before asserting silence.
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(requests).toEqual([])
  })

  it('does not request a reachable PUBLIC identifier fallback', async () => {
    const { url, requests } = await listeningDtdServer()

    extractEpubDeterministically(
      await archiveWith(`<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "${url}">\n`),
    )

    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(requests).toEqual([])
  })

  it('does not resolve an entity that a reachable external DTD would have declared', async () => {
    const { url, requests } = await listeningDtdServer()

    // The document references an entity only the external DTD could define. If the parser fetched
    // the DTD, this would resolve; because it never does, the reference is an undefined entity.
    const archive = await archiveWith(`<!DOCTYPE html SYSTEM "${url}">\n`, '<p>&injected;</p>')
    expect(() => extractEpubDeterministically(archive)).toThrow(/malformed XML/)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(requests).toEqual([])
  })

  it('treats an unreachable external identifier as irrelevant rather than an error', async () => {
    // A closed port: if the parser tried to fetch, this would fail or hang instead of extracting.
    const extraction = extractEpubDeterministically(
      await archiveWith('<!DOCTYPE html SYSTEM "http://127.0.0.1:1/unreachable.dtd">\n'),
    )
    expect(
      extraction.documents.flatMap((document) =>
        document.passages.map((passage) => passage.source_text),
      ),
    ).toContain('Retained.')
  })
})
