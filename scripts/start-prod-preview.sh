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
export OAUTH_INTERCEPTOR_PORT="${OAUTH_INTERCEPTOR_PORT:-1455}"
UI_HOST="${UI_HOST:-127.0.0.1}"
UI_ORIGIN="http://$UI_HOST:$UI_PORT"
API_ORIGIN="http://127.0.0.1:$API_PORT"
# Acknowledge OpenCode's single-tenant model so the sidecar boots against
# multi-user databases (e.g. shared dev DB, Neon). See docs/limitations.md;
# unset this and run one sidecar per user only in true multi-tenant deploys.
export OPENLINEAR_ALLOW_SHARED_OPENCODE="${OPENLINEAR_ALLOW_SHARED_OPENCODE:-1}"
SHUTDOWN_GRACE_SECONDS="${SHUTDOWN_GRACE_SECONDS:-8}"

PIDS=()
CLEANED_UP=0
cleanup() {
    if [ "$CLEANED_UP" -eq 1 ]; then
        return
    fi
    CLEANED_UP=1
    log "Shutting down..."
    for pid in "${PIDS[@]}"; do
        kill "$pid" 2>/dev/null || true
    done

    local deadline alive
    deadline=$((SECONDS + SHUTDOWN_GRACE_SECONDS))
    while [ "$SECONDS" -lt "$deadline" ]; do
        alive=0
        for pid in "${PIDS[@]}"; do
            if kill -0 "$pid" 2>/dev/null; then
                alive=1
                break
            fi
        done
        [ "$alive" -eq 0 ] && break
        sleep 0.2
    done

    for pid in "${PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            warn "Force-stopping child process $pid"
            kill -9 "$pid" 2>/dev/null || true
        fi
    done

    for pid in "${PIDS[@]}"; do
        wait "$pid" 2>/dev/null || true
    done
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

pids_on_port() {
    local port="$1"
    {
        if command -v lsof >/dev/null 2>&1; then
            lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
            printf '\n'
        fi
        if command -v fuser >/dev/null 2>&1; then
            fuser -n tcp "$port" 2>/dev/null || true
            printf '\n'
        fi
        if command -v ss >/dev/null 2>&1; then
            ss -ltnp "sport = :$port" 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' || true
            printf '\n'
        fi
    } | tr ' ' '\n' | sed '/^$/d' | sort -u
}

is_openlinear_process() {
    local pid="$1"
    local cmd cwd
    cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
    case "$cmd" in
        *"$ROOT_DIR"*|*"openlinear"*)
            return 0
            ;;
    esac
    case "$cwd" in
        "$ROOT_DIR"|"$ROOT_DIR"/*)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

clear_openlinear_port() {
    local port="$1"
    local name="$2"
    local pids pid cmd
    pids="$(pids_on_port "$port")"
    [ -z "$pids" ] && return

    for pid in $pids; do
        cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
        [ -z "$cmd" ] && continue

        if is_openlinear_process "$pid"; then
            warn "Stopping stale OpenLinear process on $name port $port (pid $pid)"
            kill "$pid" 2>/dev/null || true
        else
            err "$name port $port is already in use by pid $pid:"
            err "$cmd"
            err "Stop that process or run with a different port."
            exit 1
        fi
    done

    sleep 1
    for pid in $pids; do
        if kill -0 "$pid" 2>/dev/null; then
            warn "Force-stopping stale OpenLinear process on $name port $port (pid $pid)"
            kill -9 "$pid" 2>/dev/null || true
        fi
    done
}

run_migrate_deploy() {
    local attempts=3
    local attempt
    for attempt in $(seq 1 "$attempts"); do
        if pnpm --filter @openlinear/db db:migrate:deploy; then
            return 0
        fi

        if [ "$attempt" -eq "$attempts" ]; then
            err "Database migration deploy failed after $attempts attempts."
            return 1
        fi

        warn "Database migration deploy failed, retrying in 5s ($attempt/$attempts)..."
        sleep 5
    done
}

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

ensure_database() {
    if [ -z "${DATABASE_URL:-}" ]; then
        export DATABASE_URL="postgresql://openlinear:openlinear@localhost:5432/openlinear"
    fi

    if echo "$DATABASE_URL" | grep -qE 'localhost|127\.0\.0\.1'; then
        if ! command -v docker >/dev/null 2>&1; then
            err "Local DATABASE_URL requires Postgres. Install/start Postgres or Docker."
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

log "Preparing database schema..."
pnpm --filter @openlinear/db db:generate
run_migrate_deploy

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
REQUIRED_CORS_ORIGINS="$UI_ORIGIN,http://localhost:$UI_PORT,tauri://localhost,https://tauri.localhost"
export CORS_ORIGIN="${CORS_ORIGIN:+$CORS_ORIGIN,}$REQUIRED_CORS_ORIGINS"

clear_openlinear_port "$UI_PORT" "UI"
clear_openlinear_port "$API_PORT" "API"
clear_openlinear_port "$OAUTH_INTERCEPTOR_PORT" "OAuth callback"

log "Starting execution-capable sidecar on port $API_PORT..."
log "(sidecar serves CRUD + /api/tasks/:id/execute + /api/batches + /api/opencode)"
API_PORT="$API_PORT" pnpm --filter @openlinear/sidecar dev:once &
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
node "$ROOT_DIR/scripts/serve-static.mjs" "$OUT_DIR" "$UI_HOST" "$UI_PORT" >/tmp/openlinear-static-server.log 2>&1 &
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
    --config "$TAURI_CONFIG_OVERRIDE" &
PIDS+=($!)

wait "${PIDS[-1]}"
