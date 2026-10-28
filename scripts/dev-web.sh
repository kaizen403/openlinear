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
      echo "[dev:web] Local DATABASE_URL requires Postgres. Install/start Postgres or Docker."
      exit 1
    fi
    if ! docker ps --format '{{.Names}}' | grep -qx 'openlinear-db'; then
      echo "[dev:web] Starting Postgres database container only..."
      docker compose up -d postgres
      sleep 2
    fi
  else
    echo "[dev:web] Using configured remote database; skipping Docker."
  fi
}

ensure_database

echo "[dev:web] Seeding test tasks..."
pnpm db:seed

# Acknowledge OpenCode's single-tenant model so the sidecar boots against
# multi-user databases (shared dev DB, Neon). See docs/limitations.md.
# OpenCode is single-tenant. Do not default this to 1; set it explicitly
# if this machine's database has more than one user.
# export OPENLINEAR_ALLOW_SHARED_OPENCODE=1

# W03a: the cloud API (auth, CRUD, chat, events) always runs on :3001.
# Unless SIDECAR=0 / OPENLINEAR_CRUD_ONLY=1, the execution sidecar runs on
# :3003 without DATABASE_URL and authenticates/persists through the API.
export NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-http://127.0.0.1:3001}"
export NEXT_PUBLIC_SIDECAR_URL="${NEXT_PUBLIC_SIDECAR_URL:-http://127.0.0.1:3003}"
echo "[dev:web] Starting @openlinear/api on :3001..."
API_PORT=3001 pnpm --filter @openlinear/api dev &
API_PID=$!
SIDECAR_PID=""

for i in $(seq 1 60); do
  if curl -sf http://127.0.0.1:3001/health >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if [ "${OPENLINEAR_CRUD_ONLY:-0}" = "1" ] || [ "${SIDECAR:-1}" = "0" ]; then
  echo "[dev:web] CRUD-ONLY mode — execution endpoints (/api/tasks/:id/execute, /api/batches) are unavailable."
else
  echo "[dev:web] Starting execution sidecar on :3003..."
  env -u DATABASE_URL API_PORT=3003 OPENLINEAR_API_URL=http://127.0.0.1:3001 pnpm --filter @openlinear/sidecar dev &
  SIDECAR_PID=$!
  for i in $(seq 1 40); do
    if curl -sf http://127.0.0.1:3003/health >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
fi

echo "[dev:web] Starting Next.js dev server on :3000..."
PORT=3000 pnpm --filter @openlinear/desktop-ui dev

kill $API_PID 2>/dev/null
[ -n "$SIDECAR_PID" ] && kill $SIDECAR_PID 2>/dev/null
