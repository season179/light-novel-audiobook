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
- The type-only workspace imports in `port.ts` are erased at transpile, so tsx never
  resolves them at runtime. For `tsc --noEmit` they are satisfied by local direct-export
  declaration modules under `src/workspace-type-shims/` (`application.d.ts`,
  `domain.d.ts`), which mirror the real application/domain port shapes. `tsconfig.json`
  maps the bare specifiers `@light-novel-audiobook/application` and
  `@light-novel-audiobook/domain` to those files through `paths`; because `paths` takes
  precedence over the node_modules walk, tsc resolves them locally whether or not the
  pnpm workspace links exist at the repo root, so the spike typecheck can never traverse
  `packages/application` or `packages/domain`. The remaining `paths` entries (`zod`,
  `@tanstack/*`) point at this directory's `node_modules` — the same `paths` are what let
  tsx resolve `zod` from the gemma-director sources at runtime.
- `./verify-typecheck-isolation.sh` is the regression for that isolation: it runs
  `npm run typecheck` with the workspace links present and then with them removed, and
  leaves the worktree in the isolated (no root workspace node_modules) state.

## Install (exact)

```sh
cd scripts/gemma-mlx-spike
npm install --no-audit --no-fund
```

Verify: `git status` at the repo root shows only `scripts/gemma-mlx-spike/` as new.

## Commands

```sh
./node_modules/.bin/tsc --noEmit          # typecheck (TypeScript 6, clean)
npm test                                  # deterministic failure-evidence tests (no network/model/server)
./node_modules/.bin/tsx src/spike.ts --help
```

`npm test` runs `node --import tsx --test`, which discovers `src/**/*.test.ts`. The tests
replace `globalThis.fetch` with canned SSE responses so the real `@tanstack/ai` adapter and
the production-shaped client gates run end to end with no model, server, or network.

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

The cancellation evidence distinguishes **armed** from **fired**: `cancel_requested` is true
whenever `--cancel-after-ms` is supplied, but `cancel_timer_fired` and `exercised` are true only
when the timer callback (or a terminating signal) actually fired. A 30 s timer on a run that
ends at ~18.6 s on a gate failure therefore reports `cancel_requested=true`,
`cancel_timer_fired=false`, `exercised=false`, `observed_error_code=malformed_output` — it is
never labelled a cancellation outcome merely because the flag was supplied. A cancellation that
fires and verifies cleanup still reports `cancelled-clean`.

The `cancellation` section is written on **both** a clean completion and any failure, and `phase`
is derived from what actually fired (the run's own `cancel_timer_fired` or a terminating signal),
never from the mere presence of `--cancel-after-ms`. So a cancel-mode run that finishes before
the timer fires is auditable as `phase=measurement`, `exercised=false` rather than mislabelled as
a cancellation outcome. A completed run also surfaces `cancel_timer_fired`/`timed_out` (both
`false`) on its per-run result so the firing truth is reachable from a successful outcome.

Evidence lands in `<out>/gemma-mlx-spike-evidence.json` (default
`~/.cache/light-novel-audiobook/gemma-mlx-spike/<utc-stamp>/`, outside the repo) plus the
bounded server log `mlx-lm-server.log`. Every metric carries its collector and units.

## Failure evidence (`failure_context`)

When a direction run fails at a client-side gate (`malformed_output` /
`schema_validation` / `stream`) or ends without a structured output (`undefined-output`), or is
cancelled/timed out, the normal per-run result object is never built. To keep that failure
diagnosable, `runDirection` returns a `{ kind: 'failed', error, failureContext }` outcome (never
a wrapper around the error) and `spike.ts` writes a `failure_context` section alongside `error`,
`cancellation`, `cleanup`, and a `startup_partial`. The stable fields are:

- `response_status` — HTTP status of the `/chat/completions` response.
- `raw_response_bytes` — exact total byte count of the raw response body (never bounded).
- `raw_response_sha256` — SHA-256 of those exact bytes (null only when zero bytes arrived).
- `sse_tail` — bounded raw SSE response tail:
  - `bytes` — exact UTF-8 byte length of the stored tail.
  - `limit_bytes` — the cap applied (64 KiB).
  - `truncated` — true when `raw_response_bytes > limit_bytes`.
  - `text` — the tail itself.
  - `privacy_note` — see below.
- `event_sequence` — bounded `{ type, code, name }` summaries of each consumed stream event (no
  deltas/payloads): `events`, `limit` (64), and `truncated`.
- `terminal_event` — the `{ type, code, name }` of the event that terminated the run (e.g.
  `{ type: 'RUN_ERROR', code: 'structured-output-parse-failed' }`), or null when the run was
  aborted without a terminal stream event.
- `transmitted` — the request envelope record (url, `body_sha256`, model, stream flags,
  response_format + its sha256, sampling). **Request body text is never persisted** — only its
  sha256.
- `request_payload_sha256` — stable hash of the canonical prompt/schema/parameters envelope.
- `cancellation_state` — `cancel_requested`, `cancel_timer_fired`, `timeout_fired`,
  `caller_signal_aborted`.
- `timing` — `dispatch_to_first_token_ms` and `elapsed_ms` at failure.

Comparing `observed_error_code` (top-level `error.code`) and `terminal_event.code` against
`raw_response_bytes`/`raw_response_sha256` and the event sequence is what lets a reviewer tell
model output corruption/truncation apart from an adapter parsing or protocol defect.

### Privacy

`failure_context.sse_tail.text` is a bounded slice of the raw SSE **response** body and may
contain generated text that approximates source passages. It lives only in the cache-local,
gitignored evidence directory (default `~/.cache/light-novel-audiobook/gemma-mlx-spike/…`,
outside the repo) and **must never be committed or shared**. The tail is capped tightly at 64 KiB
(the upper end of the 16–64 KiB diagnostic band) rather than redacted prose-by-prose, because
over-redaction would make malformed output indistinguishable from an adapter parsing failure;
the always-shareable structural view is `event_sequence` (type/code/name only). Request body
text is never persisted.

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
