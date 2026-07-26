#!/usr/bin/env bash
# Thin wrapper for the issue #21 proof harness. The harness itself starts and reaps the dev
# server; this wrapper only pins the working directory and fails early with a useful message.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [[ ! -d node_modules ]]; then
  printf 'error: node_modules is missing; run pnpm install first\n' >&2
  exit 1
fi

exec node scripts/proof-m1.mjs "$@"
