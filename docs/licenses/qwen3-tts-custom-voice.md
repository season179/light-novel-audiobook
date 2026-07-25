# Qwen3-TTS CustomVoice licensing and provenance

Issue [#8](https://github.com/season179/light-novel-audiobook/issues/8) evaluates only
`Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice`. It uses the model's built-in Aiden, Ryan, and Serena
speakers. No reference recording, voice clone, microphone input, book passage, or network TTS
service is used.

## Model snapshot

- Hugging Face repository: `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice`
- Repository creation: `2026-01-21T08:56:49Z`
- Revision: `0c0e3051f131929182e2c023b9537f8b1c68adfe`
- Model-card license: Apache-2.0
- Hugging Face `usedStorage`: 4,523,965,995 bytes
- Complete revision payload: 4,520,218,951 bytes across 13 files
- Main weights: 3,833,402,552 bytes, SHA-256
  `38b1d5971bdbd982b561cccec982669a53b0537c3cf5e9bd4778ed07bb2f5137`
- Speech-tokenizer weights: 682,293,092 bytes, SHA-256
  `836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258`

Hugging Face's repository-level `usedStorage` includes storage accounting beyond the files in
this revision. The harness records and verifies that supplied value separately from the exact
sum of all 13 downloaded revision files. Every file size and SHA-256 is pinned in
[`../../config/qwen3-tts-custom-voice.lock.json`](../../config/qwen3-tts-custom-voice.lock.json).
The model card at the pinned revision declares Apache-2.0.

## Runtime

- Package: `qwen-tts==0.1.1`
- PyPI upload: `2026-02-06T04:10:51.716041Z`
- Wheel: `qwen_tts-0.1.1-py3-none-any.whl`, 113,529 bytes
- Wheel SHA-256: `11a290d8dabc7ef91a90c54478c8ab19b3edb1d85c0882313721892bdc4af15d`
- Matching source commit: `6cafe5582caea83df269c36b1ce62d953a9cc66b`
- Matching source tree: `3bd8928130d289476ab9139e7e863ba48563b24d`
- Source repository: `QwenLM/Qwen3-TTS`
- Package/source license: Apache-2.0
- Pinned license-text SHA-256:
  `a44a6081c73ad75f0255bb2bb5cab74ef1829565a895a24e53a4f11290ab7655`

The complete Python 3.12 dependency graph is committed as a uv lock. The installed environment,
model snapshot, uv/Python runtime, and caches stay on WSL ext4 outside Git. FlashAttention is
neither locked nor installed for this evaluation; PyTorch SDPA is selected explicitly.

## Text and generated assets

The three comparison lines and three style instructions were written for this project. Their
exact text and hashes are locked. Generated WAVs, review pages/forms, package diagnostics, and
raw logs remain in private, immutable external run directories. Committed evidence contains
hashes and measurements only. This provenance record describes project handling and is not a
general legal opinion about generated-audio copyright.
