#!/usr/bin/env bash
# Boots the API image twice — API (`node dist/index.js`) and worker
# (`node dist/worker.js`) — against a migrated database and checks:
#   - /livez 200, /readyz 200 with migrations "ok", an unauthenticated call 401;
#   - the worker logs "[worker] started" and keeps running;
#   - both exit 0 on SIGTERM.
# Never pushes anything. Secrets are random throwaways generated here.
#
# Usage: scripts/ci/smoke-api-image.sh <image> <database-url>
#   DATABASE_URL must be reachable from inside the container. CI uses host
#   networking (default). Elsewhere: SMOKE_NETWORK=bridge publishes the port on
#   127.0.0.1 and the URL should use host.docker.internal.
#   SMOKE_PORT (default 3901) is the API port inside and outside the container.
set -euo pipefail

IMAGE="${1:?usage: $0 <image> <database-url>}"
DB_URL="${2:?usage: $0 <image> <database-url>}"
PORT="${SMOKE_PORT:-3901}"
NETWORK="${SMOKE_NETWORK:-host}"
SUFFIX="$$"
API="ol-api-smoke-${SUFFIX}"
WORKER="ol-worker-smoke-${SUFFIX}"

if [ "$NETWORK" = "host" ]; then
  API_NET_ARGS=(--network host)
  WORKER_NET_ARGS=(--network host)
else
  API_NET_ARGS=(--network "$NETWORK" -p "127.0.0.1:${PORT}:${PORT}")
  WORKER_NET_ARGS=(--network "$NETWORK")
fi

ENV_FILE="$(mktemp)"
cleanup() {
  docker rm -f "$API" "$WORKER" >/dev/null 2>&1 || true
  rm -f "$ENV_FILE"
}
trap cleanup EXIT

{
  echo "DATABASE_URL=${DB_URL}"
  echo "JWT_SECRET=$(openssl rand -hex 32)"
  echo "TOKEN_ENCRYPTION_KEY=$(openssl rand -hex 32)"
  echo "API_PORT=${PORT}"
  echo "CORS_ORIGIN=http://localhost:${PORT}"
} >"$ENV_FILE"

fail() {
  echo "::error::$*"
  echo "--- API logs ---"; docker logs "$API" 2>&1 | tail -n 60 || true
  echo "--- worker logs ---"; docker logs "$WORKER" 2>&1 | tail -n 60 || true
  exit 1
}

docker run -d --name "$API" "${API_NET_ARGS[@]}" --env-file "$ENV_FILE" "$IMAGE" >/dev/null
docker run -d --name "$WORKER" "${WORKER_NET_ARGS[@]}" --no-healthcheck --env-file "$ENV_FILE" \
  "$IMAGE" node dist/worker.js >/dev/null

BASE="http://127.0.0.1:${PORT}"
for _ in $(seq 1 30); do
  if curl -fsS "${BASE}/livez" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "${BASE}/livez" >/dev/null || fail "/livez did not answer within 30 s"

READY="$(curl -sS -w '\n%{http_code}' "${BASE}/readyz")"
READY_CODE="$(tail -n 1 <<<"$READY")"
READY_BODY="$(sed '$d' <<<"$READY")"
echo "/readyz -> ${READY_CODE} ${READY_BODY}"
[ "$READY_CODE" = "200" ] || fail "/readyz returned ${READY_CODE}"
grep -q '"migrations":"ok"' <<<"$READY_BODY" || fail "/readyz did not confirm migrations"

UNAUTH="$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/users/me")"
[ "$UNAUTH" = "401" ] || fail "unauthenticated /api/users/me returned ${UNAUTH}, expected 401"

for _ in $(seq 1 30); do
  if docker logs "$WORKER" 2>&1 | grep -q '\[worker\] started'; then break; fi
  sleep 1
done
docker logs "$WORKER" 2>&1 | grep -q '\[worker\] started' || fail "worker did not start within 30 s"
sleep 3
[ "$(docker inspect -f '{{.State.Running}}' "$WORKER")" = "true" ] || fail "worker exited after starting"
docker logs "$WORKER" 2>&1 | grep '\[worker\] started'

docker stop -t 30 "$API" "$WORKER" >/dev/null
API_EXIT="$(docker inspect -f '{{.State.ExitCode}}' "$API")"
WORKER_EXIT="$(docker inspect -f '{{.State.ExitCode}}' "$WORKER")"
[ "$API_EXIT" = "0" ] || fail "API exited ${API_EXIT} on SIGTERM"
[ "$WORKER_EXIT" = "0" ] || fail "worker exited ${WORKER_EXIT} on SIGTERM"

echo "Image smoke test passed: API ready (migrations ok), worker running, clean shutdown."
