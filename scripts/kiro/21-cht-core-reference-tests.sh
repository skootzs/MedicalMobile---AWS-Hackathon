#!/usr/bin/env bash
# R6's check: run cht-core's own reference config/default tests once inside
# the built BUILD_IMAGE, --network none, and report whether Chromium
# launched. Confirmed command via the cht-core repo itself:
#   config/default/package.json -> "test-unit": "mocha --recursive ... test"
#   config/default/test/forms/*.spec.js use cht-conf-test-harness (Chromium)
set -euo pipefail

IMAGE_TAG="${BUILD_IMAGE_TAG:-cht-nocode/build-image:latest}"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "== 21-cht-core-reference-tests: cloning cht-core (shallow, default branch) =="
git clone --depth 1 https://github.com/medic/cht-core.git "$WORK_DIR/cht-core"

CONFIG_DIR="$WORK_DIR/cht-core/config/default"
echo "== 21-cht-core-reference-tests: npm ci (network needed for this step only) =="
(cd "$CONFIG_DIR" && npm ci)

LOG_FILE="$(mktemp)"
echo "== 21-cht-core-reference-tests: npm run test-unit, inside $IMAGE_TAG, --network none =="
if docker run --rm --network none \
  -v "$CONFIG_DIR:/workdir:rw" \
  -w /workdir \
  "$IMAGE_TAG" \
  sh -c "npm run test-unit" > "$LOG_FILE" 2>&1; then
  status=0
else
  status=$?
fi

cat "$LOG_FILE"

chromium_launched="no"
grep -qiE 'chromium|puppeteer' "$LOG_FILE" && ! grep -qiE 'error.*launch' "$LOG_FILE" && chromium_launched="yes (no launch errors seen)"

if [ "$status" -eq 0 ]; then
  echo "RESULT: PASS cht-core reference tests passed inside the image; Chromium: $chromium_launched"
else
  echo "RESULT: FAIL cht-core reference tests exited $status; Chromium: $chromium_launched; see output above"
  exit 1
fi
