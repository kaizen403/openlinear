#!/usr/bin/env bash
set -euo pipefail

LOG_DIR=/var/log/openlinear
mkdir -p "$LOG_DIR"
chmod 777 "$LOG_DIR"
chown -R postgres:postgres "$PGDATA" 2>/dev/null || true

echo "[entrypoint] OpenLinear preview container booting..."

/usr/local/bin/openlinear-init-db

PG_VERSION="$(ls /etc/postgresql 2>/dev/null | head -1)"
PG_BIN="/usr/lib/postgresql/${PG_VERSION}/bin"

echo "[entrypoint] Starting Postgres in background..."
su postgres -c "$PG_BIN/postgres -D $PGDATA -c logging_collector=off -c listen_addresses=127.0.0.1" \
  > "$LOG_DIR/postgres.log" 2>&1 &
PG_PID=$!
echo "[entrypoint] Postgres PID=$PG_PID"

echo "[entrypoint] Waiting for Postgres to accept connections..."
for i in $(seq 1 60); do
  if su postgres -c "pg_isready -h 127.0.0.1 -p 5432" > /dev/null 2>&1; then
    echo "[entrypoint] Postgres ready."
    break
  fi
  sleep 1
done

cd /app

echo "[entrypoint] Pushing Prisma schema..."
pnpm --filter @openlinear/db db:push --accept-data-loss > "$LOG_DIR/db-push.log" 2>&1 || {
  echo "[entrypoint] WARNING: db push failed; check $LOG_DIR/db-push.log"
  tail -40 "$LOG_DIR/db-push.log" || true
}

declare -a CHILD_PIDS=()

start_service() {
  local name="$1"; shift
  echo "[entrypoint] Starting $name..."
  ( "$@" ) > "$LOG_DIR/${name}.log" 2>&1 &
  local pid=$!
  CHILD_PIDS+=("$pid")
  echo "[entrypoint] $name PID=$pid (logs: $LOG_DIR/${name}.log)"
}

shutdown() {
  echo ""
  echo "[entrypoint] Shutdown requested. Stopping services..."
  for pid in "${CHILD_PIDS[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 2
  for pid in "${CHILD_PIDS[@]}"; do
    kill -KILL "$pid" 2>/dev/null || true
  done
  echo "[entrypoint] Stopping Postgres..."
  su postgres -c "$PG_BIN/pg_ctl -D $PGDATA -m fast -w stop" || true
  exit 0
}
trap shutdown SIGTERM SIGINT

start_service api          node /app/apps/api/dist/index.js
start_service desktop-ui   pnpm --filter @openlinear/desktop-ui exec next start -p 3000
start_service landing      pnpm --filter @openlinear/landing exec next start -p 3002

echo ""
echo "================================================================"
echo " OpenLinear preview is live"
echo "   Web (kanban):     http://localhost:3000"
echo "   API:              http://localhost:3001/health"
echo "   Landing:          http://localhost:3002"
echo "   Postgres:         container-local only (127.0.0.1:5432)"
echo ""
echo " Tail logs:          docker exec openlinear tail -F /var/log/openlinear/*.log"
echo "================================================================"
echo ""

while true; do
  for pid in "${CHILD_PIDS[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "[entrypoint] Child PID $pid exited unexpectedly. Initiating shutdown."
      shutdown
    fi
  done
  if ! kill -0 "$PG_PID" 2>/dev/null; then
    echo "[entrypoint] Postgres exited unexpectedly. Initiating shutdown."
    shutdown
  fi
  sleep 5
done
