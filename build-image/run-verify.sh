#!/bin/sh
# Stage 6 (verify), run inside BUILD_IMAGE. /project is the already-converted package from
# COMPILE_LOGIC, so nothing is reconverted here. The runner passes CHT_CONFIG_DIR, OUT_DIR,
# TZ, PACKAGE_HASH, COMPILE_ARTIFACT_HASH, LOGIC_MODEL_HASH, INPUT_HASH and, for jobs with
# golden cases, GOLDEN_CASES_FILE and GOLDEN_CASES_HASH.
#
# Exit codes: 0 passed, 1 failed with a valid report, 2 runner error.
VERIFIER_ENTRYPOINT="/verifier/dist/run.js"
CHT_CONFIG_DIR="${CHT_CONFIG_DIR:-/project}"
OUT_DIR="${OUT_DIR:-/out}"
STAGE_LOG="/tmp/run-verify-stage.log"

set -u
export TZ="${TZ:-Africa/Nairobi}"
# /verifier has no node_modules: the harness and its Chromium are baked into the image.
export NODE_PATH="/build-image/node_modules"
# The verifier's fallback if `cht --version` can't run. Matches the image's pin.
export CHT_CONF_VERSION="${CHT_CONF_VERSION:-6.6.1}"
# The verifier's Python evaluator sits on a read-only mount.
export PYTHONDONTWRITEBYTECODE=1
export CHT_CONFIG_DIR OUT_DIR

# The verifier writes verification.log itself, so its console output goes elsewhere first.
# The preload adds Chromium's --no-sandbox, since the stage has no capabilities for its sandbox.
node --require /harness-no-sandbox.cjs "$VERIFIER_ENTRYPOINT" > "$STAGE_LOG" 2>&1
exit_code=$?

{
  echo "== run-verify: console output (CHT_CONFIG_DIR=$CHT_CONFIG_DIR OUT_DIR=$OUT_DIR) =="
  cat "$STAGE_LOG"
} >> "$OUT_DIR/verification.log"

if [ "$exit_code" -eq 0 ] || [ "$exit_code" -eq 1 ]; then
  # The runner validates report.json against R6's schema; this only catches a missing one.
  if [ ! -s "$OUT_DIR/report.json" ]; then
    echo "RESULT: FAIL exit $exit_code but no report.json written" >> "$OUT_DIR/verification.log"
    cat "$OUT_DIR/verification.log"
    exit 2
  fi
  echo "RESULT: PASS exit $exit_code, report.json present" >> "$OUT_DIR/verification.log"
else
  echo "RESULT: FAIL runner error, exit $exit_code" >> "$OUT_DIR/verification.log"
fi

cat "$OUT_DIR/verification.log"
exit "$exit_code"
