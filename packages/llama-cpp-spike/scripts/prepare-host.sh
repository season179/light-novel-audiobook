#!/usr/bin/env bash
set -euo pipefail

runtime_root_input="${LLAMA_CPP_SPIKE_ROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/light-novel-audiobook/issue-5}"

reject_symlink_components() {
  local candidate="$1" current='/' segment
  local -a segments
  [[ "$candidate" = /* ]] || { printf 'Expected an absolute path: %s\n' "$candidate" >&2; exit 1; }
  IFS='/' read -r -a segments <<< "${candidate#/}"
  for segment in "${segments[@]}"; do
    [[ -n "$segment" ]] || continue
    current="${current%/}/$segment"
    if [[ -L "$current" ]]; then
      printf 'Refusing symbolic-link path component: %s\n' "$current" >&2
      exit 1
    fi
  done
}

runtime_root_lexical="$(realpath -ms "$runtime_root_input")"
reject_symlink_components "$runtime_root_lexical"
runtime_root="$(realpath -m "$runtime_root_lexical")"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(git -C "$script_dir" rev-parse --show-toplevel)"
repository_root="$(realpath "$repository_root")"
llama_repository='https://github.com/ggml-org/llama.cpp.git'
llama_commit='555881ebc8b0fc0402b30e09258a32a7bfd13c52'
llama_license_sha256='94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d'
model_repository='bartowski/SmolLM2-135M-Instruct-GGUF'
model_revision='09816acd5d99df7be770d85ea30822623dab342c'
model_file='SmolLM2-135M-Instruct-Q4_K_M.gguf'
model_sha256='2e8040ceae7815abe0dcb3540b9995eaa1fa0d2ca9e797d0a635ae4433c68c2d'
quant_readme_sha256='09b1f05942d11f5c47aac9789dde6fa8e431cdd541028532a7fb6f1c0e63d939'
instruct_revision='12fd25f77366fa6b3b4b768ec3050bf629380bac'
instruct_readme_sha256='4f97533ad95b1b2fea15fbc075c01b94578ebdd7c8138888fa43fa3abd530dc4'
base_revision='93efa2f097d58c2a74874c7e644dbc9b0cee75a2'
base_readme_sha256='d1ba68cae64a89b6b434b11526e6e2271ee5ffd2c914ec35ed515f9d84c6085c'
source_dir="$runtime_root/llama.cpp"
model_dir="$runtime_root/models"
model_path="$model_dir/$model_file"
license_dir="$runtime_root/license-evidence"
llama_license_path="$license_dir/llama.cpp-LICENSE"
quant_readme_path="$license_dir/quantization-README.md"
instruct_readme_path="$license_dir/instruct-README.md"
base_readme_path="$license_dir/base-README.md"
temporary_source="$runtime_root/.llama.cpp.prepare.$$"
model_part="$model_path.part"
host_manifest="$runtime_root/host-build.json"
host_manifest_tmp="$host_manifest.tmp"

# Validate the nearest existing ancestor and repository separation before any mutation.
probe="$runtime_root"
while [[ ! -e "$probe" ]]; do
  parent="$(dirname "$probe")"
  [[ "$parent" != "$probe" ]] || { printf 'No existing ancestor for %s\n' "$runtime_root" >&2; exit 1; }
  probe="$parent"
done
canonical_probe="$(realpath "$probe")"
filesystem_type="$(findmnt -n -o FSTYPE -T "$canonical_probe")"
if [[ "$filesystem_type" != 'ext4' ]]; then
  printf 'Refusing runtime root %s: expected ext4, found %s\n' "$runtime_root" "$filesystem_type" >&2
  exit 1
fi
case "$runtime_root/" in
  "$repository_root/"*) printf 'Runtime root overlaps the Git worktree\n' >&2; exit 1 ;;
esac
case "$repository_root/" in
  "$runtime_root/"*) printf 'Runtime root contains the Git worktree\n' >&2; exit 1 ;;
esac
for protected_path in \
  "$runtime_root" "$source_dir" "$model_dir" "$model_path" "$model_part" \
  "$license_dir" "$llama_license_path" "$llama_license_path.part" \
  "$quant_readme_path" "$quant_readme_path.part" \
  "$instruct_readme_path" "$instruct_readme_path.part" \
  "$base_readme_path" "$base_readme_path.part" \
  "$temporary_source" "$host_manifest" "$host_manifest_tmp"; do
  reject_symlink_components "$protected_path"
done

cleanup_temporary_files() {
  rm -rf -- "$temporary_source"
  rm -f -- "$model_part" "$license_dir"/*.part "$host_manifest_tmp" 2>/dev/null || true
}
trap cleanup_temporary_files EXIT

mkdir -p "$runtime_root" "$model_dir" "$license_dir"
rm -rf -- "$source_dir" "$temporary_source"
mkdir -p "$temporary_source"
git -C "$temporary_source" init --quiet
git -C "$temporary_source" remote add origin "$llama_repository"
git -C "$temporary_source" fetch --depth 1 origin "$llama_commit"
git -C "$temporary_source" checkout --quiet --detach FETCH_HEAD
test "$(git -C "$temporary_source" rev-parse HEAD)" = "$llama_commit"
test "$(git -C "$temporary_source" remote get-url origin)" = "$llama_repository"
test -z "$(git -C "$temporary_source" status --porcelain --untracked-files=no)"
mv "$temporary_source" "$source_dir"

if [[ -f "$model_path" ]] && ! printf '%s  %s\n' "$model_sha256" "$model_path" | sha256sum --check --status; then
  rm -f -- "$model_path"
fi
if [[ ! -f "$model_path" ]]; then
  reject_symlink_components "$model_path"
  reject_symlink_components "$model_part"
  model_url="https://huggingface.co/$model_repository/resolve/$model_revision/$model_file?download=true"
  curl -fL --retry 4 --retry-all-errors --output "$model_part" "$model_url"
  mv "$model_part" "$model_path"
fi
printf '%s  %s\n' "$model_sha256" "$model_path" | sha256sum --check

fetch_hashed_document() {
  local url="$1" destination="$2" expected="$3"
  reject_symlink_components "$destination"
  reject_symlink_components "$destination.part"
  curl -fsSL --retry 4 --retry-all-errors --output "$destination.part" "$url"
  printf '%s  %s\n' "$expected" "$destination.part" | sha256sum --check
  mv "$destination.part" "$destination"
}
fetch_hashed_document \
  "https://raw.githubusercontent.com/ggml-org/llama.cpp/$llama_commit/LICENSE" \
  "$llama_license_path" "$llama_license_sha256"
fetch_hashed_document \
  "https://huggingface.co/$model_repository/raw/$model_revision/README.md" \
  "$quant_readme_path" "$quant_readme_sha256"
fetch_hashed_document \
  "https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct/raw/$instruct_revision/README.md" \
  "$instruct_readme_path" "$instruct_readme_sha256"
fetch_hashed_document \
  "https://huggingface.co/HuggingFaceTB/SmolLM2-135M/raw/$base_revision/README.md" \
  "$base_readme_path" "$base_readme_sha256"

# The source checkout and build directory are recreated on every preparation run.
cmake \
  -S "$source_dir" \
  -B "$source_dir/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_CUDA=OFF \
  -DLLAMA_CURL=OFF \
  -DLLAMA_BUILD_TESTS=OFF \
  -DLLAMA_BUILD_EXAMPLES=OFF \
  -DLLAMA_BUILD_SERVER=ON
cmake --build "$source_dir/build" --config Release --target llama-server -j "$(nproc)"
test "$(git -C "$source_dir" rev-parse HEAD)" = "$llama_commit"
test -z "$(git -C "$source_dir" status --porcelain --untracked-files=no)"
git -C "$source_dir" diff --quiet HEAD --

binary_path="$source_dir/build/bin/llama-server"
binary_sha256="$(sha256sum "$binary_path" | cut -d' ' -f1)"
reject_symlink_components "$host_manifest"
reject_symlink_components "$host_manifest_tmp"
printf '%s\n' \
  '{' \
  '  "schemaVersion": 1,' \
  "  \"llamaCommit\": \"$llama_commit\"," \
  "  \"binarySha256\": \"$binary_sha256\"," \
  "  \"modelRevision\": \"$model_revision\"," \
  "  \"modelSha256\": \"$model_sha256\"," \
  '  "cleanSourceCheckout": true,' \
  '  "cleanRebuild": true' \
  '}' > "$host_manifest_tmp"
mv "$host_manifest_tmp" "$host_manifest"
"$binary_path" --version
printf 'Pinned clean host runtime is ready under %s (not in Git); binary SHA-256 %s.\n' \
  "$runtime_root" "$binary_sha256"
