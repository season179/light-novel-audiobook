#!/usr/bin/env bash
# Thin wrapper for the listening-run script. The script itself spawns and reaps the pipeline
# driver; this wrapper only pins the working directory and fails early with a useful message.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [[ ! -d node_modules ]]; then
  printf 'error: node_modules is missing; run pnpm install first\n' >&2
  exit 1
fi

exec node scripts/listening-run.mjs "$@"
