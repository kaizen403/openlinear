# Perf — P95 plan Phase 0: instrumentation and reproducible baselines

**Round:** 2 (2026-10-26) · **Engineer ID:** perf · **Status:** done for the local scope
(frontend vitals collector shipped, browser baseline not captured — see §9).
**Owner constraint:** local only. Nothing deployed; only loopback Postgres :54330 databases
`openlinear_perf_test` (tests) and `openlinear_perf_bench_test` (fixture) were touched.
Full report: [`docs/reports/perf-baseline-2026-10-26/README.md`](../perf-baseline-2026-10-26/README.md).

## 1. Outcome

- Every API request now records route **template**, method, status, bytes, duration,
  duration bucket, auth source and the number/time of Prisma statements it issued, into
  bounded in-process histograms; slow, query-heavy or sampled requests are logged
  (`evt: route_timing`). Overhead is not measurable above run-to-run noise.
- Prisma slow-query logging (100 ms dev / 250 ms prod, `OPENLINEAR_SLOW_QUERY_MS`), SQL
  only, literals masked, never parameter values, attributed to the issuing route.
- Deterministic 50,000-task fixture (≈640k rows, 47 s), loopback + `*_test` only.
- A benchmark that drives the production API bundle, a fake chat provider, and an
  EXPLAIN (ANALYZE, BUFFERS) capture of the exact SQL each hot route issues.
- Baselines for 40 scenarios × 3 rounds (11,115 measured requests, 0 errors), EXPLAIN for 16 routes, a with/without
  comparison of the manual phase-0 index file (which does **not** apply cleanly and
  changes no hot-path plan), and a probe of two Phase 1 candidates.

## 2. What was added

| File | What |
|---|---|
| `apps/api/src/middleware/route-timing.ts` (new) | Middleware: route template from `ROUTE_REGISTRY` (Express template fallback for unregistered routers, e.g. sidecar), per-request `AsyncLocalStorage` statement counter, bounded per-route histograms (≤ 512 series, overflow → `OTHER`; unknown paths → `UNMATCHED`), logging policy, optional periodic summary, `getRouteTimingSnapshot()`; installs the Prisma query observer that logs `evt: slow_query` with route + request id |
| `apps/api/src/lib/latency-histogram.ts` (new) | Fixed-size log-linear histogram (8 buckets/octave, 0.125 ms–137 s, ≤ 4.5 % percentile error, constant memory) and a 9-value duration-bucket label |
| `apps/api/src/app.ts` | +1 import, `app.use(routeTiming())` right after `pinoHttp` |
| `packages/db/src/query-observer.ts` (new) | Threshold resolution, SQL redaction (string/dollar-quoted literals → `'?'`, 2,000-char cap), fingerprint, observer hook, default stderr JSON sink for processes without an observer (worker, scripts) |
| `packages/db/src/client.ts` | `createClient()`: subscribes to `query` events only when a threshold is configured; otherwise constructed exactly as before |
| `packages/db/src/index.ts` | Exports `setQueryObserver`, `resolveSlowQueryThresholdMs`, `redactSql`, `fingerprintSql` and types |
| `apps/api/src/__tests__/route-timing.test.ts` (new, 14 tests) | Matcher precedence + every registry route; histogram accuracy/bounds; env parsing; `createApp()` aggregation by template with no ids or query values; unmatched collapse; slow/query-heavy/sampled logging; slow Prisma query logged with route, `$1` placeholder and **without** the bound value; disabled = no-op |
| `scripts/perf/seed.ts` (new) | Deterministic fixture (`PERF_TASKS`, `PERF_SEED`, `PERF_ANCHOR`), TRUNCATE + bulk insert + `VACUUM ANALYZE`, mints bench sessions/PAT, writes the manifest to `$TMPDIR/openlinear-perf/` (0600) |
| `scripts/perf/bench.ts` (new) | Starts `apps/api/dist/index.js` (NODE_ENV=production) + fake LLM on 5050/5051, runs 40 scenarios × N rounds, joins server log lines, writes `bench-<label>.{json,md}`; `PERF_INSTRUMENTATION=sample|prod|off` |
| `scripts/perf/explain.ts` (new) | In-process `createApp()` with an in-memory capturing Prisma client (via the existing `globalThis.prisma` hook); EXPLAINs every SELECT of each route's warm call; counts statements cold / warm / after the response |
| `scripts/perf/apply-sql.ts` (new) | Runs a SQL file statement-by-statement against the perf DB only (same guard) |
| `scripts/perf/lib/*` (new) | Safety guard (loopback + `_test`, refuses a repo `.env`), PRNG/stable UUIDs/text, manifest, HS256 token minting, stats, fake OpenAI-compatible server |
| `scripts/perf/sql/*.bench.sql` (new) | Corrected copy of the manual index file, Phase 1 probe, drop script — perf DB only |
| `scripts/perf/{package.json,tsconfig.json}` (new) | ESM marker (not a workspace package) and a strict typecheck project |
| `apps/desktop-ui/components/web-vitals-reporter.tsx` (new) + `app/layout.tsx` (+import, +1 JSX line) | LCP/INP/CLS/FCP/TTFB via Next's built-in `useReportWebVitals` (no new dependency); console in dev or with `localStorage["openlinear-web-vitals"]="1"`; UUIDs masked in the route |
| `package.json` | `perf:seed`, `perf:bench`, `perf:explain`, `perf:sql`, `perf:typecheck`; the 4 new API/db files added to the `lint` list |
| `docs/reports/perf-baseline-2026-10-26/**` (new) | README (method, tables, EXPLAIN reading, index comparison), 10 bench JSON+MD pairs, 3 EXPLAIN label sets (largest file 512 KB, 5.2 MB total) |

