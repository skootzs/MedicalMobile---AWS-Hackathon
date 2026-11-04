#!/bin/sh
# Stage 3 (convert), run inside BUILD_IMAGE. cwd is /work (copied from the
# compile stage's /out by the runner on the host). Writes exit code + output
# to /work/convert.log so the runner can collect it either way.
#
# COMPILE_LOGIC owns all cht-conf conversion (agreed with R2): this stage's
# output package is the complete converted project -- forms/app/*.xml and
# compiled app_settings.json, on top of what the compiler already wrote.
set -u

cd /work || exit 2

# /home/node isn't writable under --read-only (only /out, /work, /tmp are).
export HOME="${HOME:-/tmp}"

FORM_ID="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("compile-manifest.json","utf8")).formId)')"

{
  echo "== run-convert: formId=$FORM_ID =="
  cht --local --skip-dependency-check --skip-git-check \
    convert-app-forms validate-app-forms compile-app-settings -- "$FORM_ID"
} > convert.log 2>&1
exit_code=$?

if [ "$exit_code" -eq 0 ]; then
  echo "RESULT: PASS" >> convert.log
else
  echo "RESULT: FAIL cht exited $exit_code" >> convert.log
fi

cat convert.log
exit "$exit_code"
