# Representative corpus governance and gold scoring

This harness is an offline evaluator, not a model client or production pipeline. It scores three
already-recorded director runs against a locked representative corpus. It never downloads a book,
starts llama.cpp, changes annotations, or chooses a fallback model.

## Corpus selection policy (`representative-selection@1`)

Select one contiguous, representative chapter or chapter-sized excerpt only after EPUB extraction
under the accepted source semantics in
[`ADR 0001`](../decisions/0001-epub-source-text-semantics.md). Preserve spine order and immutable
passage IDs, locators, extraction identity, and Unicode-scalar offsets. Do not select only easy
examples. The corpus must include at least one case tagged for every dimension below:

- spoken dialogue, narration, and internal thought;
- aliases and pronoun/other coreference requiring canonical-character resolution;
- genuinely ambiguous or unresolved speakers;
- structurally ambiguous content retained by extraction for review;
- repeated text at different source references; and
- multiple scored spans that refer to one source passage.

Record the rationale before observing model results. Keep all legitimate mature-content passages in
the refusal denominator. Cases partition every selected source passage exactly: no gap, overlap,
normalization, synthetic separator, or text-based deduplication is allowed. Selection should be
reviewed for a mix of short and long turns, scene transitions, recurring and one-off characters,
and both explicit and distant attribution. The synthetic analogue is only a scorer contract; it is
not evidence that a real chapter is representative.

Gold annotation uses `gold-annotation-policy@1`. A second reader should adjudicate disagreements
without seeing model output. Exact speaker labels contain one canonical character ID. Alias and
coreference evidence are marked separately. If the source does not justify one speaker, label the
case `ambiguous` or `unresolved`; never force a convenient gold answer.

## Data governance

Only the original project-authored synthetic analogue under
`packages/scoring-harness/test/fixtures/` may be committed. It is dedicated under CC0-1.0 and
contains no personal data. Real EPUB content, extracted source, selection manifests, gold labels,
model outputs, and reports belong under `${workspace.root}/evaluation/` (or another explicitly
configured external workspace), never in this repository. Use `storage_class: workspace_private`
and source provenance `redistribution: workspace_only` for those files. The scorer rejects a
private source described as committed synthetic.

Before creating a private corpus, record lawful provenance, the permitted evaluation use, who can
access it, and whether it contains personal data. Use opaque source/case/character IDs; omit title,
author, annotator names, and free-text excerpts from reports. Restrict workspace permissions and
backups. Do not upload private fixtures to hosted CI, issue attachments, chat, or artifact stores.

Delete a private evaluation set by removing its source, corpus, annotations, runs, reports, and
backups from the external workspace, then verify no copies exist in logs or CI caches. Retain only
non-reversible aggregate results when the source licence permits it. A hash proves identity; it is
not permission to redistribute and should also be deleted if local policy treats it as sensitive.
Git history is not a deletion mechanism, so private data must never enter Git.

## Versioned inputs and hashes

The authoritative JSON Schemas are in `schemas/evaluation/`:

| Document | Schema version | Purpose |
| --- | --- | --- |
| source | `evaluation-source@1` | Exact selected passage text, ADR extraction identity, provenance, source references, and per-passage hashes |
| corpus | `representative-corpus@1` | Predeclared selection rationale, source spans, legitimacy, and required coverage tags |
| annotations | `gold-annotations@1` | Kind, canonical speaker, evidence class, and ambiguity adjudication |
| run | `evaluation-run@1` | One run's model/prompt/schema identity, parameters, predictions, time, memory, and failure outcome |
| report | `evaluation-report@1` | Text-free identities, counts, metric decisions, resource summaries, and sanitized findings |

All SHA-256 document identities use UTF-8 canonical JSON with recursively sorted object keys and
preserved array order. Whitespace and object insertion order do not affect a hash; array order and
all values do. `source_sha256` hashes the complete validated source document, including exact text
and extraction identity. The corpus locks that source hash. Annotations lock both source and corpus
hashes. Runs lock source and corpus hashes. The report records source, corpus, annotation, input-run,
and configuration hashes.

`scorer_sha256` hashes the canonical `SCORER_POLICY` object in
`packages/scoring-harness/src/scorer-policy.ts`; `scorer_version` identifies the implementation
contract. A policy or semantic scoring change requires a new scorer version and regenerated gold
report. Source, corpus, annotation, extraction-rule, prompt, output-schema, adapter, and model
versions are independent and must not be conflated.

