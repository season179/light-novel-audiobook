# WSL2 development setup

The supported local environment is WSL2 with native Linux Node.js 24 and pnpm 11. The
repository may live under `/mnt/c`, but its tools must not resolve to Windows executables.
Never reuse `node_modules` between Windows and WSL2.

## Fresh clone

From an Ubuntu WSL2 shell:

```sh
git clone https://github.com/season179/light-novel-audiobook.git
cd light-novel-audiobook
./scripts/install-wsl-toolchain.sh
export PATH="$HOME/.local/share/light-novel-audiobook/toolchain/current/bin:$PATH"
hash -r
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

The installer downloads the Node version pinned in `.node-version` from nodejs.org, verifies
its published SHA-256 checksum, and activates the pnpm version pinned by `packageManager`.
Repeated runs validate the cached Node version, architecture, and binary integrity and replace
an incomplete or stale target. The toolchain installs under the current WSL user's data
directory; it does not modify Windows or shell startup files.

Add the following line to the WSL shell profile if the toolchain should be selected in future
shells:

```sh
export PATH="$HOME/.local/share/light-novel-audiobook/toolchain/current/bin:$PATH"
```

A different native Linux Node version manager is acceptable if it selects Node 24 or newer and
pnpm resolves to the exact pinned version. Do not use npm for project commands.

## Verify the active tools

```sh
command -v node
command -v pnpm
node --version
pnpm --version
pnpm preflight
```

`node` and `pnpm` must resolve to native Linux paths, not `/mnt/c/...`. The preflight rejects an
unsupported Node or pnpm version, Windows-resolved tools, and dependency trees that contain
Windows native packages or lack the expected Linux native packages.

If the dependency tree was created outside the current WSL environment, remove all workspace
install products and install again from WSL2:

```sh
rm -rf node_modules apps/*/node_modules packages/*/node_modules
pnpm install --frozen-lockfile
```

Do not copy or link a Windows `node_modules` directory into this checkout.

## Standard checks

```sh
pnpm check
pnpm build
```

`pnpm dev` binds the review app directly to `127.0.0.1:3000`; open
`http://localhost:3000` in the Windows browser. Startup fails if port 3000 is occupied rather
than selecting another port. The planned brain and TTS defaults are `127.0.0.1:8080` and
`127.0.0.1:8081`. Keep the exact configured Host/Origin allowlists and anti-CSRF protection for
review state changes; model endpoints must reject browser-origin requests and expose no CORS
permission.

The WSL2 topology integration checks can also be run directly with `pnpm test:topology`.
`pnpm probe:topology` captures repeatable filesystem, SQLite, fixed-port networking, process,
and resource evidence. A host-acceptance run requires `TOPOLOGY_WINDOWS_BROWSER`; a default run
without Windows browser/LAN proof exits nonzero. `--skip-network` is CI-only synthetic behavior
and is not acceptance. See
[`docs/adr/0001-wsl2-runtime-topology.md`](adr/0001-wsl2-runtime-topology.md).

`pnpm check` runs the environment preflight, Biome formatting/lint/import checks, verifies that
the normal `tsc` command is TypeScript 7, checks the strict compiler options, typechecks every
workspace package, and runs the test suite. CI repeats these commands on native Linux with Node
24 and a frozen lockfile.

Neither normal project setup nor CI downloads books, model weights, voices, or generated audio.

## VoxCPM2 runtime spike

The opt-in issue #7 harness is intentionally separate from normal setup and CI:

```sh
pnpm voxcpm2:verify
pnpm voxcpm2:setup
pnpm voxcpm2:probe -- --output docs/evidence/issue-7-voxcpm2-wsl2.json
```

It fails closed unless its runtime, model, audio, and raw-log roots are external WSL ext4 paths,
and it keeps the TTS runtime separate from the standard llama.cpp brain runtime. Setup downloads
about 3.55 GB of checksum-pinned public GGUF assets. See
[`spikes/voxcpm2-runtime.md`](spikes/voxcpm2-runtime.md) before using it; the pinned server has a
known streaming crash and is not approved for a production adapter.

## Synthetic voice bootstrap spike

Issue #8's eSpeak NG plus VoxCPM2 experiment is historical and retired. Human review judged all
nine primary outputs “unacceptable / extremely bad quality,” with no numeric per-clip scores
supplied. The orchestrator removed the installed eSpeak NG source/build/install and VoxCPM2
weights/runtime; do **not** run `voices:setup`, `voices:probe`, or reinstall those engines.

The 12 historical WAVs, manifests, review bundle, repository code, and sanitized evidence remain
preserved. The technical experiment record is retained rather than rewritten, while its human
listening decision is NO-GO. See
[`spikes/synthetic-voice-bootstrap.md`](spikes/synthetic-voice-bootstrap.md) and
[`evidence/issue-8-human-listening-2026-07-25.json`](evidence/issue-8-human-listening-2026-07-25.json).
