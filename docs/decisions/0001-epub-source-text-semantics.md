# ADR 0001: EPUB parser spike and immutable source-text semantics

- Status: **Accepted for the spike; production adapter not yet implemented**
- Date: 2026-07-24
- Issue: #3

## Decision

Use a small, fail-closed EPUB adapter built from pinned parsing primitives rather than a
high-level reader library:

- `fflate@0.8.3` for ZIP access (MIT)
- `saxes@6.0.0` for strict XML/XHTML parsing (ISC)
- project-owned, versioned rules identified as `epub-source-text@1`

This combination is the selected **approach**, not production ingestion. The spike implementation
is in `packages/epub-spike`; it deliberately does not connect to the domain model, persistence,
or the review application.

The spine is the only authority for audiobook reading order. EPUB 3 navigation and NCX order are
retained as evidence. A disagreement creates a finding and never reorders the spine.

## Candidate comparison

Maintenance data was observed on 2026-07-24 using `pnpm view` and `gh repo view`. Runtime results
are reproducible with `pnpm --filter @light-novel-audiobook/epub-spike compare`; the checked-in
output is [`docs/evidence/epub-parser-comparison.json`](../evidence/epub-parser-comparison.json).

| Candidate | Maintenance/licence evidence | Useful behavior | Rejection reason |
| --- | --- | --- | --- |
| `@lingo-reader/epub-parser@0.4.6` | npm modified 2026-04-06; `hhk-png/lingo-reader` pushed 2026-04-06; MIT; TypeScript declarations and Node export | Repeatedly returned correct spine and NCX order | Exposes transformed body markup, not raw XHTML; rewrites links/image paths; accepted the malformed XHTML fixture. Its reader-oriented resource extraction is the wrong fidelity boundary. |
| `epub2@3.0.2` | npm modified 2023-09-20; `bluelovers/ws-epub` pushed 2024-07-28; npm package says ISC; TypeScript declarations | Repeatedly returned correct spine/NCX order and byte-for-byte raw chapter XHTML | Older callback/Bluebird design and broad dependency tree. The malformed chapter failed later as `File not found`, not as a structural XHTML error. It does not define our text, ruby, or offset semantics. |
| `epubjs@0.3.93` | npm modified 2023-09-26; repository pushed 2026-03-24; BSD-2-Clause package | Mature rendering ecosystem and EPUB CFI support | Desk-review rejection: a browser reader/rendering engine (including storage/rendering concerns), approximately 6.4 MB unpacked, not a deterministic Node ingestion boundary. It was not run in the Node harness. |
| `fflate@0.8.3` + `saxes@6.0.0` + rules v1 | fflate npm modified 2026-07-20/repository pushed 2026-05-16, MIT; saxes repository pushed 2025-12-31, ISC | Exact control of path validation, strict errors, decoded text-node partitioning, annotations, locators, versions, and audit findings | Selected. More project-owned rules must be tested and maintained; known gaps are listed below. |

A high-level parser may be reconsidered if it exposes unmodified resource bytes, has strict and
observable failures, and passes the same golden contract. Reader convenience APIs are not a
substitute for source-fidelity semantics.

## Exact `source_text` semantics (rules v1)

`source_text` is the immutable concatenation, in XML document order, of the **source-role decoded
text nodes owned by one passage root**. It is not `textContent`, rendered browser text, innerHTML,
or speech-ready text.

### Decode and parse

1. ZIP entry names are case-sensitive. Absolute paths, backslashes, invalid percent escapes, and
   paths escaping the archive root are errors.
2. Rules v1 accepts UTF-8 XML only. Invalid UTF-8 or another declared encoding is an error, not a
   replacement-character repair. UTF-16 support requires a later rule version.
3. XML 1.0 line-end handling applies before text events: CRLF and bare CR become LF. This is the
   only line-ending change and is part of the extraction semantics.
4. XML predefined references (`amp`, `lt`, `gt`, `quot`, `apos`) and valid decimal/hex numeric
   references are decoded once to Unicode. For example, `&amp;` becomes `&` and `&#x1F642;` becomes
   `🙂`. A DOCTYPE, custom entity, undeclared named HTML entity such as `&nbsp;`, malformed reference,
   or invalid scalar is a hard error. A non-breaking space can be authored as `&#160;`.
