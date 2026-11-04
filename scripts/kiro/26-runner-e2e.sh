#!/usr/bin/env bash
# Real containers, real Worker, DynamoDB Local. Uses no AWS credentials or live resources.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=scripts/kiro/lib-dynamodb-local.sh
source "$REPO_ROOT/scripts/kiro/lib-dynamodb-local.sh"
COMPILER_COMMIT="${COMPILER_COMMIT:-7f488e6}"
COMPILE_IMAGE="${COMPILE_IMAGE:-node:22.23.4-slim}"
BUILD_IMAGE_TAG="${BUILD_IMAGE_TAG:-cht-nocode/build-image:latest}"
WORK_PARENT="${RUNNER_E2E_DIR:-$(mktemp -d)}"
COMPILER_ROOT="$WORK_PARENT/compiler-worktree"
# mktemp dirs are mode 700, but stage containers run as uid 1000. The runner chmods its
# own mounts; the parents and the compiler checkout are this script's job.
chmod 0755 "$WORK_PARENT"

cleanup() {
  git -C "$REPO_ROOT" worktree remove --force "$COMPILER_ROOT" 2>/dev/null || true
  stop_dynamodb_local "$REPO_ROOT"
}
trap cleanup EXIT

fail() { echo "RESULT: FAIL $1"; exit 1; }

echo "== 26-runner-e2e: compiler worktree at $COMPILER_COMMIT =="
git -C "$REPO_ROOT" fetch origin compiler
git -C "$REPO_ROOT" worktree add --detach "$COMPILER_ROOT" "$COMPILER_COMMIT"
chmod -R a+rX "$COMPILER_ROOT"

echo "== 26-runner-e2e: DynamoDB Local =="
start_dynamodb_local "$REPO_ROOT"

cd "$REPO_ROOT/runner"
echo "== 26-runner-e2e: npm ci =="
npm ci --no-audit --no-fund

echo "== 26-runner-e2e: unit tests =="
npm test || fail "runner unit tests failed"

echo "== 26-runner-e2e: real stages =="
docker pull "$COMPILE_IMAGE"
COMPILE_IMAGE="$COMPILE_IMAGE" BUILD_IMAGE="$BUILD_IMAGE_TAG" COMPILER_ROOT="$COMPILER_ROOT" \
  RUNNER_WORK_DIR="$WORK_PARENT/work" node test/docker-stages.e2e.ts || fail "real-stage run failed, see output above"

echo "RESULT: PASS runner e2e at compiler@$COMPILER_COMMIT"
