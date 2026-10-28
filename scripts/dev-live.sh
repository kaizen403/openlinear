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

# Two backends since the sidecar stopped mounting the cloud routes:
#   - cloud API (apps/api): auth, workspaces, projects, tasks, chat, events
#   - sidecar (apps/sidecar): local execution (/api/tasks/:id/execute, ...)
# The UI routes each path with apps/desktop-ui/lib/api/routes.ts.
CLOUD_API_PORT="${CLOUD_API_PORT:-3001}"
SIDECAR_PORT="${SIDECAR_PORT:-3003}"
CLOUD_API_URL="http://127.0.0.1:$CLOUD_API_PORT"
SIDECAR_URL="http://127.0.0.1:$SIDECAR_PORT"
# OpenCode is single-tenant. Do not default this to 1; set it explicitly
# if this machine's database has more than one user.
# export OPENLINEAR_ALLOW_SHARED_OPENCODE=1
export NEXT_PUBLIC_API_URL="$CLOUD_API_URL"        # web build: cloud API
export NEXT_PUBLIC_CLOUD_API_URL="$CLOUD_API_URL"  # Tauri dev: cloud API
export NEXT_PUBLIC_SIDECAR_URL="$SIDECAR_URL"      # web build: local execution
export FRONTEND_URL="http://127.0.0.1:3000"
REQUIRED_CORS_ORIGINS="http://127.0.0.1:3000,http://localhost:3000,tauri://localhost,https://tauri.localhost"
export CORS_ORIGIN="${CORS_ORIGIN:+$CORS_ORIGIN,}$REQUIRED_CORS_ORIGINS"

log "Preparing database schema..."
pnpm --filter @openlinear/db db:generate

PIDS=()
cleanup() {
    log "Shutting down..."
    for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
    wait 2>/dev/null
}
trap cleanup EXIT INT TERM

wait_for_health() {
    local name="$1" url="$2"
    for i in $(seq 1 30); do
        if curl -sf "$url/health" >/dev/null 2>&1; then
            ok "$name ready at $url"
            return 0
        fi
        [ "$i" -eq 30 ] && { echo "$name failed to start"; exit 1; }
        sleep 1
    done
}

log "Starting cloud API on port $CLOUD_API_PORT..."
API_PORT="$CLOUD_API_PORT" pnpm --filter @openlinear/api dev &
PIDS+=($!)
wait_for_health "Cloud API" "$CLOUD_API_URL"

log "Starting sidecar on port $SIDECAR_PORT..."
# W03a: the sidecar persists only through the cloud API; it must not inherit
# the database URL exported above for the API (its boot check refuses it).
env -u DATABASE_URL API_PORT="$SIDECAR_PORT" OPENLINEAR_API_URL="$CLOUD_API_URL" pnpm --filter @openlinear/sidecar dev &
PIDS+=($!)
wait_for_health "Sidecar" "$SIDECAR_URL"

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
# With OPENLINEAR_SKIP_SIDECAR=1 the shell reports API_PORT as the sidecar port.
OPENLINEAR_SKIP_SIDECAR=1 API_PORT="$SIDECAR_PORT" \
    pnpm --filter @openlinear/desktop exec tauri dev \
    --no-dev-server-wait \
    --config '{"build":{"beforeDevCommand":"","devUrl":"http://127.0.0.1:3000"}}'

wait
