#!/usr/bin/env bash
# OpenLinear Installer Script
# Usage: curl -fsSL https://rixie.in/api/install | bash

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

REPO='kaizen403/openlinear'
INSTALLER_URL='https://rixie.in/api/install'
INSTALL_COMMAND="curl -fsSL ${INSTALLER_URL} | bash"
API_URL="https://api.github.com/repos/${REPO}/releases/latest"
RELEASES_URL="https://github.com/${REPO}/releases/latest"
INSTALL_DIR="${HOME}/.openlinear"
LINUX_BUNDLE_DIR="${INSTALL_DIR}/openlinear-linux-x64"
LINUX_BINARY_PATH="${LINUX_BUNDLE_DIR}/openlinear-desktop"
LEGACY_LINUX_APPIMAGE_PATH="${INSTALL_DIR}/openlinear.AppImage"
BIN_DIR="${HOME}/.local/bin"
BIN_PATH="${BIN_DIR}/openlinear"
DATA_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}"
DESKTOP_DIR="${DATA_DIR}/applications"
ICON_DIR="${DATA_DIR}/icons/hicolor/256x256/apps"
ICON_PATH="${ICON_DIR}/openlinear.png"
LINUX_DESKTOP_PATH="${DESKTOP_DIR}/openlinear.desktop"
MACOS_APPLICATIONS_DIR="${HOME}/Applications"
MACOS_APP_PATH="${MACOS_APPLICATIONS_DIR}/OpenLinear.app"
LEGACY_MACOS_APP_PATH="${INSTALL_DIR}/OpenLinear.app"

echo -e "${BLUE}OpenLinear Installer${NC}"
echo "===================="
echo ""

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

INSTALL_MODE=""
ASSET_PATTERN=""
ASSET_LABEL=""

case "$OS/$ARCH" in
    linux/x86_64)
        INSTALL_MODE="linux-portable"
        ASSET_PATTERN='-x86_64-linux\.tar\.gz$'
        ASSET_LABEL='Linux desktop bundle'
        ;;
    darwin/x86_64)
        INSTALL_MODE="macos-app"
        ASSET_PATTERN='-x86_64\.app\.tar\.gz$'
        ASSET_LABEL='macOS app bundle'
        ;;
    darwin/arm64)
        INSTALL_MODE="macos-app"
        ASSET_PATTERN='-aarch64\.app\.tar\.gz$'
        ASSET_LABEL='macOS app bundle'
        ;;
    *)
        echo -e "${RED}This installer currently supports macOS (Apple Silicon / Intel) and Linux x86_64 only.${NC}"
        echo "Use one of these instead:"
        echo "  npm install -g openlinear"
        echo "  paru -S openlinear-bin"
        echo "  ${RELEASES_URL}"
        exit 1
        ;;
esac

echo -e "Detected: ${YELLOW}${OS} / ${ARCH}${NC}"
echo ""

if ! command -v curl >/dev/null 2>&1; then
    echo -e "${RED}Error: curl is required${NC}"
    exit 1
fi

if [ "$INSTALL_MODE" = "macos-app" ] && ! command -v tar >/dev/null 2>&1; then
    echo -e "${RED}Error: tar is required on macOS installs${NC}"
    exit 1
fi

find_macos_binary_path() {
    local macos_dir="${MACOS_APP_PATH}/Contents/MacOS"

    if [ ! -d "$macos_dir" ]; then
        return 0
    fi

    for candidate in "OpenLinear" "openlinear-desktop"; do
        if [ -f "${macos_dir}/${candidate}" ]; then
            printf '%s\n' "${macos_dir}/${candidate}"
            return 0
        fi
    done

    find "$macos_dir" -maxdepth 1 -type f ! -name '*sidecar*' | head -n 1
}

