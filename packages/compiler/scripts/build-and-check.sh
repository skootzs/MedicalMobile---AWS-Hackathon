#!/usr/bin/env bash
# Compile a LogicModel into a CHT project directory, then run cht-conf conversion and validation on it.
# Fails if either step fails. Extra arguments are passed to the compiler (--watermark, --snapshot-hash, --icon).
#
#   scripts/build-and-check.sh <logic-model.json> <out-dir> [compiler options]
#   CHT      cht-conf binary (default: cht)
#   SHIV_ROOT  writable folder for cht-conf's bundled Python converter if $HOME is read-only
set -euo pipefail

if [ "$#" -lt 2 ]; then
  sed -n '2,8p' "$0"
  exit 2
fi
model="$1"
out="$2"
shift 2
here="$(cd "$(dirname "$0")/.." && pwd)"
CHT="${CHT:-cht}"

node "$here/src/cli.ts" "$model" --out "$out" "$@"
form_id="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).formId)' "$out/compile-manifest.json")"

cd "$out"
"$CHT" --local --skip-dependency-check --skip-git-check convert-app-forms validate-app-forms -- "$form_id"
echo "OK: $out/forms/app/$form_id.xml"