Runtime knobs (all optional): `OPENLINEAR_ROUTE_TIMING=off`,
`OPENLINEAR_ROUTE_TIMING_SLOW_MS` (250 prod / 100 else), `OPENLINEAR_ROUTE_TIMING_MAX_QUERIES`
(25), `OPENLINEAR_ROUTE_TIMING_SAMPLE` (0), `OPENLINEAR_ROUTE_TIMING_SUMMARY_MS` (off),
`OPENLINEAR_SLOW_QUERY_MS` (250 prod / 100 else / off under NODE_ENV=test; `off` disables).

## 3. How to run

```bash
createdb -h 127.0.0.1 -p 54330 -U openlinear openlinear_perf_bench_test
(cd packages/db && DATABASE_URL=postgresql://openlinear@127.0.0.1:54330/openlinear_perf_bench_test pnpm exec prisma migrate deploy)
export PERF_DATABASE_URL=postgresql://openlinear@127.0.0.1:54330/openlinear_perf_bench_test
pnpm perf:seed                              # ~47 s; PERF_TASKS=50000 PERF_SEED=20261026 PERF_ANCHOR=2026-10-25
pnpm perf:seed -- --tokens-only             # re-mint bench credentials (12 h TTL)
pnpm --filter @openlinear/api build         # bench runs the bundle
pnpm perf:explain -- --label baseline       # ~1 min → docs/reports/perf-baseline-2026-10-26/explain/
pnpm perf:bench -- --label baseline         # ~5 min (3 rounds of ~90 s) → bench-baseline.{json,md}
pnpm perf:bench -- --label x --only search,activity --rounds 3 --iterations 100
PERF_INSTRUMENTATION=off pnpm perf:bench -- --label overhead-off --only shell.me,task.get
pnpm perf:sql scripts/perf/sql/phase0-hot-path-indexes.bench.sql   # then drop-…bench.sql
pnpm perf:typecheck
```

Re-seed before each labelled run (bulk/PATCH scenarios toggle state back, but activity and
outbox rows grow). Ports 5050/5051 (`PERF_API_PORT`, `PERF_FAKE_LLM_PORT`).

## 4. Baseline (headline run; Apple M5 Pro, 15 cores, 24 GiB, PG 14.17 stock settings, load mean 4.8)

Median across 3 rounds; client latency on loopback; queries = Prisma statements per request.

