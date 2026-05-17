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
TARGET_CHOICE="${DESKTOP_BUILD_TARGET:-}"

for arg in "$@"; do
    case "$arg" in
        --skip-test) SKIP_TEST=1 ;;
        --target=*) TARGET_CHOICE="${arg#--target=}" ;;
        --appimage) TARGET_CHOICE="appimage" ;;
        --macos|--dmg) TARGET_CHOICE="macos" ;;
    esac
done

HOST_OS="$(uname -s)"

prompt_target() {
    if [ -n "$TARGET_CHOICE" ]; then
        return
    fi
    if [ ! -t 0 ]; then
        case "$HOST_OS" in
            Linux)  TARGET_CHOICE="appimage" ;;
            Darwin) TARGET_CHOICE="macos" ;;
        esac
        warn "Non-interactive shell; defaulting target to '$TARGET_CHOICE'."
        return
    fi
    echo ""
    echo "Select build target:"
    echo "  1) Linux AppImage"
    echo "  2) macOS app (.dmg / .app)"
    echo ""
    read -r -p "Choice [1-2]: " choice
    case "$choice" in
        1) TARGET_CHOICE="appimage" ;;
        2) TARGET_CHOICE="macos" ;;
        *) err "Invalid choice."; exit 1 ;;
    esac
}

prompt_target

case "$TARGET_CHOICE" in
    appimage)
        if [ "$HOST_OS" != "Linux" ]; then
            err "AppImage can only be built on Linux. Detected host: $HOST_OS"
            exit 1
        fi
        BUNDLE_TARGETS="appimage"
        ;;
    macos)
        if [ "$HOST_OS" != "Darwin" ]; then
            err "macOS apps can only be built on macOS. Detected host: $HOST_OS"
            err "Tauri does not support cross-compiling to macOS from $HOST_OS."
            err "Use a Mac (or CI with a macOS runner) to build .dmg / .app."
            exit 1
        fi
        BUNDLE_TARGETS="dmg,app"
        ;;
    *)
        err "Unknown target: $TARGET_CHOICE (expected 'appimage' or 'macos')"
        exit 1
        ;;
esac

ok "Build target: $TARGET_CHOICE  (tauri --bundles $BUNDLE_TARGETS)"
export DESKTOP_BUILD_BUNDLES="$BUNDLE_TARGETS"

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
if [ "$TARGET_CHOICE" = "appimage" ]; then
    "$ROOT_DIR/scripts/build-appimage-workaround.sh"
else
    pnpm --filter @openlinear/desktop tauri build --bundles "$DESKTOP_BUILD_BUNDLES"
fi

BUNDLE_DIR="apps/desktop/src-tauri/target/release/bundle"
if [ ! -d "$BUNDLE_DIR" ]; then
    err "Build completed but no bundle directory found at $BUNDLE_DIR"
    exit 1
fi

log "Build artifacts:"
find "$BUNDLE_DIR" -type f \( -name "*.AppImage" -o -name "*.dmg" -o -name "*.app" -o -name "openlinear" \) | while read -r f; do
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

if [ -n "$APPIMAGE_CANDIDATE" ]; then
    EXECUTABLE="$APPIMAGE_CANDIDATE"
elif [ -x "$RAW_BINARY" ]; then
    EXECUTABLE="$RAW_BINARY"
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
find "$BUNDLE_DIR" -type f \( -name "*.AppImage" -o -name "*.dmg" \) | while read -r f; do
    echo "  -> $f"
done
echo ""
echo "Install:"
if [ "$TARGET_CHOICE" = "appimage" ]; then
    echo "  Linux (AppImage):  chmod +x $BUNDLE_DIR/appimage/*.AppImage && $BUNDLE_DIR/appimage/*.AppImage"
else
    echo "  macOS (.dmg):      open $BUNDLE_DIR/dmg/OpenLinear_*.dmg"
fi
