#!/usr/bin/env bash
# Stop the local web app from anywhere, and free the GPU with it.
#
#   ./scripts/stop-web-app.sh
#
# The launcher already does this when its window closes. This is for the case where it did not get
# the chance — a killed terminal, a lost WSL session, a machine that came back from sleep with the
# card still held.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lna-process-tree.sh
source "$REPO_ROOT/scripts/lna-process-tree.sh"

PORT="${1:-3000}"
SERVER_PID="$(lna_server_pid "$PORT")"

if [[ -z "$SERVER_PID" ]]; then
  echo "Nothing is listening on port $PORT."
  lna_report_gpu
  exit 0
fi

echo "Stopping the app (pid $SERVER_PID) and freeing the GPU…"
lna_stop_tree "$SERVER_PID" 30

if [[ -n "$(lna_server_pid "$PORT")" ]]; then
  echo "stop: something is still listening on port $PORT." >&2
  exit 1
fi

echo "Stopped."
lna_report_gpu
