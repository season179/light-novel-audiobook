#!/usr/bin/env bash

set -euo pipefail

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lock_file="$repo_root/config/voxcpm2-spike.lock.json"
probe_file="$repo_root/scripts/probe-voxcpm2.mjs"
core_file="$repo_root/scripts/voxcpm2/core.mjs"
shell_file="$repo_root/scripts/voxcpm2-spike.sh"
[[ -f "$lock_file" && -f "$probe_file" && -f "$core_file" ]] || fail 'VoxCPM2 harness files are incomplete'

json() {
  node -e "const x=require(process.argv[1]); console.log($1)" "$lock_file"
}

runtime_revision="$(json 'x.runtime.revision')"
model_revision="$(json 'x.ggufModel.revision')"
data_root="${VOXCPM2_DATA_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/light-novel-audiobook}"
state_root="${VOXCPM2_STATE_ROOT:-${XDG_STATE_HOME:-$HOME/.local/state}/light-novel-audiobook}"
runtime_root="$data_root/runtimes/tts/llama.cpp-omni/$runtime_revision"
model_root="$data_root/models/tts/voxcpm2/$model_revision"
brain_root="${BRAIN_RUNTIME_ROOT:-$data_root/runtimes/brain/llama.cpp}"

file_hash() {
  sha256sum "$1" | cut -d ' ' -f 1
}

source_identity="$({
  printf 'config:%s\n' "$(file_hash "$lock_file")"
  printf 'core:%s\n' "$(file_hash "$core_file")"
  printf 'probe:%s\n' "$(file_hash "$probe_file")"
  printf 'shell:%s\n' "$(file_hash "$shell_file")"
} | sha256sum | cut -d ' ' -f 1)"
audio_base="$data_root/workspaces/spikes/issue-7/runs/$source_identity"
raw_base="$state_root/spikes/issue-7/runs/$source_identity"
build_log_base="$state_root/spikes/issue-7/builds/$source_identity"

canonical() {
  realpath -m -- "$1"
}

