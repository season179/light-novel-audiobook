#!/usr/bin/env bash

set -euo pipefail

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lock_file="$repo_root/config/synthetic-voice-bootstrap.lock.json"
vox_lock_file="$repo_root/config/voxcpm2-spike.lock.json"
probe_file="$repo_root/scripts/probe-synthetic-voices.mjs"
core_file="$repo_root/scripts/synthetic-voices/core.mjs"
vox_core_file="$repo_root/scripts/voxcpm2/core.mjs"
shell_file="$repo_root/scripts/synthetic-voice-bootstrap.sh"
for file in "$lock_file" "$vox_lock_file" "$probe_file" "$core_file" "$vox_core_file"; do
  [[ -f "$file" ]] || fail "missing harness file: $file"
done

json() {
  node -e "const x=require(process.argv[1]); console.log($1)" "$lock_file"
}

vox_json() {
  node -e "const x=require(process.argv[1]); console.log($1)" "$vox_lock_file"
}

file_hash() {
  sha256sum "$1" | cut -d ' ' -f 1
}

espeak_revision="$(json 'x.espeakNg.revision')"
data_root="${SYNTH_VOICE_DATA_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/light-novel-audiobook}"
state_root="${SYNTH_VOICE_STATE_ROOT:-${XDG_STATE_HOME:-$HOME/.local/state}/light-novel-audiobook}"
espeak_tool_root="$data_root/tools/espeak-ng/$espeak_revision"
espeak_source_root="$espeak_tool_root/source"
config_hash="$(node --input-type=module - "$lock_file" "$core_file" <<'NODE'
import { pathToFileURL } from 'node:url'
const [lockPath, corePath] = process.argv.slice(2)
const { loadBootstrapLock, stableJsonHash } = await import(pathToFileURL(corePath))
const lock = await loadBootstrapLock(lockPath)
console.log(stableJsonHash(lock.espeakNg.build))
NODE
)"
voice_selection_hash="$(node --input-type=module - "$lock_file" "$core_file" <<'NODE'
import { pathToFileURL } from 'node:url'
const [lockPath, corePath] = process.argv.slice(2)
const { loadBootstrapLock, stableJsonHash } = await import(pathToFileURL(corePath))
const lock = await loadBootstrapLock(lockPath)
console.log(stableJsonHash(lock.espeakNg.voiceSources))
NODE
)"
build_identity="$({
  printf 'revision:%s\n' "$espeak_revision"
  printf 'tree:%s\n' "$(json 'x.espeakNg.sourceTree')"
  printf 'configuration:%s\n' "$config_hash"
  printf 'voice-selection:%s\n' "$voice_selection_hash"
} | sha256sum | cut -d ' ' -f 1)"
# The compiled runtime data path is also limited to 160 bytes upstream.
espeak_install_root="${SYNTH_VOICE_INSTALL_ROOT:-$HOME/.local/share/lna-i8/espeak}/$build_identity"
# eSpeak NG 1.52.0 uses a 160-byte internal data path buffer. Keep the external
# build path short while retaining the full build identity in its manifest.
build_base="${SYNTH_VOICE_BUILD_ROOT:-$HOME/.i8-builds}/${build_identity:0:16}"
source_identity="$({
  printf 'config:%s\n' "$(file_hash "$lock_file")"
  printf 'core:%s\n' "$(file_hash "$core_file")"
  printf 'probe:%s\n' "$(file_hash "$probe_file")"
  printf 'shell:%s\n' "$(file_hash "$shell_file")"
  printf 'voxConfig:%s\n' "$(file_hash "$vox_lock_file")"
  printf 'voxCore:%s\n' "$(file_hash "$vox_core_file")"
} | sha256sum | cut -d ' ' -f 1)"
# Keep eSpeak's create-new WAV paths below the same upstream fixed buffer.
audio_base="${SYNTH_VOICE_AUDIO_ROOT:-$HOME/.i8-runs}/${source_identity:0:16}"
raw_base="$state_root/spikes/issue-8/runs/$source_identity"
vox_runtime_revision="$(vox_json 'x.runtime.revision')"
vox_model_revision="$(vox_json 'x.ggufModel.revision')"
vox_runtime_root="${VOXCPM2_RUNTIME_ROOT:-$data_root/runtimes/tts/llama.cpp-omni/$vox_runtime_revision}"
vox_model_root="${VOXCPM2_MODEL_ROOT:-$data_root/models/tts/voxcpm2/$vox_model_revision}"
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

