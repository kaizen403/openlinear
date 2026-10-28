# Performance baseline — 2026-10-26 (P95 plan, Phase 0)

**Scope.** API latency, statement counts and query plans for the hot routes named in
`docs/reports/performance-codebase-review-2026-06-04.md`, measured on a deterministic
50,000-task fixture. These are **descriptive local baselines on one laptop**, not SLAs or
production claims. Engineer ID: `perf`. Ledger: `docs/reports/revamp-2026-10-26/perf.md`.

## Files

| File | What |
|---|---|
| `bench-baseline.json` / `.md` | Headline baseline: 40 scenarios × 3 rounds (11,115 measured requests, 0 errors), raw per-request samples, server-side durations, statement counts, slow statements |
| `bench-baseline-run1.json` / `.md` | An earlier full run of the same suite (38 scenarios; before the two owner-pinned scenarios existed) — run-to-run reproducibility |
| `bench-with-phase0-indexes.json` / `.md` | Same suite with the manual phase-0 index file applied (corrected copy, see below) |
| `bench-with-phase0-plus-probe.json` / `.md` | Search and activity scenarios with the manual indexes plus two Phase 1 probe indexes |
| `bench-overhead-{off,prod,sample}-{1,2}.json` / `.md` | Instrumentation overhead: route timing + Prisma query events off, production defaults, and log-every-request |
| `explain/explain-<label>.json` | Per route: statement count (cold / warm / after the response), DB time, and per statement: execution time, seq scans, rows removed by filter, sort method, buffers |
| `explain/<label>/<route>.txt` | Full SQL and `EXPLAIN (ANALYZE, BUFFERS)` plan of every SELECT the route issued on its warm call |

Raw API logs (one JSON line per request) are written to `$TMPDIR/openlinear-perf/api-<label>.log`
and are not committed.

## Environment and method

- **Host:** Apple M5 Pro, 15 cores, 24 GiB, macOS (Darwin 27.0.0), Node v22.16.0.
- **Database:** PostgreSQL 14.17 (Homebrew) on loopback, `shared_buffers` 128 MB,
  `work_mem` 4 MB, `random_page_cost` 4, JIT on — stock settings, smaller than a managed
  production instance. Database `openlinear_perf_bench_test`, 374 MB after seeding.
- **Load:** the machine was shared with nine other engineers' test suites. The 1-minute
  load average sampled every 5 s during the headline run: mean 4.8, max 6.1 (15 cores).
- **Target:** the real API bundle `apps/api/dist/index.js`, `NODE_ENV=production`
  (production JWT claims, rate limiters, info logging), started by the bench on port 5050.
  Background jobs off (`OPENLINEAR_JOBS_RUNNER=worker`), in-process outbox relay on.
- **Client:** Node `fetch` on loopback, sequential (concurrency 1) unless the scenario name
  starts with `concurrent8`. Latency is request start to last body byte. 10 warm-up
  requests per scenario, then 100 measured (60 for search; 20 bulk, 5 fan-out, 20 chat).
- **Rounds:** 3 full rounds. Tables show the **median across rounds** of each round's
  nearest-rank percentile, and the min–max of the per-round p95 ("p95 spread").
- **Principals:** 16 bench users with identical memberships (workspace owner/admins).
  Requests rotate across them, which also keeps the user-keyed search limiter (30/min)
  happy; each request carries a distinct synthetic `X-Forwarded-For` for the IP limiter
  (`trust proxy` = 1). `perf-owner` carries the heavy personal volumes (4,000
  notifications, 20,000 MCP calls); the others have 300 and 0, so the rotating
  `notifications.*` and `usage.mcp` scenarios have a light p50 and an owner-driven p95.
  The `.owner` scenarios pin the owner.
- **Server-side numbers** come from the new route-timing log line (`evt: route_timing`)
  joined on `x-request-id`; "queries" counts Prisma statements issued in the request's
  async context before the response finished.
- **Chat:** `CHAT_LLM_BASE_URL` points at a local fake OpenAI-compatible server that
  streams four deltas immediately — no paid inference, so chat numbers are the
  platform's own overhead before model latency.
- **State:** the fixture is rebuilt (`perf:seed`, deterministic) before each labelled run;
  bulk and PATCH scenarios toggle state and end where they started.

## Fixture (`scripts/perf/seed.ts`, seed 20261026, anchor 2026-10-25)

