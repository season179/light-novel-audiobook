#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != 'Linux' ]] || ! grep -qi 'microsoft.*wsl2' /proc/version; then
  printf '%s\n' 'error: this installer must run inside WSL2.' >&2
  exit 1
fi

for command_name in curl sha256sum tar; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'error: required native Linux command is missing: %s\n' "$command_name" >&2
    exit 1
  fi
done

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_version="$(tr -d '[:space:]' < "$repository_root/.node-version")"
pnpm_version="$({ grep -o '"packageManager"[[:space:]]*:[[:space:]]*"pnpm@[^"]*"' \
  "$repository_root/package.json" || true; } | sed -E 's/.*pnpm@([^"]+)"/\1/')"

if [[ ! "$node_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  printf 'error: invalid Node version in .node-version: %s\n' "$node_version" >&2
  exit 1
fi
if [[ ! "$pnpm_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  printf 'error: package.json must pin packageManager to an exact pnpm version.\n' >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64) node_arch='x64' ;;
  aarch64 | arm64) node_arch='arm64' ;;
  *)
    printf 'error: unsupported WSL2 architecture: %s\n' "$(uname -m)" >&2
    exit 1
    ;;
esac

version="v$node_version"
archive="node-$version-linux-$node_arch.tar.xz"
install_root="${XDG_DATA_HOME:-$HOME/.local/share}/light-novel-audiobook/toolchain"
target="$install_root/node-$version-linux-$node_arch"

if [[ ! -x "$target/bin/node" ]]; then
  temporary_directory="$(mktemp -d)"
  trap 'rm -rf "$temporary_directory"' EXIT

  printf 'Downloading native Linux Node.js %s...\n' "$version"
  curl --fail --silent --show-error --location \
    --output "$temporary_directory/$archive" \
    "https://nodejs.org/dist/$version/$archive"
  curl --fail --silent --show-error --location \
    --output "$temporary_directory/SHASUMS256.txt" \
    "https://nodejs.org/dist/$version/SHASUMS256.txt"

  (
    cd "$temporary_directory"
    checksum_line="$(grep "  $archive\$" SHASUMS256.txt || true)"
    if [[ -z "$checksum_line" ]]; then
      printf 'error: nodejs.org checksum list does not contain %s.\n' "$archive" >&2
      exit 1
    fi
    printf '%s\n' "$checksum_line" | sha256sum --check --strict -
  )

  mkdir -p "$install_root"
  tar -xJf "$temporary_directory/$archive" -C "$temporary_directory"
  mv "$temporary_directory/node-$version-linux-$node_arch" "$target"
fi

ln -sfn "$target" "$install_root/current"
export PATH="$install_root/current/bin:$PATH"
hash -r

corepack enable pnpm
corepack install --global "pnpm@$pnpm_version"

printf '\nInstalled native WSL2 toolchain:\n'
printf '  node: %s (%s)\n' "$(command -v node)" "$(node --version)"
printf '  pnpm: %s (%s)\n' "$(command -v pnpm)" "$(pnpm --version)"
printf '\nActivate it in this shell:\n'
printf '  export PATH="%s/current/bin:$PATH"\n' "$install_root"
printf '  hash -r\n'
