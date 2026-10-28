# perf1 — P95 Phase 1 on the read paths outside the API-contract slice

**Round:** 3 (2026-10-26) · **Engineer ID:** perf1 · **Status:** done for the local scope.
**Owner constraint:** local only. Nothing deployed; only loopback Postgres :54330 databases
`openlinear_perf1_test` (suite), `openlinear_perf1_bench_test` (50k fixture) and
`openlinear_perf1_shadow_test` (migrate diff) were touched. Base: `922dbd7` + `round3c-base.patch`.

Raw evidence: `docs/reports/perf-baseline-2026-10-26/phase1-perf1-*` (bench JSON/MD per run,
statement inventories, EXPLAIN before/after). Phase 0 ledger: `perf.md`.

## 1. Outcome (headline)

Medians of 4 "before" runs (base bundle, no new index) vs 3 "after" runs (final code), each run
3 rounds × 100 requests, alternated on the same 50k-task fixture (§3 for method, variance, controls):

| Route | p95 before → after | statements/request |
|---|---:|---:|
| `GET /api/activity` (scoped feed) | **300.9 → 2.1 ms** (−99 %) | 4 → 2 |
| `GET /api/activity` keyset page (`cursor`, 15 days back) | 202.2 → 2.5 ms | 4 → 2 |
| `GET /api/activity?projectId` | 5.9 → 2.0 ms | 9 → 3 |
| `GET /api/usage/summary` | 49.7 → 27.2 ms (−45 %) | 3 → 1 |
| `GET /api/usage/by-task` | 74.0 → 41.3 ms (−44 %) | 4 → 1 |
| `GET /api/dashboard/tasks` | 23.6 → 9.9 ms (−58 %) | 6 → 1 |
| `GET /api/inbox/count` / `GET /api/inbox` | 23.6 → 8.3 / 40.8 → 26.0 ms | 2 → 1 / 7 → 6 |
| `GET /api/notifications` (light user / owner / badge) | 25.9 → 8.9 / 38.8 → 11.4 / 24.6 → 8.0 ms | 5 → 3 |
| `GET /api/workspaces/:id/structure?view=summary` (new) vs default | 15.6 → 6.0 ms, **761 KB → 40 KB** | 9 → 6 |
| `GET /api/tasks/:id` / board page (authorization path) | 2.4 → 2.0 / 19.6 → 19.8 ms | 13 → 9 / 15 → 11 |
| `GET /api/workspaces` | 2.0 → 1.1 ms | 6 → 2 |

- Every project-scoped authorization check (`assertProjectAccess`, `assertTaskAccess` on project
  tasks, `policy.assertCan`) is now **one live statement instead of five or six**, with no caching, so
  revocation semantics are unchanged; the principal cache got bounded, indexed invalidation and a fix
  for an invalidation race (a pre-revocation snapshot could be cached after the invalidation).
- Telemetry histograms are fixed-size (no more unbounded sample arrays) with p50/p95/p99.
- Exact/equivalent results proven against the old code paths on a multi-tenant fixture (21 new tests);
  API suite **636 passed + 2 skipped** (base 615 + 2; 21 new), typecheck 10/10, lint clean.

## 2. Changes, each with its evidence

### 2.1 Activity feed (`GET /api/activity`) — index, keyset pagination, no exact count

- **Index** `activity_logs ("createdAt" DESC, "id" DESC)` — migration
  `20261026100000_activity_feed_keyset_index` (`CREATE INDEX IF NOT EXISTS`, `migration-safety: allow`
  with reason), `schema.prisma` `@@index([createdAt(sort: Desc), id(sort: Desc)])`, out-of-band
  `packages/db/prisma/manual/2026-10-26-phase1-activity-feed-index.sql` (CONCURRENTLY) and
  `docs/runbooks/phase1-perf-indexes.md`. Build on the bench (336,648 rows): plain 588 ms,
  CONCURRENTLY 543 ms, 22 MB. `prisma migrate diff --from-migrations … --to-schema … --exit-code`:
  no difference; on a DB where the manual file ran first, `migrate deploy` records the migration and
  the `IF NOT EXISTS` is a no-op (done on the bench DB).