existing_ancestor() {
  local candidate parent
  candidate="$(canonical "$1")"
  while [[ ! -e "$candidate" ]]; do
    parent="$(dirname "$candidate")"
    [[ "$parent" != "$candidate" ]] || fail "no existing ancestor for path: $1"
    candidate="$parent"
  done
  realpath -- "$candidate"
}

validate_paths() {
  [[ "$(uname -s)" == Linux ]] || fail 'synthetic voice experiment requires Linux/WSL2'
  grep -qi 'microsoft.*wsl2' /proc/version || fail 'synthetic voice host run requires WSL2'
  local path ancestor left right
  local -a paths=(
    "$espeak_source_root"
    "$espeak_install_root"
    "$build_base"
    "$audio_base"
    "$raw_base"
    "$vox_runtime_root"
    "$vox_model_root"
  )
  for path in "${paths[@]}"; do
    contains_path "$repo_root" "$path" && fail "artifact path is inside Git: $path"
    contains_path "$path" "$repo_root" && fail "artifact path contains Git: $path"
    ancestor="$(existing_ancestor "$path")"
    [[ "$(findmnt -n -o FSTYPE -T "$ancestor")" == ext4 ]] || fail "artifact path is not ext4: $path"
    contains_path "$brain_root" "$path" && fail "artifact path overlaps brain runtime: $path"
    contains_path "$path" "$brain_root" && fail "brain runtime overlaps artifact path: $path"
  done
  for ((left = 0; left < ${#paths[@]}; left += 1)); do
    for ((right = left + 1; right < ${#paths[@]}; right += 1)); do
      if contains_path "${paths[left]}" "${paths[right]}" || contains_path "${paths[right]}" "${paths[left]}"; then
        fail "artifact roots overlap: ${paths[left]} and ${paths[right]}"
      fi
    done
  done
}

new_directory() {
  local base="$1" prefix="$2" attempt id target
  mkdir -p -- "$base"
  for attempt in {1..20}; do
    id="${prefix}-$(date -u +%Y%m%dT%H%M%S.%NZ)-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
    target="$base/$id"
    if mkdir -- "$target" 2>/dev/null; then
      printf '%s\n' "$target"
      return 0
    fi
  done
  fail "could not allocate immutable $prefix directory"
}

sha256_url() {
  curl --fail --silent --show-error --location "$1" | sha256sum | cut -d ' ' -f 1
}

verify_upstream() {
  local command_name actual base source_path expected
  for command_name in cmake curl git g++ node sha256sum; do
    command -v "$command_name" >/dev/null || fail "missing required command: $command_name"
  done
  actual="$(git ls-remote "$(json 'x.espeakNg.repository')" "refs/tags/$(json 'x.espeakNg.tag')" | cut -f1)"
  [[ "$actual" == "$espeak_revision" ]] || fail 'pinned eSpeak NG tag moved or is unavailable'
  base="https://raw.githubusercontent.com/espeak-ng/espeak-ng/$espeak_revision"
  [[ "$(sha256_url "$(json 'x.espeakNg.licenseUrl')")" == "$(json 'x.espeakNg.licenseSha256')" ]] || fail 'eSpeak NG GPL checksum mismatch'
  [[ "$(sha256_url "$base/README.md")" == "$(json 'x.espeakNg.readmeSha256')" ]] || fail 'eSpeak NG README checksum mismatch'
  [[ "$(sha256_url "$base/docs/voices.md")" == "$(json 'x.espeakNg.voiceDocumentationSha256')" ]] || fail 'eSpeak NG voice documentation checksum mismatch'
  while IFS=$'\t' read -r source_path expected; do
    [[ "$(sha256_url "$base/$source_path")" == "$expected" ]] || fail "eSpeak NG voice source checksum mismatch: $source_path"
  done < <(node -e "const x=require(process.argv[1]); for(const v of x.espeakNg.voiceSources) console.log(v.path+'\\t'+v.sha256)" "$lock_file")
  [[ "$(file_hash "$vox_lock_file")" == "$(json 'x.voxcpm2.lockSha256')" ]] || fail 'issue #7 VoxCPM2 lock checksum mismatch'
  printf 'Verified pinned GPL source, formant voice files, and issue #7 lock.\n'
}

checkout_source() {
  validate_paths
  local parent temporary
  parent="$(dirname "$espeak_source_root")"
  mkdir -p -- "$parent"
  if [[ ! -d "$espeak_source_root/.git" ]]; then
    [[ ! -e "$espeak_source_root" ]] || fail "eSpeak source target exists but is not a Git checkout: $espeak_source_root"
    temporary="$(mktemp -d "$parent/.source-staging-XXXXXXXX")"
    trap 'rm -rf -- "$temporary"' RETURN
    git init -q "$temporary"
    git -C "$temporary" remote add origin "$(json 'x.espeakNg.repository')"
    git -C "$temporary" fetch --depth=1 origin "$espeak_revision"
    git -C "$temporary" checkout -q --detach FETCH_HEAD
    [[ "$(git -C "$temporary" rev-parse 'HEAD^{tree}')" == "$(json 'x.espeakNg.sourceTree')" ]] || fail 'eSpeak source tree mismatch'
    mv -T -- "$temporary" "$espeak_source_root"
    trap - RETURN
  fi
  [[ "$(git -C "$espeak_source_root" remote get-url origin)" == "$(json 'x.espeakNg.repository')" ]] || fail 'eSpeak source remote mismatch'
  [[ "$(git -C "$espeak_source_root" rev-parse HEAD)" == "$espeak_revision" ]] || fail 'eSpeak source revision mismatch'
  [[ "$(git -C "$espeak_source_root" rev-parse 'HEAD^{tree}')" == "$(json 'x.espeakNg.sourceTree')" ]] || fail 'eSpeak source tree mismatch'
  [[ -z "$(git -C "$espeak_source_root" status --porcelain)" ]] || fail 'eSpeak source checkout is modified'
}

verify_install() {
  [[ -f "$espeak_install_root/manifest.json" && -x "$espeak_install_root/bin/espeak-ng" ]] || return 1
  ESPEAK_INSTALL_ROOT="$espeak_install_root" EXPECTED_REVISION="$espeak_revision" \
    EXPECTED_TREE="$(json 'x.espeakNg.sourceTree')" EXPECTED_CONFIG_HASH="$config_hash" \
    EXPECTED_VOICE_SELECTION_HASH="$voice_selection_hash" \
    node <<'NODE'
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const root = process.env.ESPEAK_INSTALL_ROOT
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
if (manifest.source.revision !== process.env.EXPECTED_REVISION) throw new Error('installed revision mismatch')
if (manifest.source.tree !== process.env.EXPECTED_TREE) throw new Error('installed tree mismatch')
if (manifest.configuration.sha256 !== process.env.EXPECTED_CONFIG_HASH) throw new Error('installed configuration mismatch')
if (manifest.voiceData.selectionSha256 !== process.env.EXPECTED_VOICE_SELECTION_HASH) throw new Error('installed voice selection mismatch')
if (manifest.binary.sha256 !== hash(join(root, 'bin/espeak-ng'))) throw new Error('installed binary mismatch')
NODE
}

build_espeak() {
  validate_paths
  checkout_source
  if verify_install; then
    printf 'Verified existing immutable eSpeak NG source build.\n'
    return 0
  fi
  [[ ! -e "$espeak_install_root" ]] || fail "incomplete immutable eSpeak install exists: $espeak_install_root"
  local build_run build_dir stage cmake_version cxx_version cache_hash binary_hash voice_tree_hash
  build_run="$(new_directory "$build_base" build)"
  build_dir="$build_run/build"
  # eSpeak NG embeds its data prefix before processing --path, so configure the
  # final create-new install path rather than moving a staged installation.
  stage="$espeak_install_root"
  cmake_version="$(cmake --version | head -1)"
  cxx_version="$(g++ --version | head -1)"
  cmake -S "$espeak_source_root" -B "$build_dir" \
    -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTING=OFF \
    -DUSE_MBROLA=OFF -DUSE_LIBSONIC=OFF -DUSE_LIBPCAUDIO=OFF \
    -DUSE_KLATT=ON -DUSE_SPEECHPLAYER=OFF -DUSE_ASYNC=OFF \
    -DSONIC_LIB:FILEPATH=/dev/null -DSONIC_INC:PATH=/dev/null \
    -DCMAKE_INSTALL_PREFIX="$stage" > "$build_run/configure.log" 2>&1
  cmake --build "$build_dir" --parallel 1 > "$build_run/build.log" 2>&1
  [[ ! -e "$stage" ]] || fail "immutable install target appeared during build: $stage"
  cmake --install "$build_dir" > "$build_run/install.log" 2>&1
  [[ -x "$stage/bin/espeak-ng" ]] || fail 'eSpeak NG binary was not installed'
  [[ -d "$stage/share/espeak-ng-data" ]] || fail 'eSpeak NG voice data was not installed'
  grep -q '^USE_MBROLA:BOOL=OFF$' "$build_dir/CMakeCache.txt" || fail 'MBROLA was not disabled in CMake cache'
  grep -q '^USE_LIBSONIC:BOOL=OFF$' "$build_dir/CMakeCache.txt" || fail 'libsonic was not disabled in CMake cache'
  cache_hash="$(file_hash "$build_dir/CMakeCache.txt")"
  binary_hash="$(file_hash "$stage/bin/espeak-ng")"
  voice_tree_hash="$(node --input-type=module - "$stage/share/espeak-ng-data" "$core_file" <<'NODE'
import { pathToFileURL } from 'node:url'
const [root, core] = process.argv.slice(2)
const { directoryTreeHash } = await import(pathToFileURL(core))
console.log(await directoryTreeHash(root))
NODE
)"
  BUILD_RUN="$build_run" STAGE="$stage" SOURCE_REVISION="$espeak_revision" \
    SOURCE_TREE="$(json 'x.espeakNg.sourceTree')" CONFIG_HASH="$config_hash" \
    CMAKE_VERSION="$cmake_version" CXX_VERSION="$cxx_version" CACHE_HASH="$cache_hash" \
    BINARY_HASH="$binary_hash" VOICE_TREE_HASH="$voice_tree_hash" \
    VOICE_SELECTION_HASH="$voice_selection_hash" LOCK_FILE="$lock_file" \
    node <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs')
const { basename, join } = require('node:path')
const lock = JSON.parse(readFileSync(process.env.LOCK_FILE, 'utf8'))
const manifest = {
  schemaVersion: 1,
  buildRunId: basename(process.env.BUILD_RUN),
  source: {
    repository: lock.espeakNg.repository,
    tag: lock.espeakNg.tag,
    revision: process.env.SOURCE_REVISION,
    tree: process.env.SOURCE_TREE,
    license: lock.espeakNg.license,
    licenseSha256: lock.espeakNg.licenseSha256,
  },
  configuration: {
    values: lock.espeakNg.build,
    sha256: process.env.CONFIG_HASH,
    cmakeCacheSha256: process.env.CACHE_HASH,
    configureArguments: [
      'CMAKE_BUILD_TYPE=Release', 'BUILD_SHARED_LIBS=OFF', 'BUILD_TESTING=OFF',
      'USE_MBROLA=OFF', 'USE_LIBSONIC=OFF', 'USE_LIBPCAUDIO=OFF', 'USE_KLATT=ON',
      'USE_SPEECHPLAYER=OFF', 'USE_ASYNC=OFF',
    ],
  },
  toolchain: { cmake: process.env.CMAKE_VERSION, cxx: process.env.CXX_VERSION },
  binary: { name: 'espeak-ng', sha256: process.env.BINARY_HASH },
  voiceData: {
    treeSha256: process.env.VOICE_TREE_HASH,
    selectionSha256: process.env.VOICE_SELECTION_HASH,
    selectedSourceFiles: lock.espeakNg.voiceSources,
    mbrolaOrSampledVoiceIncludedInCandidates: false,
  },
}
writeFileSync(join(process.env.STAGE, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
NODE
  BUILD_RUN="$build_run" INSTALL_MANIFEST="$espeak_install_root/manifest.json" node <<'NODE'
const { createHash } = require('node:crypto')
const { readFileSync, writeFileSync } = require('node:fs')
const { basename, join } = require('node:path')
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
writeFileSync(join(process.env.BUILD_RUN, 'manifest.json'), `${JSON.stringify({
  schemaVersion: 1,
  buildRunId: basename(process.env.BUILD_RUN),
  immutableInstallManifestSha256: sha256(process.env.INSTALL_MANIFEST),
  logs: {
    configureSha256: sha256(join(process.env.BUILD_RUN, 'configure.log')),
    buildSha256: sha256(join(process.env.BUILD_RUN, 'build.log')),
    installSha256: sha256(join(process.env.BUILD_RUN, 'install.log')),
  },
}, null, 2)}\n`, { flag: 'wx' })
NODE
  verify_install || fail 'new eSpeak NG install failed verification'
  printf 'Built immutable eSpeak NG install: %s\n' "$build_identity"
}

print_paths() {
  printf 'source_identity=%s\nbuild_identity=%s\nespeak_source_root=%s\nespeak_install_root=%s\naudio_base=%s\nraw_base=%s\nvox_runtime_root=%s\nvox_model_root=%s\n' \
    "$source_identity" "$build_identity" "$espeak_source_root" "$espeak_install_root" \
    "$audio_base" "$raw_base" "$vox_runtime_root" "$vox_model_root"
}

command_name="${1:-help}"
case "$command_name" in
  verify) verify_upstream ;;
  paths) validate_paths; print_paths ;;
  checkout) verify_upstream; checkout_source ;;
  build) verify_upstream; build_espeak ;;
  setup) verify_upstream; build_espeak; print_paths ;;
  probe)
    validate_paths
    verify_install || fail 'run setup before the synthetic voice probe'
    SYNTH_VOICE_ESPEAK_INSTALL_ROOT="$espeak_install_root" \
      SYNTH_VOICE_ESPEAK_SOURCE_ROOT="$espeak_source_root" \
      SYNTH_VOICE_AUDIO_BASE="$audio_base" SYNTH_VOICE_RAW_BASE="$raw_base" \
      SYNTH_VOICE_SOURCE_IDENTITY="$source_identity" \
      VOXCPM2_RUNTIME_ROOT="$vox_runtime_root" VOXCPM2_MODEL_ROOT="$vox_model_root" \
      node "$probe_file" "${@:2}"
    ;;
  *)
    printf 'Usage: %s {verify|paths|checkout|build|setup|probe}\n' "$0" >&2
    [[ "$command_name" == help ]] || exit 2
    ;;
esac
