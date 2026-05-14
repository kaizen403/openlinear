#!/usr/bin/env bash
# smoke-test.sh - launch-readiness smoke checks for OpenLinear.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.preview.yml"
CONTAINER="${SMOKE_CONTAINER:-openlinear}"

API_URL="${API_URL:-http://localhost:3001}"
SIDECAR_URL="${SIDECAR_URL:-$API_URL}"
WEB_URL="${WEB_URL:-http://localhost:3000}"
LANDING_URL="${LANDING_URL:-http://localhost:3002}"

SMOKE_USER_ID="${SMOKE_USER_ID:-00000000-0000-4000-8000-000000000001}"
SMOKE_USERNAME="${SMOKE_USERNAME:-openlinear-smoke}"
SMOKE_EMAIL="${SMOKE_EMAIL:-smoke-test@openlinear.local}"
SMOKE_GITHUB_ID="${SMOKE_GITHUB_ID:-900000001}"
SMOKE_GITHUB_TOKEN="${SMOKE_GITHUB_TOKEN:-}"
JWT_SECRET="${JWT_SECRET:-openlinear-dev-secret-change-in-production}"

SMOKE_REPO_ID="${SMOKE_REPO_ID:-900000001}"
SMOKE_REPO_NAME="${SMOKE_REPO_NAME:-smoke-test}"
SMOKE_REPO_FULL_NAME="${SMOKE_REPO_FULL_NAME:-openlinear/smoke-test}"
SMOKE_REPO_CLONE_URL="${SMOKE_REPO_CLONE_URL:-https://github.com/octocat/Hello-World.git}"
SMOKE_REPO_DEFAULT_BRANCH="${SMOKE_REPO_DEFAULT_BRANCH:-master}"

SMOKE_RUN_EXECUTION="${SMOKE_RUN_EXECUTION:-0}"
SMOKE_EXPECT_PR="${SMOKE_EXPECT_PR:-0}"
SMOKE_EXPECT_HSTS="${SMOKE_EXPECT_HSTS:-0}"
SMOKE_KEEP_DATA="${SMOKE_KEEP_DATA:-0}"
SMOKE_TIMEOUT_SECONDS="${SMOKE_TIMEOUT_SECONDS:-90}"
SMOKE_TOKEN="${SMOKE_TOKEN:-}"

START_PREVIEW=0
AUTH_TOKEN=""
CREATED_TEAM_ID=""
CREATED_TASK_ID=""
CREATED_REPO_ID=""
SEEDED_USER=0

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
NC='\033[0m'

step() { echo -e "${CYAN}==>${NC} $1"; }
ok()   { echo -e "${GREEN}  ✓${NC} $1"; }
warn() { echo -e "${YELLOW}  !${NC} $1"; }
fail() { echo -e "${RED}  ✗${NC} $1"; exit 1; }

usage() {
  cat <<EOF
Usage: $(basename "$0") [--start-preview] [--run-execution] [--expect-pr] [--expect-hsts]

By default this validates running services, mocks OAuth by seeding a smoke user,
imports a test repository, creates a team and task, cancels the task, then cleans up.

Options:
  --start-preview    Start docker-compose.preview.yml before running checks.
  --run-execution    Call the sidecar execute/cancel task endpoints.
  --expect-pr        Poll the task until prUrl is set after execution.
  --expect-hsts      Require Strict-Transport-Security on API health responses.

Useful environment:
  API_URL, SIDECAR_URL, WEB_URL, LANDING_URL
  SMOKE_TOKEN                         Use an existing bearer token instead of DB seeding.
  SMOKE_GITHUB_TOKEN                  Token stored on the mock user for full execution.
  SMOKE_REPO_FULL_NAME/CLONE_URL      Test repository used by /api/repos/import.
  SMOKE_KEEP_DATA=1                   Leave created smoke data in place.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --start-preview)
      START_PREVIEW=1
      shift
      ;;
    --run-execution)
      SMOKE_RUN_EXECUTION=1
      shift
      ;;
    --expect-pr)
      SMOKE_EXPECT_PR=1
      SMOKE_RUN_EXECUTION=1
      shift
      ;;
    --expect-hsts)
      SMOKE_EXPECT_HSTS=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

