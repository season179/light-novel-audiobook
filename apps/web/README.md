# @light-novel-audiobook/web

The local-only TanStack Start app for the M1 flow: upload an EPUB, generate it, watch progress, play
the chapters, download the numbered M4B. One user, no login, bound to `127.0.0.1` only.

```bash
pnpm --filter @light-novel-audiobook/web dev   # http://localhost:3000
```

## Layers

| Path | Responsibility |
| --- | --- |
| `src/server/audiobook-web-api.ts` | The whole local API surface. Depends on the application ports only. |
| `src/server/composition-root.ts` | The single place adapters are chosen and injected. |
| `src/server/generation-runner.ts` | Runs generation outside the request, one run at a time. |
| `src/server/fakes/` | Offline fake adapters — no GPU, no models. Replaced by the real ones in #21. |
| `src/api/audiobook-server-fns.ts` | TanStack Start server functions; thin wrappers over the API. |
| `src/routes/api.jobs.*` | Server routes that stream generated audio and the M4B. |
| `src/client/audiobook-client.ts` | The interface pages depend on, so components never know the transport. |
| `src/components/` | Presentational React only. No domain rules, no model orchestration. |
| `src/start.ts` | Host/Origin allowlist and anti-CSRF at the HTTP boundary. |

## The composition-root seam (read this before wiring #21)

Adapters are supplied as **factories called once per generation run**, not as instances:

```ts
import { createAudiobookWebApi } from './server/composition-root.js'

const api = await createAudiobookWebApi({
  createEpubExtractor: () => sharedExtractor,          // may be shared
  createDirectorModel: () => new GemmaDirectorModel(config),  // MUST be fresh per run, and lazy
  directorIdentity: createGemmaDirectorIdentity(config),      // from config, never from a live model
  speechEngineFactory: createQwenSpeechEngineFactory(sharedQwenEngine), // built per book, post-review
  approvals: new SqliteFallbackApprovalRepository(db),  // shared: the review ledger
  createAudioAssembler: () => sharedFfmpegAssembler,   // may be shared
  jobs: sqliteJobRepository,                           // shared: this is persistence
  voices: approvedCast,                                // optional; defaults to the PLAN §7 M1 cast
  workspaceRoot: '/path/outside/the/repo',             // optional
})
```

Why the speech engine is a **factory taking a context** rather than an instance: it refuses any
fallback segment absent from its approval catalog, and that catalog is per book and only exists once
direction has found every unresolved speaker. `RenderAudiobook` calls it after review, so an engine
constructed alongside the extractor would always carry an empty catalog.

Why `directorIdentity` is supplied separately: the generation command identity must bind the
director before direction runs, but building the model at composition time would defeat the factory.
`GenerateAudiobook` skips direction entirely for a job already awaiting review, so a director built
eagerly there is never used and never released — with Gemma that leaks a GPU-resident model, because
`release()` is terminal. Director identity is a pure function of configuration, so it is passed as a
value.

Why `createDirectorModel` has to construct per run: `GenerateAudiobook` always calls
`DirectorModel.release()` when direction finishes, and `GemmaDirectorModel.release()` memoises its
shutdown so every later `directChapter()` throws `Gemma Director has been released`. A retained
director would generate the first book and fail every book after it.

Why the others may be shared: the real Qwen adapter's `endBatch()` clears its batch and accepts a
later `beginBatch()`, and docs/PLAN.md wants the TTS model to stay loaded across requests. The
extractor and assembler hold no lifecycle. Exactly one begin/end batch pair happens per run either way.

Runs are **serialized** by `GenerationRunner`: a second job is accepted and queued rather than run
concurrently, because two concurrent runs would put two models on one 16 GB card — what
`packages/gpu-lease` exists to prevent. A queued job reports `state: 'pending'` with
`latestMessage: 'Waiting for the current generation to finish'`.

## Server functions

Every function returns `WebApiResult<T>`: `{ ok: true, value }` or
`{ ok: false, error: { code, message } }`. Codes: `invalid_request`, `invalid_upload`,
`unknown_upload`, `unknown_job`, `generation_rejected`, `output_unavailable`, `internal`. Unexpected
adapter failures are logged server-side and reported as a generic `internal` message — infrastructure
detail never reaches the browser.

| Function | Method | Input | `value` |
| --- | --- | --- | --- |
| `uploadEpubFn` | POST | `FormData` with `file` | `EpubUploadView` |
| `startGenerationFn` | POST | `{ uploadId, recoverAbandoned? }` | `{ jobId, job }` |
| `getJobStateFn` | GET | `{ jobId }` | `JobStateView \| null` (`null` = no such job) |
| `listChapterAudioFn` | GET | `{ jobId }` | `ChapterAudioListing` |
| `listUploadsFn` | GET | — | `EpubUploadView[]` |

Binary routes: `GET /api/jobs/$jobId/audio/$chapterId` (inline chapter audio) and
`GET /api/jobs/$jobId/download` (the M4B as an attachment). Both resolve paths from persisted job
output only. Containment is then decided from the **open descriptor**, not the pathname: the file is
opened with `O_NOFOLLOW` and its identity re-read through `/proc/self/fd/<fd>`, so swapping the path
for a symlink mid-request can only produce a refusal. Measured: 5,000 requests against an atomically
swapped output leaked nothing, while 5,000 unattacked requests all served. The handle is closed on
end-of-file, error, and client cancellation.

## Fakes are as strict as the real adapters

