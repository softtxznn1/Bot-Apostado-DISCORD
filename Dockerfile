FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi \
    && npm ci --no-audit --no-fund --fetch-retries=1 --fetch-retry-mintimeout=1000 --fetch-timeout=20000
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production DATABASE_PATH=/app/.data/rooms.sqlite NODE_USE_ENV_PROXY=1
WORKDIR /app
COPY --chmod=0644 package.json package-lock.json ./
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi \
    && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --cache /tmp/npm-cache --fetch-retries=1 --fetch-retry-mintimeout=1000 --fetch-timeout=20000 \
    && rm -rf /tmp/npm-cache \
    && mkdir -p /app/.data /app/.cache/npm \
    && chown -R node:node /app/.data /app/.cache \
    && chmod 700 /app/.data
COPY --from=build --chown=node:node /app/dist/src ./dist/src
USER node
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["node", "dist/src/rooms/healthcheck.js"]
CMD ["node", "dist/src/rooms/main.js"]
