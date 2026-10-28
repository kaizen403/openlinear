# Runbook — Apply the Phase 0 hot-path indexes

File: `packages/db/prisma/manual/2026-09-09-phase0-hot-path-indexes.sql`

## Status (2026-10-26): do not apply as written

- **Measured, mostly ineffective.** On the 50,000-task local benchmark
  (`docs/reports/perf-baseline-2026-10-26/README.md`, "With the phase-0 manual
  indexes"; ledger `docs/reports/revamp-2026-10-26/perf.md` §6 item 4), **9 of
  the 10 indexes changed no query plan** across the 16 captured hot routes, and
  no route improved beyond noise. The only plan change: the usage queries'
  visibility join reads `tasks_teamId_archived_updatedAt_id_idx` as a covering
  index (fewer buffers, same execution time). `dashboard.projects` was ~23 %
  faster at p95, possibly from `(projectId, status, archived, updatedAt)`
  (not verified with EXPLAIN).
- **Why they miss:** the board orders by `createdAt`, not `updatedAt`; the
  inbox has no `teamId` predicate; the title/identifier trigram indexes cannot
  serve a search `OR` whose third arm (`description ILIKE`) is unindexed; the
  activity indexes lead with `teamId`/`userId` while the feed filters on project
  visibility and sorts on `createdAt`.
- **Table name corrected.** The trigram index on project names targeted a
  `projects` table that does not exist (`42P01`), so the file failed partway
  and left a partial set. Prisma maps `Project` to **`linear_projects`**; the
  file now creates `linear_projects_name_trgm_idx ON "linear_projects"`.
- **What to do instead:** re-measure and add only indexes EXPLAIN shows used.
  The measured Phase 1 candidates are `activity_logs("createdAt" DESC, id)`
  (feed page 70.7 → 0.11 ms, but the exact COUNT must also go) and a trigram GIN
  on `tasks.description` (selective search p95 95 → 3.8 ms). See `perf.md` §6.
  Ship them as normal migrations that build `CONCURRENTLY` with the
  `-- migration-safety: allow` marker, or out of band with this procedure.

The procedure below stays valid for any out-of-band `CONCURRENTLY` index.

## Why this is not a normal migration

`CREATE INDEX CONCURRENTLY` cannot run inside a transaction, and Prisma wraps
every migration in one. Shipping these through `prisma migrate deploy` would
take an `ACCESS EXCLUSIVE` lock on `tasks` for the whole build and stall the API.
CI **blocks** a migration containing `CREATE INDEX` without `CONCURRENTLY`
(`scripts/ci/migration-safety.sh`, run by the "Migration safety review" step in
`.github/workflows/dev.yml`; `deploy-azure.yml` has its own copy of the check),
so this has to be applied out of band on purpose.

## Procedure

1. Take a Neon branch/snapshot first.

2. Apply with a **direct** (non-pooled) connection string. `CONCURRENTLY`
   needs a real session; a pgBouncer-pooled connection in transaction mode will
   fail. On Neon that is the endpoint host **without** `-pooler`. The repository
   does not define a variable for this (there is no `DIRECT_DATABASE_URL`;
   Prisma reads only `DATABASE_URL`, see `packages/db/prisma.config.ts`), so put
   it in a shell variable for this session only:
   ```bash
   read -rs PSQL_DIRECT_URL   # paste the direct connection string; not echoed
   psql "$PSQL_DIRECT_URL" \
     -v ON_ERROR_STOP=1 \
     -f packages/db/prisma/manual/2026-09-09-phase0-hot-path-indexes.sql
   unset PSQL_DIRECT_URL
   ```
   Each statement is `IF NOT EXISTS`, so the file is re-runnable. A concurrent
   build that fails leaves an `INVALID` index behind — check and clean up:
   ```sql
   SELECT indexrelid::regclass AS index, indisvalid
   FROM pg_index WHERE NOT indisvalid;
   -- DROP INDEX CONCURRENTLY "<name>";  -- then re-run the file
   ```

3. Verify the planner actually uses each index, on production-like data, with
   the SQL the route really issues (capture it with `pnpm perf:explain`, see
   `docs/reports/revamp-2026-10-26/perf.md` §3). For example, the board page
   today orders by `createdAt`:
   ```sql
   EXPLAIN (ANALYZE, BUFFERS)
   SELECT * FROM tasks
   WHERE "projectId" = '<id>' AND archived = false
   ORDER BY "createdAt" DESC, id LIMIT 50;
   ```
   Drop (`DROP INDEX CONCURRENTLY`) any index no plan uses: each one costs
   writes on every task update.

4. Reconcile Prisma so `schema.prisma`, the migration history and the database
   agree. Add the matching `@@index` entries to
   `packages/db/prisma/schema.prisma`, generate a migration, and mark it already
   applied so Prisma does not try to rebuild the indexes:
   ```bash
   pnpm --filter @openlinear/db exec prisma migrate dev \
     --create-only --name phase0_hot_path_indexes
   # edit the generated SQL to add CONCURRENTLY and the marker comment:
   #   -- migration-safety: allow
   pnpm --filter @openlinear/db exec prisma migrate resolve \
     --applied <generated_migration_name>
   ```
   What the CI drift check does and does not see: it runs
   `prisma migrate diff --from-migrations ./prisma/migrations --to-schema ./prisma/schema.prisma`,
   i.e. migration history against `schema.prisma`. It never connects to a real
   database, so out-of-band indexes do **not** make it fail, before or after
   this step. It fails only if the `@@index` lines and the migration disagree
   (for example, `@@index` added without the migration). Skipping this step
   leaves the database ahead of Prisma: `prisma migrate dev` against a copy of
   that database reports drift, and a later schema change could drop or
   duplicate the indexes.

## What these were meant to fix, and what was measured

| Index | Intended query | Measured 2026-10-26 (50k tasks) |
|---|---|---|
| `tasks (projectId, archived, updatedAt DESC, id)` | board page, project-scoped | not used — the board orders by `createdAt` |
| `tasks (teamId, archived, updatedAt DESC, id)` | board page, team-scoped | used only as a covering index in the usage visibility join |
| `tasks (teamId, archived, status, inboxRead, updatedAt DESC)` | inbox list and unread count | not used — the inbox has no `teamId` predicate |
| `tasks (projectId, status, archived, updatedAt DESC)` | grouped board | no captured plan change (`dashboard.projects` −23 % p95, unverified) |
| `activity_logs (teamId, createdAt DESC)` / `(userId, createdAt DESC)` | activity feeds | not used — the feed filters on project visibility, sorts on `createdAt` |
| `pg_trgm` GIN on `tasks.title`, `tasks.identifier`, `linear_projects.name`, `teams.name` | search | not used for task search until `tasks.description` is indexed too (the `OR` has an unindexed arm) |

Targets from the performance plan: board first page p95 < 250 ms at 50k tasks
per workspace; search p95 < 300 ms; inbox count p95 < 150 ms. The 2026-10-26
baseline, without these indexes, already meets them locally (board p95 ≤ 60 ms,
search ≤ 97 ms, inbox count ≈ 20 ms); the slowest route is the activity feed
(p95 ≈ 185 ms, dominated by its exact COUNT).
