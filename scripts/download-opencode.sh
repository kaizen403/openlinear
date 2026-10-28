#!/usr/bin/env bash
set -euo pipefail

# Downloads the OpenCode CLI the sidecar drives (`opencode serve`) for one
# Tauri target and installs it as apps/desktop/src-tauri/binaries/
# opencode-<target-triple> (Tauri externalBin naming).
#
# SECURITY: the version is pinned and every download is verified before it is
# extracted. A release asset is accepted only when ALL of these agree:
#   1. the SHA-256 committed in scripts/opencode.sha256 (our pin);
#   2. the SHA-256 the upstream release publishes for the asset (the GitHub
#      release API `digest` field, fetched at download time);
#   3. the SHA-256 of the bytes actually downloaded;
#   4. the GitHub-signed release attestation (`gh release verify-asset`): the
#      upstream release is immutable and GitHub signs its asset digests.
#      Runs whenever `gh` is installed and authenticated; required when
#      OPENCODE_REQUIRE_ATTESTATION=1 (release.yml sets it).
# Optional 5th check (--cross-check-npm): the binary inside the GitHub archive
# is byte-identical to the one in upstream's npm platform package
# (`opencode-<os>-<arch>`), whose tarball is checked against the registry's
# sha512 integrity. That is an independent distribution channel.
# Any mismatch exits non-zero. There is no "skip if already downloaded"
# shortcut: every run re-verifies and reinstalls.
#
# Usage:
#   scripts/download-opencode.sh                     # host target, install
#   scripts/download-opencode.sh --target x86_64-apple-darwin
#   scripts/download-opencode.sh --all --verify-only [--cross-check-npm]
#
# Environment:
#   OPENCODE_VERSION              must equal the "# Version:" line of
#                                 scripts/opencode.sha256 (default: that line)
#   OPENCODE_TARGET               target triple (same as --target)
#   OPENCODE_REQUIRE_ATTESTATION  1 = fail when the attestation cannot be checked
#   GH_TOKEN / GITHUB_TOKEN       optional; authenticates API calls and `gh`

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
BINARIES_DIR="$ROOT_DIR/apps/desktop/src-tauri/binaries"
CHECKSUMS_FILE="$SCRIPT_DIR/opencode.sha256"

# anomalyco/opencode (formerly sst/opencode): the CLI and @opencode-ai/sdk are
# released together, so the pin follows the SDK version in pnpm-lock.yaml.
# (opencode-ai/opencode is the archived Go CLI and has no server API.)
REPO="anomalyco/opencode"

die() {
  echo "  ! $*" >&2
  exit 1
}

PINNED_VERSION="$(awk '/^# Version: /{ print $3; exit }' "$CHECKSUMS_FILE")"
[ -n "$PINNED_VERSION" ] || die "no '# Version:' line in $CHECKSUMS_FILE"
OPENCODE_VERSION="${OPENCODE_VERSION:-$PINNED_VERSION}"
if [ "$OPENCODE_VERSION" != "$PINNED_VERSION" ]; then
  die "OPENCODE_VERSION=$OPENCODE_VERSION but $CHECKSUMS_FILE pins $PINNED_VERSION; regenerate the checksums file (instructions inside) together with the version"
fi

TARGET="${OPENCODE_TARGET:-}"
ALL=0
VERIFY_ONLY=0
CROSS_CHECK_NPM=0
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --target=*) TARGET="${1#--target=}"; shift ;;
    --all) ALL=1; shift ;;
    --verify-only) VERIFY_ONLY=1; shift ;;
    --cross-check-npm) CROSS_CHECK_NPM=1; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

host_triple() {
  case "$(uname -s)/$(uname -m)" in
    Darwin/arm64) echo "aarch64-apple-darwin" ;;
    Darwin/x86_64) echo "x86_64-apple-darwin" ;;
    Linux/x86_64) echo "x86_64-unknown-linux-gnu" ;;
    Linux/aarch64) echo "aarch64-unknown-linux-gnu" ;;
    *) die "unsupported host: $(uname -s)/$(uname -m)" ;;
  esac
}

