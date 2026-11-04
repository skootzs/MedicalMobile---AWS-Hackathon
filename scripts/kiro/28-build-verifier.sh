#!/usr/bin/env bash
# Builds R6's verifier at the pinned commit. Safe to re-run: replaces its own worktree.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERIFIER_COMMIT="${VERIFIER_COMMIT:-90fd841}"
VERIFIER_WORKTREE="${VERIFIER_WORKTREE:-$HOME/cht-nocode/verifier-worktree}"

echo "== 28-build-verifier: building verifier at $VERIFIER_COMMIT =="
if output="$("$REPO_ROOT/scripts/build-verifier.sh" "$VERIFIER_WORKTREE" "$VERIFIER_COMMIT")"; then
  echo "$output"
  echo "RESULT: PASS verifier built at $VERIFIER_COMMIT"
else
  echo "RESULT: FAIL verifier build failed, see output above"
  exit 1
fi
