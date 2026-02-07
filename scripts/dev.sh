#!/bin/bash
set -e

cd "$(dirname "$0")/.."

if ! docker ps --format '{{.Names}}' | grep -q 'openlinear-db'; then
  echo "[dev] Starting database..."
  docker compose up -d
  sleep 2
fi

echo "[dev] Starting API and UI..."
pnpm --filter @openlinear/api --filter @openlinear/desktop-ui dev
