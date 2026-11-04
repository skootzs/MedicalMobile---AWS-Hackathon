#!/usr/bin/env bash
# Builds R6's verifier at a pinned commit into a git worktree, ready to mount read-only at
# /verifier. Prints VERIFIER_DIR=<path>. node_modules is deleted after the build, so the
# harness comes from the image's /build-image/node_modules through NODE_PATH.
#
# Usage: scripts/build-verifier.sh <worktree-dir> [commit]
set -euo pipefail

[ "$#" -ge 1 ] || { echo "Usage: $0 <worktree-dir> [commit]" >&2; exit 2; }

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKTREE="$1"
COMMIT="${2:-${VERIFIER_COMMIT:-90fd841}}"

git -C "$REPO_ROOT" fetch origin verification >&2
git -C "$REPO_ROOT" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
mkdir -p "$(dirname "$WORKTREE")"
git -C "$REPO_ROOT" worktree add --detach "$WORKTREE" "$COMMIT" >&2

VERIFIER_DIR="$WORKTREE/packages/verification"
# tsc is a dev dependency, so --omit=dev can't build. --ignore-scripts skips a Chromium download.
(cd "$VERIFIER_DIR" && npm ci --ignore-scripts --no-audit --no-fund && npm run build) >&2
rm -rf "$VERIFIER_DIR/node_modules"
chmod -R a+rX "$WORKTREE"

for file in dist/run.js dist/data/patients.json; do
  [ -f "$VERIFIER_DIR/$file" ] || { echo "Missing $file after the build" >&2; exit 1; }
done
echo "VERIFIER_DIR=$VERIFIER_DIR"
