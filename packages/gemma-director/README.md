# Gemma Director adapter

Focused M1 implementation of issue #29's application `DirectorModel` contract for issue #30. It
connects TanStack AI's OpenAI-compatible adapter to the selected loopback llama.cpp/Gemma profile;
it does not add another benchmark or provider framework.

## Contract and safety

- `GemmaDirectorModel` implements `directChapter(Book, Chapter): Promise<DirectedChapter>` and
  maps directly to issue #29 domain `DirectedSegment` values.
- A required `DirectorContextProvider` supplies story-bible/cast context that is intentionally not
  stored on the domain `Book`.
- A required `DirectorRuntimeLifecycle` owns or delegates model shutdown. `release()` first cancels
  and settles active direction calls, invokes lifecycle release exactly once, and is safe to call
  repeatedly. Calls after release fail closed.
- The selected model ID/revision/SHA, seed 42, temperature 0, top-p 1, maximum tokens, prompt, and
  schema versions are fixed. The configured confidence threshold is included in adapter identity
  and every concrete result.
- The model receives exact passage IDs/text. It may return multiple ordered fragments per passage,
  allowing narration/dialogue/thought changes inside a paragraph. Every fragment carries inclusive
  `source_start` and exclusive `source_end` UTF-16 offsets.
- Zod constrains the wire response. Separate deterministic validation rejects malformed output,
  unknown passages/speakers, gaps, overlaps, duplicate ranges, invalid ranges, passage/fragment
  reorder, text changes, and trailing omissions. Issue #29's `ExactSourceCoverage` validates the
  mapped fragments again at the application boundary.
- Explicit unresolved speakers and known-speaker assignments below the configured threshold map to
  domain `speakerId: null`, forcing issue #29 fallback voice semantics. The concrete result also
  exposes review-required warnings with source ranges, candidate speaker, confidence, and threshold.
- Every run writes text-free progress and safe terminal errors through `DirectorProgressStore`.
  Caller cancellation, release cancellation, and deadlines abort TanStack AI's request.
- The endpoint is server-side only and accepts only `http://127.0.0.1:<port>/v1`.

The package intentionally does not claim representative Gemma accuracy. Existing issue #6 evidence
says representative accuracy was not assessed. Normal tests use only a fake endpoint; no GPU
inference runs in `pnpm check` or `pnpm build`.

## Tests

```sh
pnpm --filter @light-novel-audiobook/gemma-director test
```

The contract suite covers the real issue #29 port, exact split-fragment mapping, confidence fallback,
schema/request shape, malformed and transport failures, progress, cancellation, release ordering and
idempotence, and source-fidelity attacks. Separate smoke-safety tests reject substituted process
identity, model argv, PID/listener binding, unsafe Origin/fetch-metadata responses, CORS permission,
and inference-slot occupation.

## Opt-in owned real smoke (do not run during normal checks)

`config/real-smoke.json` contains only public profile settings, loopback URL, external runtime
location, confidence threshold, and deadlines. The command does **not** trust an existing endpoint:
it refuses an occupied port, hashes the complete installed GGUF and binary, creates an ephemeral
mode-`0600` API-key file, and launches the verified binary itself with the verified model path. It
then proves `/proc/<pid>/exe`, exact process argv, and the sole `ss` loopback listener/PID all match
that owned process before making any inference claim.

Before direction, the smoke sends authenticated POSTs carrying an attacker `Origin` and
`Sec-Fetch-Site: cross-site`; both must receive 401/403 despite the valid server key, receive no
CORS permission, and never occupy the inference slot. The pinned bare llama.cpp server may fail
this production-boundary gate; that is a truthful failed smoke, not successful evidence. If the
gate passes, it directs only two public synthetic passages. Stdout contains sanitized
counts, classifications, hashes, ownership/browser-boundary results, and progress states—never
source text, API keys, provider bodies, or absolute paths. `finally` unloads/stops the owned server,
removes its key, and proves the port was released.

Exact later invocation:

```sh
GEMMA_DIRECTOR_REAL_SMOKE=1 \
pnpm --filter @light-novel-audiobook/gemma-director smoke:real
```

Optional external-runtime/config override:

```sh
GEMMA_DIRECTOR_REAL_SMOKE=1 \
GEMMA_DIRECTOR_RUNTIME_ROOT="$HOME/.cache/light-novel-audiobook/issue-6-brain" \
pnpm --filter @light-novel-audiobook/gemma-director smoke:real -- \
  --config packages/gemma-director/config/real-smoke.json
```
