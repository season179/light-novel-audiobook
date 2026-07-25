#!/usr/bin/env bash

set -euo pipefail
umask 077

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lock_file="$repo_root/config/qwen3-tts-custom-voice.lock.json"
core_file="$repo_root/scripts/qwen3-tts/core.py"
probe_file="$repo_root/scripts/probe-qwen3-tts.py"
shell_file="$repo_root/scripts/qwen3-tts-extension.sh"
pyproject_file="$repo_root/scripts/qwen3-tts-runtime/pyproject.toml"
uv_lock_file="$repo_root/scripts/qwen3-tts-runtime/uv.lock"
test_file="$repo_root/scripts/test/qwen3-tts-extension.test.py"
for file in "$lock_file" "$core_file" "$probe_file" "$shell_file" "$pyproject_file" "$uv_lock_file" "$test_file"; do
  [[ -f "$file" ]] || fail "missing Qwen3-TTS harness file: $file"
done

json() {
  python3 - "$lock_file" "$1" <<'PY'
import json,sys
value=json.load(open(sys.argv[1], encoding='utf-8'))
for part in sys.argv[2].split('.'):
    value=value[int(part)] if part.isdigit() else value[part]
if isinstance(value, bool): print(str(value).lower())
elif isinstance(value, (dict,list)): print(json.dumps(value, separators=(',',':')))
else: print(value)
PY
}

file_hash() { sha256sum "$1" | cut -d ' ' -f 1; }
model_revision="$(json model.revision)"
uv_lock_hash="$(file_hash "$uv_lock_file")"
data_root="${QWEN3_TTS_DATA_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/light-novel-audiobook}"
state_root="${QWEN3_TTS_STATE_ROOT:-${XDG_STATE_HOME:-$HOME/.local/state}/light-novel-audiobook}"
runtime_root="${QWEN3_TTS_RUNTIME_ROOT_OVERRIDE:-$data_root/runtimes/tts/qwen3-tts/$uv_lock_hash}"
model_root="${QWEN3_TTS_MODEL_ROOT_OVERRIDE:-$data_root/models/tts/qwen3-tts-custom-voice/$model_revision}"
model_snapshot="$model_root/snapshot"
brain_root="${BRAIN_RUNTIME_ROOT:-$data_root/runtimes/brain/llama.cpp}"
source_identity="$(python3 - "$repo_root" <<'PY'
import hashlib,sys
from pathlib import Path
root=Path(sys.argv[1])
paths={
 'config':'config/qwen3-tts-custom-voice.lock.json',
 'core':'scripts/qwen3-tts/core.py',
 'probe':'scripts/probe-qwen3-tts.py',
 'pyproject':'scripts/qwen3-tts-runtime/pyproject.toml',
 'shell':'scripts/qwen3-tts-extension.sh',
 'tests':'scripts/test/qwen3-tts-extension.test.py',
 'uvLock':'scripts/qwen3-tts-runtime/uv.lock',
}
hashes={name:hashlib.sha256((root/path).read_bytes()).hexdigest() for name,path in paths.items()}
encoded=''.join(f'{name}:{hashes[name]}\n' for name in sorted(hashes)).encode()
print(hashlib.sha256(encoded).hexdigest())
PY
)"
run_base="${QWEN3_TTS_RUN_BASE_OVERRIDE:-$state_root/spikes/issue-8/qwen3-tts/artifacts/$source_identity}"
raw_base="${QWEN3_TTS_RAW_BASE_OVERRIDE:-$state_root/spikes/issue-8/qwen3-tts/raw/$source_identity}"
retired_paths=(
  "$data_root/models/tts/voxcpm2"
  "$data_root/runtimes/tts/llama.cpp-omni"
  "$HOME/.local/share/lna-i8/espeak"
)

