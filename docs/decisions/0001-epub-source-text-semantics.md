# ADR 0001: EPUB parser spike and immutable source-text semantics

- Status: **Accepted for the spike; production adapter not yet implemented**
- Date: 2026-07-24
- Issue: #3

## Decision

Use a small, fail-closed EPUB adapter built from pinned parsing primitives rather than a
high-level reader library:

- `fflate@0.8.3` for ZIP access (MIT)
- `saxes@6.0.0` for strict XML/XHTML parsing (ISC)
- project-owned, versioned rules identified as `epub-source-text@2`

Rules v2 replaces the initial spike's v1 after cross-review; changed navigation, nested-root,
image, ZIP-validation, and ID semantics intentionally invalidate prior IDs and extraction hashes.

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
| `fflate@0.8.3` + `saxes@6.0.0` + rules v2 | fflate npm modified 2026-07-20/repository pushed 2026-05-16, MIT; saxes repository pushed 2025-12-31, ISC | Exact control of path validation, strict errors, decoded text-node partitioning, annotations, locators, versions, and audit findings | Selected. More project-owned rules must be tested and maintained; known gaps are listed below. |

The comparison harness hashes each candidate's actual ordered spine/TOC/chapter output and its
canonical accepted-or-rejected malformed outcome on two independent runs. The checked-in evidence
contains both run hashes and the actual error/outcome; its determinism result is not derived from a
summary projection.

A high-level parser may be reconsidered if it exposes unmodified resource bytes, has strict and
observable failures, and passes the same golden contract. Reader convenience APIs are not a
substitute for source-fidelity semantics.

## Exact `source_text` semantics (rules v2)

`source_text` is the immutable concatenation, in XML document order, of the **source-role decoded
text nodes owned by one passage root**. It is not `textContent`, rendered browser text, innerHTML,
or speech-ready text.

### Decode and parse

1. ZIP entry names are case-sensitive. Before reading the mimetype, container, manifest, or any
   referenced resource, every exposed ZIP entry name is validated. Empty names, POSIX/Windows
   absolute names, backslashes, NUL, and any `..` segment are errors even when the entry is
   unreferenced. Invalid percent escapes and referenced paths escaping the archive root are also
   errors.
2. Rules v2 accepts UTF-8 XML only. Invalid UTF-8 or another declared encoding is an error, not a
   replacement-character repair. UTF-16 support requires a later rule version.
3. XML 1.0 line-end handling applies before text events: CRLF and bare CR become LF. This is the
   only line-ending change and is part of the extraction semantics.
