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
- Direct loopback-only local runtime endpoints

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

The review app listens at `http://127.0.0.1:3000`; open `http://localhost:3000` in the browser.
The current worker is only a scaffold; model-server lifecycle management will be added with the
processing pipeline. See the [WSL2 topology ADR](docs/adr/0001-wsl2-runtime-topology.md) for the
storage, process, and direct-loopback boundaries.

## Repository boundaries

- Source code, prompts, schemas, tests, and documentation belong here.
- SQLite and runtime state belong on WSL ext4 outside Git. Large book workspaces, reference
  voices, and generated audio may use an explicit Linux-mounted path such as
  `/mnt/c/Users/WINDOWS 11/Audiobooks`.
- Model weights and inference engines belong on WSL ext4 under paths such as
  `/home/windows_11/models/audiobook` and `/home/windows_11/src`.