| Table | Rows | Notes |
|---|---:|---|
| users | 80 | 16 bench users |
| workspaces | 3 | primary (bench users are owner/admins), secondary (members), foreign tenant (no access) |
| linear_projects / teams | 100 / 120 | Zipf-sized: largest primary project 7,975 tasks, 10th 797, 61st 131 |
| tasks | 50,000 | 80 % primary, 10 % / 10 % other tenants; 1 % team-only legacy tasks; 45 % done, 13 % cancelled, ~8 % archived; 25 % of finished tasks with runs carry persisted execution logs (10–40 entries) |
| activity_logs | 336,648 | |
| comments | 102,683 | |
| task_labels / task_assignees | 54,600 / 11,231 | |
| agent_runs | 33,941 | spread over 120 days, ~11k inside the 30-day usage window |
| notifications | 12,900 | owner 4,000 |
| chat_sessions / chat_messages | 191 / 9,833 | |
| mcp_tool_calls / audit_logs | 20,000 / 5,000 | |

Seeding takes about 47 s. Re-running with the same seed and anchor produces identical rows
(checked by `md5(string_agg(...))` over tasks, comments and activity).

## Baseline (headline run `bench-baseline`)

Latency in ms; "queries" = mean Prisma statements per request (max in parentheses);
bytes = mean response size.

