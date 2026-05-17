#!/bin/bash
set -e

cd "$(dirname "$0")/.."

# Skip docker if DATABASE_URL points to a remote host (not localhost)
if grep -q 'localhost\|127\.0\.0\.1' .env 2>/dev/null; then
  if ! docker ps --format '{{.Names}}' | grep -q 'openlinear-db'; then
    echo "[dev:web] Starting database..."
    docker compose up -d
    sleep 2
  fi
else
  echo "[dev:web] Using remote database, skipping docker..."
fi

echo "[dev:web] Seeding test tasks..."
pnpm db:seed

# Honor SIDECAR=0 to start the CRUD-only API instead (faster boot, no execution).
# Default is execution-capable mode so the kanban board's Execute/Parallel/Queue work.
if [ "${OPENLINEAR_CRUD_ONLY:-0}" = "1" ] || [ "${SIDECAR:-1}" = "0" ]; then
  echo "[dev:web] CRUD-ONLY mode — execution endpoints (/api/tasks/:id/execute, /api/batches) will 404."
  echo "[dev:web] Starting @openlinear/api on :3001 and Next.js dev server on :3000..."
  API_PORT=3001 pnpm --filter @openlinear/api dev &
  API_PID=$!
else
  echo "[dev:web] Starting execution-capable @openlinear/sidecar on :3001 and Next.js dev server on :3000..."
  API_PORT=3001 pnpm --filter @openlinear/sidecar dev &
  API_PID=$!
fi

# Wait for sidecar/api /health
for i in $(seq 1 40); do
  if curl -sf http://127.0.0.1:3001/health >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

PORT=3000 pnpm --filter @openlinear/desktop-ui dev

kill $API_PID 2>/dev/null
