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

Reuse independently reopens the WAV and recomputes its SHA-256 against the recorded content
address, and structurally rechecks the recorded audio identity against the pinned WAV
requirements. The deep per-sample clipping/silence gate runs when audio is produced (in both the
Python worker and this adapter) rather than on every resume, since a matching SHA-256 proves the
bytes are the ones that already passed it. A missing, forged, stale, malformed, or
hash-mismatched pair is rendered again without invalidating any other segment; an unreadable
cached file is surfaced as an error instead of being re-rendered blindly.

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
- adapter `identity` -> #29's engine identity input, including the approval catalog identity
- the supplied #29 `inputIdentity` -> manifest and returned repository record
- `Segment.delivery` -> a deterministic effective Qwen instruction and render identity
- progress events -> ordered durable job progress without a web-request lifetime

`@light-novel-audiobook/gpu-lease` is the shared Gemma/Qwen/final-composition contract. Both
owners must receive the same configured stable lock-file path. Its held Linux kernel `flock`, not
an `nvidia-smi` check, guarantees cross-process exclusion and releases automatically on process
crash. `nvidia-smi` remains a fail-closed diagnostic for uncoordinated pre-existing GPU users.

Because the worker runs in its own process group so cancellation can reach the whole tree, it arms
`prctl(PR_SET_PDEATHSIG, SIGKILL)` before reading its first request. A SIGKILLed orchestrator
therefore cannot leave a CUDA-resident worker running after the lease it protected is gone.

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
