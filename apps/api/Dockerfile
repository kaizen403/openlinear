# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV CI=1

RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS deps

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY apps/api/package.json          apps/api/package.json
COPY packages/db/package.json       packages/db/package.json
COPY packages/types/package.json    packages/types/package.json
COPY packages/api-core/package.json packages/api-core/package.json
COPY packages/api-client/package.json packages/api-client/package.json
COPY packages/telemetry/package.json packages/telemetry/package.json

RUN pnpm install --frozen-lockfile --ignore-scripts

FROM base AS build

COPY --from=deps /app /app

COPY apps/api        apps/api
COPY packages/db     packages/db
COPY packages/types  packages/types
COPY packages/api-core packages/api-core
COPY packages/api-client packages/api-client
COPY packages/telemetry packages/telemetry

ENV DATABASE_URL=postgresql://x:x@localhost:5432/x

RUN pnpm --filter @openlinear/db db:generate
RUN pnpm --filter @openlinear/api build

RUN pnpm --filter @openlinear/api --prod deploy /app/pruned

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV API_PORT=3001

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      openssl \
      tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN groupadd --gid 10001 openlinear \
 && useradd --uid 10001 --gid 10001 --home-dir /app --shell /usr/sbin/nologin openlinear

COPY --from=build --chown=10001:10001 /app/pruned/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/apps/api/dist       ./dist
COPY --from=build --chown=10001:10001 /app/packages/db/prisma  ./prisma

USER 10001

EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -fsS http://localhost:3001/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
