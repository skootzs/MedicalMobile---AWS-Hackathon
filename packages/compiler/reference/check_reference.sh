#!/usr/bin/env bash
# Rebuild the handwritten child-cough XLSForm and run cht-conf's conversion and validation on it.
#
# Requires cht-conf (6.6.1 is what was tested), Python 3.10+ with openpyxl, and xsltproc.
#   CHT     path to the cht binary          (default: cht)
#   PYTHON  python with openpyxl installed  (default: python3)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
project="$here/child-cough/cht-project"
CHT="${CHT:-cht}"
PYTHON="${PYTHON:-python3}"

"$PYTHON" "$here/write_reference_xlsx.py" \
  "$here/child-cough/child_cough.rows.json" \
  "$project/forms/app/child_cough.xlsx"

cd "$project"
"$CHT" --version
"$CHT" --local --skip-dependency-check --skip-git-check \
  convert-app-forms validate-app-forms -- child_cough
