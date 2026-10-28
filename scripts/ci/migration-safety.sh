#!/usr/bin/env bash
# Migration safety review (CI gate).
#
# Flags, in Prisma migration files added or changed by a push or pull request:
#   - destructive DDL: DROP TABLE, DROP COLUMN, TRUNCATE
#   - CREATE [UNIQUE] INDEX without CONCURRENTLY (long write locks)
# Escape hatch: a `migration-safety: allow` comment in the SQL file, followed
# by the reason, so the decision is visible in review.
#
# Usage:
#   scripts/ci/migration-safety.sh <base-sha> [<head-ref>]   # diff mode (CI)
#   scripts/ci/migration-safety.sh --files <migration.sql>...  # check given files
#
# Diff mode compares <base-sha>...<head-ref> (merge-base semantics, default
# head HEAD) and reads file contents from <head-ref>. CI passes the pull
# request base SHA, or `github.event.before` on push; both need a full-history
# checkout (actions/checkout fetch-depth: 0). An unknown base (new branch,
# force push, manual dispatch) falls back to the head commit's parent, with a
# warning.
set -euo pipefail

MIGRATIONS_GLOB='packages/db/prisma/migrations/*/migration.sql'
ZERO_SHA=0000000000000000000000000000000000000000
FAIL=0
CHECKED=0

# check_sql <label> <content>
check_sql() {
  local label="$1" content="$2"
  CHECKED=$((CHECKED + 1))
  if grep -q 'migration-safety: allow' <<<"$content"; then
    echo "skip (opt-in 'migration-safety: allow'): $label"
    return 0
  fi
  if grep -iEq '^[[:space:]]*(DROP[[:space:]]+(TABLE|COLUMN)|ALTER[[:space:]]+TABLE[^;]*DROP[[:space:]]+COLUMN|TRUNCATE)' <<<"$content"; then
    echo "::error file=$label::destructive DDL without '-- migration-safety: allow <reason>'"
    FAIL=1
  fi
  # POSIX ERE has no lookahead: flag any CREATE INDEX line that does not itself
  # say CONCURRENTLY.
  if grep -iE '^[[:space:]]*CREATE[[:space:]]+(UNIQUE[[:space:]]+)?INDEX' <<<"$content" | grep -ivq 'CONCURRENTLY'; then
    echo "::error file=$label::CREATE INDEX without CONCURRENTLY (or '-- migration-safety: allow <reason>')"
    FAIL=1
  fi
  echo "checked: $label"
}

if [ "${1:-}" = "--files" ]; then
  shift
  [ "$#" -gt 0 ] || { echo "usage: $0 --files <migration.sql>..." >&2; exit 2; }
  for f in "$@"; do
    check_sql "$f" "$(cat "$f")"
  done
  exit "$FAIL"
fi

BASE="${1:-}"
HEAD_REF="${2:-HEAD}"

if [ -z "$BASE" ] || [ "$BASE" = "$ZERO_SHA" ] || ! git cat-file -e "${BASE}^{commit}" 2>/dev/null; then
  if git rev-parse --verify --quiet "${HEAD_REF}^" >/dev/null; then
    echo "::warning::migration safety: base '${BASE:-<none>}' is not available; checking only the last commit"
    BASE="$(git rev-parse "${HEAD_REF}^")"
  else
    echo "::warning::migration safety: no base commit available; nothing to compare"
    exit 0
  fi
fi

echo "Migration safety: comparing ${BASE}...${HEAD_REF}"
FILES="$(git diff --name-only --diff-filter=AMR "${BASE}...${HEAD_REF}" -- "$MIGRATIONS_GLOB")"
if [ -z "$FILES" ]; then
  echo "No migration changes."
  exit 0
fi

MODIFIED="$(git diff --name-only --diff-filter=M "${BASE}...${HEAD_REF}" -- "$MIGRATIONS_GLOB")"
while IFS= read -r f; do
  [ -n "$f" ] || continue
  echo "::warning file=$f::an existing migration was edited; databases that already applied it will not re-run it"
done <<<"$MODIFIED"

while IFS= read -r f; do
  [ -n "$f" ] || continue
  check_sql "$f" "$(git show "${HEAD_REF}:${f}")"
done <<<"$FILES"

echo "Checked ${CHECKED} migration file(s)."
exit "$FAIL"