| Scenario | Request | n | p50 | p95 | p99 | p95 spread | server p95 | queries | KiB |
|---|---|---:|---:|---:|---:|---|---:|---:|---:|
| `shell.me` | GET /api/auth/me | 300 | 0.55 | 0.91 | 1.53 | 0.63–1.63 | 0.66 | 2 (8) | 0.3 |
| `shell.workspaces` | GET /api/workspaces | 300 | 0.91 | 1.44 | 1.63 | 1.04–2.17 | 1.07 | 6 (6) | 0.6 |
| `shell.projects.ui-fields` | GET /api/projects?workspaceId&fields=(UI list) | 300 | 3.3 | 4.25 | 4.81 | 3.81–5.41 | 3.49 | 2 (2) | 68.5 |
| `shell.projects.default` | GET /api/projects | 300 | 4.12 | 5.17 | 5.63 | 5.05–6.72 | 4.62 | 5 (5) | 105.1 |
| `shell.teams.ui-fields` | GET /api/teams?workspaceId&fields=… | 300 | 0.68 | 1.0 | 1.4 | 1.0–1.1 | 0.73 | 1 (1) | 8.6 |
| `shell.workspace-structure` | GET /api/workspaces/:id/structure | 300 | 13.73 | 16.6 | 18.23 | 15.62–16.8 | 15.9 | 9 (9) | **743.1** |
| `board.project-large` | GET /api/tasks?projectId (7,975 tasks)&pageSize=200 | 300 | 16.39 | 19.82 | 24.93 | 18.82–20.64 | 18.81 | 15 (15) | 406.9 |
| `board.project-large.pat` | same with a PAT | 300 | 16.2 | 18.13 | 20.24 | 17.06–19.87 | 17.65 | 17 (17) | 406.9 |
| `board.project-medium` | … (797 tasks) | 300 | 8.68 | 10.69 | 11.11 | 10.03–11.59 | 10.2 | 15 (15) | 397.0 |
| `board.project-small` | … (131 tasks) | 300 | 6.21 | 7.65 | 8.61 | 7.59–9.11 | 7.27 | 15 (15) | 229.5 |
| `board.team` | GET /api/tasks?teamId&pageSize=200 | 300 | 12.83 | 15.55 | 17.46 | 13.34–18.44 | 14.95 | 10 (10) | 402.5 |
| `board.all` | GET /api/tasks?pageSize=200 (all visible) | 300 | 54.55 | **59.19** | 62.18 | 56.55–62.63 | 58.42 | 10 (10) | 443.8 |
| `board.my-issues` | GET /api/tasks?assignee=me&pageSize=200 | 300 | 10.28 | 11.86 | 13.2 | 11.37–12.03 | 11.38 | 10 (10) | 430.8 |
| `board.deep-page` | … large project, page 100 of 50 (OFFSET 4,950) | 300 | 16.44 | 19.38 | 20.95 | 18.75–19.75 | 18.91 | 15 (15) | 98.8 |
| `board.archived` | GET /api/tasks/archived?pageSize=50 | 300 | 15.62 | 16.76 | 17.71 | 16.66–23.27 | 16.37 | 9 (9) | 145.4 |
| `task.get` | GET /api/tasks/:id | 300 | 1.1 | 1.54 | 1.86 | 1.46–1.66 | 1.37 | 13 (13) | 2.1 |
| `task.comments` | GET /api/tasks/:id/comments | 300 | 0.85 | 1.18 | 1.42 | 1.15–1.26 | 0.99 | 9 (9) | 1.5 |
| `task.patch` | PATCH /api/tasks/:id | 300 | 1.79 | 2.32 | 3.41 | 2.12–2.98 | 2.08 | 18 (18) | 2.1 |
| `search.common` | GET /api/search?q=latency (~4 % of titles) | 180 | 37.36 | 40.24 | 42.01 | 40.14–40.62 | 39.89 | 3 (3) | 1.5 |
| `search.rare` | GET /api/search?q=zephyrine (12 titles) | 180 | 87.92 | **94.74** | 101.97 | 91.95–98.61 | 94.33 | 3.6 (7) | 1.0 |
| `search.identifier` | GET /api/search?q=K4-17 | 180 | 89.05 | 97.06 | 100.61 | 95.41–100.31 | 96.64 | 3.2 (7) | 1.0 |
| `search.no-match` | GET /api/search?q=(no match) | 180 | 90.66 | 94.3 | 97.44 | 94.04–198.67 | 93.85 | 3 (3) | 0.0 |
| `inbox.list` | GET /api/inbox?pageSize=50 | 300 | 32.95 | 38.06 | 40.02 | 36.66–42.45 | 37.48 | 7 (7) | 110.8 |
| `inbox.count` | GET /api/inbox/count | 300 | 18.07 | 20.36 | 21.49 | 17.16–25.33 | 19.87 | 2 (2) | 0.0 |
| `notifications.page` | GET /api/notifications?pageSize=100 (rotating users) | 300 | 5.59 | 21.47 | 25.89 | 20.76–26.62 | 21.17 | 5 (5) | 46.0 |
| `notifications.page.owner` | same as perf-owner (4,000 notifications) | 300 | 24.33 | 29.87 | 33.57 | 26.55–30.73 | 29.46 | 5 (5) | 46.4 |
| `notifications.badge` | GET /api/notifications?pageSize=1 | 300 | 4.39 | 22.09 | 25.67 | 19.59–24.77 | 21.79 | 5 (5) | 0.5 |
| `dashboard.tasks` | GET /api/dashboard/tasks | 300 | 19.59 | 22.16 | 23.93 | 19.73–22.68 | 21.71 | 6 (6) | 0.2 |
| `dashboard.projects` | GET /api/dashboard/projects | 300 | 7.2 | 8.32 | 8.75 | 7.01–11.73 | 7.95 | 4 (4) | 4.4 |
| `usage.summary` | GET /api/usage/summary | 300 | 38.28 | 43.06 | 45.07 | 38.48–47.12 | 42.7 | 3.6 (7) | 1.8 |
| `usage.by-task` | GET /api/usage/by-task?sort=cost | 300 | 52.69 | 61.93 | 66.47 | 54.24–64.2 | 61.56 | 4 (8) | 8.6 |
| `usage.mcp` | GET /api/mcp/usage (rotating users) | 300 | 0.46 | 9.77 | 10.41 | 9.46–10.26 | 9.58 | 4 (4) | 1.0 |
| `usage.mcp.owner` | same as perf-owner (20,000 calls) | 300 | 10.08 | 11.25 | 13.25 | 11.2–11.45 | 10.3 | 4 (4) | 1.3 |
| `activity.feed` | GET /api/activity?pageSize=50 | 300 | 166.83 | **184.75** | 191.69 | 178.89–210.27 | 184.24 | 4 (4) | 21.3 |
| `activity.project` | GET /api/activity?projectId&pageSize=50 | 300 | 4.04 | 5.2 | 6.1 | 4.91–6.55 | 4.97 | 9 (13) | 22.2 |
| `bulk.status-100` | PATCH /api/tasks/bulk-status, 100 tasks | 60 | 55.53 | 65.05 | 72.57 | 59.36–72.43 | 60.81 | 126.9 (141) | 185.9 |
| `bulk.fanout-100` | 100 × PATCH /api/tasks/:id, 6 in flight (today's board) | 15 moves | 216.6 | **238.36** | 238.36 | 227.31–243.53 | — | **3,416 per move** | 184.6 |
| `chat.stream` | POST /api/chat/sessions/:id/messages (fake provider) | 60 | 3.75 | 4.52 | 5.0 | 4.41–5.64 | 4.36 | 8.6 (12) | 0.7 |
| `concurrent8.board-large` | board.project-large, 8 in flight | 480 | 47.94 | 56.69 | 64.39 | 55.76–61.92 | 53.83 | 15 (19) | 406.9 |
| `concurrent8.inbox-count` | inbox.count, 8 in flight | 480 | 20.67 | 24.06 | 25.19 | 23.03–24.52 | 23.42 | 2 (2) | 0.0 |

- **Chat stream (fake provider):** response headers p95 1.06 ms, first SSE event p95
  1.99 ms, first `assistant_delta` p95 4.04 ms, whole turn p95 4.52 ms. The platform's own
  time to first byte is far inside the 500 ms budget; real TTFB will be provider latency.
  Attachments were not exercised.
- **Fan-out vs bulk:** one 100-task move through today's per-task PATCH fan-out takes
  p95 238 ms and 3,416 statements (34 per PATCH; per-request p95 17.5 ms); the existing
  bulk endpoint does the same move in p95 65 ms with 127 statements in the request
  (plus about 590 more after the response — see "Statement amplification").
- **Throughput:** `board.project-large` 59–60 req/s sequential vs 155–168 req/s with 8
  in flight (2.7×) while p95 triples — the 400 KB JSON responses are serialized on the
  single Node event loop. `inbox.count` 365–390 req/s with 8 in flight.

### Reproducibility and instrumentation overhead

- `bench-baseline-run1` (same suite 12 minutes earlier, load mean 5.3 vs 4.8) vs
  the headline, per-scenario p95: median absolute difference 11 %, 29 of 38 scenarios
  within 25 %. Run 1 was slower almost everywhere. Sub-5 ms routes differ by up to 74 %
  in relative terms but at most 1.1 ms; routes at or above 15 ms differ by at most 27 %,
  except `board.archived` (24.4 vs 16.8 ms). Treat the p95 spread column and a ±25 %
  band as the noise floor on this machine: smaller differences are not findings.
- Instrumentation overhead (`bench-overhead-*`, two runs per mode, 600 requests per
  scenario per run): median p95 for `board.project-large` 19.1–19.6 ms off,
  19.3–20.6 ms production defaults, 19.0–19.5 ms log-every-request; `task.get`
  1.85–1.98 / 1.71–2.28 / 1.69–2.56 ms; `inbox.count` 21.8–23.0 / 21.7–22.3 /
  21.3–23.7 ms. The route-timing middleware and Prisma query events are not
  distinguishable from run-to-run noise. In-process microbenchmark: route-template match
  0.38 µs per request (136 templates), histogram record 0.013 µs.

## Statement amplification (route-timing counts and the EXPLAIN capture)

| Path | Statements | Where they come from |
|---|---:|---|
| `PATCH /api/tasks/bulk-status`, 100 tasks | 133 in the request + **592 after the response** | per task: 1 activity INSERT (100 separate inserts), and per published event: `INSERT domain_events` + `teams` lookup + `linear_projects` lookup + `UPDATE domain_events SET published_at` (201 events → ~800). Captured in `explain/baseline/bulk.status-100.txt`. |
| Board multi-select move today (100 × PATCH) | 3,416 | 34 per PATCH: 6 access checks, update + full reload with relations, activity insert, 2 events × 4 statements |
| `PATCH /api/tasks/:id` | 19 + 5 after the response | as above for one task |
| `GET /api/tasks?projectId` | 15 | `team_members` (uncached `getUserTeamIds`), 5 for `assertProjectAccess` (project, project_access, workspace, teams, workspace_members — not served from the cached tenancy context), the page, 6 relation loads (batched `IN`, not N+1), the COUNT, COMMIT |
| `GET /api/tasks/:id` | 13 | 6 access checks + 7 for the row and its relations |
| `GET /api/auth/me`, cold principal | 8 (2 warm) | session revocation + tenancy resolution; warm calls hit the 30 s caches |
| PAT-authenticated request | +2 | PAT lookup and an unthrottled `lastUsedAt` UPDATE on every request (JWT sessions are throttled to one touch per 10 min) |

Relation loading is batched (`WHERE id IN (...)`), so no classic N+1 appears on read
routes; the amplification is in authorization checks repeated per request and in the
event/outbox write path.

## EXPLAIN (ANALYZE, BUFFERS) reading

Plans are from `explain/baseline/` (the second, warm call of each route as `perf-owner`).
Small-table sequential scans (`linear_projects` 100 rows, `teams` 120,
`workspace_members`, `project_access`) are cheap and expected; they appear in almost every
plan because the visibility predicate joins them.

**The common shape.** Every task-, notification-, usage- and activity-listing query
carries the `scopedTaskWhere`/`scopedActivityWhere` visibility predicate: an `OR` of three
branches (project visible through workspace membership / explicit grant / team, minus
explicit denies; team-only task; self-created orphan), with correlated `EXISTS`
sub-plans and the caller's team ids bound twice as `IN` lists (2 × 73 bind parameters
for perf-owner; 159 placeholders in the inbox COUNT). Postgres cannot turn that `OR` into an index condition, so whenever the
route has no selective equality filter of its own (a project id), it reads every
candidate row, joins `linear_projects`, `workspaces`, `teams`, and filters. For a
principal who can see most of a workspace that is ~45k rows per statement.

