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

echo "[dev] Starting API and Desktop UI..."

API_PORT=3001 pnpm --filter @openlinear/api dev &
API_PID=$!

sleep 2

# Try Tauri desktop if available, otherwise fall back to Next.js dev server
if command -v tauri &>/dev/null || pnpm --filter @openlinear/desktop tauri --version &>/dev/null 2>&1; then
  API_PORT=3001 PORT=3000 pnpm --filter @openlinear/desktop tauri dev
else
  echo "[dev] Tauri not available, starting Next.js dev server..."
  PORT=3000 pnpm --filter @openlinear/desktop-ui dev
fi

kill $API_PID 2>/dev/null
