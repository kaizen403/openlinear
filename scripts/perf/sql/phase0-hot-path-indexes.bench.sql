-- Bench-only copy of packages/db/prisma/manual/2026-09-09-phase0-hot-path-indexes.sql
-- with one correction, used by docs/reports/perf-baseline-2026-10-26 to measure
-- "with vs without" on the perf database. NOT a migration; never run it against
-- a shared or production database from here.
--
-- Correction: the manual file indexes "projects", but Prisma maps `Project` to
-- "linear_projects" (schema.prisma @@map). Run as-is, the manual file stops with
-- `relation "projects" does not exist` after creating the first nine objects.
--
-- psql runs each statement in autocommit, so CONCURRENTLY is allowed.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "tasks_projectId_archived_updatedAt_id_idx"
  ON "tasks" ("projectId", "archived", "updatedAt" DESC, "id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tasks_teamId_archived_updatedAt_id_idx"
  ON "tasks" ("teamId", "archived", "updatedAt" DESC, "id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tasks_teamId_archived_status_inboxRead_updatedAt_idx"
  ON "tasks" ("teamId", "archived", "status", "inboxRead", "updatedAt" DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tasks_projectId_status_archived_updatedAt_idx"
  ON "tasks" ("projectId", "status", "archived", "updatedAt" DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "activity_logs_teamId_createdAt_idx"
  ON "activity_logs" ("teamId", "createdAt" DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "activity_logs_userId_createdAt_idx"
  ON "activity_logs" ("userId", "createdAt" DESC);
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tasks_title_trgm_idx"
  ON "tasks" USING gin ("title" gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tasks_identifier_trgm_idx"
  ON "tasks" USING gin ("identifier" gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "projects_name_trgm_idx"
  ON "linear_projects" USING gin ("name" gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "teams_name_trgm_idx"
  ON "teams" USING gin ("name" gin_trgm_ops);
ANALYZE "tasks";
ANALYZE "activity_logs";
ANALYZE "linear_projects";
ANALYZE "teams";
