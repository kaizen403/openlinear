#!/usr/bin/env bash
# rollback.sh - redeploy the last recorded good OpenLinear revision.
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/openlinear}"
DEPLOY_STATE_DIR="${DEPLOY_STATE_DIR:-.deploy}"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

step() { echo -e "${CYAN}==>${NC} $1"; }
ok()   { echo -e "${GREEN}  ✓${NC} $1"; }
fail() { echo -e "${RED}  ✗${NC} $1"; exit 1; }

usage() {
    cat <<EOF
Usage: $(basename "$0") [git-ref]

Rolls production back by redeploying the saved rollback ref from
${DEPLOY_STATE_DIR}/rollback-ref. Pass an explicit git ref to override it.

Environment:
  DEPLOY_DIR              Repository path on the deploy host (default: /opt/openlinear)
  DEPLOY_STATE_DIR        State directory under DEPLOY_DIR (default: .deploy)
EOF
}

case "${1:-}" in
    -h|--help)
        usage
        exit 0
        ;;
esac

[ -d "$DEPLOY_DIR/.git" ] || fail "DEPLOY_DIR is not a git checkout: $DEPLOY_DIR"
cd "$DEPLOY_DIR"

rollback_ref="${1:-}"
if [ -z "$rollback_ref" ] && [ -f "$DEPLOY_STATE_DIR/rollback-ref" ]; then
    rollback_ref="$(tr -d '[:space:]' < "$DEPLOY_STATE_DIR/rollback-ref")"
fi

if [ -z "$rollback_ref" ] && git rev-parse --verify openlinear-rollback^{commit} >/dev/null 2>&1; then
    rollback_ref="openlinear-rollback"
fi

[ -n "$rollback_ref" ] || fail "No rollback ref found. Pass a commit or deploy once with the updated deploy script."

step "Validating rollback ref..."
target_ref="$(git rev-parse --verify "${rollback_ref}^{commit}")"
ok "Rollback target is $target_ref"

step "Redeploying rollback target..."
DEPLOY_DIR="$DEPLOY_DIR" \
DEPLOY_REF="$target_ref" \
DEPLOY_RECORD_ROLLBACK=0 \
"$DEPLOY_DIR/scripts/deploy.sh" --skip-rollback-record

echo ""
echo -e "${GREEN}Rollback complete: ${target_ref}${NC}"