| Route (scenario) | n | p50 ms | p95 ms | p99 ms | queries |
|---|---:|---:|---:|---:|---:|
| GET /api/tasks?projectId (7,975-task project, 200/page) | 300 | 16.4 | 19.8 | 24.9 | 15 |
| GET /api/tasks?teamId | 300 | 12.8 | 15.6 | 17.5 | 10 |
| GET /api/tasks (all visible, 200/page) | 300 | 54.6 | 59.2 | 62.2 | 10 |
| GET /api/tasks?projectId page 100 (OFFSET 4,950) | 300 | 16.4 | 19.4 | 21.0 | 15 |
| GET /api/tasks/:id | 300 | 1.1 | 1.5 | 1.9 | 13 |
| PATCH /api/tasks/:id | 300 | 1.8 | 2.3 | 3.4 | 18 (+5 after response) |
| GET /api/search, selective term | 180 | 87.9 | 94.7 | 102.0 | 3.6 |
| GET /api/search, common term | 180 | 37.4 | 40.2 | 42.0 | 3 |
| GET /api/inbox?pageSize=50 | 300 | 33.0 | 38.1 | 40.0 | 7 |
| GET /api/inbox/count | 300 | 18.1 | 20.4 | 21.5 | 2 |
| GET /api/notifications?pageSize=100 (owner, 4,000) | 300 | 24.3 | 29.9 | 33.6 | 5 |
| GET /api/dashboard/tasks | 300 | 19.6 | 22.2 | 23.9 | 6 |
| GET /api/usage/summary | 300 | 38.3 | 43.1 | 45.1 | 3.6 |
| GET /api/usage/by-task | 300 | 52.7 | 61.9 | 66.5 | 4 |
| GET /api/activity?pageSize=50 | 300 | 166.8 | **184.8** | 191.7 | 4 |
| GET /api/workspaces/:id/structure (743 KB) | 300 | 13.7 | 16.6 | 18.2 | 9 |
| PATCH /api/tasks/bulk-status (100 tasks) | 60 | 55.5 | 65.1 | 72.6 | 127 (+~590 after response) |
| 100-task move via 100 × PATCH (today's board) | 15 moves | 216.6 | **238.4** | 238.4 | 3,416 per move |
| POST chat message (fake provider): full turn | 60 | 3.8 | 4.5 | 5.0 | 8.6 |
| ↳ first SSE event / first assistant delta | 60 | — | 2.0 / 4.0 | — | — |

All 40 scenarios, p95 spread per round, server-side p95 and bytes: README §Baseline.
Reproducibility: a second full run differed by median 11 % per scenario p95 (29/38 within
25 %); treat ±25 % as the noise floor. Instrumentation overhead (off vs prod defaults vs
log-every-request, 2 × 600 requests each): indistinguishable from noise; route match
0.38 µs/request.

## 5. Top 10 bottlenecks (evidence in `docs/reports/perf-baseline-2026-10-26/`)

1. **Scoped activity feed** — p95 185 ms. Parallel seq scan of 336,648 rows with an
   external merge sort spilling ~30 MB per worker (no index leads with `createdAt`), plus
   an exact `COUNT(*)` of all visible activity at 132 ms; 45 slow-query log hits.
   `explain/baseline/activity.feed.txt`.
2. **Search** — p95 95–97 ms for selective terms: seq scan of all 50k tasks with three
   `ILIKE '%q%'` arms (rare term: 50,143 rows removed to return 12). `search.rare.txt`.
3. **Board multi-select fan-out** — one 100-task move = 100 HTTP requests, 3,416
   statements, p95 238 ms; the existing bulk endpoint does it in 65 ms.
4. **Event/outbox write amplification** — bulk move of 100 tasks = 725 statements
   (133 in the request + 592 after it): per event `INSERT domain_events` + `teams` lookup +
   `linear_projects` lookup + `UPDATE … published_at` (201 events), and 100 single-row
   activity INSERTs. One PATCH = 24 statements. `explain/baseline/bulk.status-100.txt`.
5. **Visibility predicate shape** — `scopedTaskWhere` is an `OR` of correlated `EXISTS`
   branches with the caller's 73 team ids bound twice; Postgres cannot index it, so any
   route without a selective filter scans the whole visible set (~44k rows): board "all"
   59 ms, inbox list 38 ms / count 20 ms, dashboard 6 scans (~99 ms DB per request),
   notifications hash-join all 50k tasks three times.
6. **Exact COUNT on every page** — board, inbox, notifications (×2), activity (132 ms),
   archived: each list repeats its full scan to compute `total`.
7. **Usage analytics in Node memory** — `/usage/summary` loads 11,324 run rows to build
   a 30-bucket chart; `/usage/by-task` runs a second full `groupBy` only to count groups;
   both join all 50k tasks for visibility. p95 43 / 62 ms.
8. **Payload size** — 200-task board page = 407 KB (≈2 KB/task: description, persisted
   execution logs, relations), workspace structure 743 KB, default projects 105 KB.
   With 8 in flight board throughput rises only 2.7× (60 → 165 req/s) while p95 triples:
   JSON serialization on the single event loop.
9. **Offset pagination** — page 100 of the large project sorts 5,000 wide rows →
   external merge sort, 5 MB on disk (`board.deep-page.txt`).
10. **Per-request authorization statements** — `assertProjectAccess` re-reads 5 tables
    although the tenancy context is cached; `getUserTeamIds` is uncached; task GET = 13
    statements; PAT requests +2 (unthrottled `lastUsedAt` UPDATE). ~1–2 ms on loopback,
    but each is a network round trip against a managed database.

Not bottlenecks here: chat stream overhead before the model (first delta p95 4 ms),
task detail/comments (≤ 2 ms), project-filtered activity (5 ms), relation loading
(batched `IN`, no classic N+1 on reads).

## 6. Phase 1 candidates (expected impact; "measured" = probed on the bench DB)

| # | Change | Expected impact |
|---|---|---|
| 1 | Drop exact `COUNT` from feed/list routes (cursor + `take+1`, or capped/estimated total) | activity −128–142 ms (measured COUNT); inbox −14 ms; board −3–22 ms; notifications −13–23 ms DB |
| 2 | `activity_logs("createdAt" DESC, id)` | **measured:** feed page 70.7 → 0.11 ms. With #1: feed p95 185 → < 15 ms. Watch `activity.project` (plan changed, p95 5.2 → 7.9) |
| 3 | Trigram GIN on `tasks.description` in addition to title/identifier | **measured:** selective search p95 95 → 3.8 ms; common terms unchanged (39 ms) → rank + LIMIT or FTS next |
| 4 | Fix the manual index file (`projects` → `linear_projects`) and drop entries no query uses | **measured:** 9 of 10 indexes change no plan (board sorts on `createdAt`, inbox has no team predicate, activity indexes lead with team/user); keep only what EXPLAIN shows used |
| 5 | Visibility as a set: resolve visible project ids from the cached TenancyContext, filter `projectId = ANY($1)` (+ team-only branch); or use `tasks.workspaceId` with `(workspaceId, archived, …)` indexes. Mind the F-060 rationale for correlated EXISTS | inbox.count 20 → ~3 ms, board "all" 59 → ~10 ms, notifications 30 → ~5 ms, dashboard/usage scans shrink (estimate) |
| 6 | Inbox: one COUNT with `FILTER (WHERE NOT "inboxRead")`; partial index `WHERE NOT archived AND status IN ('done','cancelled')` | inbox.count ~−50 % |
| 7 | Dashboard: one aggregate with `FILTER` clauses instead of 6 scans | ~99 → ~20 ms DB per request |
| 8 | Usage: `date_trunc` + `SUM … GROUP BY day` in SQL; `count(DISTINCT "taskId")` for totals | removes 11k-row transfer and one full scan: summary 43 → ~20 ms, by-task 62 → ~35 ms |
| 9 | Batch event/outbox + activity writes (createMany; routing metadata from rows already loaded) | bulk 725 → ~10 statements, p95 65 → ~25 ms; PATCH 24 → ~12 |
| 10 | Board uses `PATCH /api/tasks/bulk-status` / bulk archive/delete (UI change) | **measured today:** 238 → 65 ms p95, 3,416 → ~130 in-request statements per 100-task move |
| 11 | Slim board projection (no `executionLogs`/`description`/`outcome` in lists) | 407 KB → ~80–100 KB per page; better concurrency scaling |
| 12 | Keyset pagination for board/archived | removes deep-offset disk sorts |
| 13 | Serve `assertProjectAccess`/team ids from the cached principal; throttle PAT `lastUsedAt` | −6 to −8 statements per request |

## 7. Decisions

- **Labels from `ROUTE_REGISTRY`** (method + path, static segments win), not `req.route`:
  Express 5 resets `baseUrl` on error paths, and the registry is parity-tested. Express
  fallback only for unregistered routers; unknown paths are `UNMATCHED`.
- **No new HTTP endpoint** for percentiles: a route needs a `registry.ts` row (not mine,
  parity test). Exposure is `getRouteTimingSnapshot()` plus an opt-in periodic log summary.
- **Statement counts** are per request via `AsyncLocalStorage`; verified that Prisma 7
  query events run in the caller's async context. Counts cover statements issued before
  the response finished; fire-and-forget writes are excluded (the EXPLAIN capture reports
  them separately as "after the response").
- **Query events only when enabled**; parameter values are never read; SQL literals are
  masked as defence in depth. Off by default under NODE_ENV=test.
- **Bench runs the production bundle** with NODE_ENV=production. Rate limiters are
  handled without code changes: synthetic `X-Forwarded-For` per request (trust proxy = 1)
  and rotation over 16 bench users with identical memberships; owner-pinned variants
  where per-user volumes differ.
- **Fixture credentials** (throwaway JWT secret, session tokens, PAT) live only in the
  0600 manifest outside the repo; seeding and SQL tools refuse anything but loopback
  `*_test`, with no override.
- **Manual index file not edited** (not mine): measured through a corrected bench copy.
- **Web vitals**: shipped as a standalone component + one-line mount because it needed
  no dependency; it logs only, no network reporting.
- **No migration, no index added to the schema.**

## 8. Validation

| Check | Result |
|---|---|
| `pnpm typecheck` (root) | 11/11 successful |
| `pnpm lint` (root) | 51 files, no diagnostics |
| `pnpm perf:typecheck` | clean |
| `TEST_DATABASE_URL=…/openlinear_perf_test pnpm --filter @openlinear/api test` | final run: **35 files, 324 passed, 2 skipped** (base 310 + 14 new) |
| API suite stability | 8 full runs: 3 clean, 5 with 1–3 intermittent failures (`route-inventory` PAT probes 401 / "socket hang up", 30 s hook lock waits in `idempotency`/`archive-selectors`, one `chat.streaming` and one `tasks` socket hang up). Controls with `OPENLINEAR_ROUTE_TIMING=off` and the new test file excluded: 7 runs, 2 with the same signatures; middleware on, new file excluded: 4 runs, 1. Same signatures with the middleware off, so pre-existing under shared-machine load; the middleware does not touch sockets. `route-timing.test.ts` alone 11/11 green, with `tasks.test.ts` 11/12 (one early paired run collected only `tasks.test.ts`; log not kept, not reproduced in the 17 later runs). After the one `route-timing` socket hang-up the test now uses one listening server per app |
| `pnpm --filter @openlinear/sidecar test` (imports `@openlinear/api/app`) | 38 files, 661 passed |
| `pnpm --filter @openlinear/desktop-ui typecheck` / `vitest run` | clean / 23 files, 242 passed (font and Chromium scroll checks not run) |
| Fixture determinism | identical md5 over tasks/comments/activity on re-seed |

## 9. Leftovers

1. **Frontend vitals baseline not captured** (app shell, board, grouped board,
   drag/drop): the reporter is in place; capturing needs a browser-driven run against
   the seeded API (two engineers were editing desktop-ui).
2. Sidecar execution timings (clone/fetch/worktree, event throughput) — out of scope.
3. Chat with attachments not measured (PDF extraction is broken in the bundle per ship.md).
4. `docs/PERFORMANCE_IMPROVEMENT_PLAN.md` still says Phase 0 "Not started" (not mine):
   done except dashboards and the frontend baseline.
5. Internal metrics endpoint for `getRouteTimingSnapshot()` (needs a registry row and an
   auth decision); OTLP export.
6. `packages/telemetry` `histogram()` keeps every sample in an array (unbounded); swap
   in `LatencyHistogram`.
7. **Security finding (not mine):** `pinoHttp` logs the raw `req.url`, so query-string
   credentials (`/api/events?token=` / `?ticket=`) reach the log although
   `req.query.token` is redacted. Confirmed in the bench API log
   (`"url":"/api/search?q=latency"`). Owner: events/auth.
8. `apps/api/package.json` `lint` list not updated (not mine); the root list covers the
   new files.
9. The API suite's load-sensitive flakes (§8).

## 10. Merge hazards

- `apps/api/src/app.ts`: +1 import, +`app.use(routeTiming())` directly after `pinoHttp`
  (needs `req.id`; must stay before the routers).
- `packages/db/src/client.ts` (client construction moved into `createClient()`) and
  `packages/db/src/index.ts` (+export block).
- Root `package.json`: the `lint` file list (hotspot for every engineer) and five
  `perf:*` scripts.
- `apps/desktop-ui/app/layout.tsx`: +import, `<WebVitalsReporter />` as the first child
  of `<body>`.
- Route labels come from `apps/api/src/registry.ts`; renaming registry paths renames
  labels, and an app route missing from the registry falls back to the Express template.
- Any test that mocks `@openlinear/db` with a factory lacking `setQueryObserver` and then
  calls `createApp()` will throw on the missing mock export (no current suite does).
- `scripts/perf/explain.ts` relies on the `globalThis.prisma` singleton hook in
  `packages/db/src/client.ts`; `scripts/perf/bench.ts` relies on the `route_timing` log
  field names (`evt`, `requestId`, `durationMs`, `queries`, `queryMs`).
- Scenario paths in `bench.ts` follow today's routes (`/api/tasks/bulk-status`,
  `/api/mcp/usage`, …); route changes by other engineers need matching edits there.
