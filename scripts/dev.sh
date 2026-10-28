#!/bin/bash
set -e

cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

ensure_database() {
  if [ -z "${DATABASE_URL:-}" ]; then
    export DATABASE_URL="postgresql://openlinear:openlinear@localhost:5432/openlinear"
  fi

  if echo "$DATABASE_URL" | grep -qE 'localhost|127\.0\.0\.1'; then
    if ! command -v docker >/dev/null 2>&1; then
      echo "[dev] Local DATABASE_URL requires Postgres. Install/start Postgres or Docker."
      exit 1
    fi
    if ! docker ps --format '{{.Names}}' | grep -qx 'openlinear-db'; then
      echo "[dev] Starting Postgres database container only..."
      docker compose up -d postgres
      sleep 2
    fi
  else
    echo "[dev] Using configured remote database; skipping Docker."
  fi
}

ensure_database

echo "[dev] Seeding test tasks..."
pnpm db:seed

echo "[dev] Starting cloud API (:3001) + execution sidecar (:3003) + Desktop UI..."
echo "[dev] (API serves auth/CRUD/chat/events; the sidecar serves /api/tasks/:id/execute, /api/batches, /api/opencode)"

# NOTE (C6a F15): this used to default OPENLINEAR_ALLOW_SHARED_OPENCODE=1,
# silently disabling the sidecar's multi-tenant guard for every dev run
# against a shared database (Neon, a team DB, etc). That guard exists so a
# database with more than one user doesn't end up with every user's
# OpenCode session/auth state sharing one process. If your local DATABASE_URL
# points at a multi-user database and you've deliberately accepted that
# tradeoff, set OPENLINEAR_ALLOW_SHARED_OPENCODE=1 yourself before running
# this script — see docs/limitations.md.
export NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-http://127.0.0.1:3001}"
export NEXT_PUBLIC_SIDECAR_URL="${NEXT_PUBLIC_SIDECAR_URL:-http://127.0.0.1:3003}"
export FRONTEND_URL="${FRONTEND_URL:-http://127.0.0.1:3000}"
REQUIRED_CORS_ORIGINS="http://127.0.0.1:3000,http://localhost:3000,tauri://localhost,https://tauri.localhost"
export CORS_ORIGIN="${CORS_ORIGIN:+$CORS_ORIGIN,}$REQUIRED_CORS_ORIGINS"

# W03a: two backends. The cloud API (auth, CRUD, chat, events) on 3001 uses
# DATABASE_URL; the execution sidecar on 3003 never touches Postgres and
# authenticates callers and persists runs through OPENLINEAR_API_URL.
API_PORT=3001 pnpm --filter @openlinear/api dev &
API_PID=$!

echo "[dev] Waiting for API /health..."
for i in $(seq 1 60); do
  if curl -sf http://127.0.0.1:3001/health >/dev/null 2>&1; then
    echo "[dev] API ready"
    break
  fi
  sleep 0.5
done

env -u DATABASE_URL API_PORT=3003 OPENLINEAR_API_URL=http://127.0.0.1:3001 pnpm --filter @openlinear/sidecar dev &
SIDECAR_PID=$!

echo "[dev] Waiting for sidecar /health..."
for i in $(seq 1 40); do
  if curl -sf http://127.0.0.1:3003/health >/dev/null 2>&1; then
    echo "[dev] Sidecar ready"
    break
  fi
  sleep 0.5
done

# Try Tauri desktop if available, otherwise fall back to Next.js dev server.
# Set OPENLINEAR_SKIP_SIDECAR=1 so Tauri does NOT spawn another sidecar
# (the dev script above already started one on 3003).
if command -v tauri &>/dev/null || pnpm --filter @openlinear/desktop tauri --version &>/dev/null 2>&1; then
  OPENLINEAR_SKIP_SIDECAR=1 API_PORT=3003 PORT=3000 pnpm --filter @openlinear/desktop tauri dev
else
  echo "[dev] Tauri not available, starting Next.js dev server..."
  PORT=3000 pnpm --filter @openlinear/desktop-ui dev
fi

kill $SIDECAR_PID 2>/dev/null
kill $API_PID 2>/dev/null
