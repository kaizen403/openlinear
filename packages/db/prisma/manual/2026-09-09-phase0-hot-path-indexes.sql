-- Phase 0 — hot-path indexes
--
-- Apply OUT OF BAND, not through `prisma migrate deploy`.
-- `CREATE INDEX CONCURRENTLY` cannot run inside a transaction, and Prisma wraps
-- every migration in one. Running these as a normal migration would take an
-- ACCESS EXCLUSIVE lock on `tasks` for the duration of the build and stall the
-- API. See docs/runbooks/apply-hot-path-indexes.md for the procedure.
--
-- Every index below is additive: no column is dropped or rewritten, so this file
-- is safe to run against a live database and safe to re-run (IF NOT EXISTS).
--
-- Query shapes these serve (from apps/api/src/services/tasks.ts and
-- routes/inbox.ts): board pages filter by project or team plus `archived`, then
-- order by `updatedAt DESC, id`; the inbox additionally filters on `status` and
-- `inboxRead`. The existing indexes stop at `archived` or order by `createdAt`,
-- so the ORDER BY currently falls back to a sort.

-- Board: project-scoped page, newest first.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tasks_projectId_archived_updatedAt_id_idx"
  ON "tasks" ("projectId", "archived", "updatedAt" DESC, "id");

-- Board: team-scoped page, newest first.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tasks_teamId_archived_updatedAt_id_idx"
  ON "tasks" ("teamId", "archived", "updatedAt" DESC, "id");

-- Inbox: unread, non-archived, by team, newest first.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tasks_teamId_archived_status_inboxRead_updatedAt_idx"
  ON "tasks" ("teamId", "archived", "status", "inboxRead", "updatedAt" DESC);

-- Board grouped by status within a project.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tasks_projectId_status_archived_updatedAt_idx"
  ON "tasks" ("projectId", "status", "archived", "updatedAt" DESC);

-- Activity feed: per-team and per-user, newest first. Only (taskId, createdAt)
-- and (projectId, createdAt) exist today, so team and user feeds sort.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "activity_logs_teamId_createdAt_idx"
  ON "activity_logs" ("teamId", "createdAt" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "activity_logs_userId_createdAt_idx"
  ON "activity_logs" ("userId", "createdAt" DESC);

-- Session lookup by token hash is on the authenticated request path.
-- (`tokenHash` is already UNIQUE, which serves this; listed for completeness.)

-- Trigram search. `apps/api/src/services/search.ts` and `listTasks` use
-- `contains` with `mode: 'insensitive'`, which compiles to `ILIKE '%q%'` and
-- cannot use a btree index — every workspace search is a sequential scan.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "tasks_title_trgm_idx"
  ON "tasks" USING gin ("title" gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "tasks_identifier_trgm_idx"
  ON "tasks" USING gin ("identifier" gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "projects_name_trgm_idx"
  ON "projects" USING gin ("name" gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "teams_name_trgm_idx"
  ON "teams" USING gin ("name" gin_trgm_ops);