prod_db_guard() {
  local url="${DATABASE_URL:-}"
  [ -n "$url" ] || return 0

  if [ "${SMOKE_ALLOW_PROD_DB:-0}" = "1" ]; then
    warn "SMOKE_ALLOW_PROD_DB=1 — skipping production database guard"
    return 0
  fi

  local lower
  lower="$(printf '%s' "$url" | tr '[:upper:]' '[:lower:]')"
  case "$lower" in
    *openlinear.tech*|*neon.tech*|*amazonaws.com*|*supabase*|*railway*|*render.com*|*fly.io*)
      fail "Refusing to run smoke test against what looks like a production DATABASE_URL ($url). Set SMOKE_ALLOW_PROD_DB=1 to override."
      ;;
  esac
}

prod_db_guard

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    fail "Docker Compose is required for --start-preview"
  fi
}

curl_status() {
  local url="$1"
  curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$url"
}

wait_for_url() {
  local name="$1"
  local url="$2"
  local timeout="$3"
  local status

  for _ in $(seq 1 "$timeout"); do
    status="$(curl_status "$url" || true)"
    if [ "$status" -ge 200 ] 2>/dev/null && [ "$status" -lt 400 ] 2>/dev/null; then
      ok "$name ready ($status)"
      return 0
    fi
    sleep 1
  done

  fail "$name did not become ready at $url"
}

json_get() {
  local path="$1"
  node - "$path" <<'NODE'
const fs = require('fs');
const path = process.argv[2].split('.');
let value = JSON.parse(fs.readFileSync(0, 'utf8'));
for (const key of path) value = value?.[key];
if (value === undefined || value === null) process.exit(1);
process.stdout.write(typeof value === 'object' ? JSON.stringify(value) : String(value));
NODE
}

json_body() {
  node - "$@" <<'NODE'
const mode = process.argv[2];
if (mode === 'team') {
  const [, , , key] = process.argv;
  process.stdout.write(JSON.stringify({
    name: `Smoke ${key}`,
    key,
    description: 'Created by scripts/smoke-test.sh',
    color: '#6366f1',
    private: true,
  }));
} else if (mode === 'repo') {
  const [, , , id, fullName, name, cloneUrl, defaultBranch] = process.argv;
  process.stdout.write(JSON.stringify({
    repo: {
      id: Number(id),
      full_name: fullName,
      name,
      clone_url: cloneUrl,
      html_url: `https://github.com/${fullName}`,
      default_branch: defaultBranch,
      private: false,
      owner: { login: fullName.split('/')[0] || 'openlinear' },
    },
  }));
} else if (mode === 'task') {
  const [, , , teamId] = process.argv;
  process.stdout.write(JSON.stringify({
    title: 'Smoke test task',
    description: 'Created by scripts/smoke-test.sh',
    priority: 'low',
    status: 'todo',
    teamId,
  }));
} else if (mode === 'status') {
  const [, , , status] = process.argv;
  process.stdout.write(JSON.stringify({ status }));
}
NODE
}

make_jwt() {
  node - "$SMOKE_USER_ID" "$SMOKE_USERNAME" "$JWT_SECRET" <<'NODE'
const crypto = require('crypto');
const userId = process.argv[2];
const username = process.argv[3];
const secret = process.argv[4];
const now = Math.floor(Date.now() / 1000);
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const header = b64({ alg: 'HS256', typ: 'JWT' });
const payload = b64({ userId, username, iat: now, exp: now + 3600 });
const data = `${header}.${payload}`;
const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
process.stdout.write(`${data}.${sig}`);
NODE
}

