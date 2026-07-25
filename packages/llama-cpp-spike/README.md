# TanStack AI / llama.cpp compatibility spike

Issue: [#5](https://github.com/season179/light-novel-audiobook/issues/5)

This private package is a disposable compatibility harness. It proves the boundary needed by a
future `DirectorModel`; it is **not** that production adapter and contains no audiobook rules,
book text, prompts, weights, or generated media.

## Decision

**GO**, with a narrow scope: TanStack AI 0.42.0 and its OpenAI-compatible adapter 0.17.1 preserve
the llama.cpp request fields, JSON Schema, model identity, streaming behavior, and cancellation
needed to build a production adapter later. The selected 105 MB public model is only a protocol
fixture. Gemma 4 quality, memory, context, and throughput still require their separate acceptance
test from `docs/PLAN.md`.

## Verified current API

The installed skill contains older examples using `generate()` and an `openaiText()` constructor.
The pinned current packages and upstream sources were independently checked before implementation:

- call `chat()` from `@tanstack/ai`;
- call `openaiCompatibleText()` from `@tanstack/ai-openai/compatible` for llama.cpp's
  `/v1/chat/completions` API;
- pass Zod through `outputSchema`;
- pass cancellation through `abortController`;
- pass native OpenAI wire names (`temperature`, `seed`, `max_tokens`) through `modelOptions`.

The adapter sends streaming Chat Completions with `response_format.type = "json_schema"`, strict
schema content, `stream_options.include_usage`, and the requested model. Exact artifacts,
revisions, integrity values, build flags, model license, and SHA-256 are in
[`provenance.json`](provenance.json).

## Portable checks

From the repository root with the issue #1 native WSL toolchain:

```sh
export PATH="$HOME/.local/share/light-novel-audiobook/toolchain/current/bin:$PATH"
pnpm --filter @light-novel-audiobook/llama-cpp-spike check
```

The network-free fixture server binds to an ephemeral `127.0.0.1` port and captures what the
llama.cpp-compatible endpoint actually receives. Tests cover:

- exact model/messages/sampling/schema/stream request shape;
- valid structured output and independent Zod validation;
- malformed JSON and schema-invalid JSON;
- HTTP, model, stream, connection, timeout, and caller-cancellation failures;
- health, model identity, `/props`, and slot capability discovery;
- cancellation reaching the server, queued/active slot release, and successful reuse;
- rejection of `0.0.0.0`, LAN hosts, `localhost`, TLS, credentials, and URL paths.

Stable public error codes are:

| Code | Meaning | Retry default |
| --- | --- | --- |
| `cancelled` | caller aborted | no |
| `timeout` | bounded client timeout elapsed | yes |
| `unavailable` | connection/DNS failure | yes |
| `http` | non-model HTTP/API failure | 429/5xx only |
| `model` | model identity/context/model rejection | no |
| `stream` | response failed after streaming began | yes |
| `malformed_response` | invalid/incomplete JSON | no |
| `schema_validation` | JSON failed the requested Zod schema | no |
| `capability` | health/capability shape is incompatible | no |

Errors retain the original exception as `cause` and expose safe `status`/`providerCode` fields
when upstream provides them. Raw responses are never written by the package.

## Real host run

The setup script refuses non-ext4 storage, checks out an exact standard llama.cpp commit, builds
`llama-server` without CUDA, downloads the pinned Apache-2.0 GGUF, and verifies its SHA-256. All
source, binaries, weights, metadata, and raw runtime logs stay under
`${XDG_CACHE_HOME:-$HOME/.cache}/light-novel-audiobook/issue-5`, outside Git and isolated from
llama.cpp-omni.

```sh
pnpm --filter @light-novel-audiobook/llama-cpp-spike host:prepare
pnpm --filter @light-novel-audiobook/llama-cpp-spike host:smoke
```

The default smoke endpoint is the production brain default, `http://127.0.0.1:8080`. Startup
fails closed when that fixed port is occupied. A host-only override is available for a conflict:

```sh
LLAMA_CPP_SPIKE_PORT=18080 \
  pnpm --filter @light-novel-audiobook/llama-cpp-spike host:smoke
```

This measured worktree used that override because an unrelated, user-managed loopback
`llama-server` already owned and automatically reclaimed port 8080. The committed application
and harness default remains `127.0.0.1:8080`; the evidence records the override openly.

The real smoke:

1. verifies source/model pins and ext4 placement;
2. refuses an occupied configured port;
3. starts only the pinned process on explicit `127.0.0.1`;
4. checks the real listener using `ss` and rejects any non-loopback shape;
5. probes health, models, properties, and slots;
6. sends schema-constrained structured output through TanStack AI;
7. observes a cancellation request in a real llama.cpp slot, aborts it, and proves both the
   server slot and client semaphore are released;
8. proves reuse with another successful request;
9. stops only its own child in `finally`, escalating to `SIGKILL` only if that same child misses
   the grace period;
10. proves the configured port is free before atomically replacing sanitized evidence.

Only [`evidence/real-host-run.json`](evidence/real-host-run.json) is committed. The external raw
log can help local debugging but must never be added to Git.
