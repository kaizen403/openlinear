-- Task list / search indexes — out-of-band, no-write-lock variant (2026-10-26).
--
-- Run this BEFORE `prisma migrate deploy` on a production database whose
-- "tasks"/"task_labels" tables are large. It builds the same indexes as
-- migrations/20261026090000_task_list_indexes CONCURRENTLY (no write lock);
-- that migration then no-ops via IF NOT EXISTS. Run statement by statement
-- outside a transaction (psql autocommit). If a CONCURRENTLY build fails it
-- leaves an INVALID index: DROP INDEX CONCURRENTLY it and re-run.
-- Evidence: docs/reports/revamp-2026-10-26/apicontract.md §2.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "tasks_archived_createdAt_id_idx" ON "tasks"("archived", "createdAt", "id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "tasks_parentId_idx" ON "tasks"("parentId");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "task_labels_labelId_idx" ON "task_labels"("labelId");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "tasks_title_trgm_idx" ON "tasks" USING GIN ("title" gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "tasks_description_trgm_idx" ON "tasks" USING GIN ("description" gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "tasks_identifier_trgm_idx" ON "tasks" USING GIN ("identifier" gin_trgm_ops);
