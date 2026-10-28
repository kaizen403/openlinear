-- Bench-only probe of two Phase 1 candidates that the phase-0 manual file does
-- not contain. Applied on top of phase0-hot-path-indexes.bench.sql to check the
-- expected plan change with EXPLAIN; not a migration and not a recommendation
-- that has been reviewed. Perf database only.
--
-- 1. The scoped activity feed orders all visible activity by "createdAt" DESC.
--    Only (taskId, createdAt) and (projectId, createdAt) exist, and the visibility
--    predicate is an OR across project/team/self, so neither the existing nor the
--    manual (teamId|userId, createdAt) indexes can serve it.
-- 2. Search ORs ILIKE over title, identifier AND description. A BitmapOr needs
--    every arm indexed; the manual file has no description trigram index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "activity_logs_createdAt_id_idx"
  ON "activity_logs" ("createdAt" DESC, "id");
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tasks_description_trgm_idx"
  ON "tasks" USING gin ("description" gin_trgm_ops);
ANALYZE "tasks";
ANALYZE "activity_logs";