| Route | Main statements (execution ms) | Reading |
|---|---|---|
| `board.project-large` | page 6.0, COUNT 3.4 | Bitmap index scan on `tasks_projectId_idx` (7,975 rows) → visibility filter → top-N heapsort by `createdAt` (373 kB). Fine at this size; cost is linear in project size and the COUNT repeats the whole scan on every page. The existing `(projectId, archived, createdAt)` index is not used because the OR predicate defeats an ordered index scan. |
| `board.all` | page 37.3, COUNT 22.5 | Seq scan of all 50k tasks (44,463 survive `archived=false`), visibility filter removes 10,278, heapsort for the top 200. Two full scans per page. |
| `board.deep-page` | page 10.8 | Same as large project but OFFSET 4,950: the sort must keep 5,000 wide rows (description + execution logs) → **external merge sort, 5 MB on disk**. Offset pagination plus wide rows. |
| `inbox.count` | 15.2 + 9.2 | Two separate COUNTs (total, unread). Bitmap scan on `tasks_status_idx` (done OR cancelled, ~29k) → `NOT archived` → visibility → 21k rows counted. The manual `(teamId, archived, status, inboxRead, updatedAt)` index cannot apply: the inbox has no `teamId` predicate. |
| `inbox.list` | page 22.7, COUNT 14.5 | Same scan, sorted by `updatedAt`, plus the COUNT again. |
| `search.*` | task search 39.7 (common) / 103.1 (rare) | **Seq scan of all 50k tasks** evaluating `ILIKE '%q%'` on title, description and identifier; the rare term removes 50,143 rows to return 12. The common term is cheaper only because the LIMIT stops early. Projects/teams search is sub-millisecond. |
| `usage.summary` | aggregate 29.8 + row fetch 24.8 | Both statements hash-join all 50k tasks to ~11k agent runs in the window for the visibility check; the second **loads 11,324 rows into Node** to build the daily chart. |
| `usage.by-task` | groupBy page 33.8 + full groupBy 23.0 | The second `groupBy` exists only to count groups (`total`), repeating the whole join. |
| `activity.feed` | page 70.7 + COUNT **132.1** | **Parallel seq scan of 336,648 activity rows, external merge sort spilling ~30 MB per worker** (no index leads with `createdAt`), and the COUNT joins and filters every row (10.5k buffers read from outside shared buffers). The slowest route in the suite. |
| `activity.project` | COUNT 4.4 | Uses `(projectId, createdAt)`; fine. |
| `notifications.page` | page 27.9, COUNT 13.4, unread COUNT 9.6 | 4,000 owner notifications hash-joined to **all 50k tasks** to apply task visibility, three times (page, total, unread). |
| `dashboard.tasks` | 6 statements, 8–21 ms each, ~99 ms DB total | Six COUNT/GROUP BY statements over the same visible set (status, priority, overdue, unassigned, total, recent), each a seq scan + visibility filter; they run in parallel (`Promise.allSettled`), so wall time is ~22 ms but DB work is ~100 ms per request. |
| `task.patch`, `bulk.status-100` | writes not EXPLAINed | Statement lists only (see amplification table). Sum of statement durations for the bulk move is ~1.1 s because 100 activity inserts run concurrently and wait for pool connections. |

