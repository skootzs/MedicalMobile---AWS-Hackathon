#!/usr/bin/env bash
# Real Worker and real containers for COMPILE_LOGIC then VERIFY_BUILD, with and without
# golden cases, against DynamoDB Local. Uses no AWS credentials or live resources.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=scripts/kiro/lib-dynamodb-local.sh
source "$REPO_ROOT/scripts/kiro/lib-dynamodb-local.sh"
COMPILER_COMMIT="${COMPILER_COMMIT:-7f488e6}"
# R5 added the child-cough golden cases after the compiler pin.
GOLDEN_COMMIT="${GOLDEN_COMMIT:-2f7fb75}"
COMPILE_IMAGE="${COMPILE_IMAGE:-node:22.23.4-slim}"
BUILD_IMAGE_TAG="${BUILD_IMAGE_TAG:-cht-nocode/build-image:latest}"
VERIFIER_COMMIT="${VERIFIER_COMMIT:-90fd841}"
VERIFIER_WORKTREE="${VERIFIER_WORKTREE:-$HOME/cht-nocode/verifier-worktree}"
VERIFIER_DIR="$VERIFIER_WORKTREE/packages/verification"
WORK_PARENT="$(mktemp -d)"
COMPILER_ROOT="$WORK_PARENT/compiler-worktree"
chmod 0755 "$WORK_PARENT"

cleanup() {
  git -C "$REPO_ROOT" worktree remove --force "$COMPILER_ROOT" 2>/dev/null || true
  stop_dynamodb_local "$REPO_ROOT"
}
trap cleanup EXIT

fail() { echo "RESULT: FAIL $1"; exit 1; }

[ -f "$VERIFIER_DIR/dist/run.js" ] || fail "no built verifier at $VERIFIER_DIR, run 28-build-verifier.sh first"
docker image inspect "$BUILD_IMAGE_TAG" >/dev/null 2>&1 || fail "$BUILD_IMAGE_TAG not found, run 20-build-image.sh first"

echo "== 29-verify-stage-e2e: compiler worktree at $COMPILER_COMMIT =="
git -C "$REPO_ROOT" fetch origin compiler
git -C "$REPO_ROOT" worktree add --detach "$COMPILER_ROOT" "$COMPILER_COMMIT"
chmod -R a+rX "$COMPILER_ROOT"
GOLDEN_FILE="$WORK_PARENT/golden-cases.json"
git -C "$REPO_ROOT" show "$GOLDEN_COMMIT:fixtures/child-cough/golden-cases.json" > "$GOLDEN_FILE"

echo "== 29-verify-stage-e2e: DynamoDB Local =="
start_dynamodb_local "$REPO_ROOT"

cd "$REPO_ROOT/runner"
npm ci --no-audit --no-fund
npm run sync-contract
docker pull "$COMPILE_IMAGE"

echo "== 29-verify-stage-e2e: real stages =="
COMPILE_IMAGE="$COMPILE_IMAGE" BUILD_IMAGE="$BUILD_IMAGE_TAG" COMPILER_ROOT="$COMPILER_ROOT" \
  RUNNER_WORK_DIR="$WORK_PARENT/work" VERIFIER_DIR="$VERIFIER_DIR" VERIFIER_COMMIT="$VERIFIER_COMMIT" \
  GOLDEN_FILE="$GOLDEN_FILE" node test/verify-stage.e2e.ts || fail "verify stage run failed, see output above"

echo "RESULT: PASS verify stage e2e at compiler@$COMPILER_COMMIT verifier@$VERIFIER_COMMIT"
