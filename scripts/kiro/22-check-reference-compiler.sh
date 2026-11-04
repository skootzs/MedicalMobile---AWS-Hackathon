#!/usr/bin/env bash
# R5's check: branch `compiler` @ pinned commit 7f488e6 (until R5 says
# otherwise; moved from b2c5fb1 once his baseline-diff + working
# templates/cht-base landed). Runs his reference/check_reference.sh and the
# cht-conf integration test inside medicmobile/cht-app-ide:v6.6.1 on x86_64.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
COMPILER_COMMIT="${COMPILER_COMMIT:-7f488e6}"
COMPILER_DIR="${COMPILER_DIR:-$(mktemp -d)/compiler-worktree}"

echo "== 22-check-reference-compiler: git worktree add (read-only, pinned to $COMPILER_COMMIT) =="
git -C "$REPO_ROOT" fetch origin compiler
git -C "$REPO_ROOT" worktree add --detach "$COMPILER_DIR" "$COMPILER_COMMIT"
trap 'git -C "$REPO_ROOT" worktree remove --force "$COMPILER_DIR" 2>/dev/null || true' EXIT

cd "$COMPILER_DIR/packages/compiler"

LOG_FILE="$(mktemp)"
echo "== 22-check-reference-compiler: check_reference.sh + integration test, inside medicmobile/cht-app-ide:v6.6.1 =="
if docker run --rm --platform linux/amd64 \
  -v "$COMPILER_DIR/packages/compiler:/compiler:rw" \
  -w /compiler \
  --entrypoint bash \
  medicmobile/cht-app-ide:v6.6.1 \
  -lc '
    set -e
    npm ci
    # check_reference.sh writes the reference xlsx via openpyxl, which our
    # own BUILD_IMAGE deliberately does not include (not needed for the
    # pipeline itself). Install it here, scoped to this check only.
    pip3 install --quiet openpyxl
    echo "--- check_reference.sh ---"
    bash reference/check_reference.sh
    echo "--- integration test (REQUIRE_CHT=1) ---"
    REQUIRE_CHT=1 npm run test:integration
  ' > "$LOG_FILE" 2>&1; then
  status=0
else
  status=$?
fi

cat "$LOG_FILE"

if [ "$status" -eq 0 ]; then
  echo "RESULT: PASS check_reference.sh and integration test passed at $COMPILER_COMMIT"
else
  echo "RESULT: FAIL exit $status at $COMPILER_COMMIT; see output above"
  exit 1
fi