Slow statements logged by the new Prisma hook during the headline run (threshold 100 ms):
the activity COUNT (45×, p50 102 ms), task search (30×, p50 114 ms, max 221 ms) and the
activity page (8×, p50 108 ms) — `bench-baseline.json` → `slowQueries`.

## With the phase-0 manual indexes (`packages/db/prisma/manual/2026-09-09-phase0-hot-path-indexes.sql`)

**It does not apply cleanly.** Run statement by statement (`pnpm perf:sql`) against a
freshly seeded perf database, the first nine objects are created and statement 10 fails:
`CREATE INDEX CONCURRENTLY … "projects_name_trgm_idx" ON "projects"` →
`42P01 relation "projects" does not exist`. Prisma maps `Project` to `linear_projects`.
An operator following `docs/runbooks/apply-hot-path-indexes.md` would be left with a
partial set. The comparison below uses `scripts/perf/sql/phase0-hot-path-indexes.bench.sql`,
a copy with only that table name corrected (11 objects + ANALYZE), applied to the
re-seeded perf database, then dropped again (`drop-phase0-hot-path-indexes.bench.sql`).

**Plans:** with the ten indexes present, the only plan change across the 16 captured
routes is that `tasks_teamId_archived_updatedAt_id_idx` is used as a covering index for
`(id, teamId)` inside the usage queries' visibility join (shared buffers 10,276 → 6,365;
execution time unchanged). No board, inbox, search or activity plan changes: the
board orders by `createdAt` (not `updatedAt`, as the manual file assumes), the inbox has
no `teamId` predicate, the title/identifier trigram indexes cannot serve an `OR` whose
third arm (`description ILIKE`) is unindexed, and the activity indexes lead with
`teamId`/`userId` while the feed filters on project visibility and sorts on `createdAt`.

