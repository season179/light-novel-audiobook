# Issue #31 Qwen3-TTS batch adapter

## Boundary

`@light-novel-audiobook/qwen-tts` is a small M1 adapter, not a server. One pinned Python 3.12
subprocess receives an ordered begin/render/end batch protocol, verifies the immutable local
CustomVoice snapshot/runtime, loads Qwen once, renders serially, atomically replaces stale
stable-ID WAVs, empties CUDA, and exits.
It has no HTTP listener, streaming protocol, cloud path, reference-audio field, or concurrency
framework.

The adapter stores `<segment-id>.wav` beside `<segment-id>.render.json`. Reuse requires the exact
text, selected built-in speaker/instruction profile, application input identity, delivery,
explicit fallback approval identity/hash, derived seed, generation settings, adapter protocol,
model revision/weight identity, and the live pinned worker runtime identity — the Python worker
hash, the Python executable hash, the runtime-manifest hash, the uv-lock hash, and the installed
package inventory. Editing the worker script therefore stales every segment, which is correct:
its PCM scaling, seeding order, and generation-kwargs mapping all change the waveform. The
manifest also records the observed production-config hash for audit, but only relevant scoped
fields participate in reuse so an unrelated voice-profile edit cannot stale every clip.

Reuse independently reopens the WAV, recomputes its SHA-256 against the recorded content address,
and then re-derives the audio's shape from the file's own canonical RIFF/WAVE header rather than
trusting the manifest: magic, RIFF length, PCM `fmt` chunk, pinned rate/channels/bit-depth, and
`frames` from the declared data chunk, cross-checked against the recorded values. Nothing a
manifest asserts about the audio is taken on faith, so a record written by anything other than
`recordRendered` cannot pass non-audio off as a finished clip. Only the deep per-sample
clipping/silence and text-relative duration gate is render-time only (in both the Python worker
and this adapter), since a matching SHA-256 proves the bytes are the ones that already passed it.
A missing, forged, stale, malformed, or hash-mismatched pair is rendered again without
invalidating any other segment; an unreadable cached file or directory is surfaced as an error
instead of being re-rendered blindly.

Leftover `.<name>.tmp` staging files from a run that was SIGKILLed mid-write (which
`PR_SET_PDEATHSIG` makes routine on orchestrator death) are swept from the output root at engine
construction once they are older than `staleTemporaryFileAgeMs`, default one hour. Atomicity never
depended on that cleanup — a canonical WAV is never partial — so this is litter collection only,
and the age floor means a concurrently constructed engine cannot delete a live staging file.

Segment IDs must be issue #29's book-scoped `book-<24hex>-chNNNN-pNNNNNN-sNNNN` form. The flat
output root is shared across books, so short unscoped `chNN-NNNN` IDs would collide; they are
accepted only behind the `allowUnscopedSegmentIds` test-fixture flag.

The default unresolved-speaker fallback is explicitly configured as `ryan-low-weary` in
`config/qwen3-tts-production.json`. Omitting `voiceProfileId` is rejected unless the request also
supplies a persisted human fallback approval ID and SHA-256; both are stored in the manifest.
Through the issue #29 bridge each approval is bound to one specific segment and its speaker/reason
decision, so approving one unresolved speaker never authorizes another, and a cast whose fallback
voice is not the configured fallback profile is rejected rather than silently substituted.
Source text is passed unchanged.

## Issue #29 integration note

Issue #29 commit `2db0aef` is merged. `QwenApplicationSpeechEngine` implements its actual
`identity` / `beginBatch()` / awaited per-segment `render()` / `endBatch()` port. The bridge uses
one persistent multi-message Python process across the pair, while `QwenTtsSpeechEngine` retains
its efficient complete `renderBatch()` API for direct workers and smoke tests.

The composition mapper then has these mechanical responsibilities:

- `Segment.id` -> `segmentId` (the adapter accepts #29's full deterministic book/chapter/passage/
  segment IDs as canonical filenames)
- `Segment.sourceText` -> `text`, unchanged
- validate/map `VoiceProfile.syntheticSpeaker`, instruction, and seed to one selected profile
- `VoiceProfile.role === 'fallback'` -> configured low/weary profile plus the per-segment approval
  record supplied in `fallbackApprovals`; a different approved profile is a configuration error
