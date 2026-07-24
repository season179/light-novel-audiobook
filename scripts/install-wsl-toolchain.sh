#!/usr/bin/env bash

toolchain_error() {
  printf 'error: %s\n' "$1" >&2
}

toolchain_read_node_version() {
  local value
  value="$(tr -d '[:space:]' < "$1")"
  if [[ ! "$value" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    toolchain_error "invalid Node version in .node-version: $value"
    return 1
  fi
  printf '%s\n' "$value"
}

toolchain_read_pnpm_version() {
  local value
  value="$({ grep -o '"packageManager"[[:space:]]*:[[:space:]]*"pnpm@[^"]*"' "$1" || true; } |
    sed -E 's/.*pnpm@([^"]+)"/\1/')"
  if [[ ! "$value" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    toolchain_error 'package.json must pin packageManager to an exact pnpm version.'
    return 1
  fi
  printf '%s\n' "$value"
}

toolchain_is_wsl2() {
  local kernel_name="$1"
  local proc_version_file="$2"
  [[ "$kernel_name" == 'Linux' ]] && [[ -r "$proc_version_file" ]] &&
    grep -qi 'microsoft.*wsl2' "$proc_version_file"
}

toolchain_node_architecture() {
  case "$1" in
    x86_64) printf '%s\n' 'x64' ;;
    aarch64 | arm64) printf '%s\n' 'arm64' ;;
    *)
      toolchain_error "unsupported WSL2 architecture: $1"
      return 1
      ;;
  esac
}

toolchain_write_integrity_manifest() {
  local target="$1"
  local version="$2"
  local architecture="$3"
  local node_checksum corepack_checksum
  node_checksum="$(sha256sum "$target/bin/node" | cut -d ' ' -f 1)"
  corepack_checksum="$(sha256sum "$target/bin/corepack" | cut -d ' ' -f 1)"
  cat > "$target/.toolchain-integrity" <<EOF
node_version=$version
node_architecture=$architecture
node_sha256=$node_checksum
corepack_sha256=$corepack_checksum
EOF
}

toolchain_cache_is_valid() {
  local target="$1"
  local version="$2"
  local architecture="$3"
  local manifest="$target/.toolchain-integrity"
  [[ -d "$target" && ! -L "$target" ]] || return 1
  [[ -x "$target/bin/node" && -x "$target/bin/corepack" && -f "$manifest" ]] || return 1
  grep -qxF "node_version=$version" "$manifest" || return 1
  grep -qxF "node_architecture=$architecture" "$manifest" || return 1

  local expected_node_checksum expected_corepack_checksum
  expected_node_checksum="$(grep '^node_sha256=' "$manifest" | cut -d = -f 2-)"
  expected_corepack_checksum="$(grep '^corepack_sha256=' "$manifest" | cut -d = -f 2-)"
  [[ "$expected_node_checksum" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "$expected_corepack_checksum" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "$(sha256sum "$target/bin/node" | cut -d ' ' -f 1)" == "$expected_node_checksum" ]] ||
    return 1
  [[ "$(sha256sum "$target/bin/corepack" | cut -d ' ' -f 1)" == "$expected_corepack_checksum" ]] ||
    return 1
  [[ "$("$target/bin/node" --version)" == "v$version" ]] || return 1
  [[ "$("$target/bin/node" -p '`${process.platform}:${process.arch}`')" == "linux:$architecture" ]]
}

toolchain_install_node() {
  local target="$1"
  local install_root="$2"
  local version="$3"
  local architecture="$4"
  local dist_url="$5"
  local archive="node-v$version-linux-$architecture.tar.xz"
  local temporary_directory
  temporary_directory="$(mktemp -d "$install_root/.install.XXXXXX")"

  printf 'Downloading native Linux Node.js v%s...\n' "$version"
  curl --fail --silent --show-error --location \
    --output "$temporary_directory/$archive" \
    "$dist_url/v$version/$archive"
  curl --fail --silent --show-error --location \
    --output "$temporary_directory/SHASUMS256.txt" \
    "$dist_url/v$version/SHASUMS256.txt"

  (
    cd "$temporary_directory"
    local checksum_line
    checksum_line="$(grep "  $archive\$" SHASUMS256.txt || true)"
    if [[ -z "$checksum_line" ]]; then
      toolchain_error "nodejs.org checksum list does not contain $archive."
      exit 1
    fi
    printf '%s\n' "$checksum_line" | sha256sum --check --strict -
  )

  tar -xJf "$temporary_directory/$archive" -C "$temporary_directory"
  local extracted="$temporary_directory/node-v$version-linux-$architecture"
  if [[ ! -x "$extracted/bin/node" || ! -x "$extracted/bin/corepack" ]]; then
    toolchain_error 'downloaded Node archive is incomplete.'
    rm -rf "$temporary_directory"
    return 1
  fi
  if [[ "$("$extracted/bin/node" --version)" != "v$version" ]] ||
    [[ "$("$extracted/bin/node" -p '`${process.platform}:${process.arch}`')" != "linux:$architecture" ]]; then
    toolchain_error 'downloaded Node archive does not match the requested version and architecture.'
    rm -rf "$temporary_directory"
    return 1
  fi

  toolchain_write_integrity_manifest "$extracted" "$version" "$architecture"
  if [[ -e "$target" || -L "$target" ]]; then
    toolchain_error "refusing to nest the Node installation into an existing target: $target"
    rm -rf "$temporary_directory"
    return 1
  fi
  mv "$extracted" "$target"
  rm -rf "$temporary_directory"
}

toolchain_main() {
  set -euo pipefail

  local proc_version_file="${TOOLCHAIN_PROC_VERSION_FILE:-/proc/version}"
  if ! toolchain_is_wsl2 "$(uname -s)" "$proc_version_file"; then
    toolchain_error 'this installer must run inside WSL2.'
    return 1
  fi

  local command_name
  for command_name in curl sha256sum tar; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
      toolchain_error "required native Linux command is missing: $command_name"
      return 1
    fi
  done

  local repository_root node_version pnpm_version node_arch
  repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  node_version="$(toolchain_read_node_version "$repository_root/.node-version")"
  pnpm_version="$(toolchain_read_pnpm_version "$repository_root/package.json")"
  node_arch="$(toolchain_node_architecture "$(uname -m)")"

  local install_root target dist_url
  install_root="${XDG_DATA_HOME:-$HOME/.local/share}/light-novel-audiobook/toolchain"
  target="$install_root/node-v$node_version-linux-$node_arch"
  dist_url="${TOOLCHAIN_NODE_DIST_URL:-https://nodejs.org/dist}"
  mkdir -p "$install_root"

  if [[ -e "$target" || -L "$target" ]] &&
    ! toolchain_cache_is_valid "$target" "$node_version" "$node_arch"; then
    printf 'Discarding invalid cached Node.js target: %s\n' "$target"
    rm -rf "$target"
  fi
  if [[ ! -e "$target" && ! -L "$target" ]]; then
    toolchain_install_node "$target" "$install_root" "$node_version" "$node_arch" "$dist_url"
  fi
  if ! toolchain_cache_is_valid "$target" "$node_version" "$node_arch"; then
    toolchain_error 'installed Node.js target failed its integrity check.'
    return 1
  fi

  ln -sfnT "$target" "$install_root/current"
  export PATH="$install_root/current/bin:$PATH"
  hash -r

  if [[ ! -x "$target/bin/pnpm" ]] || [[ "$("$target/bin/pnpm" --version 2>/dev/null || true)" != "$pnpm_version" ]]; then
    corepack enable pnpm
    corepack install --global "pnpm@$pnpm_version"
  fi

  local actual_node_version actual_pnpm_version actual_platform
  actual_node_version="$(node --version)"
  actual_pnpm_version="$(pnpm --version)"
  actual_platform="$(node -p '`${process.platform}:${process.arch}`')"
  if [[ "$actual_node_version" != "v$node_version" || "$actual_platform" != "linux:$node_arch" ]]; then
    toolchain_error "installed Node validation failed: $actual_node_version ($actual_platform)"
    return 1
  fi
  if [[ "$actual_pnpm_version" != "$pnpm_version" ]]; then
    toolchain_error "installed pnpm validation failed: expected $pnpm_version, got $actual_pnpm_version"
    return 1
  fi

  printf '\nInstalled native WSL2 toolchain:\n'
  printf '  node: %s (%s)\n' "$(command -v node)" "$actual_node_version"
  printf '  pnpm: %s (%s)\n' "$(command -v pnpm)" "$actual_pnpm_version"
  printf '\nActivate it in this shell:\n'
  printf '  export PATH="%s/current/bin:$PATH"\n' "$install_root"
  printf '  hash -r\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  toolchain_main "$@"
fi
