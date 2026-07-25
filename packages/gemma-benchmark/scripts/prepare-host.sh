#!/usr/bin/env bash
set -euo pipefail

runtime_input="${GEMMA_BENCHMARK_ROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/light-novel-audiobook/issue-6-brain}"
llama_repo='https://github.com/ggml-org/llama.cpp.git'
llama_commit='555881ebc8b0fc0402b30e09258a32a7bfd13c52'
llama_license_sha='94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d'
model_repo='google/gemma-4-26B-A4B-it-qat-q4_0-gguf'
model_revision='d1c082be9cf3c8a514acf63b8761f4b41935842e'
model_file='gemma-4-26B_q4_0-it.gguf'
model_size='14439363584'
model_sha='3eca3b8f6d7baf218a7dd6bba5fb59a56ee25fe2d567b6f5f589b4f697eca51d'
card_sha='f9e8c5e65c069adf1ea0e212f5c20303e68e78469bf549d10e631fe9c3612873'
gitattributes_sha='e33a964fc605748fe74d1c47c08def72764bd8fe0300648a3d1e8fc305944eaa'
apache_license_sha='cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'
cuda_root="${CUDA_HOME:-/usr/local/cuda-13.0}"

reject_symlinks() {
  local path="$1" current='/' part
  IFS='/' read -r -a parts <<< "${path#/}"
  for part in "${parts[@]}"; do
    [[ -n "$part" ]] || continue
    current="${current%/}/$part"
    [[ ! -L "$current" ]] || { printf 'Refusing symlink component.\n' >&2; exit 1; }
  done
}

runtime_root="$(realpath -ms "$runtime_input")"
reject_symlinks "$runtime_root"
repo_root="$(realpath "$(git rev-parse --show-toplevel)")"
case "$runtime_root/" in "$repo_root/"*) printf 'Runtime overlaps Git.\n' >&2; exit 1;; esac
case "$repo_root/" in "$runtime_root/"*) printf 'Runtime contains Git.\n' >&2; exit 1;; esac
probe="$runtime_root"
while [[ ! -e "$probe" ]]; do probe="$(dirname "$probe")"; done
[[ "$(findmnt -n -o FSTYPE -T "$probe")" == ext4 ]] || { printf 'Runtime must use ext4.\n' >&2; exit 1; }

source_dir="$runtime_root/llama.cpp"
model_dir="$runtime_root/models"
model_path="$model_dir/$model_file"
evidence_dir="$runtime_root/provenance"
manifest="$runtime_root/host-build.json"
for path in "$runtime_root" "$source_dir" "$model_dir" "$model_path" "$evidence_dir" "$manifest"; do reject_symlinks "$path"; done
mkdir -p "$runtime_root" "$model_dir" "$evidence_dir"
chmod 700 "$runtime_root" "$model_dir" "$evidence_dir"

fetch_hashed() {
  local url="$1" output="$2" expected="$3"
  reject_symlinks "$output"
  curl -fsSL --retry 4 --retry-all-errors "$url" -o "$output.part"
  printf '%s  %s\n' "$expected" "$output.part" | sha256sum --check --status
  mv "$output.part" "$output"
  chmod 400 "$output"
}

api_path="$evidence_dir/hugging-face-revision-api.json"
curl -fsSL --retry 4 --retry-all-errors \
  "https://huggingface.co/api/models/$model_repo/revision/$model_revision?blobs=true" -o "$api_path.part"
MODEL_REPO="$model_repo" MODEL_REVISION="$model_revision" MODEL_FILE="$model_file" \
MODEL_SIZE="$model_size" MODEL_SHA="$model_sha" node - "$api_path.part" <<'NODE'
const fs = require('node:fs')
const path = process.argv[2]
const value = JSON.parse(fs.readFileSync(path, 'utf8'))
const file = value.siblings?.find((item) => item.rfilename === process.env.MODEL_FILE)
if (value.id !== process.env.MODEL_REPO || value.sha !== process.env.MODEL_REVISION ||
    value.private !== false || value.gated !== false || value.cardData?.license !== 'apache-2.0' ||
    file?.size !== Number(process.env.MODEL_SIZE) || file?.lfs?.size !== Number(process.env.MODEL_SIZE) ||
    file?.lfs?.sha256 !== process.env.MODEL_SHA) process.exit(1)
if (value.siblings?.some((item) => /mmproj/i.test(item.rfilename))) {
  // Presence upstream is allowed; this preparation deliberately selects only the exact text file.
}
NODE
mv "$api_path.part" "$api_path"
chmod 400 "$api_path"