- adapter `identity` -> #29's engine identity input. It covers the model, runtime and generation
  settings only. The approval catalog is deliberately excluded: approvals arrive incrementally, and
  #29 folds this identity into every segment's `inputIdentity` and into the job command identity,
  so hashing a growing catalog would re-render the whole book and stale the running job on each
  approval. Each approval invalidates its own segment through the render manifest instead. The
  accepted consequence is audit staleness — an already-rendered segment keeps the approval id it
  was rendered with until it re-renders for some other reason — never audio staleness.
- the supplied #29 `inputIdentity` -> manifest and returned repository record
- `Segment.delivery` -> a deterministic effective Qwen instruction and render identity
- progress events -> ordered durable job progress without a web-request lifetime. `endBatch()`
  never fails a batch whose audio is complete; a GPU lease that will not release cleanly is
  reported as a `lease-release-failed` progress event and on `QwenManagedBatch.leaseReleaseError`
  (`renderBatch` reports the same condition as `SpeechBatchResult.leaseReleaseError`).

`@light-novel-audiobook/gpu-lease` is the shared Gemma/Qwen/final-composition contract. Both
owners must receive the same configured stable lock-file path. Its held Linux kernel `flock`, not
an `nvidia-smi` check, guarantees cross-process exclusion and releases automatically on process
crash. `nvidia-smi` remains a fail-closed diagnostic for uncoordinated pre-existing GPU users.

The adapter is strictly lease-before-spawn and release-after-exit on every path. `renderBatch`
acquires only when at least one segment is stale, and always before `QwenWorkerSession.start`;
`beginManagedBatch` acquires as its first statement. Every release is preceded by `finish()` or
`abort()`, both of which await the child's `close`. No Qwen worker is therefore ever GPU-resident
at the moment `acquire()` is called, which is what keeps the coordinator's
`residentGpuMemoryThresholdMiB` ceiling from rejecting this consumer even though the worker is
spawned detached and may not be attributable through the `nvidia-smi` compute-app table.

Because the worker runs in its own process group so cancellation can reach the whole tree, it arms
`prctl(PR_SET_PDEATHSIG, SIGKILL)` before reading its first request. A SIGKILLed orchestrator
therefore cannot leave a CUDA-resident worker running after the lease it protected is gone. Note
that the kernel ties that signal to the *thread* that spawned the worker, not to the parent
process: the composition root must keep spawning from its main thread, or a future background
worker would kill the batch the moment its spawning thread finished.

## Opt-in real smoke

Do not run this in normal tests or CI. First run `pnpm qwen3-tts:setup`, then obtain the printed
runtime and snapshot paths. Stop Gemma and use a new empty ext4 output directory outside Git:

```sh
QWEN3_TTS_REAL_SMOKE=1 \
QWEN3_TTS_RUNTIME_ROOT="$HOME/.local/share/light-novel-audiobook/runtimes/tts/qwen3-tts/<uv-lock-sha>" \
QWEN3_TTS_MODEL_SNAPSHOT="$HOME/.local/share/light-novel-audiobook/models/tts/qwen3-tts-custom-voice/0c0e3051f131929182e2c023b9537f8b1c68adfe/snapshot" \
QWEN3_TTS_SMOKE_OUTPUT_ROOT="$HOME/.local/state/light-novel-audiobook/smoke/issue-31-$(date -u +%Y%m%dT%H%M%SZ)" \
QWEN3_TTS_GPU_LEASE_PATH="$HOME/.local/state/light-novel-audiobook/gpu/exclusive.lock" \
pnpm --filter @light-novel-audiobook/qwen-tts smoke:real
```

The command renders Aiden calm, Ryan energetic, and Ryan low/weary in one process, validates all
three canonical WAVs/hashes, creates manifests, constructs a fresh adapter, and requires all
three clips to be reused without another Python model process. Before engine construction or GPU
lease acquisition it requires a completely empty output root; the worker also uses atomic
no-replace installation. It refuses non-WSL2 hosts, non-ext4 output, active GPU compute processes,
and output inside Git.
