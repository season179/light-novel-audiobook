# Development setup

The supported local environments are **WSL2** (primary, with native Linux Node.js 24 and pnpm 11)
and **macOS arm64** (Apple Silicon). Both run the same frozen `pnpm install`, Biome checks, strict
TypeScript 7 typecheck, and workspace build. In WSL2 the repository may live under `/mnt/c`, but
its tools must not resolve to Windows executables. Never reuse `node_modules` across Windows and
WSL2. See the [macOS arm64 setup](#macos-arm64-setup) section for the Mac toolchain entry points.

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

## macOS arm64 setup

Native macOS arm64 (Apple Silicon) is a supported install target alongside WSL2. `pnpm preflight`
now accepts Darwin arm64 and verifies the native `@biomejs/cli-darwin-arm64`,
`@typescript/typescript-darwin-arm64` (the TypeScript 7 native binary), `@rolldown/binding-darwin-arm64`,
`@esbuild/darwin-arm64`, and `lightningcss-darwin-arm64` packages are present and that no foreign
platform package contaminated the tree. Intel (x64) macOS is out of scope.

### Required entry points

| Tool | Version | How to provide it |
| --- | --- | --- |
| Node.js | 24 or newer (the `.node-version` pin) | nvm/fnm/volta, or the official arm64 installer from nodejs.org |
| pnpm | the exact `packageManager` pin in `package.json` (11.17.0) | `corepack enable && corepack prepare pnpm@11.17.0 --activate` |
| Apple clang | any recent Xcode or Command Line Tools | `xcode-select --install`; the FFmpeg build needs `clang`, `make`, and `xcrun` |
| `shasum` | ships with macOS | macOS has no `sha256sum`; the build script and CI use `shasum -a 256` |
| `curl`, `tar` (xz) | ship with macOS | the FFmpeg source tarball is `.tar.xz` |
| uv | the Qwen3-TTS spike uses uv/CPython 3.12 | `brew install uv` or the standalone installer; the lock already carries darwin-arm64 wheels. Spike runtimes remain owned by their own issues. |

`nasm`/`yasm` are **not** required: the macOS FFmpeg configure passes `--disable-x86asm` because
the build targets arm64.

### Fresh clone (macOS)

```sh
git clone https://github.com/season179/light-novel-audiobook.git
cd light-novel-audiobook
corepack enable
pnpm install --frozen-lockfile
pnpm preflight
bash scripts/build-ffmpeg-macos.sh
```

### Pinned FFmpeg 7.0.2

The johnvansickle.com static build that Linux uses publishes no macOS binaries, so macOS compiles
FFmpeg/ffprobe 7.0.2 from the pinned upstream source tarball tracked in
[`config/ffmpeg-artifacts.json`](../config/ffmpeg-artifacts.json). `scripts/build-ffmpeg-macos.sh`
downloads and sha256-checks that tarball, loads the ordered `configureFlags` directly from that
manifest under stock macOS Bash 3.2, builds, and installs both binaries into
`~/.local/share/light-novel-audiobook/tools/ffmpeg/current` — the same default path
`packages/audio-assembly/src/ffmpeg-toolchain.ts` resolves, so no environment override is needed.
The script also writes a `.ffmpeg-build-manifest.json` sidecar recording the effective ordered
flags, the SHA-256 of canonical `JSON.stringify(configureFlags)`, the exact Xcode/clang/SDK
toolchain, and the resulting binary sha256 values. The known-good binary hashes are mirrored in
the committed manifest's `darwin-arm64.referenceBuild` block.

A different Xcode/SDK image produces a different binary hash, so the macOS CI lane pins the
**source archive sha256** and the **7.0.2 version**, not an exact binary hash. The Linux amd64 pin
in the same manifest is the value the Ubuntu lane verifies and is kept beside the darwin entry.

### Portable macOS CI gate

The `validate-macos` lane (runs-on `macos-15-arm64`) is the portable install/toolchain gate owned
by issue #108. It runs this exact ordered command set, pinned by
[`config/macos-ci-gate.json`](../config/macos-ci-gate.json) and its policy test:

```sh
bash scripts/build-ffmpeg-macos.sh
pnpm install --frozen-lockfile
pnpm preflight
pnpm exec biome check .
pnpm typecheck
node --test scripts/test/preflight-toolchain.test.mjs scripts/test/ffmpeg-artifacts.test.mjs scripts/test/macos-ci-gate.test.mjs
pnpm build
# Exact installed ffmpeg and ffprobe 7.0.2 probes follow in the workflow.
```

This gate is explicitly **not equivalent to `pnpm check`**. Root `pnpm check` remains the
Linux/WSL2 gate until #107 and #111–#113 provide portable Darwin contracts. The excluded surfaces
are WSL2 installer behavior, `flock`, `/proc` process identity, ext4/DrvFS qualification and
`findmnt`, Bash 4 process-tree assumptions, Linux process-group/reaper semantics, and Python
`prctl` parent-death signalling. The committed policy fails if the macOS commands are missing,
reordered, replaced, or supplemented by an unnamed substitute, and it pins the existing Ubuntu
job bytes separately. No model weights, voices, books, or generated audio are downloaded in CI.

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

## Qwen3-TTS issue #8 extension

The independent replacement experiment is opt-in and restricted to the pinned
`Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` snapshot:

```sh
pnpm qwen3-tts:verify
pnpm qwen3-tts:setup
pnpm qwen3-tts:probe -- --output docs/evidence/issue-8-qwen3-tts-custom-voice-wsl2.json
```

Setup installs a complete locked uv/CPython 3.12 environment and 4.52 GB model snapshot on WSL
ext4 outside Git. Inference is offline from that local path, uses PyTorch SDPA, and supplies no
reference audio. The harness fails if the retired eSpeak/VoxCPM2 paths reappear. Normal setup and
CI run only portable adversarial tests and do not install the environment, download weights, or
create audio. Read [`spikes/qwen3-tts-custom-voice.md`](spikes/qwen3-tts-custom-voice.md) before
running it.
