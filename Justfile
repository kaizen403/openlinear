# OpenLinear Development Workflow
# Usage: just <recipe>
# List all recipes: just --list

set dotenv-load
set shell := ["bash", "-cu"]

# Default: show available recipes
default:
    @just --list

# ─── Development ──────────────────────────────────────────────────

# Start API server on :3001
api:
    #!/usr/bin/env bash
    set -e
    pids=$(lsof -ti :3001 2>/dev/null || true)
    [ -n "$pids" ] && echo "$pids" | xargs kill -9 2>/dev/null && sleep 1
    echo "✓ Starting API on http://localhost:3001"
    API_PORT=3001 pnpm --filter @openlinear/api dev

# Start Next.js UI in browser on :3000
web:
    #!/usr/bin/env bash
    set -e
    pids=$(lsof -ti :3000 2>/dev/null || true)
    [ -n "$pids" ] && echo "$pids" | xargs kill -9 2>/dev/null && sleep 1
    echo "✓ Starting UI on http://localhost:3000 (falls back to 3001 if busy)"
    PORT=3000 pnpm --filter @openlinear/desktop-ui dev

# Start Tauri desktop app
desktop:
    API_PORT=3001 PORT=3000 pnpm --filter @openlinear/desktop tauri dev

# ─── Setup ────────────────────────────────────────────────────────

# First-time setup: install deps, start db, push schema
setup:
    @echo "==> Installing dependencies..."
    pnpm install
    @echo "==> Starting database..."
    just db-up
    @sleep 3
    @echo "==> Generating Prisma client..."
    pnpm --filter @openlinear/db db:generate
    @echo "==> Pushing database schema..."
    pnpm db:push
    @echo "==> Setup complete! Run 'just web' or 'just desktop' to start."

# ─── Database ─────────────────────────────────────────────────────

# Start PostgreSQL container
db-up:
    #!/usr/bin/env bash
    if docker ps --format '{{"{{"}}.Names{{"}}"}}' | grep -q 'openlinear-db'; then
        echo "[db] Already running."
    else
        echo "[db] Starting PostgreSQL..."
        docker compose up -d
        echo "[db] Waiting for healthy..."
        for i in $(seq 1 30); do
            if docker exec openlinear-db pg_isready -U openlinear -d openlinear >/dev/null 2>&1; then
                echo "[db] Ready."
                break
            fi
            sleep 1
        done
    fi

# Stop PostgreSQL container
db-down:
    docker compose down

# Push Prisma schema to database
db-push:
    pnpm db:push

# Open Prisma Studio
db-studio:
    pnpm db:studio

# Generate Prisma client
db-generate:
    pnpm --filter @openlinear/db db:generate

# Reset database (destroy + recreate)
db-reset:
    docker compose down -v
    docker compose up -d
    @sleep 3
    pnpm db:push
    @echo "[db] Database reset complete."

# ─── Build ────────────────────────────────────────────────────────

# Build all packages
build:
    pnpm build

# Build the API sidecar binary
build-sidecar:
    pnpm build:sidecar

# Build the desktop app
build-desktop:
    pnpm build:desktop

# ─── Quality ──────────────────────────────────────────────────────

# Run all tests
test:
    pnpm test

# Run type checking
typecheck:
    pnpm typecheck

# Run linter
lint:
    pnpm lint

# ─── Utilities ────────────────────────────────────────────────────

# Show status of all services
status:
    #!/usr/bin/env bash
    echo "==> Docker"
    if docker ps --format '{{"{{"}}.Names{{"}}"}}' 2>/dev/null | grep -q 'openlinear-db'; then
        echo "  PostgreSQL: running"
    else
        echo "  PostgreSQL: stopped"
    fi
    echo ""
    echo "==> Ports"
    for port in 3000 3001 5432; do
        pid=$(lsof -ti :$port 2>/dev/null | head -1)
        if [ -n "$pid" ]; then
            name=$(ps -p $pid -o comm= 2>/dev/null)
            echo "  :$port  $name (PID $pid)"
        else
            echo "  :$port  free"
        fi
    done

# Kill processes on dev ports (3000, 3001)
kill:
    #!/usr/bin/env bash
    for port in 3000 3001; do
        pids=$(lsof -ti :$port 2>/dev/null)
        if [ -n "$pids" ]; then
            echo "Killing processes on :$port"
            echo "$pids" | xargs kill -9 2>/dev/null
        fi
    done
    echo "Ports cleared."

# Clean all build artifacts and node_modules
clean:
    rm -rf node_modules apps/*/node_modules packages/*/node_modules
    rm -rf apps/*/.next apps/*/dist packages/*/dist
    rm -rf .turbo apps/*/.turbo packages/*/.turbo
    @echo "Cleaned. Run 'just setup' to reinstall."

# Install dependencies only
install:
    pnpm install

# ─── Internal ─────────────────────────────────────────────────────

[private]
_free-ports:
    #!/usr/bin/env bash
    for port in 3000 3001; do
        pids=$(lsof -ti :$port 2>/dev/null)
        if [ -n "$pids" ]; then
            echo "[cleanup] Killing stale process on :$port"
            echo "$pids" | xargs kill -9 2>/dev/null
            sleep 1
        fi
    done
