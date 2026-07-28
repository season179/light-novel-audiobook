#!/usr/bin/env bash
#
# verify-typecheck-isolation.sh — regression for issue #123.
#
# Proves the gemma-mlx-spike driver's `npm run typecheck` is fully isolated from the
# pnpm workspace: it must pass BOTH when the root/apps/packages node_modules workspace
# links are present (the `pnpm install` state) AND when they are absent (the isolated
# measurement state). It never disturbs this spike's own node_modules, and it always
# leaves the worktree in the isolated state (no root workspace node_modules) so a
# measurement run can follow immediately.
#
# Why this is needed: `packages/gemma-director/src/port.ts` has two `import type`
# statements from the bare specifiers `@light-novel-audiobook/application` and
# `@light-novel-audiobook/domain`. tsconfig.json `paths` maps those specifiers to the
# local direct-export declaration modules under `src/workspace-type-shims/`, and `paths`
# takes precedence over the node_modules walk — so tsc resolves them locally and never
# traverses `packages/application`/`packages/domain`, whether or not the workspace links
# exist. This script fails if that isolation ever regresses (for example if the `paths`
# entries are removed or the ambient `declare module` style is restored).
#
# Usage:  ./verify-typecheck-isolation.sh
# Exit:   0 if typecheck passes in both states and the spike's node_modules is intact.
#
set -euo pipefail

spike_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$spike_dir/../.." && pwd)"

log() { printf '\n== %s ==\n' "$*"; }
fail() { printf '\nFAIL: %s\n' "$*" >&2; exit 1; }

# Sanity: the spike's own deps must already be installed (npm install). This script never
# runs npm install for the spike and never removes the spike's node_modules.
[ -d "$spike_dir/node_modules" ] || fail "$spike_dir/node_modules is missing; run 'npm install' in the spike first."
[ -x "$spike_dir/node_modules/.bin/tsc" ] || fail "tsc is not installed in the spike's node_modules."

run_typecheck() {
  # Run the spike's own typecheck exactly as CI/developers do.
  ( cd "$spike_dir" && npm run typecheck --silent )
}

assert_isolated_program() {
  # tsc must not pull any real packages/application or packages/domain source into the
  # program. Only the pure gemma-director files imported by relative path are expected.
  log "asserting tsc program excludes packages/application and packages/domain"
  local leaked
  leaked="$(
    ( cd "$spike_dir" && ./node_modules/.bin/tsc --noEmit --listFiles 2>/dev/null ) \
      | grep -E 'packages/(application|domain)/' || true
  )"
  [ -z "$leaked" ] || fail "typecheck leaked into workspace packages:\n$leaked"
}

remove_workspace_links() {
  # Remove ONLY the root/apps/packages node_modules. Never touch the spike's own
  # node_modules (it lives under scripts/, which is not under apps/ or packages/).
  log "removing root/apps/packages node_modules (isolated state)"
  rm -rf "$repo_root/node_modules"
  find "$repo_root/apps" "$repo_root/packages" -maxdepth 2 -name node_modules -type d -prune \
    -exec rm -rf {} + 2>/dev/null || true
}

state_is_isolated() {
  [ -e "$repo_root/node_modules" ] && return 1 || return 0
}

# ---------------------------------------------------------------------------
# State A: workspace links present (the `pnpm install` state).
# ---------------------------------------------------------------------------
log "State A: workspace links present"
log "installing workspace links (pnpm install --frozen-lockfile)"
( cd "$repo_root" && pnpm install --frozen-lockfile --silent )
run_typecheck
assert_isolated_program
printf 'PASS: typecheck isolated with workspace links present\n'

# ---------------------------------------------------------------------------
# State B: workspace links absent (isolated measurement state).
# ---------------------------------------------------------------------------
remove_workspace_links
state_is_isolated || fail "failed to remove root workspace node_modules"
log "State B: workspace links absent (isolated)"
run_typecheck
printf 'PASS: typecheck isolated with workspace links absent\n'

# ---------------------------------------------------------------------------
# Leave the worktree in the isolated state; spike node_modules must be intact.
# ---------------------------------------------------------------------------
[ -d "$spike_dir/node_modules" ] || fail "spike node_modules was disturbed"
state_is_isolated || fail "worktree not left in isolated state"
log "OK: typecheck isolated in both states; worktree left isolated; spike node_modules intact"