- **Service** `apps/api/src/services/activity-feed.ts` (new): order `(createdAt DESC, id DESC)`;
  `take: pageSize + 1` → exact `hasMore`; opaque `nextCursor` (base64url `createdAt|id`); cursor pages
  seek with an index condition `createdAt <= c` plus a tie-break filter; exact `COUNT(*)` only with
  `count=exact`.
- **Route** `routes/activity-log.ts`: new optional `cursor` (validated, 400 `VALIDATION_ERROR` when
  malformed) and `count=none|exact`; authorization untouched (same `assert*` filters, same
  `scopedActivityWhere`).
- **Compatibility:** envelope keeps `items, total, page, pageSize, hasMore` and adds `nextCursor`,
  `totalExact`. `page`/`pageSize` still page by OFFSET. `total` is exact only with `count=exact`;
  otherwise it is `offset + items.length` (a lower bound) and `totalExact: false`. No in-repo client
  reads `/api/activity` (desktop-ui, MCP, api-client checked).
- **Evidence:** EXPLAIN feed page: `Parallel Seq Scan` 336k rows + `external merge` sort 26–31 MB per
  worker + exact count (plan execution 292.9 ms in total) → `Index Scan using
  activity_logs_createdAt_id_idx`, no sort, 0.11–0.18 ms; statements 4 → 2 (no COUNT, no transaction).
  Bench: see §3 (`activity.feed`, `activity.feed.cursor`, `activity.project`, `activity.feed.deep-offset`).
- **Known trade-off:** a deep OFFSET page now walks the index and filters row by row, so its cost grows
  with the offset (page 200: p95 408 → 286 ms, still faster than the old full sort, but nowhere near
  the 2.5 ms of a keyset page at the same depth). Clients that page deep should use `nextCursor`.

### 2.2 Usage summary / by-task — aggregated in SQL

- `apps/api/src/services/usage.ts` (new), `routes/usage.ts` now thin.
  - **summary:** one statement, `GROUP BY ROLLUP (date_trunc('day', startedAt))` → 30 UTC daily
    buckets + the grand total; was an `aggregate` plus a `findMany` that shipped ~11k rows to Node.
  - **by-task:** one statement: grouped page + `COUNT(*) OVER ()` for the number of tasks, titles
    joined for the page only; was `groupBy` page + a second full `groupBy` only to count groups + a
    `tasks` lookup. Past the last page a `COUNT(DISTINCT taskId)` fallback keeps `total` correct.
- **Scope unchanged:** own runs OR runs on the caller's teams' tasks, AND the task visible now. Team
  ids now come from the request principal (`ctx.teams`) — the same snapshot the visibility filter
  already used — instead of a second live `team_members` read.
- **Unknown cost stays unknown:** `costUsd` sums known costs only; `unknownCostRuns` per day, per task
  and in `costCoverage` exactly as before; `cost` sort keeps Postgres' `DESC` order (NULL first, as
  Prisma generated) and adds a `taskId` tiebreaker for stable pages.
- **Time zones:** `startedAt` is `timestamp(3)` in UTC; the bound is bound as a UTC literal and the day
  read with `to_char`, so a non-UTC session TimeZone (the local cluster runs `Asia/Kolkata`) changes
  nothing — the equivalence test runs in that zone.
- **Evidence:** statements 3 → 1 and 4 → 1; EXPLAIN ANALYZE (sum of plan execution, single shot,
  load-sensitive): summary 66.8 → 22.1–34.7 ms (no 11k-row sort, one pass), by-task 59.8 → 45–46 ms
  (one pass; the GROUP BY sort now fits in memory: titles are joined after paging, the first version
  that carried them spilled 3.3 MB to disk). Bench: §3.

### 2.3 SQL visibility for aggregates (`services/scoped-sql.ts`, new) + dashboard / inbox / notifications counters

