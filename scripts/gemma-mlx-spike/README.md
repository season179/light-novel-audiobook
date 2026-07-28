# gemma-mlx-spike — issue #106 self-contained macOS spike driver

Drives the pinned SuperGemma MLX snapshot through an owned `mlx_lm.server` on
`127.0.0.1:8090` and the production-shaped OpenAI-compatible client gates, and writes
structured evidence for the GO/NO-GO report. This is the only TypeScript that runs on
Darwin before #108; it is deliberately self-contained.

## Constraints this directory honors

- Installs locally with **npm** into `scripts/gemma-mlx-spike/node_modules` only. It never
  touches the workspace `pnpm-lock.yaml` and never triggers the root `preinstall` gate
  (npm does not read `pnpm-workspace.yaml` and only runs this package's own lifecycle
  scripts, of which there are none).
- Pins exactly `@tanstack/ai@0.42.0`, `@tanstack/ai-openai@0.17.1`, `zod@4.4.3` — identical
  to the workspace pins in `packages/gemma-director/package.json`, so the client-side gates
  are the production gates — plus `tsx@4.21.0` and the workspace's TypeScript 6 preview.
- Imports the pure validation/schema logic from `packages/gemma-director/src/` by relative
  path only (`validation.ts`, `schema.ts`, `canonical-json.ts`, `errors.ts`, and the pure
  `repairMechanicalSourceEcho` from `fidelity-recovery.ts`). It never imports
  `OwnedLlamaLifecycle`, `SELECTED_GEMMA_PROFILE`, `llamaServerArgs`, or the CUDA
  `hostManifestSchema`; it owns the MLX spawn, sampling, cancellation, and cleanup itself.
- The type-only workspace imports in `port.ts` are erased at transpile. For `tsc --noEmit`
  they are satisfied by `src/workspace-type-shims.d.ts`, which mirrors the real
  domain/application port shapes, and by `tsconfig.json` `paths` entries that point bare
  specifiers (`zod`, `@tanstack/*`) at this directory's `node_modules` — the same `paths`
  are what let tsx resolve `zod` from the gemma-director sources at runtime.

## Install (exact)

```sh
cd scripts/gemma-mlx-spike
npm install --no-audit --no-fund
```

Verify: `git status` at the repo root shows only `scripts/gemma-mlx-spike/` as new.

## Commands

```sh
./node_modules/.bin/tsc --noEmit          # typecheck (TypeScript 6, clean)
./node_modules/.bin/tsx src/spike.ts --help
```

Dry run — validates args, server-bin resolution, immutable snapshot resolution and
completeness (without hashing the 6.3 GB shards), the fail-closed port precheck, and
request construction. Spawns nothing, loads nothing:

```sh
./node_modules/.bin/tsx src/spike.ts --dry-run [--out <dir>]
```

Measurement run — spawns the owned server, sends the representative operational direction
prompt twice (cold request = lazy model load + direction; warm request = representative
throughput), runs all client-side gates, samples process-family RSS, shuts down with
SIGTERM → bounded SIGKILL, and verifies descendant exit and port release:

```sh
./node_modules/.bin/tsx src/spike.ts [--out <dir>] [--snapshot <path> | --revision <sha>]
```

Cancellation run — aborts the in-flight request 30 s after dispatch, then proves cleanup:

```sh
./node_modules/.bin/tsx src/spike.ts --cancel-after-ms 30000 [--out <dir>]
```

Evidence lands in `<out>/gemma-mlx-spike-evidence.json` (default
`~/.cache/light-novel-audiobook/gemma-mlx-spike/<utc-stamp>/`, outside the repo) plus the
bounded server log `mlx-lm-server.log`. Every metric carries its collector and units.

## What the evidence does and does not claim

- The strict JSON-schema `response_format` is transmitted (TanStack AI streaming
  `outputSchema` path) and preserved verbatim in evidence, but `mlx_lm.server` 0.31.3
  accepts and silently ignores it (verified statically: no `response_format`/`json_schema`
  handling in `server.py`). Validity rests on TanStack AI's client-side
  structured-output parse/schema validation, the production mechanical source-echo repair,
  and deterministic `validateDirectionOutput`. No server-side schema parity is claimed.
- `/health` answers unconditionally; cold model load is measured as the first request's
  dispatch-to-first-token time, never as `/health` readiness.
- RSS, Metal `recommendedMaxWorkingSetSize` (queried through the real Metal API via a
  one-shot Swift probe), and memory pressure are recorded as separate labeled quantities.
  RSS is never labeled per-process Metal allocation and no headroom figure is derived by
  subtracting incomparable measurements.
- Exit code 0 means: dry-run checks passed, or all client-side gates passed and cleanup
  was verified (`client-gates-passed`), or cancellation was exercised and cleanup was
  verified (`cancelled-clean`). `client-gates-failed` and `error` exit 1. The final
  GO/NO-GO call is made from this evidence by the spike report, not by this driver.
