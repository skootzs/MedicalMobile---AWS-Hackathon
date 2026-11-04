#!/usr/bin/env bash
# Builds the runner bundle image: the runner, plus R5's compiler and template and R6's built
# verifier at their pinned commits.
#
# Usage: scripts/build-runner-image.sh <image-ref>
set -euo pipefail

[ "$#" -eq 1 ] || { echo "Usage: $0 <image-ref>" >&2; exit 2; }

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="$1"
COMPILER_COMMIT="${COMPILER_COMMIT:-7f488e6}"
VERIFIER_COMMIT="${VERIFIER_COMMIT:-90fd841}"
WORK_PARENT="$(mktemp -d)"
VERIFIER_WORKTREE="$WORK_PARENT/verifier-worktree"
CONTEXT="$WORK_PARENT/context"

cleanup() {
  git -C "$REPO_ROOT" worktree remove --force "$VERIFIER_WORKTREE" >/dev/null 2>&1 || true
  rm -rf "$WORK_PARENT"
}
trap cleanup EXIT

mkdir -p "$CONTEXT"

# git archive, so only committed files ship: no node_modules, .env or local changes.
git -C "$REPO_ROOT" archive HEAD runner | tar -x -C "$CONTEXT"
rm -rf "$CONTEXT/runner/test"
mv "$CONTEXT/runner/install-runner.sh" "$CONTEXT/install-runner.sh"
mkdir -p "$CONTEXT/runner/src/generated"
git -C "$REPO_ROOT" show HEAD:packages/schema/src/handoffs.ts > "$CONTEXT/runner/src/generated/handoffs.ts"

git -C "$REPO_ROOT" fetch origin compiler >&2
mkdir "$WORK_PARENT/compiler"
git -C "$REPO_ROOT" archive "$COMPILER_COMMIT" packages/compiler templates/cht-base | tar -x -C "$WORK_PARENT/compiler"
mv "$WORK_PARENT/compiler/packages/compiler" "$CONTEXT/compiler"
mv "$WORK_PARENT/compiler/templates/cht-base" "$CONTEXT/template"

VERIFIER_DIR="$("$REPO_ROOT/scripts/build-verifier.sh" "$VERIFIER_WORKTREE" "$VERIFIER_COMMIT" | sed -n 's/^VERIFIER_DIR=//p')"
cp -R "$VERIFIER_DIR" "$CONTEXT/verifier"

printf 'COMPILER_COMMIT=%s\nVERIFIER_COMMIT=%s\n' "$COMPILER_COMMIT" "$VERIFIER_COMMIT" > "$CONTEXT/versions.env"

docker build --platform linux/amd64 -t "$IMAGE" -f "$CONTEXT/runner/Dockerfile" "$CONTEXT"
