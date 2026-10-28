#!/usr/bin/env bash
# Smoke-tests a packaged sidecar executable (scripts/build-sidecar.sh output)
# the way the Tauri launcher starts it: an emptied environment, no
# DATABASE_URL or signing secret, and OPENLINEAR_API_URL pointing at a cloud
# API that is not there. Used by .github/workflows/release.yml for every
# target and runnable locally:
#
#   scripts/release/smoke-sidecar-binary.sh apps/desktop/src-tauri/binaries/openlinear-sidecar-<triple>
#
# Asserts:
#   1. /health answers 200 with persistence "api" (no database in the binary);
#   2. an auth-requiring route without a token answers 401;
#   3. the same route with a bearer token answers 503 (cloud API unreachable:
#      the sidecar fails closed instead of trusting the token);
#   4. SIGTERM stops the process;
#   5. the binary refuses to start when DATABASE_URL is passed explicitly.
set -euo pipefail

BIN="${1:-}"
if [ -z "$BIN" ] || [ ! -x "$BIN" ]; then
  echo "usage: $0 <path-to-packaged-sidecar-binary>" >&2
  exit 2
fi
BIN="$(cd "$(dirname "$BIN")" && pwd)/$(basename "$BIN")"

WORK="$(mktemp -d)"
SIDECAR_PID=""
cleanup() {
  if [ -n "$SIDECAR_PID" ] && kill -0 "$SIDECAR_PID" 2>/dev/null; then
    kill -9 "$SIDECAR_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});'
}

PORT="$(free_port)"
# A loopback port with nothing listening: every control-plane call fails.
DEAD_API_PORT="$(free_port)"
mkdir -p "$WORK/home" "$WORK/tmp"

fail() {
  echo "FAIL: $1" >&2
  echo "----- sidecar log -----" >&2
  cat "$WORK/sidecar.log" >&2 || true
  exit 1
}

# Mirrors apps/desktop/src-tauri/src/sidecar.rs build_sidecar_env(): env_clear()
# plus the launcher's own variables. Nothing secret is present.
start_sidecar() {
  env -i \
    HOME="$WORK/home" \
    TMPDIR="$WORK/tmp" \
    PATH="/usr/bin:/bin" \
    API_PORT="$PORT" \
    OPENLINEAR_API_URL="http://127.0.0.1:$DEAD_API_PORT" \
    FRONTEND_URL="http://127.0.0.1:3000" \
    CORS_ORIGIN="http://127.0.0.1:3000,tauri://localhost,https://tauri.localhost" \
    OPENLINEAR_SKIP_DOTENV=1 \
    NODE_ENV=production \
    "$@" \
    "$BIN" >"$WORK/sidecar.log" 2>&1 &
  SIDECAR_PID=$!
}

http_status() {
  # $1 = path, remaining args = extra curl args
  local path="$1"
  shift
  curl -s -o "$WORK/body" -w '%{http_code}' "$@" "http://127.0.0.1:$PORT$path" || true
}

echo "==> Starting $BIN on 127.0.0.1:$PORT (empty environment, no DATABASE_URL)"
start_sidecar
for _ in $(seq 1 60); do
  if ! kill -0 "$SIDECAR_PID" 2>/dev/null; then
    fail "sidecar exited during startup"
  fi
  if [ "$(http_status /health)" = "200" ]; then
    break
  fi
  sleep 0.5
done

STATUS="$(http_status /health)"
[ "$STATUS" = "200" ] || fail "/health returned $STATUS"
grep -q '"persistence":"api"' "$WORK/body" || fail "/health did not report persistence \"api\": $(cat "$WORK/body")"
echo "  ok  /health 200 $(cat "$WORK/body")"

# The run journal (node:sqlite) is opened during boot. Its failure is logged
# and boot continues, so check it explicitly: a packaged runtime without a
# working node:sqlite would otherwise pass /health.
for _ in $(seq 1 10); do
  JOURNAL="$(find "$WORK/home" -name runs.sqlite -type f 2>/dev/null | head -n 1)"
  [ -n "$JOURNAL" ] && break
  sleep 0.5
done
[ -n "$JOURNAL" ] || fail "run journal (node:sqlite) was not created under the sidecar's HOME"
if grep -q 'recovery sweep failed' "$WORK/sidecar.log"; then
  fail "boot recovery sweep failed (journal/node:sqlite)"
fi
echo "  ok  node:sqlite run journal created (${JOURNAL#"$WORK/home/"})"

STATUS="$(http_status /api/opencode/status)"
[ "$STATUS" = "401" ] || fail "unauthenticated /api/opencode/status returned $STATUS (expected 401)"
echo "  ok  /api/opencode/status without a token -> 401"

STATUS="$(http_status /api/opencode/status -H 'Authorization: Bearer ol_pat_00000000000000000000000000000000')"
[ "$STATUS" = "503" ] || fail "/api/opencode/status with an unverifiable token returned $STATUS (expected 503)"
echo "  ok  /api/opencode/status with a token, cloud API down -> 503 $(cat "$WORK/body")"

kill -TERM "$SIDECAR_PID"
for _ in $(seq 1 20); do
  kill -0 "$SIDECAR_PID" 2>/dev/null || break
  sleep 0.5
done
if kill -0 "$SIDECAR_PID" 2>/dev/null; then
  fail "sidecar did not exit within 10 s of SIGTERM"
fi
SIDECAR_PID=""
echo "  ok  SIGTERM -> exited"

echo "==> Starting again with an explicit DATABASE_URL (must refuse to boot)"
start_sidecar DATABASE_URL="postgresql://u:p@127.0.0.1:1/db"
for _ in $(seq 1 30); do
  kill -0 "$SIDECAR_PID" 2>/dev/null || break
  sleep 0.5
done
if kill -0 "$SIDECAR_PID" 2>/dev/null; then
  fail "sidecar kept running with DATABASE_URL set"
fi
set +e
wait "$SIDECAR_PID"
CODE=$?
set -e
SIDECAR_PID=""
[ "$CODE" != "0" ] || fail "sidecar exited 0 with DATABASE_URL set (expected a refusal)"
echo "  ok  DATABASE_URL set -> refused (exit $CODE)"

echo "==> Sidecar binary smoke test passed"
