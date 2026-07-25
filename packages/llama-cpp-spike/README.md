# TanStack AI / llama.cpp compatibility spike

Issue: [#5](https://github.com/season179/light-novel-audiobook/issues/5)

This private package is a disposable compatibility harness. It proves the boundary needed by a
future `DirectorModel`; it is **not** that production adapter and contains no audiobook rules,
book text, private prompts, weights, or generated media.

## Decision

**GO**, with a narrow scope: TanStack AI 0.42.0 and its OpenAI-compatible adapter 0.17.1 preserve
the llama.cpp request fields, JSON Schema, model identity, streaming behavior, authentication,
and cancellation needed to build a production server-side adapter later. The selected 105 MB
public model is only a protocol fixture. Gemma 4 quality, memory, context, and throughput still
require their separate acceptance test from `docs/PLAN.md`.

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
revisions, package integrity values, MIT license URLs/hashes, model license chain, build flags,
and model SHA-256 are in [`provenance.json`](provenance.json).

## Security boundary

`LlamaCppSpikeClient` requires an API key and is server-side only. The real smoke generates 32
random bytes for every run, writes them to an external mode-`0600` file, passes only that filename
to llama.cpp, disables llama.cpp logging, redacts Authorization at the recording boundary, and
removes the key file after the owned child exits. The key is never passed in argv/environment,
committed, printed, or retained in evidence.

CORS is not authentication. At the pinned llama.cpp revision, the default wildcard origin plus
credentials reflects an arbitrary browser `Origin`; additionally, `OPTIONS` intentionally skips
API-key validation. The harness therefore uses `--cors-origins localhost` and
`--no-cors-credentials`, but this does not make the key browser-safe. The key must remain behind a
server-side application boundary. The real probe sends repeated attacker-origin, no-key OPTIONS
and inference POST requests, samples `/slots` while they run, requires all POSTs to return 401,
requires no attacker CORS permission, and proves no inference slot becomes busy.

## Portable checks

From the repository root with the issue #1 native WSL toolchain:

```sh
export PATH="$HOME/.local/share/light-novel-audiobook/toolchain/current/bin:$PATH"
pnpm --filter @light-novel-audiobook/llama-cpp-spike check
```

The network-free fixture server binds to an ephemeral `127.0.0.1` port. A transparent recording
`fetch` boundary clones the body for hashing/sanitized inspection and forwards the same `Request`
object. Tests compare its body SHA-256 with the bytes received by the fixture. They cover:

- exact model/messages/temperature/seed/max-token/schema/stream request shape;
- Authorization presence with the value redacted from captures;
- valid structured output and independent Zod validation;
- malformed JSON and schema-invalid JSON;
- HTTP, model, stream, connection, timeout, and caller-cancellation failures;
- health, model identity, `/props`, and slot capability discovery;
- cancellation and timeout reaching the server, queued/active slot release, and successful reuse;
- a deadline expiring while queued classifying as `timeout`, not `cancelled`;
- rejection of `0.0.0.0`, LAN hosts, `localhost`, TLS, credentials, and URL paths;
- recomputation of committed evidence's canonical Git source-set identity.

Stable public error codes are:

| Code | Meaning | Retry default |
| --- | --- | --- |
| `cancelled` | caller aborted | no |
| `timeout` | bounded deadline elapsed, including while queued | yes |
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

Before any mutation, both host scripts canonicalize the proposed external root, require ext4,
reject overlap in either direction with the repository, current worktree, and Git directory, and reject symlink
components or escapes for every runtime, source, binary, model, manifest, license, and temporary
path. The setup script then recreates a clean exact standard llama.cpp checkout and build, verifies
the pinned Apache-2.0 model and complete model-card chain, and writes an external build manifest
with the binary SHA-256. Its exit trap removes interrupted source/download/license and
`host-build.json.tmp` files. All source, binaries,
weights, metadata, and license evidence stay under
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

This measured worktree uses that explicit override because an unrelated, user-managed loopback
`llama-server` already owns and automatically reclaims port 8080. The committed application and
harness default remains `127.0.0.1:8080`; evidence records port 18080 openly.

The real smoke:

1. validates and records a sanitized proof that every external path is canonical, ext4,
   outside Git in both directions, and free of symlink escapes before any mutation;
2. requires a clean Git implementation commit and clean exact external checkout/build, then
   verifies source/model/build pins, binary hash, and a loopback-only listener;
3. creates the random key and spawns llama.cpp inside one enclosing ownership `try/finally`, with
   restricted CORS, no credentials, logging disabled, child `error` handling, and drained streams;
4. proves attacker-origin/no-key OPTIONS and POST traffic cannot infer or occupy a slot;
5. probes health, models, properties, and slots with the server-side client;
6. records and forwards the exact real structured-request bytes, retaining only body/schema hashes,
   sanitized asserted fields, redacted Authorization metadata, and backend status;
7. proves real cancellation and a real deadline both abort/release llama.cpp and client slots;
8. proves a follow-up structured request succeeds after each terminal path;
9. handles spawn errors and already-emitted exit-code/signal-code child exits without hanging,
   closing process streams and deleting the key on every startup, probe, or cleanup failure;
10. proves the configured port is free before atomically replacing sanitized evidence.

## Evidence commit protocol

Evidence is deliberately a second commit. First commit all implementation/provenance/lockfile/CI
changes. Run the host smoke from that clean commit. It records that implementation commit and full
tree, the binary hash, and a canonical SHA-256 over Git `ls-tree` entries for the complete package
(excluding generated evidence) plus root lock/workspace/compiler/test/formatter/package and CI
files. Then commit only `evidence/real-host-run.json`. CI fetches history, recomputes both the
recorded implementation source set and the current source set, and fails if implementation changed
without regenerated evidence.
