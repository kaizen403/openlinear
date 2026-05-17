#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${CYAN}[start]${NC} $1"; }
ok()   { echo -e "${GREEN}[start]${NC} $1"; }
warn() { echo -e "${YELLOW}[start]${NC} $1"; }
err()  { echo -e "${RED}[start]${NC} $1"; }

UI_PORT="${UI_PORT:-3000}"
export API_PORT="${API_PORT:-3001}"

PIDS=()
cleanup() {
    log "Shutting down..."
    for pid in "${PIDS[@]}"; do
        kill "$pid" 2>/dev/null || true
    done
    for pid in "${PIDS[@]}"; do
        wait "$pid" 2>/dev/null || true
    done
}
trap cleanup EXIT INT TERM

if [ -f .env ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            \#*|""|\;*) continue ;;
        esac
        key="${line%%=*}"
        value="${line#*=}"
        case "$value" in
            \"*) value="${value#\"}"; value="${value%\"}" ;;
            \'*) value="${value#\'}"; value="${value%\'}" ;;
        esac
        export "$key=$value"
    done < .env
fi

if [ -n "${DATABASE_URL:-}" ] && echo "$DATABASE_URL" | grep -qE 'localhost|127\.0\.0\.1'; then
    if ! docker ps --format '{{.Names}}' | grep -q 'openlinear-db'; then
        log "Starting database..."
        docker compose up -d
        sleep 2
    fi
fi

log "Syncing database schema..."
pnpm --filter @openlinear/db db:generate
pnpm --filter @openlinear/db db:push

log "Building Next.js frontend for production (static export -> out/)..."
BUILD_FOR_TAURI=1 pnpm --filter @openlinear/desktop-ui build

OUT_DIR="$ROOT_DIR/apps/desktop-ui/out"
if [ ! -d "$OUT_DIR" ]; then
    err "Build did not produce $OUT_DIR"
    exit 1
fi

log "Starting API server on port $API_PORT..."
API_PORT="$API_PORT" pnpm --filter @openlinear/api dev &
PIDS+=($!)

log "Waiting for API to be reachable..."
for i in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; then
        ok "API ready."
        break
    fi
    if [ "$i" -eq 30 ]; then
        err "API did not become ready on port $API_PORT after 30s."
        exit 1
    fi
    sleep 1
done

log "Serving production build from $OUT_DIR on port $UI_PORT..."
pnpm dlx serve@14 -s "$OUT_DIR" -l "$UI_PORT" --no-clipboard >/tmp/openlinear-static-server.log 2>&1 &
PIDS+=($!)

log "Waiting for static server..."
for i in $(seq 1 20); do
    if curl -sf "http://127.0.0.1:$UI_PORT/" >/dev/null 2>&1; then
        ok "Static server ready at http://127.0.0.1:$UI_PORT"
        break
    fi
    if [ "$i" -eq 20 ]; then
        err "Static server did not become ready on port $UI_PORT after 20s. See /tmp/openlinear-static-server.log"
        exit 1
    fi
    sleep 1
done

log "Launching Tauri (skipping bundled sidecar; using live API on $API_PORT)..."
TAURI_CONFIG_OVERRIDE='{"build":{"beforeDevCommand":"","devUrl":"http://localhost:'"$UI_PORT"'"}}'

OPENLINEAR_SKIP_SIDECAR=1 API_PORT="$API_PORT" \
    pnpm --filter @openlinear/desktop exec tauri dev \
    --no-dev-server-wait \
    --config "$TAURI_CONFIG_OVERRIDE"
