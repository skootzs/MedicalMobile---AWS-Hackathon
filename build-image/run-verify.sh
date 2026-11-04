#!/bin/sh
# Stage 6 (verify), run inside BUILD_IMAGE with --cap-add SYS_ADMIN (Chromium).
# /project is the already-converted package from COMPILE_LOGIC (forms/app/*.xml
# + compiled app_settings.json) -- NO reconversion happens here.
#
# TODO(R6): confirm the exact command and env var names once the verifier is
# written (see docs/job-delivery.md / r7-infra-instructions.md section 6).
# Everything that's R6's to confirm is isolated in this block so it's a
# one-line change later.
VERIFIER_ENTRYPOINT="/verifier/dist/run.js"
CHT_CONFIG_DIR="${CHT_CONFIG_DIR:-/project}"
OUT_DIR="${OUT_DIR:-/out}"

set -u
export TZ="${TZ:-Africa/Nairobi}"
export CHT_CONFIG_DIR OUT_DIR

{
  echo "== run-verify: CHT_CONFIG_DIR=$CHT_CONFIG_DIR OUT_DIR=$OUT_DIR =="
  node "$VERIFIER_ENTRYPOINT"
} > "$OUT_DIR/verification.log" 2>&1
exit_code=$?

if [ "$exit_code" -eq 0 ] || [ "$exit_code" -eq 1 ]; then
  # 0 = passed, 1 = failed-but-ran: both need a valid report.json. The runner
  # (not this script) validates report.json against R6's schema and treats
  # exit 0/1 with a missing/invalid report as exit 2.
  if [ ! -s "$OUT_DIR/report.json" ]; then
    echo "RESULT: FAIL exit $exit_code but no report.json written" >> "$OUT_DIR/verification.log"
    exit 2
  fi
  echo "RESULT: PASS exit $exit_code, report.json present" >> "$OUT_DIR/verification.log"
else
  echo "RESULT: FAIL runner error, exit $exit_code" >> "$OUT_DIR/verification.log"
fi

cat "$OUT_DIR/verification.log"
exit "$exit_code"