Each fake refuses what its merged counterpart refuses, because a permissive fake hides defects that
only surface once real models load:

| Fake | Refuses, like the real adapter |
| --- | --- |
| `FakeDirectorModel` | use after `release()`; a chapter that is not the exact one owned by the book |
| `FakeSpeechEngine` | second open batch; render outside a batch; overlapping renders; non-SHA-256 `inputIdentity`; voice that is not the segment's assignment; **fallback speech with no matching per-segment human approval** |
| `FakeAudioAssembler` | chapter/segment misordering; audio supplied for the wrong segment; truncated segment lists; duplicate segments; overwriting a reserved output; **a reserved chapter extension it cannot produce** |
| `InMemoryJobRepository` | reuse of a segment whose bytes no longer match its hash and size; a reservation naming an existing file |
| `createM1VoiceCast` | it cannot drift: `syntheticSpeaker`, `instruction` and `seed` are read out of the pinned Qwen production config, which is exactly what `selectedVoiceProfile()` matches on |

Two consequences worth knowing:

- `FakeSpeechEngine` refuses a fallback segment with no matching per-segment human approval,
  unconditionally, exactly like `QwenApplicationSpeechEngine`. There is **no policy option**: the
  `'auto-approve'` M1 stand-in that used to live here is gone, and issue #45's round-2 review removed
  its renamed successor one layer up. A book with unresolved speakers therefore stops at
  `awaiting_review` until a human decides.

  The decision is made through the review API, and one action covers the whole book — a
  2,328-passage novel must not stop for a click per line:

  | Operation | What it does |
  | --- | --- |
  | `listFallbackReview({ jobId })` | the queue, each entry with a short excerpt of the approved line |
  | `approveAllFallbacks({ jobId })` | one book-wide decision, written out as one durable per-segment record each |
  | `revokeFallback({ jobId, segmentId })` | withdraws one speaker; a completed job returns to review and its audio for that speaker becomes unreachable |
  | `renderApprovedScript({ jobId })` | continues from the persisted script, with no re-extraction and no re-direction |

  Withdrawing one speaker invalidates only that speaker's audio, because the approval identity is
  hashed into that segment's render input identity and nothing else moves. A withdrawal is recorded
  as a durable exclusion, so the book-wide grant cannot silently re-create it.

  **None of these take an actor.** Every recorded decision names the human who made it, and that name
  is resolved once at composition — from `LNA_REVIEWER`, or failing that the operating-system account —
  never from a request body and never from a literal. `resolveReviewerIdentity` throws rather than
  invent one, so a server that cannot say who is deciding does not start. Set `LNA_REVIEWER` to record
  something more useful than the local account name:

  ```sh
  LNA_REVIEWER='Ada Lovelace' pnpm dev
  ```

  This is attribution on a single-user local app, not authentication. When real users arrive,
  `createAudiobookWebApi({ reviewer })` is the seam that carries the authenticated identity and nothing
  below it changes.

  The review excerpt is **story text**. It is returned to the browser so the human can read the line
  they are approving; it must never be written to a log or into job state.
- `FakeAudioAssembler` produces WAV, so it refuses a `.flac` reservation rather than writing WAV bytes
  under the wrong name. #43 has since aligned the real pair — SQLite persistence reserves
  `<stem>-vNNN.flac` chapter masters and `<base>-vNNN.m4b`, which the FFmpeg planner requires — and
  this app's chapter route already content-types `.flac` as `audio/flac`, covered by
  `real-output-extensions.test.ts`. The fake's refusal is what stops a fake from hiding that class of
  mismatch again.

Adapter failures are also sanitized at the composition boundary, because `GenerateAudiobook` persists
an adapter's message into job state and the browser reads that back. The raw cause is logged
server-side; only `WebApiError` and `DomainError` messages pass through.

### What the served-file guarantee is, and is not

The binary routes serve **only paths the job reserved**, opened with `O_NOFOLLOW` and proven inside the
workspace from the open descriptor. They do not claim the *content* is what this app produced: a
hardlink placed in the workspace, or a plain overwrite of a reserved path, both look like ordinary
in-workspace files, and both need workspace write access — which already allows substituting the bytes
directly. Refusing `nlink > 1` would not change that and would reject legitimate exports, since the
FFmpeg assembler places outputs with `link()` and a failed `unlink()` of its staged copy leaves a real
output at two links. Closing it properly needs a digest recorded when the output is produced and
verified when it is served; `AudiobookOutput` carries no hashes today, so that is a port-level change.

## Local workspace

EPUBs, segment WAVs, and exports live outside the repository, by default in
`~/.local/share/light-novel-audiobook/workspace`. Override it with `AUDIOBOOK_WORKSPACE_DIR`. A path
inside the repository is refused, and so is one that only *resolves* inside it through a symlink.

## HTTP boundary

`AUDIOBOOK_WEB_ORIGINS` (comma-separated) sets the exact allowed origins; it defaults to
`http://localhost:3000` and `http://127.0.0.1:3000`. Requests whose `Host` is not in that list are
refused on every method, which is what stops DNS rebinding — `Sec-Fetch-Site: same-origin` is
browser-relative and a rebound host satisfies it. Anti-CSRF additionally covers every state-changing
request; safe methods are exempt from *CSRF only*, because a top-level navigation legitimately
arrives with `Sec-Fetch-Site: none`.

## Refresh safety

Job state is never held in React. Every read goes to the server, which rebuilds it from the
`AudiobookJob` snapshot in `JobRepository`, so reloading mid-generation shows the real progress.
