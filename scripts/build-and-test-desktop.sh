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

# The packaged sidecar is API-only (W03a): building the desktop app needs no
# database, no Docker and no .env secrets.
if ! command -v pnpm &>/dev/null; then
    err "pnpm is not installed. Run: npm install -g pnpm"
    exit 1
fi

if ! command -v cargo &>/dev/null; then
    err "Rust/Cargo is required for Tauri. Install: https://rustup.rs"
    exit 1
fi

if [ ! -d node_modules ] || [ ! -d apps/desktop/node_modules ]; then
    log "Installing dependencies..."
    pnpm install --frozen-lockfile
fi

if ! pnpm --filter @openlinear/desktop tauri --version &>/dev/null 2>&1; then
    err "Tauri CLI not found. Run: pnpm install"
    exit 1
fi

ok "Prerequisites OK."

log "Cleaning previous build artifacts..."
rm -rf apps/desktop/src-tauri/target/release/bundle
rm -rf apps/desktop-ui/out
rm -rf apps/desktop-ui/.next

# Node 22 pkg executable for the host target, then the pinned OpenCode binary
# (checksum + upstream digest + release attestation when gh is available).
log "Building sidecar binary and fetching OpenCode..."
"$ROOT_DIR/scripts/build-sidecar.sh"

case "$HOST_OS/$(uname -m)" in
    Darwin/arm64) HOST_TRIPLE="aarch64-apple-darwin" ;;
    Darwin/x86_64) HOST_TRIPLE="x86_64-apple-darwin" ;;
    Linux/x86_64) HOST_TRIPLE="x86_64-unknown-linux-gnu" ;;
    Linux/aarch64) HOST_TRIPLE="aarch64-unknown-linux-gnu" ;;
    *) err "Unsupported host: $HOST_OS/$(uname -m)"; exit 1 ;;
esac

BINARIES_DIR="apps/desktop/src-tauri/binaries"
for name in openlinear-sidecar opencode; do
    if [ ! -x "$BINARIES_DIR/$name-$HOST_TRIPLE" ]; then
        err "$name binary not found after build. Check $BINARIES_DIR"
        exit 1
    fi
done
ok "Sidecar binaries ready."

if [ "$SKIP_TEST" -eq 0 ]; then
    log "Smoke-testing the packaged sidecar..."
    "$ROOT_DIR/scripts/release/smoke-sidecar-binary.sh" "$BINARIES_DIR/openlinear-sidecar-$HOST_TRIPLE"
fi

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

log "Verifying the bundle (shipped binaries, OpenCode version, bundled sidecar smoke)..."
if [ "$TARGET_CHOICE" = "appimage" ]; then
    "$ROOT_DIR/scripts/release/verify-desktop-bundle.sh" appimage "$(find "$BUNDLE_DIR/appimage" -maxdepth 1 -type f -name '*.AppImage' | head -1)"
else
    "$ROOT_DIR/scripts/release/verify-desktop-bundle.sh" macos-app "$(find "$BUNDLE_DIR/macos" -maxdepth 1 -type d -name '*.app' | head -1)"
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
    for _ in $(seq 1 15); do
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
