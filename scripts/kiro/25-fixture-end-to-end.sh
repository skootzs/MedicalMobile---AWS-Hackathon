#!/usr/bin/env bash
# Runs Matiyas's (R5) child-cough fixture through the full pipeline on x86_64:
#   compile (COMPILE_IMAGE, --template templates/cht-base@pinned commit)
#   -> copy /out to /work
#   -> convert (BUILD_IMAGE, run-convert.sh: compile-app-settings convert-app-forms validate-app-forms)
#   -> harness (BUILD_IMAGE, his test/harness/child-cough.spec.cjs, cht-conf-test-harness)
# Saves the full combined output to a log file so Srithan can send it to
# Matiyas regardless of pass or fail.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
COMPILER_COMMIT="${COMPILER_COMMIT:-7f488e6}"
COMPILE_IMAGE="${COMPILE_IMAGE:-node:22.23.4-slim}"
BUILD_IMAGE_TAG="${BUILD_IMAGE_TAG:-cht-nocode/build-image:latest}"
COMPILER_DIR="${COMPILER_DIR:-$(mktemp -d)/compiler-worktree}"
OUT_DIR="$(mktemp -d)"
WORK_DIR="$(mktemp -d)"
# mktemp dirs are mode 700, but containers run as uid 1000. Writable mounts need
# 0777 and read-only mounts need a+rX.
chmod 0777 "$OUT_DIR" "$WORK_DIR"
RESULT_LOG="${RESULT_LOG:-$REPO_ROOT/scripts/kiro/fixture-e2e-last-run.log}"

exec > >(tee "$RESULT_LOG") 2>&1

cleanup() {
  git -C "$REPO_ROOT" worktree remove --force "$COMPILER_DIR" 2>/dev/null || true
  echo "Full output saved to: $RESULT_LOG"
}
trap cleanup EXIT

echo "== 25-fixture-end-to-end: git worktree add (read-only, pinned to $COMPILER_COMMIT) =="
git -C "$REPO_ROOT" fetch origin compiler
git -C "$REPO_ROOT" worktree add --detach "$COMPILER_DIR" "$COMPILER_COMMIT"

COMPILER_SRC="$COMPILER_DIR/packages/compiler"
TEMPLATE_DIR="$COMPILER_DIR/templates/cht-base"
FIXTURE="$COMPILER_SRC/test/fixtures/child-cough.logic.json"
HARNESS_SPEC="$COMPILER_SRC/test/harness/child-cough.spec.cjs"

for f in "$FIXTURE" "$HARNESS_SPEC"; do
  [ -f "$f" ] || { echo "RESULT: FAIL not found: $f"; exit 1; }
done
[ -d "$TEMPLATE_DIR" ] || { echo "RESULT: FAIL template dir not found: $TEMPLATE_DIR"; exit 1; }
chmod -R a+rX "$COMPILER_SRC" "$TEMPLATE_DIR"

echo
echo "== stage 1/4: compile ($COMPILE_IMAGE, --template templates/cht-base, --network none) =="
if ! docker run --rm --network none --read-only \
  --cap-drop ALL --tmpfs /tmp --user 1000:1000 \
  -v "$COMPILER_SRC:/compiler:ro" \
  -v "$TEMPLATE_DIR:/template:ro" \
  -v "$FIXTURE:/in/logic.json:ro" \
  -v "$OUT_DIR:/out:rw" \
  -w /compiler \
  "$COMPILE_IMAGE" \
  node /compiler/src/cli.ts /in/logic.json --out /out --template /template \
    --snapshot-hash "sha256:fixturee2e000000000000000000000000000000000000000000000000000"; then
  echo "RESULT: FAIL compile stage failed"
  exit 1
fi
[ -f "$OUT_DIR/compile-manifest.json" ] || { echo "RESULT: FAIL compile-manifest.json not written"; exit 1; }

echo
echo "== stage 2/4: copy /out -> /work (host) =="
cp -a "$OUT_DIR"/. "$WORK_DIR"/
chmod -R a+rwX "$WORK_DIR"
ls -la "$WORK_DIR"

echo
echo "== stage 3/4: convert ($BUILD_IMAGE_TAG, run-convert.sh) =="
if ! docker run --rm --platform linux/amd64 --network none --read-only \
  --cap-drop ALL --tmpfs /tmp --user 1000:1000 \
  -e SHIV_ROOT=/work/shiv -e npm_config_cache=/tmp/npm -e TZ=Africa/Nairobi \
  -v "$WORK_DIR:/work:rw" \
  -w /work \
  "$BUILD_IMAGE_TAG" \
  sh /run-convert.sh; then
  echo "RESULT: FAIL convert stage failed (see convert.log above)"
  exit 1
fi

echo
echo "== stage 4/4: harness (test/harness/child-cough.spec.cjs, inside $BUILD_IMAGE_TAG) =="
if ! docker run --rm --platform linux/amd64 --network none --read-only \
  --cap-drop ALL --tmpfs /tmp --user 1000:1000 \
  -e CHT_PROJECT=/project -e TZ=Africa/Nairobi -e npm_config_cache=/tmp/npm \
  -e NODE_PATH=/build-image/node_modules -e NODE_OPTIONS=--require=/harness-no-sandbox.cjs \
  -v "$WORK_DIR:/project:ro" \
  -v "$HARNESS_SPEC:/harness/child-cough.spec.cjs:ro" \
  -w /harness \
  "$BUILD_IMAGE_TAG" \
  node /build-image/node_modules/.bin/mocha /harness/child-cough.spec.cjs --timeout 60000; then
  echo "RESULT: FAIL harness spec failed at compiler@$COMPILER_COMMIT"
  exit 1
fi

echo
echo "RESULT: PASS fixture end-to-end (compile -> convert -> harness) at compiler@$COMPILER_COMMIT"
