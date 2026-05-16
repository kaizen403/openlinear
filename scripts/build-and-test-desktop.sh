#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${CYAN}[build]${NC} $1"; }
ok()   { echo -e "${GREEN}[build]${NC} $1"; }
warn() { echo -e "${YELLOW}[build]${NC} $1"; }
err()  { echo -e "${RED}[build]${NC} $1"; }

SKIP_TEST=0
if [ "${1:-}" = "--skip-test" ]; then
    SKIP_TEST=1
fi

log "Checking prerequisites..."

if ! command -v docker &>/dev/null; then
    err "Docker is required for the database. Install: https://docs.docker.com/get-docker/"
    exit 1
fi

if ! command -v pnpm &>/dev/null; then
    err "pnpm is not installed. Run: npm install -g pnpm"
    exit 1
fi

if ! command -v cargo &>/dev/null; then
    err "Rust/Cargo is required for Tauri. Install: https://rustup.rs"
    exit 1
fi

if ! pnpm --filter @openlinear/desktop tauri --version &>/dev/null 2>&1; then
    err "Tauri CLI not found. Run: pnpm install"
    exit 1
fi

ok "Prerequisites OK."

if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        warn "No .env found. Copying .env.example -> .env"
        cp .env.example .env
    else
        warn "No .env or .env.example found. Creating minimal .env..."
        cat > .env <<'EOF'
DATABASE_URL=postgresql://openlinear:openlinear@localhost:5432/openlinear
JWT_SECRET=openlinear-dev-secret-change-in-production
TOKEN_ENCRYPTION_KEY=openlinear-dev-encryption-key-min-16-chars
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_REDIRECT_URI=http://localhost:3001/api/auth/github/callback
EOF
    fi
fi