write_linux_launcher() {
    cat > "$BIN_PATH" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

OPENLINEAR_BIN="${HOME}/.openlinear/openlinear-linux-x64/openlinear-desktop"

if [ ! -x "$OPENLINEAR_BIN" ]; then
  echo "OpenLinear desktop binary not found at $OPENLINEAR_BIN" >&2
  echo "Reinstall with: curl -fsSL https://rixie.in/api/install | bash" >&2
  exit 1
fi

IS_WAYLAND=false
if [ "${XDG_SESSION_TYPE:-}" = "wayland" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then
  IS_WAYLAND=true
fi

export WEBKIT_DISABLE_DMABUF_RENDERER=1

if [ "$IS_WAYLAND" = true ] && [ -z "${LD_PRELOAD:-}" ]; then
  for lib in \
    /usr/lib/libwayland-client.so \
    /usr/lib64/libwayland-client.so \
    /usr/lib/x86_64-linux-gnu/libwayland-client.so; do
    if [ -f "$lib" ]; then
      export LD_PRELOAD="$lib"
      break
    fi
  done

  if [ -z "${LD_PRELOAD:-}" ]; then
    export GDK_BACKEND=x11
    export WEBKIT_DISABLE_COMPOSITING_MODE=1
  fi
else
  export WEBKIT_DISABLE_COMPOSITING_MODE=1
fi

nohup "$OPENLINEAR_BIN" "$@" > /dev/null 2>&1 &
disown
EOF
}

write_linux_desktop_entry() {
    local version_tag="$1"
    local icon_url="https://raw.githubusercontent.com/${REPO}/${version_tag}/apps/desktop/src-tauri/icons/icon.png"
    local desktop_icon="$ICON_PATH"

    mkdir -p "$DESKTOP_DIR" "$ICON_DIR"
    if ! curl -fsSL "$icon_url" -o "$ICON_PATH"; then
        desktop_icon="openlinear"
        echo -e "${YELLOW}Warning: failed to download the OpenLinear icon. The app entry will use a generic icon until you reinstall.${NC}"
    fi

    cat > "$LINUX_DESKTOP_PATH" <<EOF
[Desktop Entry]
Version=1.0
Name=OpenLinear
Comment=AI-powered project management that actually writes the code
Exec=${BIN_PATH} %U
Icon=${desktop_icon}
Type=Application
Categories=Development;ProjectManagement;
MimeType=x-scheme-handler/openlinear;
StartupNotify=true
StartupWMClass=OpenLinear
Terminal=false
EOF

    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
    fi
}

write_macos_launcher() {
    cat > "$BIN_PATH" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

APP_BUNDLE=""
for candidate in \
  "${HOME}/Applications/OpenLinear.app" \
  "${HOME}/.openlinear/OpenLinear.app" \
  "/Applications/OpenLinear.app"; do
  if [ -d "$candidate" ]; then
    APP_BUNDLE="$candidate"
    break
  fi
done

if [ -z "$APP_BUNDLE" ]; then
  echo "OpenLinear macOS app not found in ~/Applications, ~/.openlinear, or /Applications" >&2
  echo "Reinstall with: curl -fsSL https://rixie.in/api/install | bash" >&2
  exit 1
fi

exec open -a "$APP_BUNDLE" --args "$@"
EOF
}

register_macos_app() {
    local lsregister="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

    if [ -x "$lsregister" ]; then
        "$lsregister" -f "$MACOS_APP_PATH" >/dev/null 2>&1 || true
    fi

    touch "$MACOS_APPLICATIONS_DIR" "$MACOS_APP_PATH" >/dev/null 2>&1 || true
}

echo -e "${BLUE}Fetching latest release metadata...${NC}"
RELEASE_DATA=$(curl -fsSL -H "Accept: application/vnd.github+json" -H "User-Agent: openlinear-installer" "$API_URL")

if [ -z "$RELEASE_DATA" ] || echo "$RELEASE_DATA" | grep -q "Not Found"; then
    echo -e "${RED}Error: Failed to fetch release information${NC}"
    exit 1
fi

VERSION=$(echo "$RELEASE_DATA" | grep -o '"tag_name":[[:space:]]*"[^"]*"' | cut -d'"' -f4)
ASSET_URL=$(echo "$RELEASE_DATA" | grep -o '"browser_download_url":[[:space:]]*"[^"]*' | cut -d'"' -f4 | grep -E -- "$ASSET_PATTERN" | head -1)

if [ -z "$VERSION" ]; then
    echo -e "${RED}Error: Failed to parse version${NC}"
    exit 1
fi

echo -e "Latest version: ${GREEN}${VERSION}${NC}"
echo ""

if [ -z "$ASSET_URL" ]; then
    echo -e "${RED}No ${ASSET_LABEL} found in the latest release.${NC}"
    echo "Open ${RELEASES_URL} and download it manually."
    exit 1
fi

echo -e "${BLUE}Downloading ${ASSET_LABEL}...${NC}"

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$INSTALL_DIR" "$BIN_DIR"

if [ "$INSTALL_MODE" = "linux-portable" ]; then
    DOWNLOAD_FILE="$TMP_DIR/openlinear-linux-x64.tar.gz"
    EXTRACT_DIR="$TMP_DIR/extracted"

    curl -fL "$ASSET_URL" -o "$DOWNLOAD_FILE" --progress-bar
    echo ""

    mkdir -p "$EXTRACT_DIR"
    tar -xzf "$DOWNLOAD_FILE" -C "$EXTRACT_DIR"

    EXTRACTED_BUNDLE=$(find "$EXTRACT_DIR" -maxdepth 1 -type d -name 'openlinear-linux-x64' | head -n 1)
    if [ -z "$EXTRACTED_BUNDLE" ]; then
        echo -e "${RED}Failed to extract the Linux OpenLinear bundle.${NC}"
        exit 1
    fi

    rm -rf "$LINUX_BUNDLE_DIR" "$LEGACY_LINUX_APPIMAGE_PATH"
    mv "$EXTRACTED_BUNDLE" "$LINUX_BUNDLE_DIR"
    chmod +x "$LINUX_BINARY_PATH" "$LINUX_BUNDLE_DIR/openlinear-sidecar"
    if [ -f "$LINUX_BUNDLE_DIR/opencode-x86_64-unknown-linux-gnu" ]; then
        chmod +x "$LINUX_BUNDLE_DIR/opencode-x86_64-unknown-linux-gnu"
    fi
    write_linux_launcher
    write_linux_desktop_entry "$VERSION"
else
    DOWNLOAD_FILE="$TMP_DIR/OpenLinear.app.tar.gz"
    EXTRACT_DIR="$TMP_DIR/extracted"

    curl -fL "$ASSET_URL" -o "$DOWNLOAD_FILE" --progress-bar
    echo ""

    mkdir -p "$EXTRACT_DIR"
    tar -xzf "$DOWNLOAD_FILE" -C "$EXTRACT_DIR"

    APP_BUNDLE=$(find "$EXTRACT_DIR" -type d -name '*.app' | head -n 1)
    if [ -z "$APP_BUNDLE" ]; then
        echo -e "${RED}Failed to extract OpenLinear.app from the downloaded archive.${NC}"
        exit 1
    fi

    mkdir -p "$MACOS_APPLICATIONS_DIR"
    rm -rf "$MACOS_APP_PATH" "$LEGACY_MACOS_APP_PATH"
    mv "$APP_BUNDLE" "$MACOS_APP_PATH"
    ln -s "$MACOS_APP_PATH" "$LEGACY_MACOS_APP_PATH"
    MACOS_BINARY_PATH=$(find_macos_binary_path)
    if [ -z "$MACOS_BINARY_PATH" ]; then
        echo -e "${RED}Failed to locate the OpenLinear macOS executable inside the app bundle.${NC}"
        exit 1
    fi

    chmod +x "$MACOS_BINARY_PATH"
    write_macos_launcher
    register_macos_app
fi

chmod +x "$BIN_PATH"

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
    echo ""
    echo -e "${YELLOW}Warning: $BIN_DIR is not in your PATH${NC}"
    echo ""
    echo "Add the following to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
    echo ""
    echo '    export PATH="$HOME/.local/bin:$PATH"'
    echo ""
fi

echo ""
echo -e "${GREEN}✓ OpenLinear ${VERSION} installed successfully!${NC}"
echo ""
if [ "$INSTALL_MODE" = "linux-portable" ]; then
    echo "Bundle: $LINUX_BUNDLE_DIR"
else
    echo "App bundle: $MACOS_APP_PATH"
fi
echo "Launcher: $BIN_PATH"
echo ""
echo "Run 'openlinear'"
