#!/bin/bash
set -e

cd "$(dirname "$0")/.."

# Skip docker if DATABASE_URL points to a remote host (not localhost)
if grep -q 'localhost\|127\.0\.0\.1' .env 2>/dev/null; then
  if ! docker ps --format '{{.Names}}' | grep -q 'openlinear-db'; then
    echo "[dev] Starting database..."
    docker compose up -d
    sleep 2
  fi
else
  echo "[dev] Using remote database, skipping docker..."
fi

echo "[dev] Seeding test tasks..."
pnpm db:seed

echo "[dev] Starting execution-capable sidecar + Desktop UI..."
echo "[dev] (sidecar serves CRUD + /api/tasks/:id/execute + /api/batches + /api/opencode)"

# Acknowledge OpenCode's single-tenant model so the sidecar boots against
# multi-user databases (shared dev DB, Neon). See docs/limitations.md.
export OPENLINEAR_ALLOW_SHARED_OPENCODE="${OPENLINEAR_ALLOW_SHARED_OPENCODE:-1}"
export NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-http://127.0.0.1:3001}"
export FRONTEND_URL="${FRONTEND_URL:-http://127.0.0.1:3000}"
REQUIRED_CORS_ORIGINS="http://127.0.0.1:3000,http://localhost:3000,tauri://localhost,https://tauri.localhost"
export CORS_ORIGIN="${CORS_ORIGIN:+$CORS_ORIGIN,}$REQUIRED_CORS_ORIGINS"

# Start the SIDECAR (not the CRUD-only API) on port 3001. The sidecar wraps
# the API app and additionally mounts execution, batch, and opencode routes
# that the desktop UI requires. Starting the CRUD-only API here causes
# `POST /api/tasks/:id/execute` and `POST /api/batches` to 404.
API_PORT=3001 pnpm --filter @openlinear/sidecar dev &
SIDECAR_PID=$!

# Wait for sidecar /health to come up so the UI's first calls don't race the boot.
echo "[dev] Waiting for sidecar /health..."
for i in $(seq 1 40); do
  if curl -sf http://127.0.0.1:3001/health >/dev/null 2>&1; then
    echo "[dev] Sidecar ready"
    break
  fi
  sleep 0.5
done

# Try Tauri desktop if available, otherwise fall back to Next.js dev server.
# Set OPENLINEAR_SKIP_SIDECAR=1 so Tauri does NOT spawn another sidecar
# (the dev script above already started one on 3001).
if command -v tauri &>/dev/null || pnpm --filter @openlinear/desktop tauri --version &>/dev/null 2>&1; then
  OPENLINEAR_SKIP_SIDECAR=1 API_PORT=3001 PORT=3000 pnpm --filter @openlinear/desktop tauri dev
else
  echo "[dev] Tauri not available, starting Next.js dev server..."
  PORT=3000 pnpm --filter @openlinear/desktop-ui dev
fi

kill $SIDECAR_PID 2>/dev/null
