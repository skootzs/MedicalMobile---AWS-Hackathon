#!/usr/bin/env bash
# R6's check: run cht-core's own reference config/default tests once inside
# the built BUILD_IMAGE, --network none, and report whether Chromium
# launched. Confirmed command via the cht-core repo itself:
#   config/default/package.json -> "test-unit": "mocha --recursive ... test"
#   config/default/test/forms/*.spec.js use cht-conf-test-harness (Chromium)
set -euo pipefail

IMAGE_TAG="${BUILD_IMAGE_TAG:-cht-nocode/build-image:latest}"
WORK_DIR="$(mktemp -d)"
# Files the container (uid 1000) created may not be removable by this user.
trap 'rm -rf "$WORK_DIR" 2>/dev/null || true' EXIT

echo "== 21-cht-core-reference-tests: cloning cht-core (shallow, default branch) =="
git clone --depth 1 https://github.com/medic/cht-core.git "$WORK_DIR/cht-core"

CONFIG_DIR="$WORK_DIR/cht-core/config/default"
# config/default has no dependencies or lockfile of its own, so install what its tests use.
# The versions match build-image/package.json. The harness isn't in the list: tests get the
# image's copy through NODE_PATH, with the Chromium baked in for offline runs.
echo "== 21-cht-core-reference-tests: npm install --no-save (network needed for this step only) =="
(cd "$CONFIG_DIR" && npm install --no-save --ignore-scripts --no-audit --no-fund \
  mocha@12.0.3 chai@4.5.0 chai-like@^1.1.3 chai-things@^0.2.0 chai-exclude@^2.1.1 chai-as-promised@^7.1.2 \
  sinon@^18.0.1 sinon-chai@^3.7.0 deep-equal-in-any-order@^2.0.6 moment@^2.30.1)
# The mount is writable and the image runs as uid 1000, which may not own this checkout.
chmod -R a+rwX "$CONFIG_DIR"

LOG_FILE="$(mktemp)"
echo "== 21-cht-core-reference-tests: npm run test-unit, inside $IMAGE_TAG, --network none =="
if docker run --rm --platform linux/amd64 --network none --read-only \
  --cap-drop ALL --tmpfs /tmp --user 1000:1000 \
  -e NODE_PATH=/build-image/node_modules -e NODE_OPTIONS=--require=/harness-no-sandbox.cjs \
  -e npm_config_cache=/tmp/npm \
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
