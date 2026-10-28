-- W14 task list and search indexes (apicontract).
-- See docs/reports/revamp-2026-10-26/apicontract.md §2 for the EXPLAIN evidence
-- (seed: docs/reports/revamp-2026-10-26/apicontract-seed.sql).
--
-- Expand-only: one extension and six indexes. No table, column or constraint
-- changes.
--
-- migration-safety: allow plain CREATE INDEX (not CONCURRENTLY): Prisma's
-- shadow-database replay (`migrate diff --from-migrations`, the CI drift check)
-- runs each migration inside a transaction, where CONCURRENTLY is illegal.
-- For a large production database, pre-build the same indexes out of band
-- with packages/db/prisma/manual/2026-10-26-task-list-indexes-concurrently.sql
-- (no write lock); this migration then no-ops via IF NOT EXISTS.
--
--   tasks (archived, createdAt, id)   GET /api/tasks without a project filter
--                                     (keyset order createdAt DESC, id DESC):
--                                     backward index scan instead of sorting
--                                     every visible task.
--   tasks (parentId)                  `parentId` filter and the self-FK
--                                     ON DELETE SET NULL (was a seq scan).
--   task_labels (labelId)             `labelId` filter and the label FK
--                                     ON DELETE CASCADE (was a seq scan).
--   tasks title/description/identifier gin_trgm_ops
--                                     `q` on GET /api/tasks and GET /api/search
--                                     (ILIKE '%term%'): bitmap index scans
--                                     instead of a seq scan of all tasks.
--
-- pg_trgm is a trusted extension (PostgreSQL 13+): the database owner can
-- create it; Neon allows it. Prisma does not manage extensions here (no
-- `postgresqlExtensions` preview feature), so it is created only in SQL.
--

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "tasks_archived_createdAt_id_idx" ON "tasks"("archived", "createdAt", "id");

CREATE INDEX IF NOT EXISTS "tasks_parentId_idx" ON "tasks"("parentId");

CREATE INDEX IF NOT EXISTS "task_labels_labelId_idx" ON "task_labels"("labelId");

CREATE INDEX IF NOT EXISTS "tasks_title_trgm_idx" ON "tasks" USING GIN ("title" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "tasks_description_trgm_idx" ON "tasks" USING GIN ("description" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "tasks_identifier_trgm_idx" ON "tasks" USING GIN ("identifier" gin_trgm_ops);
