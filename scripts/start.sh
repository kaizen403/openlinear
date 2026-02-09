#!/usr/bin/env bash
# OpenLinear — start everything
# Usage: ./scripts/start.sh [--api-only | --ui-only | --desktop]
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${CYAN}[start]${NC} $1"; }
ok()   { echo -e "${GREEN}[start]${NC} $1"; }
warn() { echo -e "${YELLOW}[start]${NC} $1"; }
err()  { echo -e "${RED}[start]${NC} $1"; }

PIDS=()
cleanup() {
    echo ""
    log "Shutting down..."
    for pid in "${PIDS[@]}"; do
        kill "$pid" 2>/dev/null && wait "$pid" 2>/dev/null || true
    done
    ok "All processes stopped."
    exit 0
}
trap cleanup INT TERM

MODE="${1:-all}"

# ── Step 1: Check prerequisites ──────────────────────────────────

if ! command -v docker &>/dev/null; then
    err "Docker is not installed. Install Docker Desktop: https://www.docker.com"
    exit 1
fi

if ! docker info &>/dev/null; then
    warn "Docker daemon not running. Starting Docker Desktop..."
    open -a Docker 2>/dev/null || true
    for i in $(seq 1 30); do
        docker info &>/dev/null && break
        sleep 2
    done
    if ! docker info &>/dev/null; then
        err "Docker failed to start after 60s. Start it manually."
        exit 1
    fi
    ok "Docker is running."
fi

if ! command -v pnpm &>/dev/null; then
    err "pnpm is not installed. Run: npm install -g pnpm"
    exit 1
fi

# ── Step 2: Environment ──────────────────────────────────────────

if [ ! -f .env ]; then
    warn "No .env file found. Copying from .env.example..."
    cp .env.example .env
fi

# source .env so DATABASE_URL is available for Prisma CLI
set -a
source .env
set +a

# ── Step 3: Dependencies ─────────────────────────────────────────

if [ ! -d node_modules ]; then
    log "Installing dependencies..."
    pnpm install
fi

# ── Step 4: Database ─────────────────────────────────────────────

if ! docker ps --format '{{.Names}}' | grep -q 'openlinear-db'; then
    log "Starting PostgreSQL..."
    docker compose up -d
fi

log "Waiting for database..."
for i in $(seq 1 30); do
    if docker exec openlinear-db pg_isready -U openlinear -d openlinear &>/dev/null; then
        ok "Database ready."
        break
    fi
    if [ "$i" -eq 30 ]; then
        err "Database failed to start after 30s."
        exit 1
    fi
    sleep 1
done

# ── Step 5: Prisma ───────────────────────────────────────────────

if [ ! -d node_modules/.pnpm/@prisma+client@*/node_modules/@prisma/client ]; then
    log "Generating Prisma client..."
    pnpm --filter @openlinear/db db:generate
fi

log "Syncing database schema..."
pnpm db:push 2>/dev/null || true

# ── Step 6: Free stale ports ─────────────────────────────────────

for port in 3000 3001; do
    pids=$(lsof -ti :$port 2>/dev/null)
    if [ -n "$pids" ]; then
        warn "Killing stale process on :$port"
        echo "$pids" | xargs kill -9 2>/dev/null
        sleep 1
    fi
done

# ── Step 7: Start services ───────────────────────────────────────

case "$MODE" in
    --api-only)
        log "Starting API only..."
        API_PORT=3001 pnpm --filter @openlinear/api dev &
        PIDS+=($!)
        sleep 2
        ok "API:  http://localhost:3001"
        ;;
    --ui-only)
        log "Starting UI only..."
        PORT=3000 pnpm --filter @openlinear/desktop-ui dev &
        PIDS+=($!)
        sleep 2
        ok "UI:   http://localhost:3000"
        ;;
    --desktop)
        log "Starting API + Desktop app..."
        API_PORT=3001 pnpm --filter @openlinear/api dev &
        PIDS+=($!)
        sleep 2
        ok "API:  http://localhost:3001"
        log "Starting Tauri desktop..."
        API_PORT=3001 PORT=3000 pnpm --filter @openlinear/desktop tauri dev
        cleanup
        exit 0
        ;;
    all|*)
        log "Starting API..."
        API_PORT=3001 pnpm --filter @openlinear/api dev &
        PIDS+=($!)
        sleep 2

        log "Starting UI..."
        PORT=3000 pnpm --filter @openlinear/desktop-ui dev &
        PIDS+=($!)
        sleep 2

        echo ""
        echo -e "  ${GREEN}✓${NC} API:  ${CYAN}http://localhost:3001${NC}"
        echo -e "  ${GREEN}✓${NC} UI:   ${CYAN}http://localhost:3000${NC}"
        echo -e "  ${GREEN}✓${NC} DB:   ${CYAN}localhost:5432${NC}"
        echo ""
        ok "All services running. Press Ctrl+C to stop."
        ;;
esac

wait
