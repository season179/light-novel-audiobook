#!/usr/bin/env bash
# The double-click entry point (see the desktop shortcut this repo installs).
#
#   ./scripts/start-web-app.sh          # real models: real Gemma direction, real Qwen rendering
#   ./scripts/start-web-app.sh --fake   # same UI, synthetic audio, no GPU and no models
#
# It starts the app, opens it in the browser, and — the part that matters — shuts everything down
# cleanly when this window closes, so the card is free for the next run. Closing the window is a
# real stop, not an abandonment.
set -uo pipefail

# Job control, so the server and everything it starts land in their own process group and one
# signal reaches all of them.
set -m

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lna-process-tree.sh
source "$REPO_ROOT/scripts/lna-process-tree.sh"
cd "$REPO_ROOT"

PORT=3000
URL="http://localhost:$PORT"
SERVER_PID=""
STOPPING=0

# Set LNA_OPEN_BROWSER=0 to start without opening a window — how the start/stop path is exercised
# without putting a browser tab on someone's screen.
open_app() {
  if [[ "${LNA_OPEN_BROWSER:-1}" == "0" ]]; then
    echo "Ready at $URL"
    return
  fi
  echo "Opening $URL"
  explorer.exe "$URL" >/dev/null 2>&1 || echo "Open $URL in your browser."
}

cleanup() {
  # Re-entrancy matters here: the window closing can deliver both HUP and EXIT.
  [[ $STOPPING -eq 1 ]] && return
  STOPPING=1
  trap - EXIT INT TERM HUP
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo
    echo "Stopping the app and freeing the GPU…"
    lna_stop_tree "$SERVER_PID" 30
  fi
  lna_report_gpu
}
trap cleanup EXIT INT TERM HUP

# A Desktop shortcut runs a *login* shell, which reads ~/.profile but not ~/.bashrc — and nvm lives
# in ~/.bashrc. Without this the shortcut dies with "pnpm: not found", or worse, finds the Windows
# node on /mnt/c and runs the toolchain through it. The repo pins its version in .node-version.
ensure_toolchain() {
  local node_path
  node_path="$(command -v node || true)"
  if [[ -n "$node_path" && "$node_path" != /mnt/* ]] && command -v pnpm >/dev/null 2>&1; then
    return
  fi
  local nvm_sh="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  if [[ -s "$nvm_sh" ]]; then
    # nvm reads unset variables freely, so `set -u` turns sourcing it into an exit. Relax it for
    # exactly as long as nvm is running, then put it back.
    set +u
    # shellcheck disable=SC1090
    \. "$nvm_sh" >/dev/null 2>&1 || true
    nvm use --silent >/dev/null 2>&1 || nvm use --silent default >/dev/null 2>&1 || true
    set -u
  fi
  node_path="$(command -v node || true)"
  if [[ -z "$node_path" || "$node_path" == /mnt/* ]] || ! command -v pnpm >/dev/null 2>&1; then
    echo "start: no Linux node/pnpm on PATH." >&2
    echo "start: expected nvm at ${NVM_DIR:-$HOME/.nvm} with node $(cat "$REPO_ROOT/.node-version")." >&2
    [[ "$node_path" == /mnt/* ]] && echo "start: found Windows node at $node_path; that will not work." >&2
    exit 1
  fi
}
ensure_toolchain

if [[ -n "$(lna_server_pid "$PORT")" ]]; then
  echo "The app is already running on $URL — opening it."
  open_app
  STOPPING=1 # someone else owns that server; do not stop it on the way out
  exit 0
fi

"$REPO_ROOT/scripts/web-real.sh" "$@" &
SERVER_PID=$!

# Wait for it to answer before opening a browser at a page that is not there yet. web-real.sh
# refuses to start on a busy GPU or a missing runtime, so a dead child here is a real failure with
# its reason already on screen — not something to keep waiting on.
for _ in $(seq 1 600); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo
    echo "The app stopped before it finished starting. The reason is above." >&2
    wait "$SERVER_PID"
    exit 1
  fi
  if curl -sf -o /dev/null -m 2 "http://127.0.0.1:$PORT/" 2>/dev/null; then
    echo
    open_app
    break
  fi
  sleep 0.5
done

echo
echo "Close this window, or press Ctrl-C, to stop the app and free the GPU."
wait "$SERVER_PID"
