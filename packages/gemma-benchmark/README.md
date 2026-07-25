# Gemma 4 representative-chapter benchmark

Issue [#6](https://github.com/season179/light-novel-audiobook/issues/6) is implemented here up to the private-input acceptance gate. The runner performs exactly three sequential, identically configured calls, reconstructs source slices deterministically, invokes the merged #4 scorer, and writes private immutable run bundles plus a text-free report.

Resume is fail-closed: one process owns an exclusive experiment lock; the directory may contain only the exact plan, run 1–3, report, and transient lock; every plan/run/report identity and canonical byte representation is revalidated. Resume rehashes and reparses raw provider bytes, reconstructs predictions, verifies experiment/dataset/source/corpus/profile/model/build/runtime/request identities, and rejects stale, tampered, symlinked, or extra artifacts.

## Locked primary profile

- official `google/gemma-4-26B-A4B-it-qat-q4_0-gguf` revision `d1c082be9cf3c8a514acf63b8761f4b41935842e`;
- text file only: `gemma-4-26B_q4_0-it.gguf` (no `mmproj`);
- SHA-256 `3eca3b8f6d7baf218a7dd6bba5fb59a56ee25fe2d567b6f5f589b4f697eca51d`, 14,439,363,584 bytes;
- standard llama.cpp commit `555881ebc8b0fc0402b30e09258a32a7bfd13c52`, CUDA Release build;
- 32,768-token context, 35 GPU layers (explicit partial offload), Q8_0 K/V cache, flash attention, one slot, prompt-cache reuse disabled, seed 42, temperature 0, and reasoning disabled.

[`provenance.json`](provenance.json) records the independent Hugging Face API/LFS-header and license checks. Preparation hashes every model byte. Runtime/build/model/license/header/manifest and temporary paths must use a dedicated ext4 root outside both Git and all protected llama.cpp-omni/VoxCPM2 TTS roots; every existing symlink component is rejected before mutation.

```sh
export PATH="$HOME/.local/share/light-novel-audiobook/toolchain/current/bin:$PATH"
bash packages/gemma-benchmark/scripts/prepare-host.sh
```

The setup downloads only the pinned 14.44 GB text GGUF, verifies size/SHA-256, builds standard CUDA `llama-server`, and writes a read-only external host manifest.

## Required private workspace

Create a mode-`0700` WSL ext4 directory outside Git. Put mode-`0600` `evaluation-source@1`, `representative-corpus@1`, `gold-annotations@2`, and `benchmark-context@1` files inside it. The runner rejects symlink escapes, broad permissions, broken hash chains, non-private provenance, missing corpus dimensions, unknown gold character IDs, and fewer than two blind annotators/adjudication. Gold is never sent to the model.

```sh
pnpm exec tsx packages/gemma-benchmark/src/cli.ts -- \
  --workspace /home/$USER/private-audiobook-evaluation \
  --experiment-id representative-chapter-primary-001 \
  --dataset-class private_representative \
  --source /home/$USER/private-audiobook-evaluation/source.json \
  --corpus /home/$USER/private-audiobook-evaluation/corpus.json \
  --annotations /home/$USER/private-audiobook-evaluation/annotations.json \
  --context /home/$USER/private-audiobook-evaluation/context.json
```

Elapsed time covers each complete request. Effective WSL RAM (`MemTotal - MemAvailable`) and conservative whole-device VRAM (`nvidia-smi memory.used`) are sampled initially, periodically, and finally on success, HTTP errors, transport errors, and timeouts. Collector completeness, child exit, crash/OOM, prompt/generation counts, and rates are retained. Timers are cleared; SIGTERM/SIGKILL exit is awaited; API-key deletion and port release are verified.

Operational pass requires exactly runs 1–3, each with `result_state=completed`, `failure_code=none`, valid reparsed provider output, complete resources, and no child exit/crash/OOM. Deterministic refusal surrogates used to score failed requests can never produce an operational pass or a “smoke complete” CLI status.

## Synthetic operational smoke and evidence

The #4 fixture may exercise loading, CUDA, JSON-schema output, orchestration, resources, cleanup, resume, and sanitization. It is always `synthetic_operational` and cannot support representative accuracy or a profile decision. The authoritative measured RAM/VRAM values are in the current evidence file rather than duplicated here.

Evidence uses two commits. First commit all implementation and CI-visible verification surfaces. From that clean commit, run:

```sh
pnpm exec tsx packages/gemma-benchmark/scripts/record-synthetic-evidence.ts
pnpm exec tsx packages/gemma-benchmark/scripts/verify-evidence.ts
```

Then commit only `evidence/synthetic-operational-smoke.json`. Evidence binds the implementation commit/tree/canonical source set, host/model/binary/CMake/runtime identities, experiment plan, each external run-manifest hash, sanitized report, and cleanup. Tests recompute every committed surface available in CI. Raw model output and external paths are never committed.

## Fallback safety

`fallback-history@2` requires every distinct preceding failed report in exact order. Fallback 1 requires a primary mature-content obstruction. Reaching fallback 2 requires both an ordinary primary acceptance/operational failure and a recorded fallback-1 evaluation reason for mature-content reliability; later profiles require every preceding ordered evaluation. Skips, duplicates, and mislabeled transitions fail closed. Fallback weights remain unpinned and undownloaded until authorized.

The issue remains open until a lawful private representative chapter meeting #4 governance and independently prepared blind gold annotations produce a valid three-run selected-profile or final no-go result.
