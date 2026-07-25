# Issue #31 Qwen3-TTS batch adapter

## Boundary

`@light-novel-audiobook/qwen-tts` is a small M1 adapter, not a server. One pinned Python 3.12
subprocess receives one ordered batch, verifies the immutable local CustomVoice snapshot/runtime,
loads Qwen once, renders serially, atomically replaces stable-ID WAVs, empties CUDA, and exits.
It has no HTTP listener, streaming protocol, cloud path, reference-audio field, or concurrency
framework.

The adapter stores `<segment-id>.wav` beside `<segment-id>.render.json`. Reuse requires the exact
text, selected built-in speaker/instruction profile, effective fallback decision, derived seed,
generation settings, adapter protocol, model revision/weight identity, and runtime identity. The
manifest also records the observed production-config hash for audit, but only relevant scoped
fields participate in reuse so an unrelated voice-profile edit cannot stale every clip. It
independently reopens and validates the WAV and SHA-256. A missing,
forged, stale, malformed, silent, clipped, or hash-mismatched pair is rendered again without
invalidating any other segment.

The default unresolved-speaker fallback is explicitly configured as `ryan-low-weary` in
`config/qwen3-tts-production.json`. The application must still record human approval of fallback
use; omission of `voiceProfileId` only carries that already-approved decision into this adapter.
Source text is passed unchanged.

## Issue #29 integration note

Issue #31 deliberately owns only a minimal batch port with `identity` and `renderBatch()`. Issue
#29 commit `03b7a6e` finalized a different application port: `beginBatch()`, one awaited
`render()` per segment, and `endBatch()`. That shape cannot be wrapped around this adapter as a
thin mapper: each #29 `render()` must return before the application reveals the next request,
while this adapter intentionally sends the complete ordered missing set in one Python request.

Preferred integration change: revise #29's port to one `renderBatch(readonly SpeechRenderRequest[])`
and have `GenerateAudiobook` collect the already-planned missing segments, call it once, then
validate/persist returned results in order. An alternative would require a deliberate persistent
multi-message Python protocol; do not simulate batching with one model process per `render()`.

The composition mapper then has these mechanical responsibilities:

- `Segment.id` -> `segmentId` (the adapter accepts #29's full deterministic book/chapter/passage/
  segment IDs as canonical filenames)
- `Segment.sourceText` -> `text`, unchanged
- validate/map `VoiceProfile.syntheticSpeaker`, instruction, and seed to one selected profile
- `VoiceProfile.role === 'fallback'` -> omitted `voiceProfileId` / configured approved fallback
- adapter `identity` -> #29's engine identity input
- the supplied #29 `inputIdentity` -> the returned repository record after checking the adapter
  result's segment and render identity
- progress events -> job progress without a web-request lifetime

Issue #29 currently includes `Segment.delivery` in its reuse identity, while this locked M1
adapter does not yet turn per-segment delivery fields into new Qwen instructions. Integration
must either define and contract-test that deterministic instruction mapping or remove those
fields from speech-affecting identity; it must not imply a delivery change altered audio when it
did not.

The Gemma lifecycle must acquire the same `FileGpuGate` lock before loading. Qwen also checks
`nvidia-smi` after acquiring the lock, so an already-resident Gemma/other compute process fails
closed.

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
three clips to be reused without another Python model process. It refuses reuse-only first runs,
non-WSL2 hosts, non-ext4 output, active GPU compute processes, and output inside Git.
