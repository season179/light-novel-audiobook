# Light Novel Audiobook

Local TypeScript pipeline for converting English EPUB light novels into multi-voice audiobooks.

The project combines deterministic EPUB processing, a Gemma director through llama.cpp, VoxCPM2 speech generation through `llama.cpp-omni`, human review, audio quality control, and M4B assembly.

## Status

Architecture foundation and model evaluation. See [`docs/PLAN.md`](docs/PLAN.md).

## Technology foundation

- TypeScript 7 on Node.js 24+
- pnpm workspace
- TanStack Start review app
- TanStack AI director integration
- Vitest, Zod, and Biome
- Portless local development URLs

## Development

```sh
corepack enable
pnpm install
pnpm dev
```

The review app is available at `https://audiobook.localhost`. The current worker is only a scaffold; model-server lifecycle management will be added with the processing pipeline.

Useful checks:

```sh
pnpm check
pnpm build
```

## Repository boundaries

- Source code, prompts, schemas, tests, and documentation belong here.
- Books, SQLite workspaces, reference voices, and generated audio belong in `C:\Users\WINDOWS 11\Audiobooks` and are not committed.
- Model weights and inference engines belong in WSL under `/home/windows_11/models/audiobook` and `/home/windows_11/src`.
