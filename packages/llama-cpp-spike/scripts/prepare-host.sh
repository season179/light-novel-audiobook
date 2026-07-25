#!/usr/bin/env bash
set -euo pipefail

runtime_root="${LLAMA_CPP_SPIKE_ROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/light-novel-audiobook/issue-5}"
llama_commit='555881ebc8b0fc0402b30e09258a32a7bfd13c52'
model_repository='bartowski/SmolLM2-135M-Instruct-GGUF'
model_revision='09816acd5d99df7be770d85ea30822623dab342c'
model_file='SmolLM2-135M-Instruct-Q4_K_M.gguf'
model_sha256='2e8040ceae7815abe0dcb3540b9995eaa1fa0d2ca9e797d0a635ae4433c68c2d'
source_dir="$runtime_root/llama.cpp"
model_dir="$runtime_root/models"
model_path="$model_dir/$model_file"

mkdir -p "$runtime_root" "$model_dir"
filesystem_type="$(findmnt -n -o FSTYPE -T "$runtime_root")"
if [[ "$filesystem_type" != 'ext4' ]]; then
  printf 'Refusing runtime root %s: expected ext4, found %s\n' "$runtime_root" "$filesystem_type" >&2
  exit 1
fi

if [[ ! -d "$source_dir/.git" ]]; then
  git clone --filter=blob:none https://github.com/ggml-org/llama.cpp.git "$source_dir"
fi
git -C "$source_dir" fetch --depth 1 origin "$llama_commit"
git -C "$source_dir" checkout --detach "$llama_commit"
test "$(git -C "$source_dir" rev-parse HEAD)" = "$llama_commit"

if [[ -f "$model_path" ]] && ! printf '%s  %s\n' "$model_sha256" "$model_path" | sha256sum --check --status; then
  rm -f "$model_path"
fi
if [[ ! -f "$model_path" ]]; then
  model_url="https://huggingface.co/$model_repository/resolve/$model_revision/$model_file?download=true"
  curl -fL --retry 4 --retry-all-errors --output "$model_path.part" "$model_url"
  mv "$model_path.part" "$model_path"
fi
printf '%s  %s\n' "$model_sha256" "$model_path" | sha256sum --check

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
"$source_dir/build/bin/llama-server" --version
printf 'Pinned host runtime is ready under %s (not in Git).\n' "$runtime_root"
