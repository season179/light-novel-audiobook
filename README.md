# Light Novel Audiobook

Local TypeScript pipeline for converting English EPUB light novels into multi-voice audiobooks.

The project combines deterministic EPUB processing, a Gemma director through llama.cpp, VoxCPM2 speech generation through `llama.cpp-omni`, human review, audio quality control, and M4B assembly.

## Status

Architecture foundation and model evaluation. See [`docs/PLAN.md`](docs/PLAN.md) and the
[representative-corpus scoring guide](docs/evaluation/representative-corpus.md).

## Technology foundation

- TypeScript 7 on Node.js 24+
- pnpm workspace
- TanStack Start review app
- TanStack AI director integration
- Vitest, Zod, and Biome
- Portless local development URLs

## Development

Development is supported from WSL2 with native Linux Node.js 24 and pnpm 11. Follow the
[fresh-clone and toolchain guide](docs/DEVELOPMENT.md); do not reuse `node_modules` installed
by Windows.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm dev
```

The review app is available at `https://audiobook.localhost`. The current worker is only a
scaffold; model-server lifecycle management will be added with the processing pipeline.

## Repository boundaries

- Source code, prompts, schemas, tests, and documentation belong here.
- Books, SQLite workspaces, reference voices, and generated audio belong outside Git. From
  WSL2, use an explicit Linux path such as `/mnt/c/Users/WINDOWS 11/Audiobooks`.
- Model weights and inference engines belong in WSL under `/home/windows_11/models/audiobook` and `/home/windows_11/src`.