5. No NFC, NFD, NFKC, case, punctuation, smart-quote, compatibility, or grapheme normalization is
   performed. A decomposed `e` plus combining acute remains two Unicode scalar values.

### Passage boundaries and whitespace

Recognized passage roots are `address`, `aside`, `blockquote`, `dd`, `div`, `dt`, `figcaption`,
`figure`, `h1`–`h6`, `li`, `p`, `pre`, plus any element with `epub:type="pagebreak"`. A text node is
owned by its nearest recognized root. Nested roots become separate passages and are not copied
into their ancestor. Non-whitespace body text with no recognized owner is a hard, located
`no passage root` error in rules v1; it is never relabeled as layout or silently dropped. A later
rule may support such mixed body content only with an ordering golden test.

Within a non-empty passage:

- every source-role space, tab, LF, NBSP, leading character, and trailing character is preserved;
- adjacent inline text nodes are concatenated with **no inserted separator**;
- `<br>` adds a zero-width annotation and does not invent an LF;
- paragraph/chapter boundaries are represented by separate ordered records; there is no canonical
  joined chapter string and no synthetic newline between records.

Whitespace-only text between passage roots is not story text. It is retained exactly in the
`text_ledger` with role `layout-whitespace`, not trimmed without evidence. Text in `script` and
`style` is retained in the ledger as `non-story-markup`. Ruby reading/fallback text is retained as
`ruby-annotation`. Thus every decoded XHTML body text node has one ledger role, while every
source-role node appears once in `source_text`.

The extractor deep-freezes its result. `source_text_sha256` is SHA-256 over the UTF-8 encoding of
the decoded string. Any later speech normalization must create separately mapped `render_text`;
it must never edit `source_text`.

## Unicode offsets

All annotation offsets are zero-based, half-open `[start, end)` counts of **Unicode scalar values
(code points)** in decoded `source_text`.

They are not UTF-8 bytes, UTF-16 code units, user-perceived grapheme clusters, or DOM indices.
Callers in JavaScript must slice through `Array.from(source_text)`, not `String.prototype.slice`.
Consequently `🙂` counts as one, while decomposed `e` + combining acute counts as two. The offset
unit literal `unicode-scalar-value` is stored beside annotations and at extraction-result level.

## Structure and content treatment

Nothing in this table is silently deleted from a spine item. Hints are proposed classifications;
a later reviewed ingestion workflow decides whether content is rendered.

| Content | Rules v1 treatment |
| --- | --- |
| OPF metadata title and XHTML `<head><title>` | Stored as structural metadata, not body `source_text`. |
| EPUB 3 nav / NCX | Parsed outside the story stream as labels/order evidence. Spine remains authoritative; conflicts are findings. A nav document in the spine is extracted like any other spine document and flagged `navigation-document` plus `requires-review`. |
| Body headings/titles | Retained as source passages. Equal headings at different locators are retained separately and reported as `duplicate-heading`; never deduplicated. |
| `em`, `i`, `strong`, `b` | Text remains in place. Nested half-open emphasis ranges are annotations; nesting does not duplicate text. |
| `ruby` | Ruby base is source text. `rt` reading and `rp` fallback are excluded from base text but retained exactly in a ruby annotation and ledger. This prevents spoken base/reading duplication without losing evidence. |
| Footnote references and bodies | Reference marker stays in source text with target annotation. A spine footnote body stays in order and receives a `footnote` hint. No automatic removal or reference/body deduplication occurs. Unlinked or non-spine notes remain a production-adapter risk. |
| Page breaks/running heads/feet | Text is retained. `epub:type="pagebreak"` and known class tokens (`running-head`, `running-foot`, `page-header`, `page-footer`) receive `page-furniture`; no automatic exclusion occurs. |
| Images/SVG `<image>` | An occurrence records exact `src`/`href`, exact decoded `alt` or null, locator, and source scalar offset. Attribute text is not invented as body `source_text`. A page with images and no passage text is `image-only` and `requires-review`. Binary bytes are not in source text. |
| Low-text sections | Retained and flagged when a non-furniture passage has at most one trimmed scalar. |
| `linear="no"`, side stories, and ambiguous `<aside>` content | Retained in spine position and marked `requires-review`; never assumed irrelevant. |
| Duplicate spine references | Each occurrence would have its own spine occurrence locator and text records. No deduplication by manifest ID or text hash. |

