-- P95 Phase 1 (perf1) — out-of-band build of the activity feed index.
--
-- Same index as migration 20261026100000_activity_feed_keyset_index, built
-- CONCURRENTLY so a large "activity_logs" table keeps accepting writes while
-- it builds. Run this BEFORE `prisma migrate deploy`; the migration then finds
-- the index (CREATE INDEX IF NOT EXISTS) and does nothing.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/prisma/manual/2026-10-26-phase1-activity-feed-index.sql
--
-- CONCURRENTLY cannot run inside a transaction: do not wrap this file in
-- BEGIN/COMMIT and do not pass it through a tool that does (psql -1, Prisma).
-- If the build fails or is cancelled it leaves an INVALID index behind; drop it
-- (`DROP INDEX CONCURRENTLY "activity_logs_createdAt_id_idx";`) and re-run.
-- Procedure and verification: docs/runbooks/phase1-perf-indexes.md.
--
-- Measured on the 50k-task bench (336,648 rows, local PG 14): see
-- docs/reports/revamp-2026-10-26/perf1.md §2.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "activity_logs_createdAt_id_idx"
  ON "activity_logs" ("createdAt" DESC, "id" DESC);

ANALYZE "activity_logs";
