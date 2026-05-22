#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

CYAN='\033[0;36m'; GREEN='\033[0;32m'; NC='\033[0m'
log() { echo -e "${CYAN}[dev-live]${NC} $1"; }
ok()  { echo -e "${GREEN}[dev-live]${NC} $1"; }

if [ -f .env ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in \#*|""|\;*) continue ;; esac
        key="${line%%=*}"; value="${line#*=}"
        case "$value" in \"*) value="${value#\"}"; value="${value%\"}" ;; \'*) value="${value#\'}"; value="${value%\'}" ;; esac
        export "$key=$value"
    done < .env
fi

ensure_database() {
    if [ -z "${DATABASE_URL:-}" ]; then
        export DATABASE_URL="postgresql://openlinear:openlinear@localhost:5432/openlinear"
    fi

    if echo "$DATABASE_URL" | grep -qE 'localhost|127\.0\.0\.1'; then
        if ! command -v docker >/dev/null 2>&1; then
            echo "[dev-live] Local DATABASE_URL requires Postgres. Install/start Postgres or Docker."
            exit 1
        fi
        if ! docker ps --format '{{.Names}}' | grep -qx 'openlinear-db'; then
            log "Starting Postgres database container only..."
            docker compose up -d postgres
            sleep 2
        fi
    else
        log "Using configured remote database; skipping Docker."
    fi
}

ensure_database

export API_PORT="${API_PORT:-3001}"
export OPENLINEAR_ALLOW_SHARED_OPENCODE="${OPENLINEAR_ALLOW_SHARED_OPENCODE:-1}"
export NEXT_PUBLIC_API_URL="http://127.0.0.1:$API_PORT"
export FRONTEND_URL="http://127.0.0.1:3000"
REQUIRED_CORS_ORIGINS="http://127.0.0.1:3000,http://localhost:3000,tauri://localhost,https://tauri.localhost"
export CORS_ORIGIN="${CORS_ORIGIN:+$CORS_ORIGIN,}$REQUIRED_CORS_ORIGINS"

log "Preparing database schema..."
pnpm --filter @openlinear/db db:generate
pnpm --filter @openlinear/db db:migrate:deploy

PIDS=()
cleanup() {
    log "Shutting down..."
    for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
    wait 2>/dev/null
}
trap cleanup EXIT INT TERM

log "Starting sidecar on port $API_PORT..."
API_PORT="$API_PORT" pnpm --filter @openlinear/sidecar dev &
PIDS+=($!)

for i in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; then
        ok "Sidecar ready on :$API_PORT"
        break
    fi
    [ "$i" -eq 30 ] && { echo "Sidecar failed to start"; exit 1; }
    sleep 1
done

log "Starting Next.js dev server on :3000 (hot reload)..."
PORT=3000 pnpm --filter @openlinear/desktop-ui dev &
PIDS+=($!)

log "Waiting for Next.js dev server..."
for i in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:3000/" >/dev/null 2>&1; then
        ok "Next.js ready on :3000"
        break
    fi
    [ "$i" -eq 30 ] && { echo "Next.js dev server failed to start"; exit 1; }
    sleep 1
done

log "Launching Tauri desktop app (live reload from Next.js dev server)..."
OPENLINEAR_SKIP_SIDECAR=1 API_PORT="$API_PORT" \
    pnpm --filter @openlinear/desktop exec tauri dev \
    --no-dev-server-wait \
    --config '{"build":{"beforeDevCommand":"","devUrl":"http://127.0.0.1:3000"}}'

wait
