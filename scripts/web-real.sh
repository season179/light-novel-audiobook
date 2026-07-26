#!/usr/bin/env bash
# Start the web app with REAL adapters: real Gemma direction, real Qwen rendering, real FFmpeg.
#
#   ./scripts/web-real.sh              # start on http://127.0.0.1:3000
#   ./scripts/web-real.sh --fake       # same UI, no GPU and no models (instant, synthetic audio)
#
# Real mode loads a 14 GB model onto a 16.3 GB card, so it refuses to start while anything else is
# using the GPU rather than failing with an out-of-memory error halfway through a book.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_ROOT="${LNA_DATA_ROOT:-$HOME/.local/share/light-novel-audiobook}"
STATE_ROOT="${LNA_STATE_ROOT:-$HOME/.local/state/light-novel-audiobook}"
QWEN_REVISION=0c0e3051f131929182e2c023b9537f8b1c68adfe
UV_LOCK_SHA=6a7d989924871b408ed0e6eea86ce21ff399033e1272c5fa19bf9a5e38c3bbd9

FAKE=0
[[ "${1:-}" == "--fake" ]] && FAKE=1

die() { echo "web-real: $*" >&2; exit 1; }

if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ':3000[[:space:]]'; then
  die "port 3000 is already in use (another dev server or proof run?)"
fi

if [[ $FAKE -eq 0 ]]; then
# Everything below is checked before the server starts. A missing path found now is a one-line fix;
# found later it is a failure part-way through generating someone's book.
QWEN_RUNTIME="$DATA_ROOT/runtimes/tts/qwen3-tts/$UV_LOCK_SHA"
QWEN_SNAPSHOT="$DATA_ROOT/models/tts/qwen3-tts-custom-voice/$QWEN_REVISION/snapshot"
[[ -x "$QWEN_RUNTIME/bin/python" ]] || die "no Qwen runtime at $QWEN_RUNTIME (run: pnpm qwen3-tts:setup)"
[[ -d "$QWEN_SNAPSHOT" ]] || die "no Qwen model snapshot at $QWEN_SNAPSHOT (run: pnpm qwen3-tts:setup)"
[[ -f "$QWEN_RUNTIME/manifest.json" ]] || die "no runtime manifest at $QWEN_RUNTIME/manifest.json"

# One model on the card at a time. Gemma peaks around 15,010 MiB of 16,303 MiB, so a co-resident
# process is not a slowdown, it is a guaranteed failure.
if command -v nvidia-smi >/dev/null 2>&1; then
  busy="$(nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader || true)"
  if [[ -n "${busy//[[:space:]]/}" ]]; then
    echo "web-real: the GPU is already in use:" >&2
    echo "$busy" >&2
    die "stop the other job first, or the model load will run out of memory"
  fi
else
  echo "web-real: no nvidia-smi found; skipping the GPU check" >&2
fi

mkdir -p "$STATE_ROOT/gpu"

export LNA_WEB_TRANSPORTS=real
export LNA_DIRECTOR_URL="${LNA_DIRECTOR_URL:-http://127.0.0.1:8080/v1}"
export LNA_QWEN_PYTHON="$QWEN_RUNTIME/bin/python"
export LNA_QWEN_WORKER="$REPO_ROOT/packages/qwen-tts/python/qwen_batch_worker.py"
export LNA_QWEN_RUNTIME_MANIFEST="$QWEN_RUNTIME/manifest.json"
export LNA_QWEN_SNAPSHOT="$QWEN_SNAPSHOT"
export LNA_GPU_LOCK="$STATE_ROOT/gpu/exclusive.lock"
fi  # end real-mode setup; fake mode leaves LNA_WEB_TRANSPORTS unset, which defaults to `fake`

# Unset means the app's own default: ~/.local/share/light-novel-audiobook/workspace. Outputs are
# versioned (v001, v002, ...) and an existing audiobook is never overwritten.
export AUDIOBOOK_WORKSPACE_DIR="${AUDIOBOOK_WORKSPACE_DIR:-$DATA_ROOT/workspace}"

# A job that fails puts "check the server log for details" in the browser, and the detail it means is
# a console.error on this process's stderr. The first real run scrolled past in a terminal and the
# cause was unrecoverable, so the output is teed from here on. Nothing else was writing it down.
LOG_DIR="$STATE_ROOT/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/web-$(date -u +%Y%m%dT%H%M%SZ).log"
ln -sfn "$LOG" "$LOG_DIR/web-latest.log"

if [[ $FAKE -eq 1 ]]; then
  cat <<INFO
Starting the web app in FAKE mode: real UI, synthetic audio, no GPU and no models.

  UI            http://127.0.0.1:3000
  workspace     $AUDIOBOOK_WORKSPACE_DIR
  log           $LOG_DIR/web-latest.log
INFO
else
  cat <<INFO
Starting the web app with REAL models.

  UI            http://127.0.0.1:3000
  workspace     $AUDIOBOOK_WORKSPACE_DIR
  director      $LNA_DIRECTOR_URL (llama-server is started and stopped for you)
  GPU lease     $LNA_GPU_LOCK
  log           $LOG_DIR/web-latest.log

Upload an EPUB, then watch the job page. Expect roughly four minutes of audio per two chapters on
this card, and a pause at the review gate if the director cannot attribute every speaker.
INFO
fi
echo
echo "Ctrl-C stops the server. If a job fails, send me the log path above."

cd "$REPO_ROOT"
exec pnpm --filter @light-novel-audiobook/web dev 2>&1 | tee -a "$LOG"
