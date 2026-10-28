# syntax=docker/dockerfile:1.7
#
# OpenLinear API image. One image, two processes:
#   API     node dist/index.js   default CMD; HTTP on $API_PORT, probes /livez and /readyz
#   worker  node dist/worker.js  background jobs; outbox relay only when REDIS_URL is set
#
# Build from the repository root (the context must be the whole workspace):
#   docker build -f apps/api/Dockerfile -t openlinear-api .
#
# Base image: pinned by digest (a multi-arch index, so amd64 CI and arm64
# laptops build the same Node). Renovate bumps it; keep both FROM lines equal.

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    TURBO_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

# 1. Prune: the workspace slice @openlinear/api actually depends on (today api,
#    api-core, db, execution-core, telemetry) plus a pruned lockfile. It is
#    computed from package.json, so a new workspace dependency can no longer be
#    missing from the image (the 2026-09/10 deploys failed on a deleted
#    packages/types and a missing packages/execution-core). turbo matches the
#    version in pnpm-lock.yaml.
FROM base AS pruner
COPY . .
RUN pnpm dlx turbo@2.8.9 prune @openlinear/api --docker --out-dir /prune

# 2. Dependencies from manifests only: this layer stays cached until a manifest
#    or the lockfile changes. --ignore-scripts: nothing in the API build needs
#    an install script (Prisma generate runs on WASM).
FROM base AS deps
COPY --from=pruner /prune/json/ ./
RUN pnpm install --frozen-lockfile --ignore-scripts

# 3. Build: generate the Prisma client, then bundle dist/index.js and
#    dist/worker.js. prisma.config.ts reads DATABASE_URL while generating; no
#    connection is made, so a placeholder is passed to that one command only.
FROM deps AS build
COPY --from=pruner /prune/full/ ./
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build pnpm --filter @openlinear/db db:generate \
 && pnpm --filter @openlinear/api build \
 && test -s apps/api/dist/index.js \
 && test -s apps/api/dist/worker.js

# 4. Runtime: Node, tini, the two bundles and the migration history. There is
#    no node_modules: every dependency, the Prisma client included, is bundled.
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    API_PORT=3001 \
    OPENLINEAR_MIGRATIONS_DIR=/app/prisma/migrations

WORKDIR /app

# Code stays root-owned and read-only to the app user; only uploads/ (chat
# attachments, created at startup by routes/chat-attachments.ts) is writable.
# Uploads are on the container's ephemeral disk until attachments move to
# object storage: mount a volume at /app/uploads to keep them across restarts.
RUN groupadd --gid 10001 openlinear \
 && useradd --uid 10001 --gid 10001 --home-dir /app --no-create-home --shell /usr/sbin/nologin openlinear \
 && install -d -o 10001 -g 10001 -m 0700 /app/uploads

COPY --from=build /app/apps/api/dist ./dist
# /readyz compares these directory names with _prisma_migrations, so a revision
# deployed before its migration ran never receives traffic.
COPY --from=build /app/packages/db/prisma/migrations ./prisma/migrations

USER 10001:10001

EXPOSE 3001

# Liveness only (no database), for docker run / compose. Orchestrators such as
# Azure Container Apps ignore HEALTHCHECK: point their liveness probe at /livez
# and their readiness probe at /readyz. The worker serves no HTTP, so run it
# with --no-healthcheck (compose: healthcheck.disable: true).
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||3001)+'/livez').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