run_db_node() {
  if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    docker exec -i \
      -e SMOKE_USER_ID="$SMOKE_USER_ID" \
      -e SMOKE_USERNAME="$SMOKE_USERNAME" \
      -e SMOKE_EMAIL="$SMOKE_EMAIL" \
      -e SMOKE_GITHUB_ID="$SMOKE_GITHUB_ID" \
      -e SMOKE_GITHUB_TOKEN="$SMOKE_GITHUB_TOKEN" \
      -e SMOKE_CREATED_TASK_ID="$CREATED_TASK_ID" \
      -e SMOKE_CREATED_TEAM_ID="$CREATED_TEAM_ID" \
      -e SMOKE_CREATED_REPO_ID="$CREATED_REPO_ID" \
      "$CONTAINER" sh -lc 'cd /app && node --input-type=module'
  else
    [ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL is required for smoke user DB seeding outside Docker preview"
    (
      cd "$ROOT_DIR"
      SMOKE_USER_ID="$SMOKE_USER_ID" \
      SMOKE_USERNAME="$SMOKE_USERNAME" \
      SMOKE_EMAIL="$SMOKE_EMAIL" \
      SMOKE_GITHUB_ID="$SMOKE_GITHUB_ID" \
      SMOKE_GITHUB_TOKEN="$SMOKE_GITHUB_TOKEN" \
      SMOKE_CREATED_TASK_ID="$CREATED_TASK_ID" \
      SMOKE_CREATED_TEAM_ID="$CREATED_TEAM_ID" \
      SMOKE_CREATED_REPO_ID="$CREATED_REPO_ID" \
      pnpm --filter @openlinear/api exec node --input-type=module
    )
  fi
}

seed_smoke_user() {
  [ -z "$SMOKE_TOKEN" ] || return 0

  step "Seeding OAuth mock user..."
  run_db_node <<'NODE'
import { prisma } from '@openlinear/db';

const userId = process.env.SMOKE_USER_ID;
const githubId = Number(process.env.SMOKE_GITHUB_ID);
const username = process.env.SMOKE_USERNAME;
const email = process.env.SMOKE_EMAIL;
const accessToken = process.env.SMOKE_GITHUB_TOKEN || null;

await prisma.user.upsert({
  where: { id: userId },
  update: { username, email, githubId, accessToken },
  create: { id: userId, username, email, githubId, accessToken },
});
await prisma.$disconnect();
NODE
  SEEDED_USER=1
  AUTH_TOKEN="$(make_jwt)"
  ok "OAuth mock user ready"
}

cleanup() {
  if [ "$SMOKE_KEEP_DATA" = "1" ]; then
    warn "SMOKE_KEEP_DATA=1; leaving smoke data in place"
    return 0
  fi

  if [ "$SEEDED_USER" = "1" ]; then
    run_db_node <<'NODE' >/dev/null 2>&1 || true
import { prisma } from '@openlinear/db';

const userId = process.env.SMOKE_USER_ID;
const taskId = process.env.SMOKE_CREATED_TASK_ID || '';
const teamId = process.env.SMOKE_CREATED_TEAM_ID || '';
const repoId = process.env.SMOKE_CREATED_REPO_ID || '';

if (taskId) await prisma.task.deleteMany({ where: { id: taskId } });
if (teamId) {
  await prisma.teamMember.deleteMany({ where: { teamId } });
  await prisma.team.deleteMany({ where: { id: teamId } });
}
if (repoId) await prisma.repository.deleteMany({ where: { id: repoId, userId } });
await prisma.user.deleteMany({ where: { id: userId } });
await prisma.$disconnect();
NODE
    return 0
  fi

  if [ -n "$AUTH_TOKEN" ]; then
    [ -z "$CREATED_TASK_ID" ] || curl -sS -o /dev/null -X DELETE \
      -H "Authorization: Bearer $AUTH_TOKEN" "$API_URL/api/tasks/$CREATED_TASK_ID" || true
    [ -z "$CREATED_TEAM_ID" ] || curl -sS -o /dev/null -X DELETE \
      -H "Authorization: Bearer $AUTH_TOKEN" "$API_URL/api/teams/$CREATED_TEAM_ID" || true
  fi
}
trap cleanup EXIT

api_request() {
  local method="$1"
  local url="$2"
  local body="${3:-}"
  local tmp
  local status

  tmp="$(mktemp)"
  if [ -n "$body" ]; then
    status="$(curl -sS -o "$tmp" -w '%{http_code}' --max-time 30 \
      -X "$method" \
      -H "Authorization: Bearer $AUTH_TOKEN" \
      -H "Content-Type: application/json" \
      --data "$body" \
      "$url")" || {
        cat "$tmp" >&2 || true
        rm -f "$tmp"
        fail "$method $url failed"
      }
  else
    status="$(curl -sS -o "$tmp" -w '%{http_code}' --max-time 30 \
      -X "$method" \
      -H "Authorization: Bearer $AUTH_TOKEN" \
      "$url")" || {
        cat "$tmp" >&2 || true
        rm -f "$tmp"
        fail "$method $url failed"
      }
  fi

  if [ "$status" -lt 200 ] 2>/dev/null || [ "$status" -ge 300 ] 2>/dev/null; then
    cat "$tmp" >&2 || true
    rm -f "$tmp"
    fail "$method $url returned HTTP $status"
  fi

  cat "$tmp"
  rm -f "$tmp"
}

poll_pr_url() {
  local task_id="$1"
  local body
  local pr_url

  for _ in $(seq 1 "$SMOKE_TIMEOUT_SECONDS"); do
    body="$(api_request GET "$API_URL/api/tasks/$task_id")"
    pr_url="$(printf '%s' "$body" | json_get prUrl 2>/dev/null || true)"
    if [ -n "$pr_url" ]; then
      ok "PR opened: $pr_url"
      return 0
    fi
    sleep 1
  done

  fail "Timed out waiting for task prUrl"
}

need_cmd curl
need_cmd node

if [ "$START_PREVIEW" = "1" ]; then
  need_cmd docker
  step "Starting Docker preview..."
  compose -f "$COMPOSE_FILE" up -d --build
fi

step "Checking service health..."
wait_for_url "API" "$API_URL/health" "$SMOKE_TIMEOUT_SECONDS"
wait_for_url "Web" "$WEB_URL/" "$SMOKE_TIMEOUT_SECONDS"
wait_for_url "Landing" "$LANDING_URL/" "$SMOKE_TIMEOUT_SECONDS"

if [ "$SMOKE_EXPECT_HSTS" = "1" ]; then
  step "Checking HSTS header..."
  curl -fsSI --max-time 10 "$API_URL/health" | tr -d '\r' | \
    grep -iq '^strict-transport-security:' || fail "Missing Strict-Transport-Security header"
  ok "HSTS header present"
fi

if [ -n "$SMOKE_TOKEN" ]; then
  AUTH_TOKEN="$SMOKE_TOKEN"
else
  seed_smoke_user
fi

step "Checking authenticated API access..."
api_request GET "$API_URL/api/auth/me" >/dev/null
ok "Bearer token accepted"

suffix="$(printf '%06d' "$((RANDOM % 1000000))")"
team_key="SMK${suffix}"

step "Creating smoke team..."
team_json="$(api_request POST "$API_URL/api/teams" "$(json_body team "$team_key")")"
CREATED_TEAM_ID="$(printf '%s' "$team_json" | json_get id)"
ok "Team created: $CREATED_TEAM_ID"

step "Connecting smoke repository..."
repo_json="$(api_request POST "$API_URL/api/repos/import" \
  "$(json_body repo "$SMOKE_REPO_ID" "$SMOKE_REPO_FULL_NAME" "$SMOKE_REPO_NAME" "$SMOKE_REPO_CLONE_URL" "$SMOKE_REPO_DEFAULT_BRANCH")")"
CREATED_REPO_ID="$(printf '%s' "$repo_json" | json_get id)"
ok "Repository imported: $CREATED_REPO_ID"

step "Creating smoke task..."
task_json="$(api_request POST "$API_URL/api/tasks" "$(json_body task "$CREATED_TEAM_ID")")"
CREATED_TASK_ID="$(printf '%s' "$task_json" | json_get id)"
ok "Task created: $CREATED_TASK_ID"

if [ "$SMOKE_RUN_EXECUTION" = "1" ]; then
  step "Executing smoke task through sidecar..."
  execute_json="$(api_request POST "$SIDECAR_URL/api/tasks/$CREATED_TASK_ID/execute")"
  execute_success="$(printf '%s' "$execute_json" | json_get success 2>/dev/null || true)"
  [ "$execute_success" = "true" ] || fail "Execution did not report success: $execute_json"
  ok "Execution started"

  if [ "$SMOKE_EXPECT_PR" = "1" ]; then
    poll_pr_url "$CREATED_TASK_ID"
  else
    warn "Skipping PR verification. Set --expect-pr after configuring a writable smoke repo and agent credentials."
  fi

  step "Cancelling smoke task..."
  cancel_status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 \
    -X POST \
    -H "Authorization: Bearer $AUTH_TOKEN" \
    "$SIDECAR_URL/api/tasks/$CREATED_TASK_ID/cancel" || true)"
  if [ "$cancel_status" -ge 200 ] 2>/dev/null && [ "$cancel_status" -lt 300 ] 2>/dev/null; then
    ok "Cancel endpoint checked"
  else
    warn "Cancel returned HTTP $cancel_status; task may have already stopped"
  fi
else
  step "Cancelling smoke task through API status update..."
  api_request PATCH "$API_URL/api/tasks/$CREATED_TASK_ID" "$(json_body status cancelled)" >/dev/null
  ok "Task status updated to cancelled"
  warn "Skipped sidecar execution. Re-run with --run-execution for execute/cancel route coverage."
fi

echo ""
echo -e "${GREEN}Smoke test passed.${NC}"