- `taskVisibleSql(ctx, alias)` is the raw-SQL mirror of `scopedTaskWhere(ctx, {}, 'view')`. Visible
  project ids are one uncorrelated subquery (index-driven `UNION ALL` arms: workspace membership,
  explicit view/full grant on a workspace-less project, legacy team; minus denies; PAT workspace
  binding) probed as a hashed set; team-only and orphan branches as before. No id list is bound from
  the app (the F-060 concern). A first version with a correlated `EXISTS` per task row was 2–3× slower
  (by-task plan 146 ms) and was replaced.
- `services/task-aggregates.ts` (new): `dashboardTaskStats` (one `COUNT(*) FILTER (…)` statement
  instead of six scans), `inboxCounts` (one instead of two), `notificationCounts` (total + unread in one
  instead of two). Routes: `dashboard.ts` (`/tasks`), `inbox.ts` (`/count`; `/` uses the same count
  concurrently with the page instead of a sequential READ COMMITTED transaction that gave no shared
  snapshot), `notifications.ts` (`GET /` page and counts concurrently, no transaction).
- Dashboard keeps its "degrade to zeros" behaviour on a failed read (now logged).
- Notification counts join `tasks` instead of `EXISTS`: Postgres turned the `EXISTS` into a hashed
  set of all 44,885 visible tasks even for a user with 300 notifications (28 ms; the intermediate bench
  run showed light-user p50 5.8 → 15 ms, `phase1-perf1-comparison-intermediate.md`); the join probes
  `tasks` by primary key: 3.3 ms (light user), 13.8 ms (owner, 4,000 notifications; `EXISTS` 22.8 ms).
- **Evidence:** EXPLAIN dashboard 89.4 → 13.2 ms (6 → 1 statements), inbox.count 31.6 → 6.1 ms
  (2 → 1), notifications page 31.9 → 20.5 ms plan time (5 → 3 statements, page and counts now
  concurrent); bench §3.

### 2.4 Authorization statements per request

What the inventory showed (`scripts/perf/statements.ts`, new): with the principal cached, the repeated
authorization work was not the principal itself but `resolveProjectAccess` (every
`assertProjectAccess`/`assertTaskAccess` on a project task), whose nested Prisma select ran as **five**
statements (project, grant, workspace, membership, teams) plus a sixth `team_members` read
(`getUserTeamIds`) on the legacy path; plus duplicate reads in a few routes.

- `services/workspaces.ts` `resolveProjectAccess`: one raw statement with scalar subqueries; still
  **live** on every call (no cache), so a revoked membership or a new deny applies to the next request
  on every replica. The legacy-team check keeps `getUserTeamIds`' PAT workspace binding.
  `teamIds` are now ordered (`createdAt, id`); before they were in heap order.
- Usage routes: no separate `getUserTeamIds` (principal teams, see 2.2).
- `GET /api/workspaces`: lists memberships first and only ensures the default workspace when the list
  is empty (same outcome; the route and the service both ensured before → 2 extra statements).
- **Principal cache (tenancy/context.ts, caching only, semantics kept):** bounded (10,000 entries,
  `OPENLINEAR_TENANCY_CACHE_MAX`; expired first, then oldest), expired entries dropped on read,
  invalidation through a per-user key index (was a scan + split of every key), and **a principal whose
  reads overlapped an invalidation of its user is returned but not cached** — before, a snapshot read
  just before a revoking commit could be cached after `invalidateTenancyCache` and served for the rest of
  the 30 s TTL. `OPENLINEAR_TENANCY_CACHE=1` forces the cache on (tests).
- **Decision — no cross-request cache for single-resource checks.** They now cost one statement; caching
  them would make revocation depend on every write path invalidating (project moves/deletes, team
  re-parenting are not membership events) and on relay lag across replicas. Not safe for the gain.
