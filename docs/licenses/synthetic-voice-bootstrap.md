# Synthetic voice bootstrap licensing and provenance

Issue [#8](https://github.com/season179/light-novel-audiobook/issues/8) uses only the pinned,
source-built eSpeak NG formant synthesizer to create reference WAVs. It does not use MBROLA,
sampled voices, a microphone recording, a user voice, or third-party reference audio.

## eSpeak NG

- Project: `espeak-ng/espeak-ng`
- Tag: `1.52.0`
- Commit: `4870adfa25b1a32b4361592f1be8a40337c58d6c`
- Git tree: `45e4d63726666fbde7616168e8872762470c46d1`
- Project license declaration: GPL version 3 or later
- GPL text SHA-256: `8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903`
- Pinned machine-readable record: [`../../config/synthetic-voice-bootstrap.lock.json`](../../config/synthetic-voice-bootstrap.lock.json)

The upstream README identifies eSpeak NG as formant synthesis, contrasts it with synthesizers
based on human recordings, and declares GPL-3.0-or-later. The repository also carries notices
for bundled components under other compatible terms; the experiment preserves the complete
pinned source checkout and its notices outside Git rather than redistributing a partial source
snapshot here.

The source is built locally with `USE_MBROLA=OFF`, `USE_LIBSONIC=OFF`,
`USE_LIBPCAUDIO=OFF`, and `USE_SPEECHPLAYER=OFF`. Klatt formant support remains enabled. The
build and experiment manifests record the exact source tree, compiler, CMake configuration and
cache hashes, installed voice-data tree hash, and executable hash.

## Selected voice definitions

All candidates use the English (United States) language definition and built-in formant
variants from the same pinned GPL-declared source tree:

| Candidate | eSpeak voice | Source definition | SHA-256 |
| --- | --- | --- | --- |
| Narrator | `en-us` | `espeak-ng-data/lang/gmw/en-US` | `41534c2a22df5dd4f1052ff9e1a33a3ea7bff5a26b5c02bdad5ba8ddb7524704` |
| Character one | `en-us+m3` | `espeak-ng-data/voices/!v/m3` | `7a4ac872387439814ddd65f5e1ff73017122975911df6b5dc62c5709e6fdb611` |
| Character two | `en-us+f4` | `espeak-ng-data/voices/!v/f4` | `ff9e2907a818920e3b976232c90eabaf270fff0de0b8a479af9a3633e9b7921f` |

The variants are text parameter files containing pitch, formant, stress, breath, and related
synthesis settings. They are not sampled voices. The harness verifies these files against
immutable raw URLs and again against the local checkout before generation.

## Text and generated assets

Every transcript in the lock file was authored for this project. No book text or other
copyrighted passage is used. eSpeak NG exposes no random seed; manifests record the seed as
`null`, the reason, and all effective deterministic CLI parameters. VoxCPM2 generation records
its integer seed and all request parameters.

Reference and generated WAVs are not committed. They remain in immutable, create-new run
directories on WSL ext4, with SHA-256 manifests. This document records provenance and the
project's handling decision; it is not a general legal opinion about generated-audio copyright.
VoxCPM2 runtime/model licensing remains documented in
[`../spikes/voxcpm2-runtime.md`](../spikes/voxcpm2-runtime.md).
