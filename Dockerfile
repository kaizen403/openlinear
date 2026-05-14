FROM node:22-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV CI=1
ENV NEXT_TELEMETRY_DISABLED=1

RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      openssl \
      postgresql \
      postgresql-contrib \
      tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS deps

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/sidecar/package.json apps/sidecar/package.json
COPY apps/desktop-ui/package.json apps/desktop-ui/package.json
COPY apps/landing/package.json apps/landing/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/types/package.json packages/types/package.json
COPY packages/openlinear-cli/package.json packages/openlinear-cli/package.json

RUN pnpm install --no-frozen-lockfile --prefer-offline --ignore-scripts

FROM base AS build

COPY --from=deps /app /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY apps ./apps
COPY packages ./packages

RUN pnpm install --no-frozen-lockfile --prefer-offline

ENV DATABASE_URL=postgresql://openlinear:openlinear@localhost:5432/openlinear

RUN pnpm --filter @openlinear/db db:generate

RUN pnpm --filter @openlinear/api build

RUN pnpm --filter @openlinear/sidecar build

RUN pnpm --filter @openlinear/desktop-ui build

RUN pnpm --filter @openlinear/landing build

FROM base AS runtime

ENV NODE_ENV=production
ENV DATABASE_URL=postgresql://openlinear:openlinear@127.0.0.1:5432/openlinear
ENV API_PORT=3001
ENV PORT=3000
ENV FRONTEND_URL=http://localhost:3000
ENV CORS_ORIGIN=http://localhost:3000,http://localhost:3002
ENV NEXT_TELEMETRY_DISABLED=1
ENV PGDATA=/var/lib/postgresql/data
ENV REPOS_DIR=/var/lib/openlinear/repos

COPY --from=build /app /app

RUN mkdir -p /var/lib/postgresql/data /var/lib/openlinear/repos /var/log/openlinear \
    && chown -R postgres:postgres /var/lib/postgresql/data

COPY scripts/docker/entrypoint.sh /usr/local/bin/openlinear-entrypoint
COPY scripts/docker/init-db.sh /usr/local/bin/openlinear-init-db
RUN chmod +x /usr/local/bin/openlinear-entrypoint /usr/local/bin/openlinear-init-db

EXPOSE 3000 3001 3002

HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=8 \
  CMD curl -fsS http://localhost:3001/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/openlinear-entrypoint"]
