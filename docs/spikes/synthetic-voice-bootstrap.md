# Synthetic voice bootstrap spike

- Issue: [#8](https://github.com/season179/light-novel-audiobook/issues/8)
- Dependency: issue #7 is **NO-GO for production `SpeechEngine`/M2**
- Allowed scope: serialized, non-streaming VoxCPM2 experiment only
- License/provenance: [`../licenses/synthetic-voice-bootstrap.md`](../licenses/synthetic-voice-bootstrap.md)
- Host evidence: generated only after the harness implementation is committed

## Purpose and boundary

This spike tests whether a narrator and two character references can be generated locally
without any supplied human recording. It does not approve voice quality, a production adapter,
streaming, concurrency, cancellation, deadlines, or M2 readiness.

The bootstrap engine is eSpeak NG 1.52.0 built from pinned source outside Git. It is a small,
deterministic formant synthesizer. MBROLA and sampled voices are excluded. The experiment uses
three fixed project-authored reference transcripts and three fixed project-authored target
lines. No EPUB/book passage, copyrighted reference clip, human recording, or network TTS API is
an input.

## Reproduction in two commits

Commit the lock, harness, portable tests, and documentation first. The probe rejects any harness
file that differs from `HEAD` and binds all source hashes to one identity. Then run:

```sh
export PATH="$HOME/.local/share/light-novel-audiobook/toolchain/current/bin:$PATH"
export CUDA_HOME=/usr/local/cuda

pnpm voices:verify
pnpm voices:setup
pnpm voices:probe -- --output docs/evidence/issue-8-synthetic-voices-wsl2.json
pnpm test:voices
pnpm check
pnpm build
```

The evidence path must not already exist. Commit the sanitized evidence and measured decision
separately. Do not push or merge as part of the spike.

## Safety and immutability

The shell validates every path before mutation. Source, builds, model weights, reference WAVs,
VoxCPM2 outputs, logs, listening forms, and full manifests stay outside Git on WSL ext4. The
runtime trees remain separate from the brain runtime. Source and installed-tool identities are
immutable; each build and experiment gets a create-new run directory. Every audio write and
manifest uses a new path, and committed evidence omits absolute paths and process IDs.

The probe starts the pinned issue #7 server on exactly `127.0.0.1:8081`, checks the exact
listener, and calls only `/v1/audio/speech`. An in-process guard permits exactly one in-flight
request. All complete responses receive strict RIFF/PCM validation. Cleanup requires graceful
server exit and a free port. No interruption or streaming behavior is exercised.

## Experiment and review

For each candidate, the harness:

1. creates the reference twice with identical eSpeak source, voice, transcript, and parameters;
2. requires byte-identical reference hashes;
3. freezes the first WAV and reuses that exact hash for every VoxCPM2 request;
4. renders three lines plus an exact-seed repeat of the first line;
5. requires the repeated VoxCPM2 line to be byte-identical; and
6. records transcript, source, binary, configuration, seed/seed non-applicability, model,
   reference, and output hashes.

Portable objective checks cover valid audio, clipping, active-speech fraction,
duration-per-word bounds, reference pitch separation, fixed-reference reuse, repeatability, and
per-candidate cross-line acoustic summaries. These checks are only an intelligibility proxy;
they cannot establish word accuracy. The external run therefore includes an immutable,
transcript-aligned manual listening form with intelligibility, stability, distinguishability,
and cross-line consistency fields left explicitly pending.

## Decision rule

A **GO for synthetic bootstrap technical feasibility** requires all objective checks. It means
only that three deterministic, distinct, non-human references can condition multiple serialized
VoxCPM2 lines reproducibly. Manual listening approval remains a later gate.

Any objective failure is a **NO-GO for synthetic bootstrap technical feasibility**. In either
case, issue #7 remains **NO-GO for production `SpeechEngine`/M2**, and this spike must not be
cited as production readiness evidence.