Offsets are zero-based, half-open Unicode scalar values as defined by ADR 0001. Accuracy joins use
`(source_ref, source_start, source_end)`, never story text. This is why identical sentences and
repeated references remain separate observations.

## Ambiguity and denominator policy

`exclude-speaker-accuracy-require-review@1` applies:

- exact, adjudicated dialogue speakers are eligible for speaker accuracy;
- exact dialogue cases whose evidence is `alias` or `coreference` are also eligible for the
  alias/coreference metric;
- ambiguous/unresolved speakers are excluded from both point-accuracy denominators because no
  single answer is known, but every run must flag them for review;
- ambiguity remains in refusal, exact coverage, schema, and three-run-agreement denominators;
- incorrect-speaker review recall includes only demonstrably wrong predictions on exact speaker
  gold; ambiguous cases cannot be called incorrect;
- when there are no incorrect exact-speaker predictions, recall is reported as `0/0`, rate
  `1.000000`, and passes vacuously. The zero denominator remains visible.

Each metric reports a numerator, policy denominator, observed denominator, six-decimal display
rate, exact rational threshold, and pass/fail decision. Threshold comparisons use integer cross
multiplication, not rounded display values. Missing, refused, duplicated, malformed, or
wrong-corpus observations do not shrink fixed denominators; incomplete observability fails closed.

| Report metric | Numerator / denominator | Locked threshold |
| --- | --- | --- |
| `schema_validity` | valid expected run slots / 3 | 100% |
| `exact_source_coverage` | passage-runs partitioned once with exact scalar slices / selected passages × 3 | 100% |
| `dialogue_speaker_accuracy` | exact canonical speakers / exact-speaker dialogue cases × 3 | at least 95% |
| `alias_coreference_accuracy` | exact canonical speakers / alias-or-coreference exact dialogue cases × 3 | at least 95% |
| `thought_vs_spoken_accuracy` | exact kind / gold dialogue-or-thought cases × 3 | at least 98% |
| `incorrect_speaker_review_recall` | wrong exact-speaker predictions flagged / all wrong exact-speaker predictions | at least 90% |
| `refusal_rate` | refusals / legitimate cases × 3 | 0% |
| `three_run_agreement` | cases where all three runs have the same joint `(speaker, kind)` / all cases | at least 95% |
| `elapsed_time_within_limit` | runs at or below 3,600,000 ms / 3 | 100% |
| `vram_within_limit` | runs at or below 15,872 MiB (15.5 GiB) / 3 | 100% |
| `ram_within_limit` | runs at or below 61,440 MiB (60 GiB) / 3 | 100% |
| `operational_success` | runs with neither crash nor OOM / 3 | 100% |
| `context_size_configuration` | runs at the initial 32,768-token context / 3 | 100% |

The harness additionally requires identical recorded model, adapter, prompt, output schema, seed,
context, and parameter configurations across exactly three runs, plus 100% review flags on
ambiguous/unresolved speakers. Peak memory values must come from the same documented measurement
method for every run. MiB means 1,048,576 bytes. Elapsed time covers complete chapter direction,
not setup omitted selectively between runs.

## Run the synthetic analogue

Rebuild fixtures only when intentionally changing their versioned contract:

```sh
pnpm --filter @light-novel-audiobook/scoring-harness build:fixtures
pnpm --filter @light-novel-audiobook/scoring-harness generate:schemas
```

Score immutable inputs into a new report path (the CLI refuses to overwrite):

```sh
pnpm --filter @light-novel-audiobook/scoring-harness score -- \
  --source packages/scoring-harness/test/fixtures/source.json \
  --corpus packages/scoring-harness/test/fixtures/corpus.json \
  --annotations packages/scoring-harness/test/fixtures/annotations.json \
  --runs packages/scoring-harness/test/fixtures/run-1.json \
         packages/scoring-harness/test/fixtures/run-2.json \
         packages/scoring-harness/test/fixtures/run-3.json \
  --output /tmp/synthetic-evaluation-report.json
```

Reports contain hashes, aggregate counts, numeric resource measurements, opaque 16-hex unit keys,
and sanitized error paths only. They never contain source text, locators, gold character IDs,
predicted text, refusal explanations, or input paths. Treat a private report as private anyway:
hashes and aggregate behavior may still be sensitive.
