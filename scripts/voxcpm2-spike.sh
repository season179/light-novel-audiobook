#!/usr/bin/env bash

set -euo pipefail

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lock_file="$repo_root/config/voxcpm2-spike.lock.json"
[[ -f "$lock_file" ]] || fail "missing lock file: $lock_file"

json() {
  node -e "const x=require(process.argv[1]); console.log($1)" "$lock_file"
}

runtime_revision="$(json 'x.runtime.revision')"
model_revision="$(json 'x.ggufModel.revision')"
data_root="${VOXCPM2_DATA_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/light-novel-audiobook}"
state_root="${VOXCPM2_STATE_ROOT:-${XDG_STATE_HOME:-$HOME/.local/state}/light-novel-audiobook}"
runtime_root="$data_root/runtimes/tts/llama.cpp-omni/$runtime_revision"
model_root="$data_root/models/tts/voxcpm2/$model_revision"
audio_root="$data_root/workspaces/spikes/issue-7/audio"
raw_root="$state_root/spikes/issue-7/raw"
brain_root="${BRAIN_RUNTIME_ROOT:-$data_root/runtimes/brain/llama.cpp}"

canonical() {
  realpath -m -- "$1"
}

contains_path() {
  local parent child
  parent="$(canonical "$1")"
  child="$(canonical "$2")"
  [[ "$child" == "$parent" || "$child" == "$parent"/* ]]
}

require_isolated_ext4_paths() {
  [[ "$(uname -s)" == Linux ]] || fail 'runtime setup requires Linux/WSL2'
  grep -qi 'microsoft.*wsl2' /proc/version || fail 'runtime setup requires WSL2'
  mkdir -p "$runtime_root" "$model_root" "$audio_root" "$raw_root"
  local path
  for path in "$runtime_root" "$model_root" "$audio_root" "$raw_root"; do
    [[ "$(findmnt -n -o FSTYPE -T "$path")" == ext4 ]] || fail "path is not on ext4: $path"
    contains_path "$repo_root" "$path" && fail "runtime artifact path is inside Git: $path"
    contains_path "$path" "$repo_root" && fail "runtime artifact path contains Git: $path"
  done
  contains_path "$brain_root" "$runtime_root" && fail 'TTS runtime overlaps the brain runtime'
  contains_path "$runtime_root" "$brain_root" && fail 'brain runtime overlaps the TTS runtime'
  return 0
}

sha256_url() {
  curl --fail --silent --show-error --location "$1" | sha256sum | cut -d ' ' -f 1
}

verify_upstream() {
  local actual expected api_file
  for command_name in curl git node sha256sum; do
    command -v "$command_name" >/dev/null || fail "missing required command: $command_name"
  done

  actual="$(git ls-remote "$(json 'x.runtime.repository')" "refs/tags/$(json 'x.runtime.tag')" | cut -f1)"
  [[ "$actual" == "$runtime_revision" ]] || fail 'pinned llama.cpp-omni tag moved or is unavailable'

  expected="$(json 'x.runtime.licenseSha256')"
  [[ "$(sha256_url "$(json 'x.runtime.licenseUrl')")" == "$expected" ]] || fail 'runtime license checksum mismatch'
  [[ "$(sha256_url "https://raw.githubusercontent.com/tc-mb/llama.cpp-omni/$runtime_revision/tools/omni/voxcpm2/README.md")" == "$(json 'x.runtime.voxcpmReadmeSha256')" ]] || fail 'runtime VoxCPM2 documentation checksum mismatch'

  [[ "$(sha256_url "https://huggingface.co/$(json 'x.officialModel.repository')/raw/$(json 'x.officialModel.revision')/README.md")" == "$(json 'x.officialModel.modelCardSha256')" ]] || fail 'official model card checksum mismatch'
  [[ "$(sha256_url "https://raw.githubusercontent.com/OpenBMB/VoxCPM/$(json 'x.officialModel.sourceRevision')/LICENSE")" == "$(json 'x.officialModel.sourceLicenseSha256')" ]] || fail 'official model source revision or license checksum mismatch'

  [[ "$(sha256_url "https://huggingface.co/$(json 'x.ggufModel.repository')/raw/$model_revision/README.md")" == "$(json 'x.ggufModel.modelCardSha256')" ]] || fail 'GGUF model card checksum mismatch'
  api_file="$(mktemp)"
  trap 'rm -f -- "$api_file"' RETURN
  curl --fail --silent --show-error --location \
    "https://huggingface.co/api/models/$(json 'x.ggufModel.repository')/revision/$model_revision?blobs=true" \
    > "$api_file"
  node - "$lock_file" "$api_file" <<'NODE'
const { readFileSync } = require('node:fs')
const [lockPath, apiPath] = process.argv.slice(2)
const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
const api = JSON.parse(readFileSync(apiPath, 'utf8'))
if (api.sha !== lock.ggufModel.revision) throw new Error('GGUF API revision mismatch')
if (!(api.tags ?? []).includes('license:apache-2.0')) throw new Error('GGUF license metadata mismatch')
for (const expected of lock.ggufModel.assets) {
  const actual = api.siblings?.find((item) => item.rfilename === expected.name)
  if (actual?.lfs?.sha256 !== expected.sha256 || actual?.size !== expected.size) {
    throw new Error(`GGUF provenance mismatch: ${expected.name}`)
  }
}
NODE
  rm -f -- "$api_file"
  trap - RETURN
  printf 'Verified immutable runtime/model revisions, licenses, sizes, and SHA-256 hashes.\n'
}

checkout_source() {
  require_isolated_ext4_paths
  local source="$runtime_root/source"
  if [[ ! -d "$source/.git" ]]; then
    [[ ! -e "$source" ]] || fail "source target exists but is not a Git checkout: $source"
    git init -q "$source"
    git -C "$source" remote add origin "$(json 'x.runtime.repository')"
    git -C "$source" fetch --depth=1 origin "$runtime_revision"
    git -C "$source" checkout --detach FETCH_HEAD
  fi
  [[ "$(git -C "$source" remote get-url origin)" == "$(json 'x.runtime.repository')" ]] || fail 'runtime source remote mismatch'
  [[ "$(git -C "$source" rev-parse HEAD)" == "$runtime_revision" ]] || fail 'runtime source revision mismatch'
  [[ -z "$(git -C "$source" status --porcelain)" ]] || fail 'runtime source checkout is modified'
}

build_runtime() {
  require_isolated_ext4_paths
  checkout_source
  local cuda_home="${CUDA_HOME:-/usr/local/cuda}"
  [[ -x "$cuda_home/bin/nvcc" ]] || fail "CUDA compiler not found: $cuda_home/bin/nvcc"
  export PATH="$cuda_home/bin:$PATH"
  export LD_LIBRARY_PATH="$cuda_home/lib64${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  mkdir -p "$runtime_root/build" "$raw_root"
  {
    printf 'started_at=%s\n' "$(date -u +%FT%TZ)"
    printf 'runtime_revision=%s\n' "$runtime_revision"
    printf 'nvcc=%s\n' "$(nvcc --version | tail -1)"
    printf 'cmake=%s\n' "$(cmake --version | head -1)"
  } > "$raw_root/build-metadata.txt"
  /usr/bin/time -v cmake -S "$runtime_root/source" -B "$runtime_root/build" \
    -DGGML_CUDA=ON "-DCMAKE_CUDA_ARCHITECTURES=$(json 'x.build.cudaArchitecture')" \
    -DCMAKE_BUILD_TYPE=Release > "$raw_root/cmake-configure.log" \
    2> "$raw_root/cmake-configure-time.log"
  /usr/bin/time -v cmake --build "$runtime_root/build" --parallel "$(nproc)" \
    --target $(json 'x.build.targets.join(" ")') > "$raw_root/cmake-build.log" \
    2> "$raw_root/cmake-build-time.log"
  printf 'finished_at=%s\n' "$(date -u +%FT%TZ)" >> "$raw_root/build-metadata.txt"
  [[ -x "$runtime_root/build/bin/voxcpm2-cli" ]] || fail 'voxcpm2-cli was not built'
  [[ -x "$runtime_root/build/bin/llama-tts-server" ]] || fail 'llama-tts-server was not built'
  ldd "$runtime_root/build/bin/voxcpm2-cli" | grep -q 'libggml-cuda' || fail 'CLI is not linked to the CUDA backend'
}

download_models() {
  require_isolated_ext4_paths
  mkdir -p "$model_root" "$raw_root"
  while IFS=$'\t' read -r name size expected; do
    local_path="$model_root/$name"
    partial="$local_path.partial"
    if [[ -f "$local_path" ]]; then
      [[ "$(stat -c %s "$local_path")" == "$size" ]] || fail "wrong model size: $name"
      [[ "$(sha256sum "$local_path" | cut -d ' ' -f 1)" == "$expected" ]] || fail "wrong model checksum: $name"
      continue
    fi
    curl --fail --location --retry 5 --retry-all-errors --continue-at - \
      --output "$partial" \
      "https://huggingface.co/$(json 'x.ggufModel.repository')/resolve/$model_revision/$name" \
      2>> "$raw_root/download.log"
    [[ "$(stat -c %s "$partial")" == "$size" ]] || fail "incomplete model download: $name"
    [[ "$(sha256sum "$partial" | cut -d ' ' -f 1)" == "$expected" ]] || fail "model checksum mismatch: $name"
    mv "$partial" "$local_path"
  done < <(node -e "const x=require(process.argv[1]); for(const a of x.ggufModel.assets) console.log([a.name,a.size,a.sha256].join('\\t'))" "$lock_file")
  printf 'Verified model assets in %s\n' "$model_root"
}

print_paths() {
  printf 'runtime_root=%s\nmodel_root=%s\naudio_root=%s\nraw_root=%s\n' \
    "$runtime_root" "$model_root" "$audio_root" "$raw_root"
}

command_name="${1:-help}"
case "$command_name" in
  verify) verify_upstream ;;
  paths) require_isolated_ext4_paths; print_paths ;;
  checkout) verify_upstream; checkout_source ;;
  build) verify_upstream; build_runtime ;;
  download) verify_upstream; download_models ;;
  setup) verify_upstream; build_runtime; download_models; print_paths ;;
  probe)
    require_isolated_ext4_paths
    VOXCPM2_RUNTIME_ROOT="$runtime_root" VOXCPM2_MODEL_ROOT="$model_root" \
      VOXCPM2_AUDIO_ROOT="$audio_root" VOXCPM2_RAW_ROOT="$raw_root" \
      node "$repo_root/scripts/probe-voxcpm2.mjs" "${@:2}"
    ;;
  *)
    printf 'Usage: %s {verify|paths|checkout|build|download|setup|probe}\n' "$0" >&2
    [[ "$command_name" == help ]] || exit 2
    ;;
esac
