#!/usr/bin/env bash
# Builds BUILD_IMAGE (build-image/Dockerfile, FROM medicmobile/cht-app-ide:v6.6.1)
# on x86_64. Prints the python3/xsltproc/node checks baked into the build and
# fails loudly if any of them regressed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE_TAG="${BUILD_IMAGE_TAG:-cht-nocode/build-image:latest}"
LOG_FILE="$(mktemp)"

echo "== 20-build-image: docker build (platform linux/amd64) =="
if docker build --platform linux/amd64 -t "$IMAGE_TAG" "$REPO_ROOT/build-image" 2>&1 | tee "$LOG_FILE"; then
  echo "== 20-build-image: version checks from the build log =="
  # The Dockerfile itself already fails the build if python3 < 3.10 (a RUN
  # step asserts it); if we got here the checks already passed. This just
  # surfaces the printed versions and confirms Chromium actually launched.
  grep '^CHECK ' "$LOG_FILE" || { echo "RESULT: FAIL no CHECK lines found in build log"; exit 1; }

  if ! grep -q 'Chromium launched OK' "$LOG_FILE"; then
    echo "RESULT: FAIL chromium-smoke-test.mjs did not confirm a Chromium launch"
    exit 1
  fi

  echo "RESULT: PASS built $IMAGE_TAG, python3/xsltproc/node checks passed, Chromium launched"
else
  echo "RESULT: FAIL docker build failed, see output above"
  exit 1
fi
