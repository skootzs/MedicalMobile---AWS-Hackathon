#!/bin/sh
# Stage 3 (convert), run inside BUILD_IMAGE. cwd is /work (copied from the
# compile stage's /out by the runner on the host). Writes exit code + output
# to /work/convert.log so the runner can collect it either way.
#
# COMPILE_LOGIC owns all cht-conf conversion (agreed with R2): this stage's
# output package is the complete converted project -- forms/app/*.xml,
# compiled app_settings.json and (when the pathway has a follow-up) tasks.js.
#
# No formId / `-- <formId>` here (confirmed with R5 at compiler@7f488e6): all
# three actions run project-wide, so app settings and tasks.js build too.
set -u

cd /work || exit 2

# /home/node isn't writable under --read-only (only /out, /work, /tmp are).
export HOME=/tmp

{
  echo "== run-convert =="
  cht --local --skip-dependency-check --skip-git-check \
    compile-app-settings convert-app-forms validate-app-forms
} > convert.log 2>&1
exit_code=$?

if [ "$exit_code" -eq 0 ]; then
  echo "RESULT: PASS" >> convert.log
else
  echo "RESULT: FAIL cht exited $exit_code" >> convert.log
fi

cat convert.log
exit "$exit_code"