# Target triple -> upstream asset name (macOS ships .zip, Linux .tar.gz).
asset_for() {
  case "$1" in
    aarch64-apple-darwin) echo "opencode-darwin-arm64.zip" ;;
    x86_64-apple-darwin) echo "opencode-darwin-x64.zip" ;;
    x86_64-unknown-linux-gnu) echo "opencode-linux-x64.tar.gz" ;;
    aarch64-unknown-linux-gnu) echo "opencode-linux-arm64.tar.gz" ;;
    *) die "unsupported target triple: $1" ;;
  esac
}

compute_sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

GH_AUTH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
api_get() {
  if [ -n "$GH_AUTH_TOKEN" ]; then
    curl -fsSL --retry 3 -H "Authorization: Bearer $GH_AUTH_TOKEN" -H "Accept: application/vnd.github+json" "$1"
  else
    curl -fsSL --retry 3 -H "Accept: application/vnd.github+json" "$1"
  fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

RELEASE_URL="https://api.github.com/repos/$REPO/releases/tags/$OPENCODE_VERSION"
echo "==> OpenCode $OPENCODE_VERSION from $REPO"
echo "  - Fetching release metadata ($RELEASE_URL)"
api_get "$RELEASE_URL" >"$WORK/release.json"

# Prints "<browser_download_url> <sha256 from the upstream digest>" for one asset.
upstream_asset_info() {
  # shellcheck disable=SC2016 # single quotes: JavaScript, not shell
  node -e '
const fs = require("node:fs");
const [file, name] = process.argv.slice(1);
const data = JSON.parse(fs.readFileSync(file, "utf8"));
const asset = (Array.isArray(data.assets) ? data.assets : []).find((a) => a.name === name);
if (!asset || !asset.browser_download_url) {
  console.error(`asset ${name} not found in release ${data.tag_name}`);
  process.exit(1);
}
const digest = typeof asset.digest === "string" ? asset.digest : "";
if (!digest.startsWith("sha256:")) {
  console.error(`release ${data.tag_name} publishes no sha256 digest for ${name}`);
  process.exit(1);
}
process.stdout.write(`${asset.browser_download_url} ${digest.slice("sha256:".length)}`);
' "$WORK/release.json" "$1"
}

attestation_available() {
  command -v gh >/dev/null 2>&1 && gh release verify-asset --help >/dev/null 2>&1 && gh auth status >/dev/null 2>&1
}

npm_package_for() {
  case "$1" in
    aarch64-apple-darwin) echo "opencode-darwin-arm64" ;;
    x86_64-apple-darwin) echo "opencode-darwin-x64" ;;
    x86_64-unknown-linux-gnu) echo "opencode-linux-x64" ;;
    aarch64-unknown-linux-gnu) echo "opencode-linux-arm64" ;;
  esac
}

# Finds the single regular file named `opencode` (never a symlink) at the
# archive root, bin/ or package/bin/.
find_binary() {
  local dir="$1" candidate
  for candidate in "$dir/opencode" "$dir/bin/opencode" "$dir/package/bin/opencode"; do
    if [ -f "$candidate" ] && [ ! -L "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

cross_check_npm() {
  local triple="$1" binary="$2" pkg version meta tarball integrity actual dir npm_binary
  pkg="$(npm_package_for "$triple")"
  version="${OPENCODE_VERSION#v}"
  dir="$WORK/npm-$triple"
  mkdir -p "$dir/extract"
  meta="$(npm view "$pkg@$version" dist.tarball dist.integrity --json)"
  tarball="$(printf '%s' "$meta" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(d["dist.tarball"]||"")')"
  integrity="$(printf '%s' "$meta" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(d["dist.integrity"]||"")')"
  case "$integrity" in sha512-*) ;; *) die "npm $pkg@$version has no sha512 integrity" ;; esac
  curl -fsSL --retry 3 "$tarball" -o "$dir/pkg.tgz"
  actual="sha512-$(openssl dgst -sha512 -binary "$dir/pkg.tgz" | openssl base64 -A)"
  [ "$actual" = "$integrity" ] || die "npm tarball $pkg@$version does not match the registry integrity"
  tar --no-same-owner -xzf "$dir/pkg.tgz" -C "$dir/extract"
  npm_binary="$(find_binary "$dir/extract")" || die "no opencode binary in npm $pkg@$version"
  if [ "$(compute_sha256 "$npm_binary")" != "$(compute_sha256 "$binary")" ]; then
    die "binary in the GitHub asset differs from npm $pkg@$version"
  fi
  echo "  - npm cross-check: $pkg@$version (registry integrity ok) carries the identical binary"
}

