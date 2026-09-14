#!/usr/bin/env bash
set -euo pipefail

# Debug mode: maximum verbosity, pre-flight checks, Node inspector
# Usage: pnpm debug
#   or:  bash scripts/debug.sh

cd "$(dirname "${BASH_SOURCE[0]}")/.."

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${CYAN}[debug]${NC} $1"; }
ok()   { echo -e "${GREEN}[debug]${NC} $1"; }
warn() { echo -e "${YELLOW}[debug]${NC} $1"; }
err()  { echo -e "${RED}[debug]${NC} $1"; }

# ── Load .env ──────────────────────────────────────────────────────
if [ -f .env ]; then
    log "Loading .env..."
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
else
    warn "No .env file found; relying on environment variables."
fi

# ── Database ───────────────────────────────────────────────────────
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
            log "Starting Postgres database container..."
            docker compose up -d postgres
            sleep 2
        else
            ok "Postgres container already running."
        fi
    else
        log "Using configured remote database; skipping Docker."
    fi
}

ensure_database

# ── Pre-flight type checks ─────────────────────────────────────────
log "Running pre-flight type checks..."

log "Type-checking @openlinear/api..."
if ! pnpm --filter @openlinear/api typecheck; then
    err "@openlinear/api type-check FAILED. Fix errors above, then re-run pnpm debug."
    exit 1
fi
ok "@openlinear/api type-check passed."

log "Type-checking @openlinear/sidecar..."
if ! pnpm --filter @openlinear/sidecar typecheck; then
    err "@openlinear/sidecar type-check FAILED. Fix errors above, then re-run pnpm debug."
    exit 1
fi
ok "@openlinear/sidecar type-check passed."

# ── Environment ────────────────────────────────────────────────────
export API_PORT="${API_PORT:-3001}"
export OPENLINEAR_ALLOW_SHARED_OPENCODE="${OPENLINEAR_ALLOW_SHARED_OPENCODE:-1}"
export NEXT_PUBLIC_API_URL="http://127.0.0.1:${API_PORT}"
export FRONTEND_URL="http://127.0.0.1:3000"
export LOG_LEVEL="debug"
export NODE_ENV="development"

REQUIRED_CORS_ORIGINS="http://127.0.0.1:3000,http://localhost:3000,tauri://localhost,https://tauri.localhost"
export CORS_ORIGIN="${CORS_ORIGIN:+${CORS_ORIGIN},}${REQUIRED_CORS_ORIGINS}"

# Next.js verbose
export NEXT_DEBUG="1"
export NEXT_TELEMETRY_DEBUG="1"

log "Debug environment configured:"
log "  API_PORT            = ${API_PORT}"
log "  LOG_LEVEL           = ${LOG_LEVEL}"
log "  NODE_OPTIONS        = ${NODE_OPTIONS:-<none>}"
log "  NEXT_DEBUG          = ${NEXT_DEBUG}"
log "  CORS_ORIGIN         = ${CORS_ORIGIN}"
log "  NODE_ENV            = ${NODE_ENV}"
log "  NODE inspector on   :9229 (sidecar) / :9230 (Next.js)"

# ── Process management ─────────────────────────────────────────────
PIDS=()

cleanup() {
    log "Shutting down debug session..."
    for pid in "${PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
        fi
    done
    wait 2>/dev/null || true
    ok "Debug session ended."
}
trap cleanup EXIT INT TERM

# ── Sidecar ──────────────────────────────────────────────────────────
log "Starting @openlinear/sidecar on port ${API_PORT} with inspector..."
API_PORT="${API_PORT}" pnpm --filter @openlinear/sidecar debug &
PIDS+=("$!")

log "Waiting for sidecar /health..."
for i in $(seq 1 40); do
    if curl -sf "http://127.0.0.1:${API_PORT}/health" >/dev/null 2>&1; then
        ok "Sidecar ready on :${API_PORT}"
        break
    fi
    if [ "$i" -eq 40 ]; then
        err "Sidecar failed to start within 20s. Check logs above."
        exit 1
    fi
    sleep 0.5
done

# ── Desktop UI ─────────────────────────────────────────────────────
if command -v tauri &>/dev/null || pnpm --filter @openlinear/desktop tauri --version &>/dev/null 2>&1; then
    log "Launching Tauri desktop app (debug mode)..."
    OPENLINEAR_SKIP_SIDECAR=1 API_PORT="${API_PORT}" PORT=3000 \
        pnpm --filter @openlinear/desktop exec tauri dev \
        --no-dev-server-wait \
        --config '{"build":{"beforeDevCommand":"PORT=3000 pnpm --filter @openlinear/desktop-ui debug","devUrl":"http://127.0.0.1:3000"}}'
else
    log "Tauri not available. Starting Next.js dev server in debug mode..."
    PORT=3000 pnpm --filter @openlinear/desktop-ui debug
fi
