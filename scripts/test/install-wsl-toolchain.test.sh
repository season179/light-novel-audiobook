#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
installer="$repository_root/scripts/install-wsl-toolchain.sh"
# shellcheck source=../install-wsl-toolchain.sh
source "$installer"

temporary_directory="$(mktemp -d)"
trap 'rm -rf "$temporary_directory"' EXIT

fail() {
  printf 'installer test failed: %s\n' "$1" >&2
  exit 1
}

node_version="$(toolchain_read_node_version "$repository_root/.node-version")"
pnpm_version="$(toolchain_read_pnpm_version "$repository_root/package.json")"
[[ "$node_version" =~ ^24\. ]] || fail 'the pinned Node version was not parsed'
[[ "$pnpm_version" == '11.17.0' ]] || fail 'the pinned pnpm version was not parsed'
printf 'latest\n' > "$temporary_directory/invalid-node-version"
if toolchain_read_node_version "$temporary_directory/invalid-node-version" >/dev/null 2>&1; then
  fail 'an invalid Node version was accepted'
fi
printf '{"packageManager":"pnpm@latest"}\n' > "$temporary_directory/invalid-package.json"
if toolchain_read_pnpm_version "$temporary_directory/invalid-package.json" >/dev/null 2>&1; then
  fail 'an unpinned pnpm version was accepted'
fi

printf 'Linux version without WSL markers\n' > "$temporary_directory/not-wsl-version"
if TOOLCHAIN_PROC_VERSION_FILE="$temporary_directory/not-wsl-version" \
  XDG_DATA_HOME="$temporary_directory/rejected-data" bash "$installer" \
  > "$temporary_directory/rejected.out" 2>&1; then
  fail 'the installer accepted a non-WSL environment'
fi
grep -q 'must run inside WSL2' "$temporary_directory/rejected.out" ||
  fail 'the WSL rejection did not explain the failure'

case "$(uname -m)" in
  x86_64) node_arch='x64' ;;
  aarch64 | arm64) node_arch='arm64' ;;
  *) fail "unsupported test architecture: $(uname -m)" ;;
esac

archive="node-v$node_version-linux-$node_arch.tar.xz"
distribution="$temporary_directory/distribution"
payload="$temporary_directory/payload/node-v$node_version-linux-$node_arch"
mkdir -p "$distribution/v$node_version" "$payload/bin"
cat > "$payload/bin/node" <<EOF
#!/usr/bin/env bash
case "\${1-}" in
  --version) printf '%s\\n' 'v$node_version' ;;
  -p) printf '%s\\n' 'linux:$node_arch' ;;
  *) printf '%s\\n' 'unexpected fake node arguments' >&2; exit 1 ;;
esac
EOF
cat > "$payload/bin/corepack" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
bin_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${1-}" == 'enable' && "${2-}" == 'pnpm' ]]; then
  exit 0
fi
if [[ "${1-}" == 'install' && "${2-}" == '--global' && "${3-}" == pnpm@* ]]; then
  version="${3#pnpm@}"
  cat > "$bin_directory/pnpm" <<SCRIPT
#!/usr/bin/env bash
if [[ "\${1-}" == '--version' ]]; then printf '%s\\n' '$version'; else exit 1; fi
SCRIPT
  chmod +x "$bin_directory/pnpm"
  exit 0
fi
exit 1
EOF
chmod +x "$payload/bin/node" "$payload/bin/corepack"
tar -cJf "$distribution/v$node_version/$archive" -C "$temporary_directory/payload" \
  "node-v$node_version-linux-$node_arch"
(
  cd "$distribution/v$node_version"
  sha256sum "$archive" > SHASUMS256.txt
)
printf 'Linux microsoft-standard-WSL2 test kernel\n' > "$temporary_directory/wsl-version"

assert_no_install_leaks() {
  local toolchain_root="$1"
  if [[ -d "$toolchain_root" ]] &&
    find "$toolchain_root" -mindepth 1 -maxdepth 1 -name '.install.*' -print -quit | grep -q .; then
    fail "a failed install leaked a .install.* directory under $toolchain_root"
  fi
}