headers="$evidence_dir/text-model-resolve.headers"
curl -fsSI "https://huggingface.co/$model_repo/resolve/$model_revision/$model_file?download=true" -o "$headers.part"
grep -qi "^x-linked-size: $model_size" "$headers.part"
grep -qi "^x-linked-etag: \"$model_sha\"" "$headers.part"
mv "$headers.part" "$headers"
chmod 400 "$headers"

fetch_hashed "https://huggingface.co/$model_repo/raw/$model_revision/README.md" "$evidence_dir/model-card.md" "$card_sha"
fetch_hashed "https://huggingface.co/$model_repo/raw/$model_revision/.gitattributes" "$evidence_dir/gitattributes" "$gitattributes_sha"
fetch_hashed 'https://www.apache.org/licenses/LICENSE-2.0.txt' "$evidence_dir/Apache-2.0.txt" "$apache_license_sha"
fetch_hashed "https://raw.githubusercontent.com/ggml-org/llama.cpp/$llama_commit/LICENSE" "$evidence_dir/llama.cpp-LICENSE" "$llama_license_sha"

if [[ -f "$model_path" ]]; then
  [[ "$(stat -c %s "$model_path")" == "$model_size" ]] || rm -f "$model_path"
fi
if [[ ! -f "$model_path" ]]; then
  curl -fL --retry 8 --retry-all-errors --continue-at - \
    "https://huggingface.co/$model_repo/resolve/$model_revision/$model_file?download=true" \
    -o "$model_path.part"
  [[ "$(stat -c %s "$model_path.part")" == "$model_size" ]]
  printf '%s  %s\n' "$model_sha" "$model_path.part" | sha256sum --check
  mv "$model_path.part" "$model_path"
fi
printf '%s  %s\n' "$model_sha" "$model_path" | sha256sum --check
chmod 400 "$model_path"
if find "$model_dir" -maxdepth 1 -type f -iname '*mmproj*' | grep -q .; then
  printf 'Refusing unexpected mmproj artifact.\n' >&2
  exit 1
fi

rm -rf "$source_dir.part"
git init --quiet "$source_dir.part"
git -C "$source_dir.part" remote add origin "$llama_repo"
git -C "$source_dir.part" fetch --depth 1 origin "$llama_commit"
git -C "$source_dir.part" checkout --quiet --detach FETCH_HEAD
rm -rf "$source_dir"
mv "$source_dir.part" "$source_dir"

export PATH="$cuda_root/bin:$PATH"
[[ -x "$cuda_root/bin/nvcc" ]] || { printf 'Pinned CUDA compiler was not found.\n' >&2; exit 1; }
cmake_args=(
  -DCMAKE_BUILD_TYPE=Release
  -DCMAKE_CUDA_ARCHITECTURES=120
  -DGGML_CUDA=ON
  -DLLAMA_CURL=OFF
  -DLLAMA_BUILD_TESTS=OFF
  -DLLAMA_BUILD_EXAMPLES=OFF
  -DLLAMA_BUILD_SERVER=ON
)
cmake -S "$source_dir" -B "$source_dir/build" "${cmake_args[@]}"
cmake --build "$source_dir/build" --config Release --target llama-server -j "$(nproc)"
[[ "$(git -C "$source_dir" rev-parse HEAD)" == "$llama_commit" ]]
[[ -z "$(git -C "$source_dir" status --porcelain --untracked-files=no)" ]]

binary="$source_dir/build/bin/llama-server"
binary_sha="$(sha256sum "$binary" | cut -d' ' -f1)"
cuda_compiler="$($cuda_root/bin/nvcc --version | tail -1 | tr -d '\r')"
config_sha="$(printf '%s\n' "${cmake_args[@]}" | sha256sum | cut -d' ' -f1)"
cat > "$manifest.part" <<JSON
{"schemaVersion":1,"llamaCommit":"$llama_commit","binarySha256":"$binary_sha","modelRevision":"$model_revision","modelSha256":"$model_sha","modelSizeBytes":$model_size,"cudaCompiler":"$cuda_compiler","cmakeConfigurationSha256":"$config_sha","cleanSourceCheckout":true,"cleanRebuild":true,"textModelOnly":true}
JSON
if [[ -e "$manifest" ]]; then
  cmp -s "$manifest" "$manifest.part" || { printf 'Immutable host manifest differs; use a fresh root.\n' >&2; exit 1; }
  rm "$manifest.part"
else
  mv "$manifest.part" "$manifest"
  chmod 400 "$manifest"
fi
"$binary" --version
printf 'Pinned CUDA brain runtime and verified text-only GGUF are ready outside Git.\n'
