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

`pnpm check` runs the environment preflight, Biome formatting/lint/import checks, verifies that
the normal `tsc` command is TypeScript 7, checks the strict compiler options, typechecks every
workspace package, and runs the test suite. CI repeats these commands on native Linux with Node
24 and a frozen lockfile.

Neither setup nor CI downloads books, model weights, voices, or generated audio.
