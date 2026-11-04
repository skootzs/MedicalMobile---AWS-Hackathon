#!/usr/bin/env bash
# R5's other check: a compile-stage smoke test -- his CLI, in the pinned
# COMPILE_IMAGE (node:22.23.4-slim, >= 22.18), --network none, against his
# own fixture (test/fixtures/child-cough.logic.json). No cht-conf involved;
# this only exercises the compiler itself (stage 1).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
COMPILER_COMMIT="${COMPILER_COMMIT:-7f488e6}"
COMPILE_IMAGE="${COMPILE_IMAGE:-node:22.23.4-slim}"
COMPILER_DIR="${COMPILER_DIR:-$(mktemp -d)/compiler-worktree}"
OUT_DIR="$(mktemp -d)"
# mktemp dirs are mode 700, but containers run as uid 1000. Writable mounts need
# 0777 and read-only mounts need a+rX.
chmod 0777 "$OUT_DIR"

echo "== 23-compile-smoke-test: git worktree add (read-only, pinned to $COMPILER_COMMIT) =="
git -C "$REPO_ROOT" fetch origin compiler
git -C "$REPO_ROOT" worktree add --detach "$COMPILER_DIR" "$COMPILER_COMMIT"
trap 'git -C "$REPO_ROOT" worktree remove --force "$COMPILER_DIR" 2>/dev/null || true' EXIT

COMPILER_SRC="$COMPILER_DIR/packages/compiler"
FIXTURE="$COMPILER_SRC/test/fixtures/child-cough.logic.json"
[ -f "$FIXTURE" ] || { echo "RESULT: FAIL fixture not found at $FIXTURE"; exit 1; }
chmod -R a+rX "$COMPILER_SRC"

LOG_FILE="$(mktemp)"
echo "== 23-compile-smoke-test: node src/cli.ts, inside $COMPILE_IMAGE, --network none, read-only =="
if docker run --rm --network none --read-only \
  --cap-drop ALL --tmpfs /tmp --user 1000:1000 \
  -v "$COMPILER_SRC:/compiler:ro" \
  -v "$FIXTURE:/in/logic.json:ro" \
  -v "$OUT_DIR:/out:rw" \
  -w /compiler \
  "$COMPILE_IMAGE" \
  node /compiler/src/cli.ts /in/logic.json --out /out --snapshot-hash "sha256:smoketest0000000000000000000000000000000000000000000000000000" \
  > "$LOG_FILE" 2>&1; then
  status=0
else
  status=$?
fi

cat "$LOG_FILE"

if [ "$status" -eq 0 ] && [ -f "$OUT_DIR/compile-manifest.json" ]; then
  echo "RESULT: PASS compiled against child-cough fixture, compile-manifest.json written"
elif [ "$status" -eq 1 ]; then
  echo "RESULT: FAIL compiler rejected the fixture (exit 1) - unexpected, check errors above"
  exit 1
else
  echo "RESULT: FAIL exit $status or no compile-manifest.json written"
  exit 1
fi
