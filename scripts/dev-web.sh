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

echo "[dev:web] Starting API and Next.js dev server..."

API_PORT=3001 pnpm --filter @openlinear/api dev &
API_PID=$!

sleep 2

PORT=3000 pnpm --filter @openlinear/desktop-ui dev

kill $API_PID 2>/dev/null
