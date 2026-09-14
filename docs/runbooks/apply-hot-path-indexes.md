# Runbook — Apply the Phase 0 hot-path indexes

File: `packages/db/prisma/manual/2026-09-09-phase0-hot-path-indexes.sql`

## Why this is not a normal migration

`CREATE INDEX CONCURRENTLY` cannot run inside a transaction, and Prisma wraps
every migration in one. Shipping these through `prisma migrate deploy` would
take an `ACCESS EXCLUSIVE` lock on `tasks` for the whole build and stall the API.
CI now **blocks** a migration containing `CREATE INDEX` without `CONCURRENTLY`
(see the "Migration safety review" step in `.github/workflows/deploy-azure.yml`),
so this has to be applied out of band on purpose.

## Procedure

1. Take a Neon branch/snapshot first.

2. Apply with the **direct** (non-pooled) connection string. `CONCURRENTLY`
   needs a real session; a pgBouncer-pooled connection in transaction mode will
   fail:
   ```bash
   psql "$DIRECT_DATABASE_URL" \
     -v ON_ERROR_STOP=1 \
     -f packages/db/prisma/manual/2026-09-09-phase0-hot-path-indexes.sql
   ```
   Each statement is `IF NOT EXISTS`, so the file is re-runnable. A concurrent
   build that fails leaves an `INVALID` index behind — check and clean up:
   ```sql
   SELECT indexrelid::regclass AS index, indisvalid
   FROM pg_index WHERE NOT indisvalid;
   -- DROP INDEX CONCURRENTLY "<name>";  -- then re-run the file
   ```

3. Verify the planner actually uses them, on production-like data:
   ```sql
   EXPLAIN ANALYZE
   SELECT * FROM tasks
   WHERE "projectId" = '<id>' AND archived = false
   ORDER BY "updatedAt" DESC, id LIMIT 50;
   ```
   Expect an index scan, not `Seq Scan` + `Sort`.

4. Reconcile Prisma so the schema and the database agree. Add the matching
   `@@index` entries to `packages/db/prisma/schema.prisma`, generate a migration,
   and mark it already applied so Prisma does not try to rebuild the indexes:
   ```bash
   pnpm --filter @openlinear/db exec prisma migrate dev \
     --create-only --name phase0_hot_path_indexes
   # edit the generated SQL to add CONCURRENTLY and the marker comment:
   #   -- migration-safety: allow
   pnpm --filter @openlinear/db exec prisma migrate resolve \
     --applied <generated_migration_name>
   ```
   Until step 4 is done, `prisma migrate diff --exit-code` in CI will report
   drift — so do steps 1–4 in the same change window.

## What these fix

| Index | Query | Today |
|---|---|---|
| `tasks (projectId, archived, updatedAt DESC, id)` | board page, project-scoped | existing index stops at `archived`, so the `ORDER BY` sorts |
| `tasks (teamId, archived, updatedAt DESC, id)` | board page, team-scoped | same |
| `tasks (teamId, archived, status, inboxRead, updatedAt DESC)` | inbox list and unread count | no covering index |
| `tasks (projectId, status, archived, updatedAt DESC)` | grouped board | no covering index |
| `activity_logs (teamId, createdAt DESC)` / `(userId, createdAt DESC)` | activity feeds | only `(taskId, …)` and `(projectId, …)` exist |
| `pg_trgm` GIN on `tasks.title`, `tasks.identifier`, `projects.name`, `teams.name` | search | `ILIKE '%q%'` cannot use btree — every search is a sequential scan |

Targets from the performance plan: board first page p95 < 250 ms at 50k tasks
per workspace; search p95 < 300 ms; inbox count p95 < 150 ms.