CSS (`display:none`, pseudo-element content), JavaScript, visual order, and generated browser text do
not change source text. Production policy must surface cases where CSS could alter meaning.

## Stable locators, IDs, and hashes

A passage locator has this exact shape:

```text
spine[0003]::EPUB/chapter.xhtml::/html[1]/body[1]/p[2]
```

- spine index is the zero-based occurrence in OPF order, padded to four digits;
- archive path is normalized, package-relative, case-preserving, and has no fragment;
- element steps use authored qualified names and one-based same-name sibling indices;
- text-ledger locators append `/text()[n]`, where `n` is the one-based text-node sibling index after
  adjacent SAX text callbacks have been coalesced.

This is a project locator, not an EPUB CFI. It is stable for identical publication content and
versions; an upstream structural edit is expected to change it.

`publication_content_sha256` hashes sorted `(archive path, NUL, uncompressed bytes, NUL)` tuples,
so ZIP compression level/timestamps do not change publication identity. Passage IDs hash a tagged
preimage containing all of:

1. `fflate` archive-parser name/version,
2. `saxes` XML-parser name/version,
3. extraction-rule name/version,
4. publication content hash,
5. full locator,
6. source-text hash.

`extraction_sha256` hashes the complete deterministic extraction result, including the same
identity. Therefore a parser or rule upgrade cannot silently reuse old IDs/extraction hashes even
when visible text happens to match. The golden test also proves that changing only the rule
version changes passage IDs. Future manifests/databases must store all three version strings and
both hashes, not just an opaque ID.

## Golden evidence

The fixtures are original synthetic text dedicated to this repository; no book text is used.
Their readable source trees and deterministic `.epub` archives are under
`tests/fixtures/epub/`.

`synthetic-complex.epub` covers:

- spine versus EPUB 3 nav/NCX conflicts;
- XML/numeric entities, a non-BMP scalar, decomposed Unicode, NBSP, tabs/LF and leading/trailing
  spaces;
- nested emphasis and ruby;
- duplicate headings, page furniture, footnote reference/body, image/alt text and image-only page;
- low-text, ambiguous aside, and nonlinear side-story content.

`synthetic-malformed.epub` has mismatched XHTML tags. The selected approach rejects it at the
resource path with a structural XML error.

`packages/epub-spike/test/golden/synthetic-complex.json` records the complete ordered result,
including every text-ledger entry. Tests run extraction five times, compare the entire result,
assert an explicit ordered passage list, prove source-ledger concatenation equals passage
concatenation, check unique ledger locators, test non-BMP scalar offsets, verify ambiguity
retention, and require fail-closed malformed behavior.

## Known limitations and production gates

Before this approach becomes production ingestion, resolve or explicitly review:

- ZIP bomb limits, maximum entry/count/ratio limits, CRC enforcement, duplicate entry names,
  case-colliding names, symlinks, and encrypted/obfuscated resources;
- UTF-16 XML and legal encoding/BOM combinations;
- multiple rootfiles/renditions, fallback chains, remote resources, media overlays, scripted
  content, SVG text, MathML, tables, verse, and uncommon EPUB semantic vocabulary;
- non-spine footnotes/popups and robust backlink pairing;
- CSS-hidden text, generated content, visual reordering, and image OCR/meaning;
- locator behavior under XML namespace aliases and compatibility with EPUB CFI tooling;
- recovery policy for malformed but readable real-world EPUBs (rules v1 intentionally fails
  closed; a repair must create an audited derived artifact, never silently repair source);
- adversarial/fuzz/property tests and larger permissively licensed EPUB conformance fixtures.

The spike's `fflate` object API also cannot by itself prove that duplicate ZIP central-directory
names were not collapsed. Production must scan and reject duplicates before constructing the
entry map. These are unresolved risks, not permission to silently normalize or omit content.
