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
| `src/server/fakes/` | Offline fake adapters — no GPU, no models. Replaced by the real ones in #21. |
| `src/api/audiobook-server-fns.ts` | TanStack Start server functions; thin wrappers over the API. |
| `src/routes/api.jobs.*` | Server routes that stream generated audio and the M4B. |
| `src/client/audiobook-client.ts` | The interface pages depend on, so components never know the transport. |
| `src/components/` | Presentational React only. No domain rules, no model orchestration. |

## Server functions

| Function | Method | Input | Output |
| --- | --- | --- | --- |
| `uploadEpubFn` | POST | `FormData` with `file` | `{ ok: true, upload }` or `{ ok: false, error }` |
| `startGenerationFn` | POST | `{ uploadId, recoverAbandoned? }` | `{ ok: true, jobId, job }` or `{ ok: false, error }` |
| `getJobStateFn` | GET | `{ jobId }` | `JobStateView \| null` |
| `listChapterAudioFn` | GET | `{ jobId }` | `ChapterAudioListing` |
| `listUploadsFn` | GET | — | `EpubUploadView[]` |

Binary routes: `GET /api/jobs/$jobId/audio/$chapterId` (inline chapter audio) and
`GET /api/jobs/$jobId/download` (the M4B as an attachment). Both resolve paths from persisted job
output only, and refuse anything outside the workspace.

## Local workspace

EPUBs, segment WAVs, and exports live outside the repository, by default in
`~/.local/share/light-novel-audiobook/workspace`. Override it with `AUDIOBOOK_WORKSPACE_DIR`; a path
inside the repository is refused so book text and audio can never be committed.

## Refresh safety

Job state is never held in React. Every read goes to the server, which rebuilds it from the
`AudiobookJob` snapshot in `JobRepository`, so reloading mid-generation shows the real progress.