canonical() { realpath -m -- "$1"; }
contains_path() {
  local parent child
  parent="$(canonical "$1")"; child="$(canonical "$2")"
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
  [[ "$(uname -s)" == Linux ]] || fail 'Qwen3-TTS host run requires Linux/WSL2'
  grep -qi 'microsoft.*wsl2' /proc/version || fail 'Qwen3-TTS host run requires WSL2'
  local path ancestor left right retired
  local -a paths=("$runtime_root" "$model_root" "$run_base" "$raw_base")
  for path in "${paths[@]}"; do
    contains_path "$repo_root" "$path" && fail "artifact path is inside Git: $path"
    contains_path "$path" "$repo_root" && fail "artifact path contains Git: $path"
    ancestor="$(existing_ancestor "$path")"
    [[ "$(findmnt -n -o FSTYPE -T "$ancestor")" == ext4 ]] || fail "artifact path is not ext4: $path"
    contains_path "$brain_root" "$path" && fail "artifact path overlaps brain runtime: $path"
    contains_path "$path" "$brain_root" && fail "brain runtime overlaps artifact path: $path"
  done
  for ((left=0; left<${#paths[@]}; left+=1)); do
    for ((right=left+1; right<${#paths[@]}; right+=1)); do
      if contains_path "${paths[left]}" "${paths[right]}" || contains_path "${paths[right]}" "${paths[left]}"; then
        fail "artifact roots overlap: ${paths[left]} and ${paths[right]}"
      fi
    done
  done
  for retired in "${retired_paths[@]}"; do
    [[ ! -e "$retired" ]] || fail "retired engine must remain deleted: $retired"
  done
}

verify_online() {
  local command_name tmp wheel_url wheel_size wheel_hash
  for command_name in curl git nvidia-smi python3 sha256sum uv; do
    command -v "$command_name" >/dev/null || fail "missing required command: $command_name"
  done
  [[ "$(uv --version | awk '{print $1, $2}')" == "uv $(json runtime.uv)" ]] || fail 'uv version mismatch'
  uv lock --check --project "$repo_root/scripts/qwen3-tts-runtime" >/dev/null
  ! grep -qi 'flash-attn' "$uv_lock_file" || fail 'FlashAttention must not be in the uv lock'
  grep -q "$(json runtime.wheelSha256)" "$uv_lock_file" || fail 'qwen-tts wheel hash is absent from uv lock'
  tmp="$(mktemp -d)"
  trap 'rm -rf -- "$tmp"' RETURN
  curl -fsSL "https://huggingface.co/api/models/$(json model.repository)/revision/$(json model.revision)" -o "$tmp/model.json"
  curl -fsSL "https://huggingface.co/api/models/$(json model.repository)/tree/$(json model.revision)?recursive=true&expand=true" -o "$tmp/tree.json"
  curl -fsSL "https://pypi.org/pypi/$(json runtime.package)/$(json runtime.version)/json" -o "$tmp/pypi.json"
  curl -fsSL "https://api.github.com/repos/QwenLM/Qwen3-TTS/commits/$(json runtime.sourceCommit)" -o "$tmp/commit.json"
  curl -fsSL "https://raw.githubusercontent.com/QwenLM/Qwen3-TTS/$(json runtime.sourceCommit)/LICENSE" -o "$tmp/LICENSE"
  python3 - "$lock_file" "$tmp/model.json" "$tmp/tree.json" "$tmp/pypi.json" "$tmp/commit.json" <<'PY'
import json,sys
lock,model,tree,pypi,commit=(json.load(open(path,encoding='utf-8')) for path in sys.argv[1:])
expected=lock['model']
if model.get('sha') != expected['revision']: raise SystemExit('HF revision mismatch')
if model.get('createdAt') != expected['createdAt']: raise SystemExit('HF creation timestamp mismatch')
if model.get('usedStorage') != expected['huggingFaceUsedStorageBytes']: raise SystemExit('HF usedStorage mismatch')
if model.get('cardData',{}).get('license') != 'apache-2.0': raise SystemExit('HF model license mismatch')
actual={item['path']:(item['size'],item.get('lfs',{}).get('oid')) for item in tree if item['type']=='file'}
locked={item['path']:(item['size'],item['sha256']) for item in expected['files']}
if set(actual) != set(locked): raise SystemExit('HF complete file list mismatch')
for path,(size,digest) in locked.items():
    if actual[path][0] != size: raise SystemExit(f'HF size mismatch: {path}')
    if path.endswith('.safetensors') and actual[path][1] != digest: raise SystemExit(f'HF LFS hash mismatch: {path}')
if sum(size for size,_ in actual.values()) != expected['revisionPayloadBytes']: raise SystemExit('HF payload total mismatch')
runtime=lock['runtime']; urls=pypi['urls']
wheels=[item for item in urls if item['filename']==runtime['wheelFilename']]
if len(wheels)!=1: raise SystemExit('PyPI wheel missing')
wheel=wheels[0]
if wheel['size']!=runtime['wheelSize'] or wheel['digests']['sha256']!=runtime['wheelSha256']: raise SystemExit('PyPI wheel identity mismatch')
if wheel['upload_time_iso_8601']!=runtime['releasedAt']: raise SystemExit('PyPI release timestamp mismatch')
if pypi['info'].get('license')!='Apache-2.0': raise SystemExit('PyPI license mismatch')
if commit.get('sha')!=runtime['sourceCommit'] or commit.get('commit',{}).get('tree',{}).get('sha')!=runtime['sourceTree']: raise SystemExit('runtime source identity mismatch')
print(wheel['url'])
PY
  wheel_url="$(python3 - "$tmp/pypi.json" "$(json runtime.wheelFilename)" <<'PY'
import json,sys
print(next(item['url'] for item in json.load(open(sys.argv[1]))['urls'] if item['filename']==sys.argv[2]))
PY
)"
  curl -fsSL "$wheel_url" -o "$tmp/runtime.whl"
  wheel_size="$(stat -c %s "$tmp/runtime.whl")"; wheel_hash="$(file_hash "$tmp/runtime.whl")"
  [[ "$wheel_size" == "$(json runtime.wheelSize)" ]] || fail 'downloaded qwen-tts wheel byte count mismatch'
  [[ "$wheel_hash" == "$(json runtime.wheelSha256)" ]] || fail 'downloaded qwen-tts wheel hash mismatch'
  [[ "$(file_hash "$tmp/LICENSE")" == "$(json runtime.licenseSha256)" ]] || fail 'runtime Apache-2.0 license hash mismatch'
  trap - RETURN
  rm -rf -- "$tmp"
  printf 'Verified pinned Qwen model metadata, complete file list, runtime wheel/source, and licenses.\n'
}

verify_runtime() {
  [[ -f "$runtime_root/manifest.json" && -x "$runtime_root/bin/python" ]] || return 1
  "$runtime_root/bin/python" - "$runtime_root/manifest.json" "$uv_lock_file" "$(json runtime.python)" "$(json runtime.uv)" <<'PY'
import hashlib,importlib.metadata,json,platform,sys
manifest=json.load(open(sys.argv[1],encoding='utf-8'))
h=lambda p:hashlib.sha256(open(p,'rb').read()).hexdigest()
packages=sorted(({'name':d.metadata['Name'].lower(),'version':d.version} for d in importlib.metadata.distributions() if d.metadata.get('Name')),key=lambda x:x['name'])
if platform.python_version()!=sys.argv[3] or manifest.get('pythonVersion')!=sys.argv[3]: raise SystemExit('Python version mismatch')
if manifest.get('uvVersion')!=f'uv {sys.argv[4]}': raise SystemExit('uv version mismatch')
if manifest.get('uvLockSha256')!=h(sys.argv[2]): raise SystemExit('uv lock mismatch')
if manifest.get('packages')!=packages: raise SystemExit('installed inventory mismatch')
for name,version in [('qwen-tts','0.1.1'),('torch','2.9.1'),('torchaudio','2.9.1')]:
    if not any(p['name']==name and p['version']==version for p in packages): raise SystemExit(f'{name} mismatch')
if any(p['name']=='flash-attn' for p in packages): raise SystemExit('FlashAttention is installed')
PY
  [[ -z "$(find "$runtime_root" -xdev ! -type l -perm /077 -print -quit)" ]] || return 1
}

setup_runtime() {
  validate_paths
  if verify_runtime; then
    printf 'Verified existing locked Qwen3-TTS runtime environment.\n'
    return
  fi
  [[ ! -e "$runtime_root" ]] || fail "incomplete immutable runtime exists: $runtime_root"
  uv python install "$(json runtime.python)"
  mkdir -p -- "$(dirname "$runtime_root")"
  UV_PROJECT_ENVIRONMENT="$runtime_root" uv sync --locked --no-dev --no-install-project \
    --python "$(json runtime.python)" --project "$repo_root/scripts/qwen3-tts-runtime"
  chmod -R go-rwx -- "$runtime_root"
  "$runtime_root/bin/python" - "$runtime_root/manifest.json" "$uv_lock_file" "$(uv --version | awk '{print $1, $2}')" <<'PY'
import hashlib,importlib.metadata,json,platform,sys
packages=sorted(({'name':d.metadata['Name'].lower(),'version':d.version} for d in importlib.metadata.distributions() if d.metadata.get('Name')),key=lambda x:x['name'])
h=lambda p:hashlib.sha256(open(p,'rb').read()).hexdigest()
manifest={'schemaVersion':1,'immutable':True,'pythonVersion':platform.python_version(),'uvVersion':sys.argv[3],'uvLockSha256':h(sys.argv[2]),'packages':packages}
with open(sys.argv[1],'x',encoding='utf-8') as stream: json.dump(manifest,stream,indent=2); stream.write('\n')
PY
  chmod -R go-rwx -- "$runtime_root"
  verify_runtime || fail 'new Qwen3-TTS runtime failed verification'
  printf 'Created complete locked Python runtime: %s\n' "$uv_lock_hash"
}

verify_model() {
  [[ -f "$model_root/manifest.json" && -d "$model_snapshot" ]] || return 1
  python3 - "$lock_file" "$model_root/manifest.json" "$model_snapshot" <<'PY'
import hashlib,json,os,sys
lock=json.load(open(sys.argv[1],encoding='utf-8')); manifest=json.load(open(sys.argv[2],encoding='utf-8')); root=sys.argv[3]
h=lambda p:hashlib.sha256(open(p,'rb').read()).hexdigest()
expected={item['path']:item for item in lock['model']['files']}
actual=[]
for base,dirs,files in os.walk(root,followlinks=False):
    if any(os.path.islink(os.path.join(base,name)) for name in dirs+files): raise SystemExit('snapshot symlink found')
    actual.extend(os.path.relpath(os.path.join(base,name),root) for name in files)
if set(actual)!=set(expected): raise SystemExit('snapshot file list mismatch')
total=0
for rel,item in expected.items():
    path=os.path.join(root,rel); size=os.path.getsize(path); total+=size
    if size!=item['size'] or h(path)!=item['sha256']: raise SystemExit(f'snapshot mismatch: {rel}')
if total!=lock['model']['revisionPayloadBytes']: raise SystemExit('snapshot payload mismatch')
if manifest.get('revision')!=lock['model']['revision'] or manifest.get('payloadBytes')!=total or manifest.get('configurationSha256')!=h(sys.argv[1]): raise SystemExit('snapshot manifest mismatch')
PY
  [[ -z "$(find "$model_root" -xdev -perm /077 -print -quit)" ]] || return 1
}

setup_model() {
  validate_paths
  if verify_model; then
    printf 'Verified existing complete pinned Qwen model snapshot.\n'
    return
  fi
  [[ ! -e "$model_root" ]] || fail "incomplete immutable model install exists: $model_root"
  local parent stage relative_path expected_size expected_hash target actual_size actual_hash total
  parent="$(dirname "$model_root")"; mkdir -p -- "$parent"
  stage="$(mktemp -d "$parent/.qwen-model-staging-XXXXXXXX")"
  trap 'rm -rf -- "$stage"' RETURN
  mkdir -p -- "$stage/snapshot"
  while IFS=$'\t' read -r relative_path expected_size expected_hash; do
    target="$stage/snapshot/$relative_path"
    mkdir -p -- "$(dirname "$target")"
    curl --fail --location --retry 5 --retry-delay 2 --continue-at - \
      "https://huggingface.co/$(json model.repository)/resolve/$(json model.revision)/$relative_path" \
      --output "$target"
    actual_size="$(stat -c %s "$target")"; actual_hash="$(file_hash "$target")"
    [[ "$actual_size" == "$expected_size" ]] || fail "model file byte count mismatch: $relative_path"
    [[ "$actual_hash" == "$expected_hash" ]] || fail "model file hash mismatch: $relative_path"
  done < <(python3 - "$lock_file" <<'PY'
import json,sys
for item in json.load(open(sys.argv[1]))['model']['files']: print(f"{item['path']}\t{item['size']}\t{item['sha256']}")
PY
)
  total="$(find "$stage/snapshot" -type f -printf '%s\n' | awk '{s+=$1} END{printf "%.0f",s}')"
  [[ "$total" == "$(json model.revisionPayloadBytes)" ]] || fail 'complete snapshot payload byte total mismatch'
  LOCK="$lock_file" MANIFEST="$stage/manifest.json" TOTAL="$total" python3 <<'PY'
import hashlib,json,os
h=lambda p:hashlib.sha256(open(p,'rb').read()).hexdigest()
lock=json.load(open(os.environ['LOCK']))
manifest={'schemaVersion':1,'immutable':True,'repository':lock['model']['repository'],'revision':lock['model']['revision'],'huggingFaceUsedStorageBytes':lock['model']['huggingFaceUsedStorageBytes'],'payloadBytes':int(os.environ['TOTAL']),'fileCount':len(lock['model']['files']),'configurationSha256':h(os.environ['LOCK'])}
with open(os.environ['MANIFEST'],'x',encoding='utf-8') as stream: json.dump(manifest,stream,indent=2); stream.write('\n')
PY
  chmod -R go-rwx -- "$stage"
  mv -T -- "$stage" "$model_root"
  trap - RETURN
  verify_model || fail 'new Qwen model snapshot failed verification'
  printf 'Downloaded and verified complete pinned Qwen snapshot (%s payload bytes; HF usedStorage %s).\n' "$total" "$(json model.huggingFaceUsedStorageBytes)"
}

verify_setup() {
  validate_paths
  verify_runtime || fail 'locked Qwen runtime is missing or invalid; run setup'
  verify_model || fail 'pinned Qwen model snapshot is missing or invalid; run setup'
}

print_paths() {
  printf 'source_identity=%s\nruntime_root=%s\nmodel_root=%s\nmodel_snapshot=%s\nrun_base=%s\nraw_base=%s\n' \
    "$source_identity" "$runtime_root" "$model_root" "$model_snapshot" "$run_base" "$raw_base"
}

command_name="${1:-help}"
case "$command_name" in
  verify) validate_paths; verify_online ;;
  paths) validate_paths; print_paths ;;
  setup) validate_paths; verify_online; setup_runtime; setup_model; verify_setup; print_paths ;;
  probe)
    verify_setup
    shift
    if [[ "${1:-}" == -- ]]; then shift; fi
    QWEN3_TTS_MODEL_SNAPSHOT="$model_snapshot" \
      QWEN3_TTS_RUNTIME_ROOT="$runtime_root" \
      QWEN3_TTS_RUNTIME_MANIFEST="$runtime_root/manifest.json" \
      QWEN3_TTS_RUN_BASE="$run_base" QWEN3_TTS_RAW_BASE="$raw_base" \
      QWEN3_TTS_SOURCE_IDENTITY="$source_identity" \
      "$runtime_root/bin/python" "$probe_file" "$@"
    for retired in "${retired_paths[@]}"; do
      [[ ! -e "$retired" ]] || fail "probe recreated retired engine: $retired"
    done
    ;;
  *)
    printf 'Usage: %s {verify|paths|setup|probe}\n' "$0" >&2
    [[ "$command_name" == help ]] || exit 2
    ;;
esac