process_target() {
  local triple="$1" asset pinned info url upstream file actual extract binary dest

  asset="$(asset_for "$triple")"
  echo "==> $triple ($asset)"

  pinned="$(awk -v name="$asset" '$2 == name { print $1; exit }' "$CHECKSUMS_FILE")"
  [ -n "$pinned" ] || die "no pinned checksum for $asset in $CHECKSUMS_FILE; refusing to install an unverified binary"

  info="$(upstream_asset_info "$asset")" || die "could not resolve $asset in $REPO $OPENCODE_VERSION"
  url="${info%% *}"
  upstream="${info##* }"
  if [ "$upstream" != "$pinned" ]; then
    die "upstream digest for $asset ($upstream) differs from the pinned checksum ($pinned)"
  fi
  echo "  - Pinned checksum matches the upstream release digest"

  mkdir -p "$WORK/$triple/extract"
  file="$WORK/$triple/$asset"
  curl -fsSL --retry 3 "$url" -o "$file"
  actual="$(compute_sha256 "$file")"
  if [ "$actual" != "$pinned" ]; then
    die "checksum mismatch for $asset: expected $pinned, downloaded $actual"
  fi
  echo "  - Downloaded bytes match ($actual)"

  if attestation_available; then
    gh release verify-asset "$OPENCODE_VERSION" "$file" -R "$REPO" >"$WORK/$triple/attestation.txt" 2>&1 \
      || { cat "$WORK/$triple/attestation.txt" >&2; die "GitHub release attestation check failed for $asset"; }
    echo "  - GitHub-signed release attestation verified (gh release verify-asset)"
  elif [ "${OPENCODE_REQUIRE_ATTESTATION:-0}" = "1" ]; then
    die "OPENCODE_REQUIRE_ATTESTATION=1 but 'gh release verify-asset' is unavailable or unauthenticated"
  else
    echo "  - (attestation not checked: install and authenticate gh >= 2.80 to enable)"
  fi

  extract="$WORK/$triple/extract"
  case "$asset" in
    *.zip) unzip -q "$file" -d "$extract" ;;
    *.tar.gz) tar --no-same-owner -xzf "$file" -C "$extract" ;;
  esac
  binary="$(find_binary "$extract")" || {
    find "$extract" -maxdepth 3 | head -20 >&2
    die "expected an 'opencode' binary in $asset"
  }

  if [ "$CROSS_CHECK_NPM" = "1" ]; then
    cross_check_npm "$triple" "$binary"
  fi

  if [ "$VERIFY_ONLY" = "1" ]; then
    echo "  - Verified (not installed: --verify-only)"
    return 0
  fi

  dest="$BINARIES_DIR/opencode-$triple"
  mkdir -p "$BINARIES_DIR"
  # Copy to a new file and rename over the old one: overwriting a signed
  # Mach-O in place makes macOS kill it (SIGKILL, cached code signature).
  cp "$binary" "$dest.tmp.$$"
  chmod 0755 "$dest.tmp.$$"
  mv -f "$dest.tmp.$$" "$dest"
  echo "  - Installed $dest ($(du -h "$dest" | cut -f1))"

  # When the target runs on this host, prove the installed binary is the
  # pinned version.
  if [ "$triple" = "$(host_triple)" ]; then
    local reported
    reported="$("$dest" --version 2>/dev/null | tr -d '[:space:]')" || die "installed opencode does not run on this host"
    [ "$reported" = "${OPENCODE_VERSION#v}" ] || die "installed opencode reports '$reported', expected ${OPENCODE_VERSION#v}"
    echo "  - '$dest --version' -> $reported"
  fi
}

if [ "$ALL" = "1" ]; then
  for triple in aarch64-apple-darwin x86_64-apple-darwin x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu; do
    process_target "$triple"
  done
else
  process_target "${TARGET:-$(host_triple)}"
fi

echo "==> OpenCode $OPENCODE_VERSION verified"
