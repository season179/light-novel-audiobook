# Gemma Director adapter

Focused M1 `DirectorModel` adapter for issue #30. It connects TanStack AI's OpenAI-compatible
adapter to the selected loopback llama.cpp profile and does not add another benchmark or provider
framework.

## Contract and safety

- The selected model ID/revision/SHA, seed 42, temperature 0, top-p 1, and schema/prompt versions
  are fixed in `src/profile.ts`.
- The model receives exact passage IDs/text and may only classify or annotate them.
- Zod constrains the wire response. A separate deterministic validator rejects malformed output,
  omission, duplicate passage IDs, invented passage/speaker IDs, reorder, text changes, and
  inconsistent narrator/fallback semantics.
- Unresolved dialogue/thought/message speakers use the configured fallback ID and produce a
  `reviewRequired` warning rather than failing the chapter.
- Every run writes text-free progress and safe terminal errors through `DirectorProgressStore`.
  Caller cancellation and deadlines abort TanStack AI's request.
- The endpoint is server-side only and accepts only `http://127.0.0.1:<port>/v1`.

The package intentionally does not claim representative Gemma accuracy. The existing issue #6
evidence says representative accuracy was not assessed. This adapter's normal tests use only its
fake endpoint; no GPU inference runs in `pnpm check` or `pnpm build`.

## Issue #29 integration seam

This package owns a minimal framework-independent `DirectorModel` port while issue #29 contracts
are being finalized. Integration should map issue #29 `SourcePassage.id/sourceText` into
`DirectorSourcePassage`, then map each accepted result into its `DirectedSegment`. A fallback
speaker maps to issue #29's unresolved/null speaker plus fallback warning/voice assignment. The
application must run issue #29's exact-coverage invariant again at that boundary and back
`DirectorProgressStore` with the SQLite job/event repository. No domain package dependency is
needed in this adapter.

## Portable fake-endpoint contract tests

```sh
pnpm --filter @light-novel-audiobook/gemma-director test
```

## Opt-in real smoke (do not run during normal checks)

`config/real-smoke.json` contains only the public selected profile, loopback URL, external runtime
location, and timeout. It has no secret, private text, or user-specific absolute path. The command
requires the already-running standard llama.cpp server to expose the selected profile alias and
the installed issue #6 runtime, binary, and complete model bytes to match their pinned manifest,
size, and SHA-256. Its two source passages
are synthetic/public, and stdout contains only counts, classifications, hashes, and progress
states—never source text, API keys, provider bodies, or absolute paths.

After an orchestrator starts that local server on `127.0.0.1:8080` with its server-side key, run
exactly:

```sh
GEMMA_DIRECTOR_REAL_SMOKE=1 \
GEMMA_DIRECTOR_API_KEY="$(<"$GEMMA_DIRECTOR_API_KEY_FILE")" \
pnpm --filter @light-novel-audiobook/gemma-director smoke:real
```

For a separately installed runtime/config, use sanitized overrides:

```sh
GEMMA_DIRECTOR_REAL_SMOKE=1 \
GEMMA_DIRECTOR_API_KEY="$(<"$GEMMA_DIRECTOR_API_KEY_FILE")" \
GEMMA_DIRECTOR_RUNTIME_ROOT="$HOME/.cache/light-novel-audiobook/issue-6-brain" \
pnpm --filter @light-novel-audiobook/gemma-director smoke:real -- \
  --config packages/gemma-director/config/real-smoke.json
```
