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
UI_HOST="${UI_HOST:-127.0.0.1}"
UI_ORIGIN="http://$UI_HOST:$UI_PORT"
API_ORIGIN="http://127.0.0.1:$API_PORT"
# Acknowledge OpenCode's single-tenant model so the sidecar boots against
# multi-user databases (e.g. shared dev DB, Neon). See docs/limitations.md;
# unset this and run one sidecar per user only in true multi-tenant deploys.
export OPENLINEAR_ALLOW_SHARED_OPENCODE="${OPENLINEAR_ALLOW_SHARED_OPENCODE:-1}"

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

log "Clearing stale Next.js build cache (.next, out) so CSS/font changes always take effect..."
rm -rf "$ROOT_DIR/apps/desktop-ui/.next" "$ROOT_DIR/apps/desktop-ui/out"

log "Building Next.js frontend for production (static export -> out/)..."
NEXT_PUBLIC_API_URL="$API_ORIGIN" BUILD_FOR_TAURI=1 pnpm --filter @openlinear/desktop-ui build

OUT_DIR="$ROOT_DIR/apps/desktop-ui/out"
if [ ! -d "$OUT_DIR" ]; then
    err "Build did not produce $OUT_DIR"
    exit 1
fi

export FRONTEND_URL="${FRONTEND_URL:-$UI_ORIGIN}"
export CORS_ORIGIN="${CORS_ORIGIN:-$UI_ORIGIN,http://localhost:$UI_PORT,tauri://localhost,https://tauri.localhost}"

log "Starting execution-capable sidecar on port $API_PORT..."
log "(sidecar serves CRUD + /api/tasks/:id/execute + /api/batches + /api/opencode)"
API_PORT="$API_PORT" pnpm --filter @openlinear/sidecar dev &
PIDS+=($!)

log "Waiting for sidecar to be reachable..."
for i in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; then
        ok "Sidecar ready."
        break
    fi
    if [ "$i" -eq 30 ]; then
        err "Sidecar did not become ready on port $API_PORT after 30s."
        exit 1
    fi
    sleep 1
done

log "Serving production build from $OUT_DIR at $UI_ORIGIN..."
pnpm dlx serve@14 -s "$OUT_DIR" -l "tcp://$UI_HOST:$UI_PORT" --no-clipboard >/tmp/openlinear-static-server.log 2>&1 &
PIDS+=($!)

log "Waiting for static server..."
for i in $(seq 1 20); do
    if curl -sf "$UI_ORIGIN/" >/dev/null 2>&1; then
        ok "Static server ready at $UI_ORIGIN"
        break
    fi
    if [ "$i" -eq 20 ]; then
        err "Static server did not become ready on port $UI_PORT after 20s. See /tmp/openlinear-static-server.log"
        exit 1
    fi
    sleep 1
done

log "Launching Tauri (skipping bundled sidecar; using live API on $API_PORT)..."
TAURI_DEV_URL="$UI_ORIGIN/?openlinearBuild=$(date +%s)"
TAURI_CONFIG_OVERRIDE='{"build":{"beforeDevCommand":"","devUrl":"'"$TAURI_DEV_URL"'"}}'

OPENLINEAR_SKIP_SIDECAR=1 API_PORT="$API_PORT" \
    pnpm --filter @openlinear/desktop exec tauri dev \
    --no-dev-server-wait \
    --config "$TAURI_CONFIG_OVERRIDE"
