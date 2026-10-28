# Runbook — P95 Phase 1 (perf1) activity feed index

Migration: `packages/db/prisma/migrations/20261026100000_activity_feed_keyset_index`
Out-of-band file: `packages/db/prisma/manual/2026-10-26-phase1-activity-feed-index.sql`
Evidence: `docs/reports/revamp-2026-10-26/perf1.md` §2.

## What it is

One additive btree index, `activity_logs ("createdAt" DESC, "id" DESC)`, for
`GET /api/activity` (newest-first feed with a keyset cursor). Without it every
feed request scans and sorts all of `activity_logs`.

## Why the migration is safe to ship, and when to pre-build

The migration says `CREATE INDEX IF NOT EXISTS` without `CONCURRENTLY`,
because Prisma runs every migration in a transaction and `CONCURRENTLY` cannot
run in one. A plain build blocks writes to `activity_logs` (activity logging is
best-effort and never fails a request, but those writes queue) for as long as
the build takes:

| `activity_logs` rows | plain build (local PG 14, M5 Pro) |
|---:|---:|
| 336,648 (50k-task bench) | 0.59 s (CONCURRENTLY: 0.54 s) |

Rule of thumb: below ~1M rows, `prisma migrate deploy` is fine. Above that, or
on a busy database, pre-build it out of band first; the migration then finds
the index and does nothing.

## Procedure (large tables)

1. Check the table size: `SELECT reltuples::bigint FROM pg_class WHERE relname = 'activity_logs';`
2. Build concurrently with a **direct** (non-pooled) connection (`CONCURRENTLY`
   needs a real session; transaction-mode pgBouncer fails), **before** deploying:
   ```bash
   psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 \
     -f packages/db/prisma/manual/2026-10-26-phase1-activity-feed-index.sql
   ```
   Do not use `psql -1`/`--single-transaction`.
3. Verify it is valid (a failed concurrent build leaves an INVALID index):
   ```sql
   SELECT indexrelid::regclass, indisvalid FROM pg_index
    WHERE indexrelid = '"activity_logs_createdAt_id_idx"'::regclass;
   -- if indisvalid = false:
   -- DROP INDEX CONCURRENTLY "activity_logs_createdAt_id_idx"; then re-run step 2
   ```
4. Deploy as usual (`prisma migrate deploy`): the migration is recorded as
   applied and its `CREATE INDEX IF NOT EXISTS` is a no-op. No
   `migrate resolve` step and no schema drift: `schema.prisma` already declares
   `@@index([createdAt(sort: Desc), id(sort: Desc)])`.
5. Check the plan on production-like data (expect `Index Scan using
   "activity_logs_createdAt_id_idx"` and no `Sort`):
   ```sql
   EXPLAIN (ANALYZE, BUFFERS)
   SELECT id FROM activity_logs ORDER BY "createdAt" DESC, id DESC LIMIT 51;
   ```

## Rollback

`DROP INDEX CONCURRENTLY "activity_logs_createdAt_id_idx";` restores the old
plans (the feed is correct without the index, only slow). Re-create with the
manual file. Do not delete the migration row.
