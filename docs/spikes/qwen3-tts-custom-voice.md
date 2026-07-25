# Qwen3-TTS CustomVoice extension spike

- Issue: [#8](https://github.com/season179/light-novel-audiobook/issues/8)
- Scope: **only** `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice`
- Runtime: `qwen-tts==0.1.1` on locked uv/Python 3.12
- Attention: PyTorch SDPA; no FlashAttention
- License/provenance: [`../licenses/qwen3-tts-custom-voice.md`](../licenses/qwen3-tts-custom-voice.md)
- Host evidence:
  [`../evidence/issue-8-qwen3-tts-custom-voice-wsl2.json`](../evidence/issue-8-qwen3-tts-custom-voice-wsl2.json)
- Technical decision: **GO for Qwen3-TTS technical evaluation**
- Human listening: **PENDING** until the external review form is completed

## Boundary

This is an independent extension of issue #8 after the historical eSpeak NG plus VoxCPM2 output
failed human listening. The prior repository history, evidence, 12 external WAVs, manifests, and
review bundle remain intact. Their deleted runtime, weights, source, build, and install paths
must remain absent; this harness checks that condition and never calls the old setup or probe.

The extension uses only the pinned 1.7B CustomVoice model and its built-in voices: Aiden for the
narrator, Ryan for character one, and Serena for character two. All speak English with distinct,
locked delivery instructions. It supplies no reference audio and cannot select another Qwen
checkpoint.

## Reproduction in two commits

First commit the lock, uv environment lock, harness, adversarial tests, provenance, and this
document. The real probe refuses to run if any harness source differs from `HEAD`. Then run:

```sh
pnpm qwen3-tts:verify
pnpm qwen3-tts:setup
pnpm qwen3-tts:probe -- --output docs/evidence/issue-8-qwen3-tts-custom-voice-wsl2.json
pnpm test:qwen3-tts
pnpm check
pnpm build
```

Commit only the sanitized evidence and measured documentation update in the second commit. Do
not push or merge as part of the spike.

## Locked setup and model download

`verify` checks the Hugging Face creation time, revision, Apache-2.0 declaration,
4,523,965,995-byte repository `usedStorage` value, complete revision file list, per-file sizes,
both LFS hashes, PyPI wheel identity/release time, matching source commit/tree, and license text.
The complete 13-file revision payload is 4,520,218,951 bytes. The different byte values have
different upstream meanings and are recorded separately rather than conflated.

`setup` uses uv 0.11.7 to install managed CPython 3.12.13 and sync the complete 106-package lock
into an isolated immutable environment on ext4 outside Git. It pins PyTorch and torchaudio
2.9.1. FlashAttention is absent. Every snapshot file is downloaded from the exact model revision
into a staging directory, then checked for its exact byte count and SHA-256 before an atomic
install. The model and speech-tokenizer weights receive the hashes in the issue request; all
small files are also pinned and checked. Setup fails on missing, extra, linked, permissively
accessible, or altered snapshot files.

Inference loads the complete local snapshot with `local_files_only=True`. This is required
because `qwen-tts` 0.1.1 forwards model revisions but its separate processor load does not
forward the revision. A local verified path closes that drift path. Offline environment flags
remain active during inference.

## Experiment and safeguards

For each profile the probe creates exactly one three-voice by three-line primary matrix, followed
by exactly one repeat of line 1 for each voice. The stock profile uses the checkpoint's locked
sampling defaults and resets Python, NumPy, torch CPU, and all CUDA RNGs to the line's locked
seed immediately before every call. The second profile sets both API-supported sampling switches
(`do_sample` and `subtalker_dosample`) to false. The probe refuses the greedy profile unless the
installed API exposes both controls safely.

The two-profile total is 24 WAVs: 18 primary clips and six repeats. Every output records the
speaker, English language, exact transcript/instruction and hashes, profile and parameters,
seed method, elapsed time, WAV hash, and analysis. Repeatability is reported only from each
primary/repeat hash pair. A seed or greedy setting alone is never described as repeatable.

A child process owns CUDA inference. The parent samples VRAM, GPU utilization, child RSS, system
RAM, model-load time, per-line time, and total time. After generation the child unloads the model
and exits; the parent requires GPU memory to return to its measured baseline before evidence can
pass. No server or listener is created.

Strict audio checks require an exact RIFF length, canonical mono 24 kHz 16-bit PCM structure,
nonempty aligned samples, at least 15% active frames, no more than 0.1% near-clipped samples,
and bounded duration per word and per clip. Portable tests reject malformed WAVs; missing,
extra, or duplicated matrix entries; transcript, voice, instruction, seed, parameter, file, or
hash drift; reference-audio use; unsafe greedy controls; silence; clipping; and duration errors.
These checks do not prove pronunciation, naturalness, or word accuracy.

## Immutability, sanitization, and review

The environment, snapshot, audio, package inventory, raw worker logs, review JSON/HTML, and full
artifact manifests stay under private create-new ext4 paths outside Git. Every run uses a source
identity derived from the committed harness and allocates new artifact and raw directories.
Evidence paths and run assets cannot be overwritten. Group/other permissions, symlinks in the
snapshot, unexpected files, local paths, and recreated retired engines fail closed.

The external review page contains all 18 primary clips with exact transcripts and style
instructions. Its JSON form leaves intelligibility, naturalness, style fit, stability, voice
distinction, and cross-line consistency explicitly null. Technical evidence may be committed,
but listening and production decisions remain pending until a person completes that form.

## Measured host results

The immutable host run was generated from implementation commit
`ce94ed7acef3e288dd9e95daf50e3bc5e6e9803d`. It independently rechecked all 13 snapshot files:
4,520,218,951 payload bytes, including the 3,833,402,552-byte main weights and 682,293,092-byte
speech-tokenizer weights with their locked SHA-256 values. It loaded only the local snapshot,
confirmed SDPA on both model and speech-tokenizer configurations, found no FlashAttention,
confirmed all three built-in speakers and English, and used no reference audio. The isolated
environment contained 103 installed packages from the complete uv lock on CPython 3.12.13.

Both exact 3 × 3 primary matrices and both three-repeat sets passed identity and strict WAV
checks. All 24 files were canonical mono 24 kHz 16-bit PCM. Durations ranged from 2.32 to 3.92
seconds, active-frame fractions ranged from 0.821 to 0.958, and no near-clipped samples were
measured. The nine stock primary calls took 59.90 seconds and produced 28.72 seconds of audio;
the nine greedy primary calls took 50.71 seconds and produced 26.16 seconds. All 24 calls took
143.89 seconds, including repeats.

Every same-run stock-seeded repeat matched its primary WAV byte-for-byte. Every same-run greedy
repeat also matched. The evidence records all 12 compared hashes and limits each claim to this
exact run and locked environment; it makes no cross-host repeatability claim.

Model load took 1.86 seconds and the child worker took 159.32 seconds end to end. Peak observed
VRAM was 4,619 MiB on the 16,303 MiB RTX 5070 Ti, versus a 161 MiB baseline. Peak child RSS was
3,987.96 MiB; peak observed system-used RAM was 6,403.71 MiB of 56,238.15 MiB. After the child
exited, GPU use returned to 162 MiB, within 1 MiB of baseline. The old eSpeak/VoxCPM2 paths
remained absent. External artifacts and raw logs have private permissions, and committed
evidence contains no absolute paths, process IDs, audio, or logs.

The immutable external review bundle contains all 18 primary clips, exact transcripts and style
instructions, `manual-review.json`, `review.html`, instructions, and a hashed artifact manifest.
All subjective fields remain null pending a human review.

## Decision

**GO for Qwen3-TTS technical evaluation.** Every locked provenance, isolation, exact-matrix,
WAV/activity/clipping, resource-cleanup, permission, sanitization, and review-bundle gate passed.
This technical GO does not imply human listening approval or production `SpeechEngine`
readiness. Both remain explicitly unassessed until the listening form is completed and later
adapter requirements are tested.