while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
        \#*|""|\;*) continue ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    case "$value" in
        \"*) value="${value#\"}"; value="${value%\"}" ;;
        \'*) value="${value#\'}"; value="${value%\'}" ;;
    esac
    export "$key=$value"
done < .env

if [ -z "${DATABASE_URL:-}" ]; then
    DATABASE_URL=""
fi

LOCAL_DATABASE_URL="${DESKTOP_BUILD_DATABASE_URL:-postgresql://openlinear:openlinear@localhost:5432/openlinear}"
USE_LOCAL_DATABASE=1

if [ "${DESKTOP_BUILD_USE_ENV_DATABASE:-0}" = "1" ]; then
    if [ -z "${DATABASE_URL:-}" ]; then
        err "DESKTOP_BUILD_USE_ENV_DATABASE=1 was set, but DATABASE_URL is empty."
        exit 1
    fi
    USE_LOCAL_DATABASE=0
    warn "Using DATABASE_URL from .env for schema sync."
else
    if [ -n "${DATABASE_URL:-}" ] && [ "$DATABASE_URL" != "$LOCAL_DATABASE_URL" ]; then
        warn "Ignoring .env DATABASE_URL for desktop build schema sync."
        warn "Using local Docker database. Set DESKTOP_BUILD_USE_ENV_DATABASE=1 to opt into .env DATABASE_URL."
    fi
    export DATABASE_URL="$LOCAL_DATABASE_URL"
fi

if [ ! -d node_modules ] || [ ! -d apps/desktop/node_modules ]; then
    log "Installing dependencies..."
    pnpm install
fi

if [ "$USE_LOCAL_DATABASE" -eq 1 ]; then
    if ! docker ps --format '{{.Names}}' | grep -q 'openlinear-db'; then
        log "Starting PostgreSQL..."
        docker compose up -d
    fi

    log "Waiting for local database..."
    for i in $(seq 1 30); do
        if docker exec openlinear-db pg_isready -U openlinear -d openlinear &>/dev/null; then
            ok "Database ready."
            break
        fi
        if [ "$i" -eq 30 ]; then
            err "Database failed to start after 30s."
            exit 1
        fi
        sleep 1
    done
else
    log "Skipping local Docker database startup."
fi

log "Syncing database schema..."
pnpm --filter @openlinear/db db:generate
pnpm db:push

log "Cleaning previous build artifacts..."
rm -rf apps/desktop/src-tauri/target/release/bundle
rm -rf apps/desktop-ui/out
rm -rf apps/desktop-ui/.next

log "Building packages (excluding desktop apps to avoid lock conflicts)..."
pnpm turbo run build --filter=!@openlinear/desktop --filter=!@openlinear/desktop-ui

log "Building desktop-ui for Tauri..."
pnpm --filter @openlinear/desktop-ui build:tauri

log "Building sidecar binary..."
pnpm build:sidecar

BINARIES_DIR="apps/desktop/src-tauri/binaries"
if [ ! -f "$BINARIES_DIR/openlinear-sidecar-x86_64-unknown-linux-gnu" ] && \
   [ ! -f "$BINARIES_DIR/openlinear-sidecar-x86_64-apple-darwin" ] && \
   [ ! -f "$BINARIES_DIR/openlinear-sidecar-aarch64-apple-darwin" ]; then
    err "Sidecar binary not found after build. Check $BINARIES_DIR"
    exit 1
fi

if [ ! -f "$BINARIES_DIR/opencode-x86_64-unknown-linux-gnu" ] && \
   [ ! -f "$BINARIES_DIR/opencode-x86_64-apple-darwin" ] && \
   [ ! -f "$BINARIES_DIR/opencode-aarch64-apple-darwin" ]; then
    err "OpenCode binary not found after build. Check $BINARIES_DIR"
    exit 1
fi

ok "Sidecar binaries ready."

log "Building Tauri desktop app (this may take several minutes)..."
pnpm build:desktop

BUNDLE_DIR="apps/desktop/src-tauri/target/release/bundle"
if [ ! -d "$BUNDLE_DIR" ]; then
    err "Build completed but no bundle directory found at $BUNDLE_DIR"
    exit 1
fi

log "Build artifacts:"
find "$BUNDLE_DIR" -type f \( -name "*.AppImage" -o -name "*.deb" -o -name "*.dmg" -o -name "*.app" -o -name "openlinear" \) | while read -r f; do
    size=$(du -h "$f" | cut -f1)
    echo "  - $(basename "$f") ($size)"
done

if [ "$SKIP_TEST" -eq 1 ]; then
    warn "Skipping tests (--skip-test passed)"
    exit 0
fi

EXECUTABLE=""
RAW_BINARY="apps/desktop/src-tauri/target/release/openlinear-desktop"
APPIMAGE_CANDIDATE="$(find "$BUNDLE_DIR/appimage" -maxdepth 1 -type f -name "*.AppImage" 2>/dev/null | head -1 || true)"
DEB_CANDIDATE="$(find "$BUNDLE_DIR/deb" -maxdepth 1 -type f -name "*.deb" 2>/dev/null | head -1 || true)"

if [ -n "$APPIMAGE_CANDIDATE" ]; then
    EXECUTABLE="$APPIMAGE_CANDIDATE"
elif [ -x "$RAW_BINARY" ]; then
    if [ -n "$DEB_CANDIDATE" ]; then
        warn "Built .deb package found; smoke-testing raw binary to avoid sudo package installation."
        warn "Set DESKTOP_BUILD_INSTALL_DEB=1 to install and smoke-test the .deb package."
    fi
    EXECUTABLE="$RAW_BINARY"
elif [ -n "$DEB_CANDIDATE" ] && [ "${DESKTOP_BUILD_INSTALL_DEB:-0}" = "1" ]; then
    if ! command -v dpkg &>/dev/null; then
        err "DESKTOP_BUILD_INSTALL_DEB=1 requires dpkg, but dpkg was not found."
        exit 1
    fi
    log "Found .deb package. Installing for test..."
    if ! sudo dpkg -i "$DEB_CANDIDATE"; then
        if command -v apt-get &>/dev/null; then
            sudo apt-get install -f -y
        else
            err "dpkg install failed and apt-get is not available to repair dependencies."
            exit 1
        fi
    fi
    EXECUTABLE="/usr/bin/openlinear"
fi

if [ -n "$EXECUTABLE" ] && [ -f "$EXECUTABLE" ]; then
    log "Running smoke test on built binary..."
    log "Starting: $EXECUTABLE"

    "$EXECUTABLE" &
    APP_PID=$!

    log "Checking app process stays alive (max 15s)..."
    for i in $(seq 1 15); do
        if ! kill -0 $APP_PID 2>/dev/null; then
            warn "Desktop app process exited before smoke check completed."
            break
        fi
        sleep 1
    done

    if kill -0 $APP_PID 2>/dev/null; then
        ok "Desktop app is running (PID $APP_PID)"
    else
        warn "Desktop app process exited early. Check logs above."
    fi

    log "Stopping test process..."
    kill $APP_PID 2>/dev/null || true
    wait $APP_PID 2>/dev/null || true
    ok "Smoke test complete."
else
    warn "No runnable executable found for smoke test."
    warn "Build artifacts are in: $BUNDLE_DIR"
fi

echo ""
ok "Build complete! Desktop app packages:"
find "$BUNDLE_DIR" -type f \( -name "*.AppImage" -o -name "*.deb" -o -name "*.dmg" \) | while read -r f; do
    echo "  -> $f"
done
echo ""
echo "Install:"
echo "  Linux (AppImage):  $BUNDLE_DIR/appimage/*.AppImage"
echo "  Linux (.deb):      sudo dpkg -i $BUNDLE_DIR/deb/*.deb"
echo "  macOS (.dmg):      open $BUNDLE_DIR/dmg/openlinear_*.dmg"
