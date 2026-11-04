#!/usr/bin/env bash
# Builds BUILD_IMAGE (build-image/Dockerfile, FROM medicmobile/cht-app-ide:v6.6.1)
# on x86_64, then checks the toolchain by running the built image. It doesn't parse the
# build log: cached layers print nothing, and BuildKit prefixes every line.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE_TAG="${BUILD_IMAGE_TAG:-cht-nocode/build-image:latest}"

echo "== 20-build-image: docker build (platform linux/amd64) =="
if ! docker build --platform linux/amd64 -t "$IMAGE_TAG" "$REPO_ROOT/build-image"; then
  echo "RESULT: FAIL docker build failed, see output above"
  exit 1
fi

in_image() { docker run --rm --platform linux/amd64 --network none "$IMAGE_TAG" sh -c "$1"; }

echo "== 20-build-image: toolchain checks =="
in_image 'python3 --version' || { echo "RESULT: FAIL python3 did not run"; exit 1; }
in_image "python3 -c 'import sys; assert sys.version_info >= (3, 10)'" || { echo "RESULT: FAIL python3 < 3.10"; exit 1; }
in_image "python3 -c 'from importlib.metadata import version; import jsonschema; assert version(\"jsonschema\") == \"4.26.0\"'" || { echo "RESULT: FAIL jsonschema 4.26.0 not importable"; exit 1; }
in_image 'xsltproc --version | head -1' || { echo "RESULT: FAIL xsltproc did not run"; exit 1; }
in_image 'node --version' || { echo "RESULT: FAIL node did not run"; exit 1; }
in_image 'cht --version' || { echo "RESULT: FAIL cht did not run"; exit 1; }

echo "== 20-build-image: Chromium launch check =="
if ! in_image 'cd /build-image && node chromium-smoke-test.mjs' | grep 'Chromium launched OK'; then
  echo "RESULT: FAIL Chromium did not launch in the built image"
  exit 1
fi

echo "RESULT: PASS built $IMAGE_TAG, python3/jsonschema/xsltproc/node/cht checks passed, Chromium launched"
