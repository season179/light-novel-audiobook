# Gemma Director adapter

Focused M1 implementation of issue #29's application `DirectorModel` contract for issue #30. It
connects TanStack AI's OpenAI-compatible adapter to the selected loopback llama.cpp/Gemma profile;
it does not add another benchmark or provider framework.

## Contract and safety

- `GemmaDirectorModel` implements `directChapter(Book, Chapter): Promise<DirectedChapter>` and
  maps directly to issue #29 domain `DirectedSegment` values.
- A required `DirectorContextProvider` supplies story-bible/cast context that is intentionally not
  stored on the domain `Book`.
- A required `DirectorRuntimeLifecycle` owns or delegates model start and shutdown. The adapter —
  never the caller — sequences them: it acquires the exclusive GPU lease and only then calls
  `start()`, so weights can never occupy VRAM before the lease exists. `release()` first cancels
  and settles active direction calls, invokes lifecycle release exactly once, releases the GPU
  lease even when that lifecycle release throws, and is safe to call repeatedly. Calls after
  release fail closed.
- Required `DirectorModel.identity` is a deterministic SHA-256 over canonical adapter/TanStack
  versions, model repository/revision/file/size/hash, prompt and JSON-schema versions/hashes,
  llama.cpp commit/endpoint/context/offload/cache/batch/thread settings, sampling parameters,
  confidence threshold, and GPU-lease protocol/path/release order.
- The selected model ID/revision/SHA, seed 42, temperature 0, top-p 1, maximum tokens, prompt, and
  schema versions are fixed. The configured confidence threshold is also recorded in every
  concrete result.
- The model receives exact passage IDs/text. It may return multiple ordered fragments per passage,
  allowing narration/dialogue/thought changes inside a paragraph. It copies fragment text but does
  not calculate source coordinates: deterministic validation derives inclusive `sourceStart` and
  exclusive `sourceEnd` UTF-16 offsets with a per-passage sequential cursor.
- Zod constructs a request-specific wire response. Narration/sound cues carry no model-chosen
  speaker; dialogue/thought/message speaker IDs are limited to that request's character roster or
  `null`, with `null` requiring a reason. The adapter derives narrator/fallback roles and unresolved
  status. Separate deterministic validation requires each passage's ordered fragment texts to
  concatenate to the immutable source exactly, rejects unknown passages, text
  insertion/duplication/omission/substitution, passage reorder, and surrogate splits, and maps
  downstream text from immutable source slices. Issue #29's `ExactSourceCoverage` validates the mapped
  fragments again at the application boundary. The @4 schema is a clean break with no legacy offset,
  role-ID, or unresolved-boolean compatibility shape.
- Explicit unresolved speakers and known-speaker assignments below the configured threshold map to
  domain `speakerId: null`, forcing issue #29 fallback voice semantics. The director's unresolved
  explanation is preserved into the human approval queue. The threshold applies to
  every kind: narrator-owned narration and sound cues below it raise a review-required
  `low_confidence_kind` warning that keeps the narrator voice instead of rerouting to fallback.
  The concrete result also exposes review-required warnings with source ranges, candidate speaker,
  confidence, and threshold.
- Gemma and Qwen use the same `@light-novel-audiobook/gpu-lease` kernel-`flock` protocol and stable
  configurable path (`~/.local/state/light-novel-audiobook/gpu/exclusive.lock`). The first
  `prepare()` or `directChapter()` acquires owner `gemma` and only then starts the runtime, so
  contention fails before llama.cpp loads a single byte of weights. The lease remains held across
  chapters and is released only after `DirectorRuntimeLifecycle.release()` confirms model exit —
  including when that release fails.
- The lease's post-lock `nvidia-smi` diagnostic excludes this process tree by PID. WSL2/GPU-PV
  reports a real PID but `[Not Found]`/`[N/A]` for process name and per-process memory, so names
  and per-process memory are never treated as data; a `--query-gpu=memory.used` ceiling
  (`residentGpuMemoryThresholdMiB`, default 1024 MiB, comfortably above the ~231 MiB idle baseline)
  covers residency the compute-app table cannot attribute.
- Every run writes text-free progress and safe terminal errors through `DirectorProgressStore`.
  Caller cancellation, lease cancellation, release cancellation, and deadlines abort work.
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
idempotence, deterministic identity, cross-process Gemma/Qwen contention, lease cancellation and
release ordering, and source-fidelity attacks. Separate smoke-safety tests reject substituted
process identity, model argv, PID/listener binding, unsafe Origin/fetch-metadata responses, CORS
permission, and inference-slot occupation.

## Opt-in owned real smoke (do not run during normal checks)

`config/real-smoke.json` contains only public profile settings, loopback URL, external runtime
location, confidence threshold, and deadlines. The command does **not** trust an existing endpoint:
it refuses an occupied port, hashes the complete installed GGUF and binary, then calls
`model.prepare()`, which acquires the shared GPU lease and only afterwards lets the owned
lifecycle create an ephemeral mode-`0600` API-key file and launch the verified binary with the
verified model path. It
then proves `/proc/<pid>/exe`, exact process argv, and the sole `ss` loopback listener/PID all match
that owned process before making any inference claim.

Before direction, the smoke sends authenticated POSTs carrying an attacker `Origin` and
`Sec-Fetch-Site: cross-site`; both must receive 401/403 despite the valid server key, receive no
CORS permission, and never occupy the inference slot. The pinned bare llama.cpp server may fail
this production-boundary gate; that is a truthful failed smoke, not successful evidence. If the
gate passes, it directs only two public synthetic passages. Stdout contains sanitized
counts, classifications, hashes, ownership/browser-boundary results, and progress states—never
source text, API keys, provider bodies, or absolute paths. `finally` unloads/stops the owned server,
removes its key, proves the port was released, and only then releases the GPU lease.

Exact later invocation:

```sh
GEMMA_DIRECTOR_REAL_SMOKE=1 \
pnpm --filter @light-novel-audiobook/gemma-director smoke:real
```

Optional external-runtime/config override:

```sh
GEMMA_DIRECTOR_REAL_SMOKE=1 \
GEMMA_DIRECTOR_RUNTIME_ROOT="$HOME/.cache/light-novel-audiobook/issue-6-brain" \
GEMMA_DIRECTOR_GPU_LEASE_PATH="$HOME/.local/state/light-novel-audiobook/gpu/exclusive.lock" \
pnpm --filter @light-novel-audiobook/gemma-director smoke:real -- \
  --config packages/gemma-director/config/real-smoke.json
```