4. XML predefined references (`amp`, `lt`, `gt`, `quot`, `apos`) and valid decimal/hex numeric
   references are decoded once to Unicode. For example, `&amp;` becomes `&` and `&#x1F642;` becomes
   `🙂`. A custom entity, undeclared named HTML entity such as `&nbsp;`, malformed reference, or
   invalid scalar is a hard error. A non-breaking space can be authored as `&#160;`.
   A **well-formed bare `DOCTYPE`** — a name, optionally `SYSTEM` with one quoted literal or
   `PUBLIC` with two, and nothing else — is permitted and ignored. Any other declaration is a hard
   error, including one with an internal subset (`[ ... ]`) whatever it contains, an empty
   declaration, a dangling `SYSTEM`/`PUBLIC` keyword, trailing garbage, and a nested `<!` construct.
   The external identifier is never resolved. See
   [amendment 2026-07-25](#amendment-2026-07-25-doctype-with-no-internal-subset-is-permitted).
5. No NFC, NFD, NFKC, case, punctuation, smart-quote, compatibility, or grapheme normalization is
   performed. A decomposed `e` plus combining acute remains two Unicode scalar values.

### Passage boundaries and whitespace

Recognized passage roots are `address`, `aside`, `blockquote`, `dd`, `div`, `dt`, `figcaption`,
`figure`, `h1`–`h6`, `li`, `p`, `pre`, plus any element with `epub:type="pagebreak"`. A text node is
owned by its nearest recognized root. Nested roots become separate passages and are not copied
into their ancestor. If a passage root both owns non-whitespace text and contains another passage
root, rules v2 fails closed before extraction because one parent record would reorder text around
the child. Whitespace-only parent ownership remains ledger-only, allowing structures such as an
`aside` containing a `p`. Non-whitespace body text with no recognized owner is likewise a hard,
located `no passage root` error. Neither case is relabeled as layout or silently dropped; a future
rule may segment it only with adversarial ordering goldens.

Within a non-empty passage:

- every source-role space, tab, LF, NBSP, leading character, and trailing character is preserved;
- adjacent inline text nodes are concatenated with **no inserted separator**;
- `<br>` adds a zero-width annotation and does not invent an LF;
- paragraph/chapter boundaries are represented by separate ordered records; there is no canonical
  joined chapter string and no synthetic newline between records.

Whitespace-only text between passage roots is not story text. It is retained exactly in the
`text_ledger` with role `layout-whitespace`, not trimmed without evidence. Every text node inside
`script` and `style`, including whitespace-only nodes, is retained in the ledger as
`non-story-markup`. Ruby reading/fallback text is retained as
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

| Content | Rules v2 treatment |
| --- | --- |
| OPF metadata title and XHTML `<head><title>` | Stored as structural metadata, not body `source_text`. |
| EPUB 3 nav / NCX | Each source records `valid`, `missing`, `malformed`, or (for EPUB 2 without a nav item) `not-applicable`. Missing EPUB 3 nav and malformed declared navigation create distinct findings while valid spine text is retained. A valid NCX-only EPUB 2 is not a conflict. Only a valid navigation source whose shared spine references are genuinely out of spine order creates `navigation-spine-conflict`; conflict sources are named. A nav document in the spine is also extracted and flagged for review. |
| Body headings/titles | Retained as source passages. Equal headings at different locators are retained separately and reported as `duplicate-heading`; never deduplicated. |
| `em`, `i`, `strong`, `b` | Text remains in place. Nested half-open emphasis ranges are annotations; nesting does not duplicate text. |
| `ruby` | Ruby base is source text. `rt` reading and `rp` fallback are excluded from base text but retained exactly in a ruby annotation and ledger. This prevents spoken base/reading duplication without losing evidence. |
| Footnote references and bodies | Reference marker stays in source text with target annotation. A spine footnote body stays in order and receives a `footnote` hint. No automatic removal or reference/body deduplication occurs. Unlinked or non-spine notes remain a production-adapter risk. |
| Page breaks/running heads/feet | Text is retained. `epub:type="pagebreak"` and known class tokens (`running-head`, `running-foot`, `page-header`, `page-footer`) receive `page-furniture`; no automatic exclusion occurs. |
| Images/SVG `<image>` | A document-order traversal captures every body occurrence, including images outside recognized passage roots. It records exact `src`/`href`, exact decoded `alt` or null, locator, owning passage-root locator/offset when available, and explicit hints. An occurrence outside a passage root has null passage/offset, `outside-passage-root`, and `requires-review`. Attribute text is not invented as body `source_text`. A page with images and no passage text is independently `image-only` and `requires-review`. Binary bytes are not in source text. |
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
preimage beginning with `source-passage-id@1` and containing these explicitly named fields in this
fixed order:

1. `archive_parser` (`fflate` name/version),
2. `xml_parser` (`saxes` name/version),
3. `extraction_rules` name/version,
4. `publication_content_sha256`,
5. `locator`,
6. `source_text_sha256`.

The serializer reads each named property; it never uses object insertion order or
`Object.values`. A golden assertion builds the same identity with a different insertion order and
requires the same ID.

`extraction_sha256` hashes the complete deterministic extraction result, including the same
identity. Therefore a parser or rule upgrade cannot silently reuse old IDs/extraction hashes even
when visible text happens to match. The golden test also proves that changing only the rule
version changes passage IDs. Future manifests/databases must store all three version strings and
both hashes, not just an opaque ID.

## Golden evidence

The fixtures are original synthetic text dedicated to this repository; no book text is used.
Their readable source trees and deterministic `.epub` archives are under
`tests/fixtures/epub/`. The canonical builder writes every ZIP member with creator OS `3` (Unix),
regular-file mode `0100644` in the external attributes, and DOS local timestamp 2000-01-01
00:00:00. The date is constructed from local calendar components because fflate serializes local
getters; using a UTC instant would vary the ZIP bytes by runner timezone. Tests parse both local
headers and the central directory to assert these fields, in addition to retaining byte-identical
archive assertions.

`synthetic-complex.epub` covers:

- spine versus EPUB 3 nav/NCX conflicts;
- XML/numeric entities, a non-BMP scalar, decomposed Unicode, NBSP, tabs/LF and leading/trailing
  spaces;
- nested emphasis and ruby;
- duplicate headings, page furniture, footnote reference/body, image/alt text, an image-only page,
  and a loose image outside every passage root;
- whitespace-only `script`/`style`, low-text, ambiguous aside, and nonlinear side-story content.

Additional fixtures separate a valid EPUB 2 NCX-only publication, an EPUB 3 publication with
missing navigation, malformed EPUB 3 navigation with a still-readable spine, malformed story
XHTML, and a nested passage parent with text before/after its child. Unsafe unreferenced ZIP names
are injected into a valid synthetic archive in memory.

`packages/epub-spike/test/golden/synthetic-complex.json` records the complete ordered result,
including every text-ledger entry. `navigation-cases.json` locks all navigation statuses and
conflict behavior. `adversarial-errors.json` locks the nested-order and unsafe-ZIP fail-closed
errors. Tests run extraction five times, compare the entire result, assert an explicit ordered
passage list, prove source-ledger concatenation equals passage concatenation, check unique ledger
locators, test non-BMP scalar offsets, verify image/ambiguity retention, verify named ID
serialization, and require fail-closed malformed story behavior. `pnpm --filter
@light-novel-audiobook/epub-spike update:goldens` rebuilds every EPUB before regenerating all three
goldens.

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
- recovery policy for malformed but readable package/story XHTML (rules v2 fails closed there;
  malformed optional navigation is retained as an error finding). Any repair must create an
  audited derived artifact, never silently repair source;
- adversarial/fuzz/property tests and larger permissively licensed EPUB conformance fixtures.

The spike's `fflate` object API also cannot by itself prove that duplicate ZIP central-directory
names were not collapsed. Production must scan and reject duplicates before constructing the
entry map. These are unresolved risks, not permission to silently normalize or omit content.

## Production follow-up

Issue #28 promoted the unchanged rules-v2 text traversal into `packages/epub-ingestion`. The
production-small adapter now scans the ZIP central/local records before `fflate` map construction,
rejects duplicate/case-colliding names, symlinks, ZIP/encryption.xml encryption, ZIP64, unsupported
compression, and configured size/ratio excesses, and verifies decompressed sizes and CRCs. XML
bytes, decoded characters, nodes, depth, and per-element attributes are bounded. It preserves
structured title/creator refinements, validates declared cover media against raster/SVG bytes, and
uses a two-phase, fsynced external-workspace commit that rejects child-path symlink escapes. The
issue #29 adapter maps only non-empty spine documents to one-based domain Chapters; zero-passage
items remain explicit audited non-story documents. The broader uncommon-EPUB and visual/CSS
semantics listed above remain review or future-format gates; the adapter continues to fail closed
where it cannot preserve source semantics.

## Amendment 2026-07-25: `DOCTYPE` with no internal subset is permitted

- Issue: #41 (P0 bug)
- Amends: decode-and-parse rule 4
- Rules version: unchanged, still `epub-source-text@2` — see "Why the rules version is not bumped"

### What changed

Rule 4 previously made *any* `DOCTYPE` a hard error. It now accepts only a **positively recognised
bare `doctypedecl`**: `S Name (S ExternalID)? S?`, where `ExternalID` is `SYSTEM` with one quoted
literal or `PUBLIC` with two. Anything else is rejected, including an internal subset (`[ ... ]`) in
any form, an empty declaration, a dangling `SYSTEM`/`PUBLIC` keyword, trailing garbage, and a nested
`<!` construct. Everything else rule 4 rejected is still rejected: `<!ENTITY` declarations,
undeclared named entities such as `&nbsp;`, malformed references, and invalid scalars.

Recognition is deliberately a whitelist. `saxes` reports a declaration's text without validating the
whole `doctypedecl` grammar, so a detector that merely looked for known-bad markers would let
malformed declarations through. `<!DOCTYPE html <!ENTITY x "value">` is the concrete case: it
contains no `[`, and the `>` closing the inner construct also ends the declaration, so a
"contains a subset delimiter" test finds nothing to object to while an `<!ENTITY`-shaped declaration
passes the rule meant to reject it. Whitelisting the good shape fails closed on that whole family.

### Why

The original rule was written to stop XXE and entity-expansion ("billion laughs") attacks.

Entity expansion requires *declared* entities, and with no fetched external DTD the only place to
declare them is an internal subset. XXE, however, does **not** require an internal subset: a bare
`SYSTEM` or `PUBLIC` declaration names an external DTD that could itself declare an entity, and
`&that;` would resolve in a parser that fetched it. So rejecting internal subsets is **not by itself
sufficient**, and this amendment does not claim otherwise. What makes a bare `DOCTYPE` safe here is
the separate, verified property that the parser never resolves the external identifier — see "Why
this is safe" below. Internal subsets remain rejected as defence in depth.

Rejecting the *declaration line* as well was over-broad, and it is what made the adapter unable to
read the real book measured below.

Measured against one real commercial EPUB 2.0 light novel (19,060,624 bytes; not committed, and
gitignored under `/ebooks/`):

| Measure | Value |
| --- | --- |
| Markup documents in the archive | 24 |
| Documents carrying a `DOCTYPE` | **22** |
| Distinct `DOCTYPE` forms | 2 |
| Documents with an internal subset (`[ ... ]`) | **0** |
| `<!ENTITY` declarations anywhere | **0** |
| Undeclared named entities | **0** |
| Numeric character references | 190 decimal, 0 hex |
| Predefined named references | 4 (`&quot;`) |

Both forms are standards boilerplate rather than publication content: the XHTML 1.1 public
identifier on 21 content documents, and the NCX 2005-1 public identifier on the navigation document.
A staged experiment on in-memory copies isolated the cause: unmodified archive → rejected; with only
the `DOCTYPE` declarations removed → extracted successfully. So the declaration was the sole blocker
and the threat it was guarding against was absent.

### Why this is safe

Permitting a bare `DOCTYPE` is only safe if the parser never resolves the external identifier it
names. That is verified rather than assumed, in `packages/epub-ingestion/test/doctype-rule.test.ts`:

- `saxes@6.0.0`'s dependency closure is `saxes → xmlchars → (none)`; neither module references any
  network or filesystem API, so it has no means to fetch a DTD.
- A local HTTP server is started, a `DOCTYPE`'s `SYSTEM` identifier is pointed at it, extraction is
  run, and the server must observe **zero** requests. The same is asserted for a `PUBLIC`
  identifier's system fallback.
- A document referencing an entity that only the served external DTD could declare fails as an
  undefined entity, proving the DTD was not consulted rather than merely not logged.
- An unreachable external identifier extracts normally instead of erroring or hanging, which a
  fetching parser could not do.

`saxes` additionally does not act on `<!ENTITY` declarations inside an internal subset at all: a
reference to such an entity is reported as an undefined entity. Internal subsets are still rejected
outright, so that behaviour is defence in depth rather than the thing being relied on.

### Detection detail

The internal-subset test strips quoted spans before looking for `[`. The subset delimiter is always
outside quotes, whereas a `SYSTEM` identifier may legitimately contain one — an IPv6 host literal
such as `http://[::1]/x.dtd`. A `[` cannot occur in a `PUBLIC` identifier, because the XML
`PubidChar` production excludes it.

### Why the rules version is not bumped

`extraction_rules` stays `epub-source-text@2`, and the identity guarantee is not weakened.

The rule change only *widens the set of accepted inputs*. For every input that was accepted under
the previous wording, extraction is byte-identical: documents without a `DOCTYPE` parse exactly as
before, and the `DOCTYPE` event is ignored where it is now permitted. No previously-accepted
publication changes its passages, locators, hashes, or IDs, so those IDs must stay the same — a bump
would falsely signal that stored records had become stale.

The versioning requirement exists so that outputs produced under different rules cannot be confused
when they could differ. Here they cannot differ: the overlap between the old and new accepted sets is
exactly identical, and inputs newly accepted have no prior extraction to be confused with.

The evidence does not establish that the previous wording rejected *every* real EPUB, and this
amendment does not claim it did. A valid publication carrying no `DOCTYPE` always took the accepted
path, exactly as the committed synthetic fixtures do. What was measured is narrower: the one
commercial EPUB 2.0 book tested was rejected, 22 of its 24 markup documents carry a boilerplate
`DOCTYPE`, and both forms are near-universal in EPUB 2 — so the false positive should be expected to
be common for that generation of publication rather than universal across all real input.