contains_path() {
  local parent child
  parent="$(canonical "$1")"
  child="$(canonical "$2")"
  [[ "$child" == "$parent" || "$child" == "$parent"/* ]]
}

existing_ancestor() {
  local candidate
  candidate="$(canonical "$1")"
  while [[ ! -e "$candidate" ]]; do
    local parent
    parent="$(dirname "$candidate")"
    [[ "$parent" != "$candidate" ]] || fail "no existing ancestor for path: $1"
    candidate="$parent"
  done
  realpath -- "$candidate"
}

validate_isolated_ext4_paths() {
  [[ "$(uname -s)" == Linux ]] || fail 'runtime setup requires Linux/WSL2'
  grep -qi 'microsoft.*wsl2' /proc/version || fail 'runtime setup requires WSL2'
  local path ancestor left right
  local -a tts_paths=("$runtime_root" "$model_root" "$audio_base" "$raw_base" "$build_log_base")
  for path in "${tts_paths[@]}"; do
    contains_path "$repo_root" "$path" && fail "runtime artifact path is inside Git: $path"
    contains_path "$path" "$repo_root" && fail "runtime artifact path contains Git: $path"
    ancestor="$(existing_ancestor "$path")"
    [[ "$(findmnt -n -o FSTYPE -T "$ancestor")" == ext4 ]] || fail "path is not on ext4: $path"
    contains_path "$brain_root" "$path" && fail "TTS artifact path overlaps the brain runtime: $path"
    contains_path "$path" "$brain_root" && fail "brain runtime overlaps a TTS artifact path: $path"
  done
  for ((left = 0; left < ${#tts_paths[@]}; left += 1)); do
    for ((right = left + 1; right < ${#tts_paths[@]}; right += 1)); do
      if contains_path "${tts_paths[left]}" "${tts_paths[right]}" || contains_path "${tts_paths[right]}" "${tts_paths[left]}"; then
        fail "TTS artifact roots overlap: ${tts_paths[left]} and ${tts_paths[right]}"
      fi
    done
  done
  return 0
}

new_run_directory() {
  local base="$1" kind="$2" attempt run_id target
  mkdir -p -- "$base"
  for attempt in {1..20}; do
    run_id="${kind}-${source_identity:0:16}-$(date -u +%Y%m%dT%H%M%S.%NZ)-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
    target="$base/$run_id"
    if mkdir -- "$target" 2>/dev/null; then
      printf '%s\n' "$target"
      return 0
    fi
  done
  fail "could not allocate collision-safe $kind run directory"
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
  validate_isolated_ext4_paths
  local source="$runtime_root/source"
  mkdir -p -- "$runtime_root"
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
  validate_isolated_ext4_paths
  checkout_source
  local cuda_home="${CUDA_HOME:-/usr/local/cuda}" build_run clean_build
  [[ -x "$cuda_home/bin/nvcc" ]] || fail "CUDA compiler not found: $cuda_home/bin/nvcc"
  export PATH="$cuda_home/bin:$PATH"
  export LD_LIBRARY_PATH="$cuda_home/lib64${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  build_run="$(new_run_directory "$build_log_base" build)"
  clean_build=false
  if [[ "${VOXCPM2_CLEAN_BUILD:-0}" == 1 ]]; then
    rm -rf -- "$runtime_root/build"
    clean_build=true
  fi
  mkdir -p -- "$runtime_root/build"
  local nvcc_version cmake_version cxx_version runtime_tree
  nvcc_version="$(nvcc --version | tail -1)"
  cmake_version="$(cmake --version | head -1)"
  cxx_version="$(g++ --version | head -1)"
  runtime_tree="$(git -C "$runtime_root/source" rev-parse 'HEAD^{tree}')"
  {
    printf 'started_at=%s\n' "$(date -u +%FT%TZ)"
    printf 'runtime_revision=%s\n' "$runtime_revision"
    printf 'runtime_tree=%s\n' "$runtime_tree"
    printf 'source_identity=%s\n' "$source_identity"
    printf 'nvcc=%s\n' "$nvcc_version"
    printf 'cmake=%s\n' "$cmake_version"
    printf 'cxx=%s\n' "$cxx_version"
  } > "$build_run/build-metadata.txt"
  /usr/bin/time -v cmake -S "$runtime_root/source" -B "$runtime_root/build" \
    -DGGML_CUDA=ON "-DCMAKE_CUDA_ARCHITECTURES=$(json 'x.build.cudaArchitecture')" \
    "-DCMAKE_CUDA_COMPILER=$cuda_home/bin/nvcc" -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=ON -DLLAMA_BUILD_TOOLS=ON -DLLAMA_BUILD_SERVER=ON \
    -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_APP=OFF \
    -DLLAMA_BUILD_UI=OFF -DLLAMA_USE_PREBUILT_UI=OFF -DLLAMA_OPENSSL=OFF \
    > "$build_run/cmake-configure.log" 2> "$build_run/cmake-configure-time.log"
  /usr/bin/time -v cmake --build "$runtime_root/build" --parallel "$(nproc)" \
    --target $(json 'x.build.targets.join(" ")') > "$build_run/cmake-build.log" \
    2> "$build_run/cmake-build-time.log"
  printf 'finished_at=%s\n' "$(date -u +%FT%TZ)" >> "$build_run/build-metadata.txt"
  [[ -x "$runtime_root/build/bin/voxcpm2-cli" ]] || fail 'voxcpm2-cli was not built'
  [[ -x "$runtime_root/build/bin/llama-tts-server" ]] || fail 'llama-tts-server was not built'
  ldd "$runtime_root/build/bin/voxcpm2-cli" | grep -q 'libggml-cuda' || fail 'CLI is not linked to the CUDA backend'
  ldd "$runtime_root/build/bin/llama-tts-server" | grep -q 'libggml-cuda' || fail 'server is not linked to the CUDA backend'

  BUILD_RUN="$build_run" SOURCE_IDENTITY="$source_identity" CLEAN_BUILD="$clean_build" \
    RUNTIME_REVISION="$runtime_revision" RUNTIME_TREE="$runtime_tree" \
    CUDA_ARCHITECTURE="$(json 'x.build.cudaArchitecture')" NVCC_VERSION="$nvcc_version" \
    CMAKE_VERSION="$cmake_version" CXX_VERSION="$cxx_version" \
    CLI_PATH="$runtime_root/build/bin/voxcpm2-cli" SERVER_PATH="$runtime_root/build/bin/llama-tts-server" \
    CMAKE_CACHE_PATH="$runtime_root/build/CMakeCache.txt" BUILD_METADATA_PATH="$build_run/build-metadata.txt" \
    node <<'NODE'
const { createHash } = require('node:crypto')
const { readFileSync, writeFileSync } = require('node:fs')
const { basename, join } = require('node:path')
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const parseTime = (text) => {
  const value = text.match(/Elapsed \(wall clock\) time .*: (.+)/)?.[1]
  const parts = value?.split(':').map(Number) ?? []
  let elapsedSeconds = null
  if (parts.length === 2) elapsedSeconds = parts[0] * 60 + parts[1]
  if (parts.length === 3) elapsedSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2]
  const rss = Number(text.match(/Maximum resident set size \(kbytes\): ([0-9]+)/)?.[1])
  return { elapsedSeconds, peakRamMiB: Number.isFinite(rss) ? rss / 1024 : null }
}
const run = process.env.BUILD_RUN
const manifest = {
  schemaVersion: 2,
  runId: basename(run),
  sourceIdentity: process.env.SOURCE_IDENTITY,
  cleanBuild: process.env.CLEAN_BUILD === 'true',
  runtimeSource: {
    revision: process.env.RUNTIME_REVISION,
    tree: process.env.RUNTIME_TREE,
  },
  toolchain: {
    cmake: process.env.CMAKE_VERSION,
    cxx: process.env.CXX_VERSION,
    nvcc: process.env.NVCC_VERSION,
  },
  configuration: {
    buildType: 'Release',
    cuda: true,
    cudaArchitecture: process.env.CUDA_ARCHITECTURE,
    cmakeCacheSha256: hash(process.env.CMAKE_CACHE_PATH),
    buildMetadataSha256: hash(process.env.BUILD_METADATA_PATH),
  },
  configureTiming: parseTime(readFileSync(join(run, 'cmake-configure-time.log'), 'utf8')),
  compileTiming: parseTime(readFileSync(join(run, 'cmake-build-time.log'), 'utf8')),
  binaries: {
    'voxcpm2-cli': hash(process.env.CLI_PATH),
    'llama-tts-server': hash(process.env.SERVER_PATH),
  },
}
writeFileSync(join(run, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
NODE
  printf 'Build run: %s\n' "$(basename "$build_run")"
}

download_models() {
  validate_isolated_ext4_paths
  mkdir -p -- "$model_root"
  while IFS=$'\t' read -r name size expected; do
    local local_path partial
    local_path="$model_root/$name"
    partial="$local_path.partial"
    if [[ -f "$local_path" ]]; then
      [[ "$(stat -c %s "$local_path")" == "$size" ]] || fail "wrong model size: $name"
      [[ "$(sha256sum "$local_path" | cut -d ' ' -f 1)" == "$expected" ]] || fail "wrong model checksum: $name"
      continue
    fi
    curl --fail --location --retry 5 --retry-all-errors --continue-at - \
      --output "$partial" \
      "https://huggingface.co/$(json 'x.ggufModel.repository')/resolve/$model_revision/$name"
    [[ "$(stat -c %s "$partial")" == "$size" ]] || fail "incomplete model download: $name"
    [[ "$(sha256sum "$partial" | cut -d ' ' -f 1)" == "$expected" ]] || fail "model checksum mismatch: $name"
    mv "$partial" "$local_path"
  done < <(node -e "const x=require(process.argv[1]); for(const a of x.ggufModel.assets) console.log([a.name,a.size,a.sha256].join('\\t'))" "$lock_file")
  printf 'Verified model assets in %s\n' "$model_root"
}

print_paths() {
  printf 'source_identity=%s\nruntime_root=%s\nmodel_root=%s\naudio_base=%s\nraw_base=%s\nbuild_log_base=%s\n' \
    "$source_identity" "$runtime_root" "$model_root" "$audio_base" "$raw_base" "$build_log_base"
}

command_name="${1:-help}"
case "$command_name" in
  verify) verify_upstream ;;
  paths) validate_isolated_ext4_paths; print_paths ;;
  checkout) verify_upstream; checkout_source ;;
  build) verify_upstream; build_runtime ;;
  download) verify_upstream; download_models ;;
  setup) verify_upstream; build_runtime; download_models; print_paths ;;
  probe)
    validate_isolated_ext4_paths
    VOXCPM2_RUNTIME_ROOT="$runtime_root" VOXCPM2_MODEL_ROOT="$model_root" \
      VOXCPM2_AUDIO_BASE="$audio_base" VOXCPM2_RAW_BASE="$raw_base" \
      VOXCPM2_BUILD_LOG_BASE="$build_log_base" VOXCPM2_SOURCE_IDENTITY="$source_identity" \
      node "$probe_file" "${@:2}"
    ;;
  *)
    printf 'Usage: %s {verify|paths|checkout|build|download|setup|probe}\n' "$0" >&2
    [[ "$command_name" == help ]] || exit 2
    ;;
esac