- **Statements per request** (warm second call, bench owner; `phase1-perf1-statements-*.json`):

  | Route (warm call) | principal cached (prod) | principal cache miss | response bytes |
  |---|---:|---:|---:|
  | activity feed | 4 → 2 | 7 → 5 | see note |
  | activity `?projectId` | 9 → 3 | 12 → 6 | see note |
  | activity `?taskId` | 10 → 4 | 13 → 7 | see note |
  | usage summary | 3 → 1 | 6 → 4 | 2,529 = |
  | usage by-task | 4 → 1 | 7 → 4 | 9,257 = |
  | dashboard tasks | 6 → 1 | 9 → 4 | 191 = |
  | dashboard projects (untouched control) | 4 → 4 | 7 → 7 | 4,458 = |
  | inbox list | 7 → 6 | 10 → 9 | 127,262 = |
  | inbox count | 2 → 1 | 5 → 4 | 29 = |
  | notifications page | 5 → 3 | 8 → 6 | 47,267 = |
  | workspaces list | 6 → 2 | 9 → 5 | 654 = |
  | workspace structure (default) | 9 → 9 | 12 → 12 | 760,912 = |
  | workspace structure `?view=summary` | — → 6 | — → 9 | 39,646 |
  | task GET (JWT / PAT) | 13 → 9 / 14 → 10 | 16 → 12 / 17 → 13 | = |
  | task comments | 9 → 5 | 12 → 8 | 4,111 = |
  | board page (JWT / PAT) | 15 → 11 / 16 → 12 | 18 → 14 / 19 → 15 | = |

  Note: activity response sizes differ only because `perf:explain` (run between the inventories)
  writes activity rows through its PATCH/bulk targets, and the feed shows the newest rows; the envelope
  adds `nextCursor` + `totalExact` (~120 B). `task GET` 1,387 → 1,384 B is the same task after the
  explain PATCH changed its priority.

  Under NODE_ENV=test (principal resolved every request) the suite pins the budgets in
  `perf1-read-paths.test.ts`: activity 8 → 6, activity?projectId 13 → 7, usage summary 7 → 5,
  by-task 8 → 5, dashboard 10 → 5, inbox count 6 → 5, notifications 9 → 7, workspaces 10 → 6,
  task GET 17 → 13 (before = inventory without cache + the test's session lookup).
- **Revocation tests with the cache forced on** (`perf1-tenancy-cache.test.ts`): workspace member
  removal, a new deny, a grant and `DELETE …/access` (writes a deny) each apply on the next request to
  dashboard, inbox count, activity, usage summary/by-task, notifications and task GET; a revoked PAT is
  401 on its next request on four routes; the in-flight invalidation race (mutation-tested: fails
  without the guard); bound/eviction. Every existing deny/visibility/revocation suite passes unchanged
  (`deny-surfaces`, `authorization-matrix`, `principal-context`, `tenancy`, `pat-policy`,
  `sse-session-binding`, `events.access`, …).

### 2.5 Workspace structure payload (`GET /api/workspaces/:id/structure`)

- Default response unchanged (PAT-callable; external clients may rely on it).
- `?view=summary`: workspace → projects → teams with `_count` instead of member lists (workspace
  `_count.members`, team `_count.{members,tasks}`), `currentMember` (with user) and `role`; member lists
  remain available, paginated, from `GET /api/workspaces/:id/members`.
- `?fields=` top-level field selection on both views (allow-list, 400 `INVALID_FIELDS` otherwise);
  `view` validated (400).
- **Evidence:** 760,912 → 39,646 bytes (−94.8 %), 9 → 6 statements; bench §3
  (`shell.workspace-structure.summary`).
- **Client follow-up (desktop-ui, not mine):** `components/settings/workspaces-section.tsx` only uses
  member **counts**; switch `fetchWorkspaceStructure` to `?view=summary` and read
  `_count.members` (workspace and team) instead of `.members.length`.

### 2.6 Telemetry hygiene (`packages/telemetry`)

- `histogram()` kept every sample in an array forever. Now a fixed-size log-linear histogram
  (`src/histogram.ts`, 8 buckets/octave over 2^-10..2^40, ≤ ~4.5 % percentile error, ~1.6 KB per
  series), and at most 1,024 series per process (overflow folded into `<name>|overflow=true`), counters
  included.
- `snapshotTelemetry()` keeps `histograms` (means, unchanged contract) and adds `histogramSummaries`
  (count, sum, mean, min, max, p50, p95, p99). `resetTelemetry()` test seam. Route timing itself
  already used the bounded `LatencyHistogram` (Phase 0).
- Tests: 100k samples → count/min/max exact, p50/p95/p99 within 5 %; series cap + overflow.

### 2.7 Files

- New: `apps/api/src/services/{activity-feed,usage,scoped-sql,task-aggregates}.ts`,
  `apps/api/src/__tests__/perf1-{scoped-aggregates,read-paths,tenancy-cache}.test.ts`,
  `packages/telemetry/src/histogram.ts`, `packages/db/prisma/migrations/20261026100000_activity_feed_keyset_index/`,
  `packages/db/prisma/manual/2026-10-26-phase1-activity-feed-index.sql`, `docs/runbooks/phase1-perf-indexes.md`,
  `scripts/perf/statements.ts`, `docs/reports/perf-baseline-2026-10-26/phase1-perf1-*`, this ledger.
- Changed: `apps/api/src/routes/{activity-log,usage,dashboard,inbox,notifications,workspaces}.ts`,
  `apps/api/src/services/workspaces.ts`, `apps/api/src/tenancy/context.ts`,
  `packages/telemetry/src/index.ts`, `packages/db/prisma/schema.prisma` (1 index), `scripts/perf/bench.ts`
  (3 scenarios).

## 3. Benchmarks (before/after, `pnpm perf:bench`, 3 rounds × 100 requests per run)

**Method.** Private fixture `openlinear_perf1_bench_test` (`pnpm perf:seed`, 50,000 tasks, 336,648
activity rows, seed 20261026, anchor 2026-10-25). "Before" = the base tree's `apps/api/src`
(`git archive` of the recorded base tree) bundled with the same esbuild options, with the activity
index dropped; "after" = this patch, index present (built CONCURRENTLY from the manual file). Runs
alternated B1, A1*, B2, A2*, B3, A3, A4, B4, A5 on ports 5310/5311 with `PERF_INSTRUMENTATION=sample`;
read-only scenarios only (no re-seed needed). `*` = intermediate code (A1: correlated-EXISTS
visibility; A2: before the notification join fix) — reported separately in
`phase1-perf1-comparison-intermediate.md`, not in the table below. Values: median over runs of each
run's median-of-3-rounds; brackets = min–max of the per-run p95. Before runs had higher machine load
(1-min load mean 8.5 / 13.1 / 8.0 / 6.2) than after runs (5.5 / 4.7 / 5.6) — other engineers' suites
share the machine — so untouched scenarios are listed as controls: `usage.mcp` −2 %, `board.*` +1 % /
−14 %, `task.comments` +1 %, default structure −5 %, `dashboard.projects` −12 % (≈ the noise floor;
Phase 0 measured ±25 % run-to-run). The changes below are far outside it, and the statement counts and
EXPLAIN plans (load-independent) carry the same conclusion. New scenarios (`activity.feed.cursor`,
`activity.feed.deep-offset`, `shell.workspace-structure.summary`) have 3 before runs; older builds
ignore `cursor`/`view` (they serve page 1 / the full structure), which is the comparison that matters
for clients.

| Scenario | p50 before → after (ms) | p95 before → after (ms) [per-run p95 range] | queries/req | mean bytes |
|---|---|---|---|---|
| activity.feed | 187.04 → 1.44 | 300.89 → 2.07 (−99 %) [208.04–480.47 → 2.00–2.50] | 4.3 → 2 | 26,572 → 26,673 |
| activity.feed.cursor | 170.54 → 1.75 | 202.20 → 2.50 (−99 %) [201.26–370.50 → 2.38–2.70] | 4.28 → 2 | 26,573 → 22,802 |
| activity.feed.deep-offset (page 200) | 335.55 → 239.32 | 408.00 → 285.51 (−30 %) [391.16–416.05 → 262.24–304.12] | 4.64 → 2.64 | 22,920 → 23,036 |
| activity.project | 4.45 → 1.14 | 5.88 → 1.98 (−66 %) [4.86–6.90 → 1.66–2.01] | 9 → 3 | 26,572 → 26,673 |
| usage.summary | 42.17 → 20.00 | 49.65 → 27.21 (−45 %) [49.00–57.48 → 25.45–27.30] | 3 → 1 | 2,529 = |
| usage.by-task | 61.75 → 36.41 | 73.98 → 41.31 (−44 %) [62.56–294.97 → 40.16–45.43] | 4.1 → 1 | 9,257 = |
| dashboard.tasks | 20.65 → 8.46 | 23.59 → 9.87 (−58 %) [21.86–26.24 → 9.44–11.12] | 6 → 1 | 191 = |
| inbox.count | 19.76 → 6.49 | 23.58 → 8.31 (−65 %) [19.72–32.05 → 6.91–8.78] | 2 → 1 | 29 = |
| inbox.list | 34.46 → 22.23 | 40.77 → 25.95 (−36 %) [39.51–49.77 → 23.13–27.65] | 7 → 6 | 127,262 = |
| notifications.page | 5.83 → 2.89 | 25.87 → 8.93 (−65 %) [22.84–30.28 → 8.00–9.00] | 5 → 3 | 47,093 = |
| notifications.page.owner | 29.86 → 9.15 | 38.84 → 11.41 (−71 %) [32.52–45.68 → 9.01–11.71] | 5 → 3 | 47,267 = |
| notifications.badge | 5.44 → 2.16 | 24.60 → 8.03 (−67 %) [18.27–30.02 → 7.23–8.29] | 5 → 3 | 549 = |
| shell.workspace-structure.summary | 13.60 → 5.20 | 15.60 → 5.98 (−62 %) [13.44–17.07 → 5.68–6.30] | 9 → 6 | 760,917 → 39,651 |
| shell.workspace-structure (default) | 14.04 → 13.07 | 15.71 → 15.00 (−5 %) [14.98–29.56 → 14.72–15.95] | 9 → 9 | 760,917 = |
| shell.workspaces | 1.50 → 0.82 | 1.98 → 1.06 (−46 %) [1.24–3.58 → 1.01–2.37] | 6 → 2 | 654 = |
| shell.me | 0.80 → 0.68 | 1.85 → 1.28 (−31 %) [0.77–3.31 → 1.24–1.61] | 2 → 2 | 307 = |
| task.get | 1.48 → 1.31 | 2.37 → 1.95 (−18 %) [1.63–2.67 → 1.68–2.31] | 13 → 9 | 2,157 = |
| task.comments | 1.06 → 0.97 | 1.55 → 1.56 (+1 %) [1.48–2.10 → 1.12–2.15] | 9 → 5 | 1,579 = |
| board.project-large | 16.93 → 17.14 | 19.62 → 19.83 (+1 %) [18.07–21.53 → 16.82–20.53] | 15 → 11 | 416,635 = |
| board.project-large.pat | 17.16 → 16.41 | 20.64 → 17.81 (−14 %) [17.89–25.45 → 17.10–22.23] | 16 → 12 | 416,635 = |
| dashboard.projects (control) | 7.38 → 6.79 | 8.61 → 7.59 (−12 %) [7.89–9.13 → 7.22–8.19] | 4 → 4 | 4,458 = |
| usage.mcp (control) | 0.69 → 0.58 | 10.09 → 9.93 (−2 %) [9.89–10.56 → 9.50–10.09] | 4 → 4 | 1,035 = |
| usage.mcp.owner (control) | 10.93 → 10.07 | 13.07 → 11.75 (−10 %) [12.37–13.88 → 10.94–13.00] | 4 → 4 | 1,339 = |

Files: `phase1-perf1-bench-before-{1..4}.{json,md}`, `phase1-perf1-bench-after-{3,4,5}.{json,md}`,
`phase1-perf1-bench-after-{1,2}-intermediate.{json,md}`, `phase1-perf1-comparison*.md`,
`phase1-perf1-statements-{before,after}{,-nocache}.json`, `phase1-perf1-explain/{before,after}/*.txt`
+ `explain-{before,after}.json`. The board/task/comments latencies barely move although they lose four
statements: on loopback a statement costs ~0.1–0.3 ms; against a managed database each is a network
round trip.

## 4. Validation

| Check | Result |
|---|---|
| `pnpm typecheck` (root, turbo) | 10/10 successful |
| `pnpm lint` (root list) | 167 files, no diagnostics; new perf1 files also clean under `biome check --error-on-warnings` (route files keep their pre-existing `useImportType` warnings; they are not in the lint list) |
| `pnpm perf:typecheck` | clean (`statements.ts`, `bench.ts`) |
| `TEST_DATABASE_URL=…/openlinear_perf1_test pnpm --filter @openlinear/api test` | **58 files, 636 passed, 2 skipped** (final run); earlier full run before the cache test file: 57 files, 631 passed, 2 skipped. Baseline 615 + 2. No flakes in either run |
| New tests | `perf1-scoped-aggregates.test.ts` (6: visibility SQL ≡ `scopedTaskWhere`, dashboard/inbox/notification counters ≡ Prisma counts, usage summary/by-task ≡ old route code for 3 sorts and every page, `resolveProjectAccess` ≡ old nested select for 11 principals × 6 projects), `perf1-read-paths.test.ts` (10: activity keyset walk/compat/validation/deny, structure summary/fields/validation/PAT, workspaces default, statement budgets, telemetry), `perf1-tenancy-cache.test.ts` (5: revocation with cache on, in-flight race, bound) |
| Mutation checks | deny clause broken in `taskVisibleSql` → 4/6 equivalence tests fail; PAT binding removed from the legacy-team check → `resolveProjectAccess` test fails; team-only deny broken → fails; in-flight guard disabled → race test fails |
| `prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code` (Prisma 7, shadow `openlinear_perf1_shadow_test`) | exit 0, "No difference detected" |
| `scripts/ci/migration-safety.sh --files …/20261026100000_activity_feed_keyset_index/migration.sql` | skipped by the documented `migration-safety: allow` opt-in |
| `prisma migrate deploy` | applied to `openlinear_perf1_test`; on the bench DB after the manual CONCURRENTLY build (no-op path) |

## 5. Compatibility notes

- `/api/activity`: `total` exact only with `count=exact` (otherwise lower bound, `totalExact: false`);
  new `nextCursor`, `cursor`; malformed `cursor`/`count` → 400. Order now has an `id` tiebreaker.
- `/api/usage/by-task`: ties now ordered by `taskId` (were arbitrary).
- `/api/workspaces/:id/structure`: new `view`, `fields` (unknown values → 400); default unchanged.
- `/api/dashboard/tasks`, `/api/inbox/count`, `/api/inbox`, `/api/notifications`, `/api/usage/summary`:
  same shapes and numbers (equivalence-tested).
- `resolveProjectAccess().teamIds`: deterministic order (team `createdAt`, `id`).
- `snapshotTelemetry()`: additive `histogramSummaries`.

## 6. Leftovers (not done here, or not mine)

1. **Not mine, one statement each to win:** `services/ownership.ts` `loadTeamMembershipAccess`
   (team-only tasks, `assertTeamRole`) is a nested Prisma select (4 statements) — same rewrite as
   `resolveProjectAccess`; `assertTaskAccess` could fold the task lookup into that statement;
   tasks routes call `getUserTeamIds` (the first `team_members` read on every board request) where the
   list filter already uses `principal.teams`.
2. **Principal resolution on a cache miss** is 3 statements (`resolveTenancyContext`); a single
   statement would help SSE re-validation and cold requests. Left alone: the brief limited tenancy/** to
   caching.
3. **Inbox list / notifications page queries** still use the Prisma visibility predicate and dominate
   those routes (inbox page ~25 ms, notifications page ~15 ms on the bench): keyset + `taskVisibleSql`,
   or a `tasks.workspaceId`-led predicate (Phase 0 candidate 5) — touches the shared scope builders.
4. **Usage by-task** still reads every `agent_runs` row (all tenants) and joins the visible tasks
   (~45 ms); at multi-tenant scale drive it from the tenant's tasks or add `workspaceId` to
   `agent_runs`.
5. **Deep OFFSET activity pages** cost grows with the offset (now index walk + per-row visibility, still
   faster than the old full sort at page 200); clients should use `nextCursor`. A `teamId` filter on
   the feed has no `(teamId, createdAt)` index (rare path, not measured).
6. **`taskVisibleSql` must track `scopedTaskWhere`.** The equivalence test fails on drift for the
   fixture's rule combinations; anyone changing visibility rules must change both.
7. **desktop-ui follow-ups (not mine):** settings workspaces page → `?view=summary` + `_count.members`;
   any future activity feed UI → `nextCursor`.
8. `docs/PERFORMANCE_IMPROVEMENT_PLAN.md` status lines (not mine).
9. The perf scripts' new `statements.ts` has no root `perf:*` alias (root `package.json` is a merge
   hotspot); run it with `pnpm --filter @openlinear/api exec tsx ../../scripts/perf/statements.ts`.

## 7. Merge hazards

- `packages/db/prisma/schema.prisma` (`ActivityLog`: one `@@index` line) and migration
  `20261026100000_activity_feed_keyset_index` (prefix reserved for perf1). Other engineers' migrations
  sort around it; re-run `prisma migrate diff` after merging.
- `apps/api/src/services/workspaces.ts`: `resolveProjectAccess` rewritten (raw SQL; `getUserTeamIds`
  import removed), `listWorkspacesForUser` reordered, `getWorkspaceStructure` gains `view`. Anyone
  editing project/workspace access rules must keep `loadProjectAccessRow` in step (the equivalence test
  compares it with the old implementation).
- `apps/api/src/tenancy/context.ts`: cache internals (bounded map, per-user index, invalidation
  sequence, `OPENLINEAR_TENANCY_CACHE=1`, `OPENLINEAR_TENANCY_CACHE_MAX`, `tenancyCacheSize`,
  `clearTenancyCache`). `cacheKey` no longer needs `userId` at index 1.
- `apps/api/src/tenancy/scopes.ts` is **unchanged**, but `services/scoped-sql.ts` mirrors
  `scopedTaskWhere`: a change there (API-contract engineer: visibility-as-a-set, workspaceId predicate)
  must be mirrored, or `perf1-scoped-aggregates.test.ts` fails.
- Routes `activity-log.ts`, `usage.ts`, `dashboard.ts`, `inbox.ts`, `notifications.ts`,
  `workspaces.ts` (structure + list): handlers replaced; anyone adding exact-count removal or keyset
  pagination to `schemas/pagination.ts` should note the activity feed has its own cursor helper
  (`services/activity-feed.ts`) on purpose.
- `scripts/perf/bench.ts`: +1 constant (`ACTIVITY_MID_CURSOR`), +3 scenarios
  (`shell.workspace-structure.summary`, `activity.feed.deep-offset`, `activity.feed.cursor`).
- `packages/telemetry/src/index.ts`: rewritten (same exports + `resetTelemetry`, `BoundedHistogram`,
  `MAX_SERIES`, `histogramSummaries`).
- New tests read `getRouteTimingSnapshot().maxQueries` per registry route template
  (`perf1-read-paths.test.ts`): a registry path rename, or an extra statement on one of those routes,
  fails the budget test by design.
