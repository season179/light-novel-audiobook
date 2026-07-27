#!/usr/bin/env bash
# Shared process-tree helpers for the launcher and the stop script. Sourced, not run.
#
# Why this exists rather than a single `kill -- -PGID`: the Qwen worker is spawned with
# `detached: true` on Linux (packages/qwen-tts/src/worker-session.ts), so it leaves the server's
# process group and a group signal never reaches it. It stays a *descendant* until its parent dies,
# so the tree has to be recorded before anything is signalled, then swept afterwards.

# Prints every descendant pid of $1, deepest last. Excludes $1 itself.
lna_descendants() {
  local root="$1"
  local -a frontier=("$root") found=()
  local pid child
  while ((${#frontier[@]} > 0)); do
    pid="${frontier[0]}"
    frontier=("${frontier[@]:1}")
    while read -r child; do
      [[ -z "$child" ]] && continue
      found+=("$child")
      frontier+=("$child")
    done < <(ps -eo pid=,ppid= | awk -v p="$pid" '$2 == p { print $1 }')
  done
  ((${#found[@]} > 0)) && printf '%s\n' "${found[@]}"
}

# Stops a server process and everything it started, giving the app's own release path — which reaps
# llama-server and drops the GPU lease — time to run before anything is forced.
#
#   lna_stop_tree <server-pid> [grace-seconds]
lna_stop_tree() {
  local root="$1" grace="${2:-30}"
  local -a tree
  mapfile -t tree < <(lna_descendants "$root")
  local pgid
  pgid="$(ps -o pgid= -p "$root" 2>/dev/null | tr -d ' ')"

  # SIGTERM first, and only SIGTERM: the server's own handler releases the owned llama-server and
  # the GPU lease. Killing it here would leave exactly the orphan this script exists to prevent.
  if [[ -n "$pgid" ]]; then
    kill -TERM "-$pgid" 2>/dev/null || true
  else
    kill -TERM "$root" 2>/dev/null || true
  fi

  local waited=0
  while kill -0 "$root" 2>/dev/null; do
    if ((waited >= grace * 10)); then
      echo "stop: the server did not exit within ${grace}s; forcing it" >&2
      [[ -n "$pgid" ]] && kill -KILL "-$pgid" 2>/dev/null || true
      kill -KILL "$root" 2>/dev/null || true
      break
    fi
    sleep 0.1
    waited=$((waited + 1))
  done

  # Sweep the recorded tree. A detached child is no longer in the group and has been reparented to
  # init by now, so its own pid is the only handle left on it.
  local pid
  for pid in "${tree[@]}"; do
    kill -0 "$pid" 2>/dev/null || continue
    kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 1
  for pid in "${tree[@]}"; do
    kill -0 "$pid" 2>/dev/null || continue
    echo "stop: forcing leftover pid $pid ($(ps -o comm= -p "$pid" 2>/dev/null || echo unknown))" >&2
    kill -KILL "$pid" 2>/dev/null || true
  done
}

# Reports what is still holding the card. Never kills: another run — a proof, a benchmark, someone
# else's terminal — may legitimately own the GPU, and guessing wrong destroys their work.
lna_report_gpu() {
  command -v nvidia-smi >/dev/null 2>&1 || return 0
  local busy
  busy="$(nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader 2>/dev/null || true)"
  if [[ -z "${busy//[[:space:]]/}" ]]; then
    echo "GPU is free."
  else
    echo "Something is still using the GPU:" >&2
    echo "$busy" >&2
    echo "If none of that is yours, stop it before starting again." >&2
  fi
}

# The pid listening on the app's port, or empty.
lna_server_pid() {
  local port="${1:-3000}"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnpH "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1
  fi
}
