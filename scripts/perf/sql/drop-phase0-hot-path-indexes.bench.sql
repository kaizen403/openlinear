-- Restore the perf database to the Prisma schema's index set after a
-- "with phase-0 indexes" (and Phase 1 probe) measurement. Perf database only.
DROP INDEX CONCURRENTLY IF EXISTS "tasks_projectId_archived_updatedAt_id_idx";
DROP INDEX CONCURRENTLY IF EXISTS "tasks_teamId_archived_updatedAt_id_idx";
DROP INDEX CONCURRENTLY IF EXISTS "tasks_teamId_archived_status_inboxRead_updatedAt_idx";
DROP INDEX CONCURRENTLY IF EXISTS "tasks_projectId_status_archived_updatedAt_idx";
DROP INDEX CONCURRENTLY IF EXISTS "activity_logs_teamId_createdAt_idx";
DROP INDEX CONCURRENTLY IF EXISTS "activity_logs_userId_createdAt_idx";
DROP INDEX CONCURRENTLY IF EXISTS "tasks_title_trgm_idx";
DROP INDEX CONCURRENTLY IF EXISTS "tasks_identifier_trgm_idx";
DROP INDEX CONCURRENTLY IF EXISTS "projects_name_trgm_idx";
DROP INDEX CONCURRENTLY IF EXISTS "teams_name_trgm_idx";
-- Phase 1 probe (probe-phase1-candidates.bench.sql).
DROP INDEX CONCURRENTLY IF EXISTS "activity_logs_createdAt_id_idx";
DROP INDEX CONCURRENTLY IF EXISTS "tasks_description_trgm_idx";
ANALYZE "tasks";
ANALYZE "activity_logs";
