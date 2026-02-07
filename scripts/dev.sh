#!/bin/bash
set -e

cd "$(dirname "$0")/.."

if ! docker ps --format '{{.Names}}' | grep -q 'openlinear-db'; then
  echo "[dev] Starting database..."
  docker compose up -d
  sleep 2
fi

echo "[dev] Starting API and Desktop App..."

pnpm --filter @openlinear/api dev &
API_PID=$!

sleep 2

pnpm --filter @openlinear/desktop tauri dev

kill $API_PID 2>/dev/null
