#!/bin/bash
set -e

cd "$(dirname "$0")/.."

if ! docker ps --format '{{.Names}}' | grep -q 'openlinear-db'; then
  echo "[dev] Starting database..."
  docker compose up -d
  sleep 2
fi

echo "[dev] Starting API and UI..."
echo "[dev] Open http://localhost:3000 in your browser"

(sleep 3 && xdg-open http://localhost:3000 2>/dev/null || open http://localhost:3000 2>/dev/null) &

pnpm --filter @openlinear/api --filter @openlinear/desktop-ui dev
