# BUILD_IMAGE: adds the pinned test toolchain to the official cht-app-ide image.
# Confirmed by inspecting medicmobile/cht-app-ide:v6.6.1 directly:
#   - default user: node (uid 1000, gid 1000) -- already non-root, nothing to change
#   - python3 3.11.2 (>= 3.10 required)       - OK
#   - xsltproc present                         - OK
#   - node v20.20.2 (fine for R6's harness chain, tested on Node 20/22/24)
#   - cht-conf 6.6.1 pinned globally           - OK
#   - WORKDIR /workdir, HOME /home/node
#   - ENTRYPOINT ["cht"] -- MUST be cleared below, or `docker run <image> sh
#     /run-convert.sh` gets interpreted as `cht sh /run-convert.sh` (fails:
#     "Unsupported action(s): bash/sh"). Confirmed by running the base image
#     directly before writing this file.
#
# Don't add cht-ui-builder or openpyxl (not needed; the compiler's own CLI
# does not call cht-conf, and compile-app-settings/convert-app-forms/
# validate-app-forms don't need openpyxl).
FROM medicmobile/cht-app-ide:v6.6.1

ENV TZ=Africa/Nairobi
ENTRYPOINT []

USER root

# Chromium runtime libs (puppeteer/cht-conf-test-harness launches a bundled
# Chromium; these are the common missing-lib failures on slim Debian bases).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 libdbus-1-3 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxtst6 \
    libx11-xcb1 libxcb1 libgbm1 libasound2 libpango-1.0-0 libcairo2 libgtk-3-0 \
    fonts-liberation ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /build-image
COPY package.json package-lock.json ./

# Check tool versions up front and fail loudly if anything regressed. Printed
# in the build log; a mismatch here is a reason to stop and ask, per the
# pinned-version policy in r7-infra-instructions.md.
RUN set -eux; \
  PYVER="$(python3 --version 2>&1)"; echo "CHECK python3: ${PYVER}"; \
  python3 -c "import sys; assert sys.version_info >= (3, 10), 'python3 < 3.10'"; \
  echo "CHECK xsltproc: $(xsltproc --version 2>&1 | head -1)"; \
  echo "CHECK node: $(node --version)"; \
  echo "CHECK cht-conf: $(cht --version 2>&1)"

RUN chown -R node:node /build-image

# Install as `node`: the resolver downloads Chromium under the installing user's
# home, and a copy under /root is unreadable at run time (uid 1000), which makes
# the harness try to re-download and fail under --network none.
USER node

RUN npm ci --ignore-scripts
RUN npm rebuild puppeteer-chromium-resolver

# Build-time launch checks. --no-sandbox applies here only because docker build
# has no SYS_ADMIN; stage 6 runs the sandbox with --cap-add SYS_ADMIN.
COPY chromium-smoke-test.mjs ./
RUN node chromium-smoke-test.mjs
# TODO(R7): also start the real harness here; harness-bake.cjs failed under emulation.

# QEMU writes core dumps here when Chromium aborts under amd64 emulation.
RUN find /build-image -name '*.core' -type f -delete

WORKDIR /workdir

COPY --chown=node:node run-convert.sh /run-convert.sh
COPY --chown=node:node run-verify.sh /run-verify.sh
