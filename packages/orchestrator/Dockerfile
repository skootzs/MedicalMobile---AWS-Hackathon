# R2 orchestrator — production image.
#
# Node 22 (>= 22.18, matching R7's app-host and R5's compiler requirement). The
# app runs its TypeScript sources directly via Node's type stripping, so no
# build/transpile step is needed. Dependencies are the exact pinned versions in
# package.json; no lockfile is created in the image (the team lockfile is owned
# at the workspace root, not here).
#
# Runtime contract:
#   - Starts with `npm start` (node --experimental-strip-types src/main.ts).
#   - Fastify listens on 0.0.0.0:8080 (HOST/PORT default here; overridable).
#   - GET /health responds unauthenticated.
#   - SIGTERM/SIGINT trigger graceful shutdown (handled in src/main.ts); tini is
#     PID 1 so signals reach node cleanly under Compose.
#   - No AWS credentials or secrets are embedded; AWS mode uses the instance role
#     and reads config from the environment. AWS mode cannot load demo identities
#     (that path is MODE=local only, enforced in bootstrap.ts).
#
# Build context is this package directory, e.g. from a Compose service:
#   build: { context: ./packages/orchestrator }
FROM node:22.18.0-bookworm-slim AS base

# tini for correct PID 1 signal handling (SIGTERM/SIGINT -> node).
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080

WORKDIR /app

# Install only production dependencies, pinned exactly by package.json. No
# lockfile is written (the shared lockfile is a root/team concern), and install
# scripts are skipped for reproducibility and supply-chain safety.
COPY package.json ./
RUN npm install --omit=dev --no-package-lock --ignore-scripts \
 && npm cache clean --force

# Application sources (TypeScript, run directly via type stripping).
COPY tsconfig.json ./
COPY src ./src

# Run as the unprivileged built-in `node` user.
USER node

EXPOSE 8080

# Lightweight liveness check against the unauthenticated /health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini as PID 1 so SIGTERM/SIGINT reach node directly. We invoke node rather
# than `npm start` so the signal is delivered to the Node process itself (npm
# does not forward signals to its child), letting main.ts shut down gracefully.
# This runs the exact same entry as `npm start`.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--experimental-strip-types", "src/main.ts"]
