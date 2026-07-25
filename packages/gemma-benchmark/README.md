# Gemma 4 representative-chapter benchmark

Issue [#6](https://github.com/season179/light-novel-audiobook/issues/6) is implemented here up to the private-input acceptance gate. The runner performs exactly three sequential, identically configured calls, reconstructs source slices deterministically, writes immutable private run bundles, invokes the merged #4 scorer, and writes a text-free sanitized report. Interrupted experiments resume only missing runs after the immutable plan and existing run identities are verified.

## Locked primary profile

- official `google/gemma-4-26B-A4B-it-qat-q4_0-gguf` revision `d1c082be9cf3c8a514acf63b8761f4b41935842e`;
- text file only: `gemma-4-26B_q4_0-it.gguf` (no `mmproj`);
- SHA-256 `3eca3b8f6d7baf218a7dd6bba5fb59a56ee25fe2d567b6f5f589b4f697eca51d`, 14,439,363,584 bytes;
- standard llama.cpp commit `555881ebc8b0fc0402b30e09258a32a7bfd13c52`, CUDA Release build;
- 32,768-token context, 35 GPU layers (explicit partial offload), Q8_0 K/V cache, flash attention, one slot, prompt-cache reuse disabled, seed 42, temperature 0, and reasoning disabled.

[`provenance.json`](provenance.json) records the independent Hugging Face API/LFS-header checks and license evidence. Preparation hashes every downloaded model byte. Everything produced by host preparation stays under a dedicated ext4 cache root outside Git and separate from llama.cpp-omni.

```sh
export PATH="$HOME/.local/share/light-novel-audiobook/toolchain/current/bin:$PATH"
pnpm --filter @light-novel-audiobook/gemma-benchmark prepare:host
```

The setup downloads only the pinned 14.44 GB text GGUF, verifies size/SHA-256, builds only standard `llama-server` with CUDA, and writes a read-only external build manifest containing the binary hash and compiler identity.

## Required private workspace

Create a mode-`0700` directory on WSL ext4 outside Git. Put mode-`0600` `evaluation-source@1`, `representative-corpus@1`, `gold-annotations@2`, and `benchmark-context@1` files inside it. The runner rejects symlink escapes, broad permissions, incorrect hash chains, non-private provenance, missing corpus dimensions, unknown gold character IDs, and fewer than two blind annotators/adjudication. Gold annotations are never sent to the model.

The context supplies a predeclared opaque character roster and lawful-use/blind-gold attestations. Story text, roster, raw provider responses, and run bundles remain in the private workspace. The committed report surface contains no real result; generated sanitized reports contain only hashes, counts, numeric performance/resources, opaque scorer keys, and fixed status codes.

```sh
pnpm --filter @light-novel-audiobook/gemma-benchmark benchmark -- \
  --workspace /home/$USER/private-audiobook-evaluation \
  --experiment-id representative-chapter-primary-001 \
  --dataset-class private_representative \
  --source /home/$USER/private-audiobook-evaluation/source.json \
  --corpus /home/$USER/private-audiobook-evaluation/corpus.json \
  --annotations /home/$USER/private-audiobook-evaluation/annotations.json \
  --context /home/$USER/private-audiobook-evaluation/context.json
```

Elapsed time covers each complete direction request. Peak RAM is sampled as effective WSL memory (`MemTotal - MemAvailable`); peak VRAM is the conservative whole-device `nvidia-smi memory.used` value. llama.cpp prompt/generation token counts and rates are retained numerically. The prompt plus an 8,192-token output reserve must fit 32K.

## Synthetic operational smoke

The #4 fixture may exercise loading, CUDA, JSON-schema output, exactly-three orchestration, resources, resume, and sanitization. It is clearly labeled `synthetic_operational`; it cannot support a representative-accuracy claim or profile decision.

The measured smoke in [`evidence/synthetic-operational-smoke.json`](evidence/synthetic-operational-smoke.json) completed all three independent (prompt cache disabled) runs without crash/OOM at 32K and 35 GPU layers. Peak whole-device VRAM was 14,940 MiB and peak effective WSL RAM was 4,765 MiB. Its expected semantic score is **FAIL** because arbitrary synthetic lines are not representative accuracy evidence.

## Fallback safety

The profile registry exactly follows `docs/PLAN.md`. A fallback requires a private `fallback-history@1` containing every preceding failed profile in order. The 26B uncensored fallback is accepted only after a recorded mature-content refusal/obstruction. Fallback weights are intentionally neither pinned nor downloaded until the primary representative result lawfully authorizes the next profile.

The issue must remain open until a lawful private representative chapter meeting #4 governance and independently prepared blind gold annotations are supplied and the resulting three-run report supports a selected-profile or final no-go decision.
