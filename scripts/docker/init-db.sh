#!/usr/bin/env bash
set -euo pipefail

PG_VERSION="$(ls /etc/postgresql 2>/dev/null | head -1)"
PG_BIN="/usr/lib/postgresql/${PG_VERSION}/bin"

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "[init-db] Initializing PostgreSQL data directory at $PGDATA"
  mkdir -p "$PGDATA"
  chown -R postgres:postgres "$PGDATA"
  su postgres -c "$PG_BIN/initdb --auth-host=scram-sha-256 --auth-local=peer --encoding=UTF8 --locale=C -D $PGDATA"
fi

cat > "$PGDATA/pg_hba.conf" <<'EOF'
local all postgres peer
local all all peer
host openlinear openlinear 127.0.0.1/32 scram-sha-256
host all all 127.0.0.1/32 scram-sha-256
host all all ::1/128 scram-sha-256
EOF
chown postgres:postgres "$PGDATA/pg_hba.conf"

sed -i \
  -e "/^[[:space:]]*listen_addresses[[:space:]]*=/d" \
  -e "/^[[:space:]]*password_encryption[[:space:]]*=/d" \
  "$PGDATA/postgresql.conf"
{
  echo "listen_addresses = '127.0.0.1'"
  echo "password_encryption = 'scram-sha-256'"
} >> "$PGDATA/postgresql.conf"
chown postgres:postgres "$PGDATA/postgresql.conf"

echo "[init-db] Starting Postgres for one-shot bootstrap..."
su postgres -c "$PG_BIN/pg_ctl -D $PGDATA -l /tmp/postgres-init.log -w start"

if ! su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='openlinear'\"" | grep -q 1; then
  echo "[init-db] Creating role + database 'openlinear'"
  su postgres -c "psql -c \"CREATE USER openlinear WITH SUPERUSER PASSWORD 'openlinear';\""
else
  echo "[init-db] Ensuring role 'openlinear' has password auth"
  su postgres -c "psql -c \"ALTER USER openlinear WITH SUPERUSER PASSWORD 'openlinear';\""
fi

if ! su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='openlinear'\"" | grep -q 1; then
  echo "[init-db] Creating database 'openlinear'"
  su postgres -c "psql -c \"CREATE DATABASE openlinear OWNER openlinear;\""
fi

echo "[init-db] Stopping bootstrap Postgres..."
su postgres -c "$PG_BIN/pg_ctl -D $PGDATA -m fast -w stop"
