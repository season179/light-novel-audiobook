#!/usr/bin/env bash
# Proves the launcher's shutdown actually stops everything, using real processes.
#
# The property under test is not "a kill was issued" — it is "nothing survives". The Qwen worker is
# spawned with `detached: true`, so it leaves the server's process group; a plain group kill misses
# it and it keeps holding the card. The detached case below is that bug, reproduced.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/lna-process-tree.sh
source "$REPO_ROOT/scripts/lna-process-tree.sh"

FAILED=0
pass() { echo "ok   - $1"; }
fail() { echo "FAIL - $1" >&2; FAILED=1; }

alive() { kill -0 "$1" 2>/dev/null; }

# Waits out the caller's grace period plus a margin, so a slow machine does not read as a failure.
settle() { sleep 2; }

# --- a plain child in the server's own process group ------------------------------------------
run_group_child_case() {
  local root child
  set -m
  bash -c 'sleep 300 & echo "$!" > /tmp/lna-tree-test-child.pid; wait' &
  root=$!
  set +m
  for _ in $(seq 1 50); do [[ -s /tmp/lna-tree-test-child.pid ]] && break; sleep 0.1; done
  child="$(cat /tmp/lna-tree-test-child.pid 2>/dev/null || true)"
  rm -f /tmp/lna-tree-test-child.pid

  if [[ -z "$child" ]] || ! alive "$child"; then
    fail "group child: fixture did not start"
    return
  fi

  lna_stop_tree "$root" 3
  settle
  alive "$root" && fail "group child: the server survived" && return
  alive "$child" && fail "group child: the child survived" && return
  pass "a child in the server's process group is stopped"
}

# --- a DETACHED child, the Qwen worker's shape --------------------------------------------------
run_detached_child_case() {
  local root child
  set -m
  # setsid puts the grandchild in its own session and process group, exactly as `detached: true`
  # does. It stays a descendant, which is the only handle left on it.
  bash -c 'setsid sleep 300 < /dev/null > /dev/null 2>&1 & echo "$!" > /tmp/lna-tree-test-detached.pid; wait' &
  root=$!
  set +m
  for _ in $(seq 1 50); do [[ -s /tmp/lna-tree-test-detached.pid ]] && break; sleep 0.1; done
  child="$(cat /tmp/lna-tree-test-detached.pid 2>/dev/null || true)"
  rm -f /tmp/lna-tree-test-detached.pid

  if [[ -z "$child" ]] || ! alive "$child"; then
    fail "detached child: fixture did not start"
    return
  fi

  local child_pgid root_pgid
  child_pgid="$(ps -o pgid= -p "$child" 2>/dev/null | tr -d ' ')"
  root_pgid="$(ps -o pgid= -p "$root" 2>/dev/null | tr -d ' ')"
  if [[ -n "$child_pgid" && "$child_pgid" == "$root_pgid" ]]; then
    fail "detached child: fixture is not actually detached (pgid $child_pgid), so it proves nothing"
    kill -KILL "$child" 2>/dev/null
    kill -KILL "$root" 2>/dev/null
    return
  fi

  lna_stop_tree "$root" 3
  settle
  if alive "$child"; then
    kill -KILL "$child" 2>/dev/null
    fail "detached child: survived the stop — this is the orphan that keeps the GPU"
    return
  fi
  alive "$root" && fail "detached child: the server survived" && return
  pass "a detached child outside the process group is stopped too"
}

# --- a server that ignores SIGTERM --------------------------------------------------------------
run_stubborn_server_case() {
  local root
  set -m
  bash -c 'trap "" TERM; sleep 300' &
  root=$!
  set +m
  sleep 0.5
  alive "$root" || { fail "stubborn server: fixture did not start"; return; }

  local started elapsed
  started="$(date +%s)"
  lna_stop_tree "$root" 2
  settle
  elapsed=$(( $(date +%s) - started ))

  alive "$root" && { kill -KILL "$root" 2>/dev/null; fail "stubborn server: survived"; return; }
  if (( elapsed < 2 )); then
    fail "stubborn server: forced after ${elapsed}s, before the grace period it was given"
    return
  fi
  pass "a server that ignores SIGTERM is forced, but only after its grace period"
}

# --- descendant walk ----------------------------------------------------------------------------
run_descendants_case() {
  local root found
  bash -c 'sleep 60 & sleep 60 & wait' &
  root=$!
  sleep 0.5
  found="$(lna_descendants "$root" | wc -l | tr -d ' ')"
  kill -KILL "$root" 2>/dev/null
  pkill -KILL -P "$root" 2>/dev/null
  if [[ "$found" -lt 2 ]]; then
    fail "descendants: found $found, expected at least 2"
    return
  fi
  pass "the descendant walk finds grandchildren, not just direct children"
}

run_group_child_case
run_detached_child_case
run_stubborn_server_case
run_descendants_case

if [[ $FAILED -ne 0 ]]; then
  echo "process-tree shutdown tests FAILED" >&2
  exit 1
fi
echo "process-tree shutdown tests passed"
