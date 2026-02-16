#!/usr/bin/env bash
# deploy.sh — Production deploy script for KazCode
# Called by CI via SSH at /opt/openlinear/deploy.sh
# Also works standalone: ./scripts/deploy.sh
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/openlinear}"
cd "$DEPLOY_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

step() { echo -e "${CYAN}==>${NC} $1"; }
ok()   { echo -e "${GREEN}  ✓${NC} $1"; }
fail() { echo -e "${RED}  ✗${NC} $1"; exit 1; }

# ── Pull latest code ──────────────────────────────────────────────
step "Pulling latest code..."
git pull origin main --ff-only
ok "Code updated"

# ── Install dependencies ─────────────────────────────────────────
step "Installing dependencies..."
# Temporarily override NODE_ENV so pnpm installs devDependencies (prisma, etc.)
# The droplet has NODE_ENV=production globally, which causes pnpm to skip devDeps.
_saved_node_env="${NODE_ENV:-}"
export NODE_ENV=development
pnpm install --frozen-lockfile
export NODE_ENV="${_saved_node_env}"
ok "Dependencies installed"

# ── Database ─────────────────────────────────────────────────────
step "Starting database..."
docker start openlinear-db 2>/dev/null \
    || docker run --detach --name openlinear-db \
        -e POSTGRES_DB=openlinear \
        -e POSTGRES_USER=openlinear \
        -e POSTGRES_PASSWORD=openlinear \
        -p 5432:5432 \
        -v postgres_data:/var/lib/postgresql/data \
        --restart unless-stopped \
        postgres:16-alpine 2>/dev/null \
    || true
ok "PostgreSQL start requested"

step "Waiting for database..."
for i in $(seq 1 30); do
    if docker exec openlinear-db pg_isready -U openlinear -d openlinear &>/dev/null \
       || pg_isready -h localhost -p 5432 -U openlinear &>/dev/null 2>&1; then
        ok "Database ready"
        break
    fi
    if [ "$i" -eq 30 ]; then
        fail "Database failed to start after 30s"
    fi
    sleep 1
done

# Source root .env to get DATABASE_URL (Neon) and other production vars.
# This MUST happen before the fallback below, otherwise every deploy
# overwrites packages/db/.env with the local Docker URL.
if [ -f .env ]; then
    set -a
    source .env
    set +a
fi

# Fallback only if .env didn't provide DATABASE_URL (shouldn't happen in prod)
export DATABASE_URL="${DATABASE_URL:-postgresql://openlinear:openlinear@localhost:5432/openlinear}"
# packages/db/.env is gitignored so it doesn't exist on the droplet.
# Prisma reads .env from the schema directory — write it so prisma db push can find it.
echo "DATABASE_URL=${DATABASE_URL}" > packages/db/.env

step "Generating Prisma client..."
pnpm --filter @openlinear/db db:generate
ok "Prisma client generated"

step "Pushing database schema..."
pnpm --filter @openlinear/db db:push
ok "Schema synced"

# ── Build worker Docker image ────────────────────────────────────
step "Building worker Docker image..."
docker build -t opencode-worker:latest docker/opencode-worker/
ok "Worker image built"

# ── Build applications ───────────────────────────────────────────
step "Building API..."
pnpm --filter @openlinear/api build
ok "API built"

step "Building Web..."
NEXT_PUBLIC_API_URL=https://rixie.in pnpm --filter @openlinear/desktop-ui build
ok "Web built"

step "Building Landing..."
pnpm --filter @openlinear/landing build
ok "Landing built"

# ── Restart services ─────────────────────────────────────────────
step "Restarting services..."

if command -v pm2 &>/dev/null; then
    # PM2 process manager
    pm2 restart openlinear-api 2>/dev/null || \
        pm2 start apps/api/dist/index.js --name openlinear-api
    pm2 restart openlinear-web 2>/dev/null || \
        (cd apps/desktop-ui && pm2 start node_modules/next/dist/bin/next --name openlinear-web -- start -p 3000)
    pm2 restart openlinear-landing 2>/dev/null || \
        (cd apps/landing && pm2 start node_modules/next/dist/bin/next --name openlinear-landing -- start -p 3002)
    pm2 save
    ok "Services restarted (pm2)"
elif systemctl is-active --quiet openlinear-api 2>/dev/null; then
    # Systemd services
    sudo systemctl restart openlinear-api
    sudo systemctl restart openlinear-web
    ok "Services restarted (systemd)"
else
    fail "No process manager found. Install pm2: npm install -g pm2"
fi

echo ""
echo -e "${GREEN}Deploy complete!${NC}"
