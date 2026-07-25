# EPUB ingestion adapter

This package is the deterministic M1 EPUB boundary. It promotes the extraction rules proven in
`packages/epub-spike` and adds bounded ZIP/XML validation, metadata/cover extraction, stable
book/chapter mapping, exclusion audit records, and atomic external-workspace storage.

## Boundary

`EpubIngestionAdapter.ingest()` accepts uploaded bytes and returns `StoredEpubIngestion`. It does
not call Gemma or normalize story text. `DomainEpubExtractor` concretely implements issue #29's
`EpubExtractor` port and maps the ingestion record to `Book`, `Chapter`, and `SourcePassage`.

Callers must provide both an existing, external, non-symlink `workspaceRoot` and the active
`repositoryRoot`. The adapter rejects a workspace inside the Git worktree and rejects symlink or
containment escapes at `.staging`, `books`, each staging book, the stable book target, and stored
files. A completed import has this layout:

```text
<workspace>/books/<stable-book-id>/
  book.json
  source.epub
  cover.<validated-source-extension>   # when declared by the EPUB
```

Files are fsynced under a private staging directory. The directory is renamed into place with only
`book.pending.json`; `book.json` is atomically exposed only after the target rename is durable, and
the target directory is then fsynced. Failures before that final sync remove the commit marker and
roll back the target. Concurrent identical imports converge on the same hash-verified record.

Malformed or unsupported input is fully extracted and validated before staging starts. Existing
content-addressed records are hash-checked instead of overwritten. ZIP/XML complexity limits,
entry CRCs, duplicate/case-colliding names, and encrypted/obfuscated resources fail closed.

A cover is decorative rather than story content, so it does not fail closed: a cover that is
damaged, structurally invalid, or of an unsupported media type is dropped, the book is still
ingested, and `audit.findings` gains an `unusable-cover` entry naming the archive path. Losing an
entire light novel over one bad trailing byte in a JPEG is the worse outcome. The finding is
persisted but not yet surfaced through the domain mapper or a review queue.

Every extracted source passage is retained. A spine document with no source passages is not made
into an invalid empty domain `Chapter`; it remains in `audit.nonStoryDocuments` with its one-based
spine position, locator, title provenance, images, hints, and reason. Layout whitespace, ruby
readings/fallbacks, and script/style text that do not become `sourceText` have exact text, hash,
locator, rule identity, and reason in `audit.textExclusions`. Ambiguous content is retained and
surfaced through hints/findings rather than excluded.
