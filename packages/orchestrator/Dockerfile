# Build from the repository root with -f packages/orchestrator/Dockerfile.
FROM node:22.18.0-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080

COPY package.json package-lock.json ./
COPY packages ./packages
COPY runner/package.json ./runner/package.json
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/orchestrator/src/integrated/main.js"]