expect_clean_install_failure() {
  local name="$1"
  local dist_url="$2"
  local failure_data="$temporary_directory/failure-$name"
  local toolchain_root="$failure_data/light-novel-audiobook/toolchain"
  mkdir -p "$toolchain_root/unrelated"
  printf 'keep\n' > "$toolchain_root/unrelated/sentinel"
  if TOOLCHAIN_PROC_VERSION_FILE="$temporary_directory/wsl-version" \
    TOOLCHAIN_NODE_DIST_URL="$dist_url" XDG_DATA_HOME="$failure_data" \
    bash "$installer" > "$temporary_directory/failure-$name.out" 2>&1; then
    fail "$name installation unexpectedly succeeded"
  fi
  assert_no_install_leaks "$toolchain_root"
  [[ -f "$toolchain_root/unrelated/sentinel" ]] ||
    fail "$name failure cleanup removed an unrelated path"
}

expect_clean_install_failure 'curl' "file://$temporary_directory/missing-distribution"

checksum_failure_distribution="$temporary_directory/checksum-failure-distribution"
mkdir -p "$checksum_failure_distribution/v$node_version"
cp "$distribution/v$node_version/$archive" "$checksum_failure_distribution/v$node_version/$archive"
printf '%064d  %s\n' 0 "$archive" > \
  "$checksum_failure_distribution/v$node_version/SHASUMS256.txt"
expect_clean_install_failure 'checksum' "file://$checksum_failure_distribution"

tar_failure_distribution="$temporary_directory/tar-failure-distribution"
mkdir -p "$tar_failure_distribution/v$node_version"
printf 'not an xz archive\n' > "$tar_failure_distribution/v$node_version/$archive"
(
  cd "$tar_failure_distribution/v$node_version"
  sha256sum "$archive" > SHASUMS256.txt
)
expect_clean_install_failure 'tar' "file://$tar_failure_distribution"

install_data="$temporary_directory/install-data"
install_root="$install_data/light-novel-audiobook/toolchain"
target="$install_root/node-v$node_version-linux-$node_arch"
mkdir -p "$target/bin"
printf 'partial cache\n' > "$target/bin/node"

run_installer() {
  TOOLCHAIN_PROC_VERSION_FILE="$temporary_directory/wsl-version" \
    TOOLCHAIN_NODE_DIST_URL="file://$distribution" \
    XDG_DATA_HOME="$install_data" \
    bash "$installer" "$@"
}

run_installer > "$temporary_directory/first.out"
grep -q 'Discarding invalid cached' "$temporary_directory/first.out" ||
  fail 'a partial cached target was not rejected'
grep -q 'Downloading native Linux Node.js' "$temporary_directory/first.out" ||
  fail 'a rejected cache was not repaired'
[[ "$($target/bin/node --version)" == "v$node_version" ]] || fail 'Node version assertion failed'
[[ "$($target/bin/pnpm --version)" == "$pnpm_version" ]] || fail 'pnpm version assertion failed'
[[ -f "$target/.toolchain-integrity" ]] || fail 'cache integrity metadata is missing'
original_checksum="$(sha256sum "$target/bin/node")"

run_installer > "$temporary_directory/second.out"
if grep -q 'Downloading native Linux Node.js' "$temporary_directory/second.out"; then
  fail 'an idempotent repeated run downloaded Node again'
fi
[[ "$(sha256sum "$target/bin/node")" == "$original_checksum" ]] ||
  fail 'an idempotent repeated run changed the cached Node binary'

printf 'corruption\n' >> "$target/bin/node"
run_installer > "$temporary_directory/recovery.out"
grep -q 'Discarding invalid cached' "$temporary_directory/recovery.out" ||
  fail 'a corrupted cached target was not rejected'
[[ "$(sha256sum "$target/bin/node")" == "$original_checksum" ]] ||
  fail 'a corrupted cached target was not repaired'

printf '%s\n' \
  'WSL2 installer parsing, failure cleanup, rejection, cache recovery, and idempotency tests passed.'
