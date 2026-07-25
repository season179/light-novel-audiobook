# VoxCPM2 llama.cpp-omni runtime spike

- Issue: [#7](https://github.com/season179/light-novel-audiobook/issues/7)
- Date: 2026-07-25
- Evidence: [`../evidence/issue-7-voxcpm2-wsl2.json`](../evidence/issue-7-voxcpm2-wsl2.json)
- Production decision: **derived from measured gates; currently NO-GO**
- Issue #8 gate: **may proceed only in serialized, non-streaming experimental mode**

Issue #7 does not unblock a production `SpeechEngine` or the production milestone. The narrow
experimental allowance exists so issue #8 can evaluate synthetic voice bootstrapping without
claiming that server reliability is production-ready.

## Immutable upstream inputs

[`config/voxcpm2-spike.lock.json`](../../config/voxcpm2-spike.lock.json) is the machine-readable
source of truth. `pnpm voxcpm2:verify` independently checks immutable revisions, model-card and
license hashes, Hugging Face LFS sizes, and LFS SHA-256 values before setup.

| Item | Pinned revision | License/provenance |
| --- | --- | --- |
| `tc-mb/llama.cpp-omni` tag `b258` | `74699a53df6ca0f4947ff37066f851532c20b12d` | MIT; pinned license hash |
| Official `openbmb/VoxCPM2` | `bffb3df5a29440629464e5e839f4d214c8714c3d` | Apache-2.0 model card; official source license pinned |
| `DennisHuang648/VoxCPM2-GGUF` | `169f64d8b98bbaab1761e4ca3a83e6af653456cc` | Apache-2.0 card; derived from `openbmb/VoxCPM2`; publisher is an OpenBMB Hugging Face organization member |

The GGUF files are community conversion artifacts, not files in the official model repository.
Their declared lineage, publisher affiliation, immutable repository revision, and LFS SHA-256
hashes make them acceptable for this public spike. They must not be silently replaced by files
with the same names.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `VoxCPM2-BaseLM-Q8_0.gguf` | 1,727,309,920 | `0113177abd11303503bf0b705e1613ec5f0a8508cc74a7dfd0f99312b962a962` |
| `VoxCPM2-Acoustic-F16.gguf` | 1,825,096,352 | `5bde898488ad635ff55d24da53543768fa33d5e5cdc538ce190e5ef831038e85` |

## Reproduce in two commits

The harness must be committed before evidence is generated. The probe rejects working harness
files that differ from `HEAD`, records that commit, and binds the lock, shell harness, probe, and
`core.mjs` hashes into one source identity.

```sh
export PATH="$HOME/.local/share/light-novel-audiobook/toolchain/current/bin:$PATH"
export CUDA_HOME=/usr/local/cuda

pnpm voxcpm2:verify
VOXCPM2_CLEAN_BUILD=1 pnpm voxcpm2:setup
# The evidence path must not already exist.
pnpm voxcpm2:probe -- --output docs/evidence/issue-7-voxcpm2-wsl2.json
pnpm test:voxcpm2
```

Commit harness changes first. Run the clean setup and host probe from that commit, then commit the
new evidence separately. This keeps `generatedFromCommit` meaningful.

## External artifact policy

Path policy is checked before any directory creation or other mutation. Every candidate resolves
outside Git on WSL ext4, and the TTS runtime may not overlap the standard llama.cpp brain runtime.

Build logs and each host probe use a stable source-identity parent plus a timestamp and random
suffix for collision-safe run identity. Audio, logs, timing files, and manifests are written only
into newly created per-run directories. Files use create-new semantics; the harness never
silently overwrites a previous run. Each pass or failure manifest records the run ID, source
identity, timestamps, and artifact hashes. Absolute user paths remain outside committed evidence.

CI runs only portable synthetic HTTP, strict WAV, resource-log, derivation, listener parsing, lock,
and path-policy fixtures. It does not clone inference source, compile CUDA, download weights, or
create model-generated audio.

## Measured gates

The committed evidence contains the host-specific values. Evidence generation fails instead of
publishing a stale conclusion if any pinned assumption changes.

### Non-streaming persistence and parameters

The probe requires all 20 sequential requests to preserve the same process identity and one model
load. It derives parameter effects from response duration and hashes: decode steps, seed, CFG,
temperature, and inference timesteps must have observable effects; the model alias and unknown
field checks must preserve output; invalid types must match explicit server defaults; PCM and
synthetic-reference paths must succeed.

The experimental caller must allow exactly one in-flight request. No concurrency claim is made.

### Cancellation and deadlines

Cancellation and timeout conclusions are experimental, not inferred from client exceptions. The
probe first runs a long control request, then uses equally long requests for manual client abort
and client deadline cases. It records client settlement, server process identity, GPU activity,
idle return, and server-log size/handler lifecycle after interruption.

The evidence distinguishes:

- whether inference activity is observed after the client has stopped receiving;
- whether the process survives;
- whether GPU activity later returns to idle; and
- that normal completion versus an internal early stop is **unknown** when the server exposes no
  completion marker.

The probe never converts a client `AbortError` or `TimeoutError` alone into a server-side
cancellation conclusion.

A separate server is started with the pinned short `--timeout` value. A long request measures
whether that configured read/write timeout acts as a total generation deadline. The evidence
records what happened rather than treating the option as an undocumented generation timeout.

### Streaming and decision derivation

A dedicated process runs the short streaming case. The result records the client lifecycle, exact
process exit, process survival, and any runtime assertion text. The helper derives the streaming
characterization from those observations and refuses evidence if the expected pinned behavior
changes.

The final decision is computed from measured streaming, interruption, configured-timeout, and
persistence checks. It is not inserted as an unsupported constant. At this revision the expected
measured blockers yield **NO-GO for production `SpeechEngine`/M2** while allowing issue #8 only in
serialized, non-streaming experimental mode.

### Audio validation

Every complete WAV must satisfy all of these checks:

- RIFF declared length exactly equals file length;
- one PCM `fmt ` chunk with valid channels, sample rate, bit depth, byte rate, and block align;
- exact data bounds, whole frames, and no trailing bytes;
- VoxCPM2 output is 48 kHz, mono, 16-bit PCM; and
- an independent Python standard-library `wave` check agrees for saved representative outputs.

Portable tests include malformed RIFF lengths, truncated and trailing data, non-PCM format,
inconsistent byte rate/block align, partial frames, and streaming placeholder lengths.

### Loopback proof

The probe parses every `ss` listener on the exact configured port and requires each to be exactly
`127.0.0.1:8081`. It also attempts the same port through every WSL global non-loopback address and
requires all connections to fail. Evidence records only listener/count/family results, not host
addresses or process IDs.

## Experimental issue #8 rules

Issue #8 may proceed only under all of these restrictions:

1. use `/v1/audio/speech`, never the streaming endpoint;
2. serialize requests to one in flight;
3. use only synthetic bootstrap/reference audio and public synthetic text;
4. validate every complete WAV and retain immutable run manifests;
5. treat any interrupted request outcome as uncertain until the measured server lifecycle settles;
6. do not describe issue #7 as unblocking production or M2.
