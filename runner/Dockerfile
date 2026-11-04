# Delivery bundle for the build runner. scripts/build-runner-image.sh prepares the context.
#
# The runner starts stage containers with host paths, so it runs on the host under systemd
# and this image is how it gets there: install-runner.sh copies /opt/cht-nocode-bundle out.
# That also means no container needs the Docker socket. See docs/decisions.md.
FROM node:22.23.4-slim

WORKDIR /opt/cht-nocode-bundle
COPY . .
WORKDIR /opt/cht-nocode-bundle/runner
# postinstall only copies handoffs.ts into src/generated, which the context already has.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

CMD ["node", "src/main.ts"]
