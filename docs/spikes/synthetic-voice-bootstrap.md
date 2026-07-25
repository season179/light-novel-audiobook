# Synthetic voice bootstrap spike

- Issue: [#8](https://github.com/season179/light-novel-audiobook/issues/8)
- Dependency: issue #7 is **NO-GO for production `SpeechEngine`/M2**
- Allowed scope: serialized, non-streaming VoxCPM2 experiment only
- Date: 2026-07-25
- License/provenance: [`../licenses/synthetic-voice-bootstrap.md`](../licenses/synthetic-voice-bootstrap.md)
- Host evidence: [`../evidence/issue-8-synthetic-voices-wsl2.json`](../evidence/issue-8-synthetic-voices-wsl2.json)
- Decision: **GO for synthetic bootstrap technical feasibility only**
- Listening approval: **PENDING**

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

## Measured results

The final host run was generated from implementation commit
`932e11e8bfa7562b8da5bada2217e96dcdef88ab`. It recorded eSpeak NG binary SHA-256
`36925debdef847f953863b68cf2c2452acaf1446309ab4b33f25e6c2626b7a36`, build-configuration
SHA-256 `aa7a8488c6d7e8262cce47d4247012a77620cb7a48764fced6dcb4076ebda8d1`, selected-voice-source
SHA-256 `13a4d25df87bfc42b14d82213b07826c711d8c32b748d14ebd249b2fbd8eb5e0`, and the exact
compiler/CMake cache identity. The three references were byte-identical across two
process-isolated, candidate-separated generation passes:

| Candidate | Voice | Reference SHA-256 | Estimated median pitch |
| --- | --- | --- | ---: |
| Narrator | `en-us` | `3091ec3e6d28ff40a623eb65f12dc335eec6e8ddf3cf3cb7c8d0ce5a5fbb3a92` | 94.23 Hz |
| Character one | `en-us+m3` | `6c116e87a6dce91b05fad5ba801c0ac807eca598c745e0603964896ff8223cbc` | 76.56 Hz |
| Character two | `en-us+f4` | `c7026660c91b188e5c75625f2ee5eb9f81a7515b5c27bbae88740c9c0eee71b5` | 210.00 Hz |

All pairwise reference pitch ratios exceeded the fixed 1.12 distinction gate (measured 1.23,
2.23, and 2.74). Every reference passed PCM, clipping, and speech-activity checks.

The probe made 12 serialized non-streaming requests: three fixed lines for each reference plus
one exact repeat per candidate. Every request reused its candidate's unchanged reference hash,
all WAVs passed strict validation and objective stability/intelligibility-proxy bounds, and all
three repeated VoxCPM2 outputs were byte-identical. Across each candidate's three lines, pitch
coefficient of variation was 0.054, 0.106, and 0.054 respectively. The server retained one
process, never exceeded one in-flight request, listened only on `127.0.0.1:8081`, exited
cleanly, and released the port.

The immutable transcript-aligned listening form has SHA-256
`b49af2cbe36150abb1ee062dfca598128e1b440a7d273f00f143c6cbd49d9caa` and nine primary audio
entries. Its intelligibility, stability, distinguishability, and cross-line-consistency ratings
remain deliberately unset. Objective duration/activity bounds are not word-accuracy evidence.

## Go/no-go decision

**GO for synthetic bootstrap technical feasibility.** The required additional local engine is
the pinned eSpeak NG 1.52.0 source build with deterministic formant voices and MBROLA disabled.
It is justified because it creates reproducible, distinguishable, non-human reference assets
without requiring a user recording or a network service.

This is **not** production listening approval. The external manual review remains pending, and
issue #7 remains **NO-GO for production `SpeechEngine`/M2**. This experiment does not approve a
production adapter, streaming, concurrency, cancellation, deadlines, voice naturalness, or M2
readiness.
