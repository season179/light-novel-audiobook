# Light Novel Audiobook

Local TypeScript pipeline for converting English EPUB light novels into multi-voice audiobooks.

The project combines deterministic EPUB processing, a Gemma director through llama.cpp, pinned local Qwen3-TTS CustomVoice generation behind a replaceable `SpeechEngine`, human review, audio quality control, and M4B assembly.

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

## Using it

Install two Desktop shortcuts once:

```sh
powershell.exe -ExecutionPolicy Bypass -File "$(wslpath -w scripts/windows/install-desktop-shortcuts.ps1)"
```

**Light Novel Audiobook** starts the app with real models and opens `http://localhost:3000` once
the server answers. **Stop Light Novel Audiobook** stops it from outside, for when the launcher
window was closed with the X button rather than Ctrl-C — Windows does not reliably deliver a
signal through `wsl.exe`, and an abandoned run keeps roughly 15 GB of the card.

Both are thin wrappers, so the same thing works from a terminal:

```sh
./scripts/start-web-app.sh          # real models
./scripts/start-web-app.sh --fake   # same UI, synthetic audio, no GPU
./scripts/stop-web-app.sh
```

Stopping means stopping: the server's own release path reaps the owned `llama-server` and drops the
GPU lease, then anything it started is swept — including the Qwen worker, which is spawned detached
and so is missed by a process-group signal alone. `scripts/test/lna-process-tree.test.sh` proves
that against real processes.

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
  `/mnt/c/Users/<windows-user>/Audiobooks` after replacing the placeholder.
- Model weights and inference engines belong on WSL ext4 under paths such as
  `/home/<wsl-user>/models/audiobook` and `/home/<wsl-user>/src`, again replacing the placeholder.