| Scenario | baseline p50 / p95 | + manual indexes p50 / p95 | + manual + probe p50 / p95 |
|---|---|---|---|
| `search.rare` | 87.9 / 94.7 | 90.5 / 95.9 | **3.6 / 3.8** |
| `search.identifier` | 89.1 / 97.1 | 93.0 / 101.8 | **3.0 / 3.3** |
| `search.no-match` | 90.7 / 94.3 | 91.2 / 97.1 | **4.1 / 4.6** |
| `search.common` | 37.4 / 40.2 | 38.4 / 41.2 | 37.3 / 39.3 |
| `activity.feed` | 166.8 / 184.8 | 166.0 / 177.2 | 101.2 / 170.1 |
| `activity.project` | 4.0 / 5.2 | 4.2 / 5.6 | 5.1 / 7.9 |
| `inbox.count` | 18.1 / 20.4 | 18.3 / 20.2 | — |
| `inbox.list` | 33.0 / 38.1 | 34.2 / 37.7 | — |
| `board.project-large` | 16.4 / 19.8 | 17.6 / 19.8 | — |
| `board.all` | 54.6 / 59.2 | 55.4 / 63.3 | — |
| `dashboard.tasks` | 19.6 / 22.2 | 20.0 / 22.8 | — |
| `dashboard.projects` | 7.2 / 8.3 | 4.9 / 6.4 | — |
| `usage.summary` | 38.3 / 43.1 | 38.1 / 46.7 | — |
| `usage.by-task` | 52.7 / 61.9 | 49.4 / 57.6 | — |
| `bulk.status-100` | 55.5 / 65.1 | 54.0 / 63.5 | — |

Every difference in the middle column is inside the ±25 % noise band except
`dashboard.projects` (−23 % p95, −32 % p50; plausibly the `(projectId, status, archived,
updatedAt)` index serving its per-project status `groupBy`, not verified with EXPLAIN).
Full table: `bench-with-phase0-indexes.md`. Write cost of the ten extra indexes was not
visible in `bulk.status-100` at this volume.

**Phase 1 probe** (`scripts/perf/sql/probe-phase1-candidates.bench.sql`, applied on top,
search and activity scenarios only, `bench-with-phase0-plus-probe.*`,
`explain/with-phase0-plus-probe/`):

- `tasks(description gin_trgm_ops)` completes the `OR`: task search becomes a BitmapOr
  over the three trigram indexes (rare term: 103 ms → 2.1 ms execution; p95 95 → 3.8 ms).
  The common term (2k+ matches) still seq-scans (39 ms) because the planner expects most
  of the table; that needs a different query shape (rank + LIMIT, FTS), not an index.
- `activity_logs("createdAt" DESC, id)` turns the feed page into an index walk
  (70.7 ms → 0.11 ms) but the exact `COUNT(*)` of all visible activity stays at
  128–142 ms, so the route only drops from p50 167 to 101 ms. The COUNT must go
  (cursor pagination or a capped/estimated total). It also changed the
  `activity.project` plan (buffers 572 → 3,813, p95 5.2 → 7.9 ms): check plans when adding it.
