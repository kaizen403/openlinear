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
pnpm install --frozen-lockfile
ok "Dependencies installed"

# ── Database ─────────────────────────────────────────────────────
step "Starting database..."
docker compose up -d postgres
ok "PostgreSQL running"

step "Waiting for database..."
for i in $(seq 1 30); do
    if docker exec openlinear-db pg_isready -U openlinear -d openlinear &>/dev/null; then
        ok "Database ready"
        break
    fi
    if [ "$i" -eq 30 ]; then
        fail "Database failed to start after 30s"
    fi
    sleep 1
done

step "Generating Prisma client..."
pnpm --filter @openlinear/db db:generate
ok "Prisma client generated"

step "Pushing database schema..."
pnpm db:push
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

# ── Restart services ─────────────────────────────────────────────
step "Restarting services..."

if command -v pm2 &>/dev/null; then
    # PM2 process manager
    pm2 restart openlinear-api 2>/dev/null || \
        pm2 start apps/api/dist/index.js --name openlinear-api
    pm2 restart openlinear-web 2>/dev/null || \
        pm2 start node_modules/.bin/next --name openlinear-web -- start -p 3000 --cwd apps/desktop-ui
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
