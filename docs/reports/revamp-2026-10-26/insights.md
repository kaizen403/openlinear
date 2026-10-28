# W15b — insights (telemetry dashboards)

Date: 2026-10-27. Engineer id: `insights` (background agent).
Status: **implemented and locally validated; not committed, not deployed.**

## 1. Problem

PRD W15 asks for "traces, bounded telemetry, usage and budgets … bounded
labels/histograms; raw and normalized receipts; unknown prices explicit".
W15a shipped run budgets and usage receipts, but nothing showed how agent work
was going: success, recovery, verification, pull requests, duration, cost by
runner and model, and whether issues actually get done. This slice adds one
read-only **Insights** document per project and per workspace (7 / 30 / 90
days), a desktop page for each, and an MCP tool.

Out of scope: chat/title/voice model usage (`model_usage` is per user; the
caller's own chat usage stays on `GET /api/usage/models`), span traces, and
alerting.

## 2. API

| Route | Notes |
|---|---|
| `GET /api/projects/:id/insights?range=7d\|30d\|90d` | `assertProjectAccess('view')`; this project's issues. Default `30d`; unknown query keys refused (400 `VALIDATION_ERROR`). |
| `GET /api/workspaces/:id/insights?range=…` | `assertWorkspaceRole` (owner/admin/member/viewer); the workspace's projects minus those that explicitly deny the caller (what a member may read). A PAT bound to another workspace is refused by `assertWorkspaceRole`. |

Registry rows: scope `insights:read`, PAT scope `tasks:read` (same family as
`/api/usage/*`), enforcement `project` / `workspace`, binding `enforced`,
params `project` / `workspace` (the route inventory probes them with the
existing tenant-B fixtures; no new resource param). Files:
`apps/api/src/{schemas,services,routes}/insights.ts`, mounted in `app.ts`.

The document (`InsightsDocument`): `scope { kind, id, projects }`, `range
{ key, days, since, until }`, `runs { total, outcomes, finished, successRate,
verification, publication, duration, cost, tokens, byRunner, byModel, daily }`,
`delivery { created, completed, completedUntracked, cycleTime, openNow,
blockedNow, plans, daily }`, `notes` (one sentence per number that could be
read two ways). Daily series are UTC days, `days` points (≤ 90), today last.
Rates are 0–1 with 4 decimals, `null` when there is nothing to divide by;
percentiles are `percentile_cont` (linear interpolation), integer ms, `null`
without samples.

## 3. Metric definitions

- **Window**: from UTC midnight `days − 1` days ago until now.
- **Runs**: `agent_runs` started (claimed) in the window on issues currently in scope (the issue's current project, as in `/api/usage`).
- **Outcome**: in progress = `pending`/`running`; needs recovery = the run's attempt has `recoveryState = recovery_required` (lease sweeper) or `closeReason = recovery_required` (v2 engine), taking precedence over failed/cancelled; else the run status (succeeded / failed / cancelled).
- **Finished**: succeeded + failed + cancelled + needs recovery. **Success rate** = succeeded / finished.
- **Verification pass rate**: latest evidence per finished run (`execution_verifications` of its attempt, newest `finishedAt`): passed / (passed + failed); failed includes `error`; `skipped` and runs without evidence (`unverified`) are not in the rate.
- **Publication (PR) rate**: finished runs with a recorded `prUrl` / finished.
- **Duration**: `endedAt − startedAt` of finished runs (claim to end; clone/setup before the claim is not included); median and p90.
- **Known cost** (`knownUsd`): sum of the recorded `costUsd` of **finished** runs — the same runs `runsWithCost` counts (a running run's interim cost is not spend yet). Only a **positive** `costUsd` is a recorded price. **`unknownCostRuns`**: finished runs with no recorded cost (no price from the runner, unknown model price, or a free/local model — the control plane stores 0 as "not recorded"; a stored 0 or negative value also counts as not recorded). Never counted as $0; `coverage` none / partial / complete. Per runner / model / day, `costUsd` is **`null`** (unknown) when no finished run in that row recorded a price — never `0`.
- **Tokens**: sums of reported counts; `runsWithTokens` = runs that reported input or output tokens.
- **By runner / model**: runner = `runner`, else the lower-cased `agent` (≤ 64 chars); model ≤ 120 chars. The ten busiest keep their name, the rest fold into `(other)` (listed last) — a free-text model name cannot grow the response.
- **Created**: issues with `createdAt` in the window (archived and sub-issues included).
- **Completed**: issues done **now** whose last move to done is in the window, by that day. Move to done = a `task_status_changed` activity with `to: done`, or an execution attempt whose terminal projection was `done` (agent runs write no status activity).
- **`completedUntracked`**: done issues last changed in the window with no recorded move to done (created as done, or done before it was logged). Not in the series or cycle time.
- **Cycle time**: created → last move to done, for completed issues; median and p90.
- **Open now / blocked now**: unarchived todo/in-progress issues; blocked = with at least one blocker that is not done (cancelled blockers block, as in W17a). Current, not range-bound.
- **Plans**: `approvals` = plan revisions approved in the window, `plansApproved` = distinct plans among them, `awaitingReview` = the sidebar's rule (draft never approved, or latest revision newer than the approved one; archived excluded).

**Who writes cost and outcome** (2026-10-27 fix): the control plane's attempt
run callback stores only `costUsd > 0` and tokens ≥ 0. The legacy
`PATCH /api/agent-runs/:id` now refuses `costUsd` that is not a positive
finite number ≤ 100,000 and negative/fractional token counts (400
`VALIDATION_ERROR`), and only the run's own user (`agent_runs.userId`, set on
create) may patch it — another member with full task access gets 403
`AGENT_RUN_NOT_OWNER`. Before, a co-member could patch an owner's run to
`{ costUsd: -1000, status: 'failed' }` and turn the project's `knownUsd` from
9.5 into −993 and its success rate from 1 to 0.

## 4. Queries, indexes and budgets

Three statements, run in parallel (`Promise.all`), after the access check:

1. **Runs**: scope issues → `CROSS JOIN LATERAL` runs in the window (`agent_runs (taskId, startedAt)`) → `LEFT JOIN LATERAL` attempt (`execution_attempts.agentRunId` unique) → latest evidence (`execution_verifications (attemptId, …)` unique prefix, `LIMIT 1`). Labels ranked once, then one `GROUP BY GROUPING SETS ((), runner, model, day)` with `COUNT … FILTER`, sums and `percentile_cont`. ≤ 1 + 11 + 11 + 90 rows.
2. **Delivery**: done-issue candidates with `GREATEST(last activity to done, last attempt done)` via per-issue index probes (`activity_logs (taskId, createdAt)`, `execution_attempts (taskId, createdAt)`), `ROLLUP` by day with cycle-time percentiles; plus created per day from an **index-only scan** of `tasks (projectId, archived, createdAt)` (`archived IN (false, true)` makes both values index keys, so the window is an index range). ≤ 183 rows.
3. **Snapshot**: open/blocked (`task_dependencies (taskId, dependsOnTaskId)` probe, blocker by PK), plan approvals (`plans (projectId, …)` → `plan_revisions (planId, number)`), plans awaiting review, visible project count. 1 row.

**Every table is reached through an index from the scope**: a workspace is
walked project by project (`linear_projects (workspaceId)` → `tasks
(projectId)`), then per issue. Lookups are `LATERAL … OFFSET 0`: without the
fence, on the bench below the planner pulled the subqueries up and
hash-joined **sequential scans of all of `agent_runs` (29k rows) and
`execution_attempts` (34k)**, and for a workspace used the cross-tenant
`tasks_status_idx` (22k done issues of every tenant). That was a little faster
on the bench (where one workspace holds 80 % of all data and 86 % of all runs
fall in 90 days) but grows with other tenants' data; the fenced plan grows with
the scope only. After the change, EXPLAIN shows no sequential scan except on
`linear_projects` (100 rows) and `project_access` (7 rows), which the planner
rightly scans whole at that size.

**The done pre-filter**: candidates are done issues with `updatedAt ≥ since − 1
day`. Every move to done bumps `updatedAt` (Prisma `@updatedAt`, also on
`updateMany` — the PATCH/bulk/chat paths and the fenced agent terminal write;
the only raw `UPDATE tasks` writes `executionLogs`), so no completed issue is
missed; the day of slack covers the activity row written just after the
update.

**No index was missing**, so there is **no migration** (no drift to check).

**Budgets** (bench: `pnpm perf:seed` 50k issues, 33,941 runs over 120 days,
336,648 activity rows, plus 33,941 attempts with 10 % needing recovery, 23,582
verification records, 12,314 dependencies, 3,000 plans / 6,000 revisions; PG 14,
laptop; wall time of the three parallel statements, warm):

| Scope | 7d | 30d | 90d |
|---|---|---|---|
| Project, 7,975 issues (4,695 runs in 90d) | 18 ms | 22 ms | 35 ms |
| Workspace, 80 projects / 39,600 issues (22,976 runs in 90d) | 76 ms | 112 ms | 219 ms |

Statement budget per request (route timing, tenancy cache off in tests):
**4 (session + principal) + 1 (access check) + 3**, whatever the range —
`insights.test.ts` asserts it for both routes and two ranges. Cost model:
O(issues in scope) index probes + O(runs in window) attempt/evidence probes;
independent of other tenants and of history outside the window.

## 5. Desktop

- **Project → Insights** (`/projects/insights?id=…&name=…`) and **Usage → Workspace insights** (the existing `/usage` page gains a "Workspace insights | My usage" switch; workspace insights is the default view, "My usage" is the page as before).
- `components/insights/insights-panel.tsx`: range switch (7 / 30 / 90 days, `radiogroup`), keeps the previous range on screen while the next loads, skeleton, error with Try again, empty state when nothing happened and nothing is open.
- `components/insights/insights-view.tsx`: stat tiles (runs, success, verification, PR rate, median/p90 duration, known cost with "N runs with no recorded price are not included", tokens, cached input; created, completed with untracked note, cycle time, blocked now of open, plans), outcome bar, runs per day (stacked by outcome), known cost per day (unknown-cost runs in the table), by-runner and by-model tables, created vs completed per day, and "How these numbers are counted" (the `notes`). A row, day or range with no recorded price reads **"unknown"** (`formatKnownCost`; `—` when nothing ran), never "$0.00"; the cost chart's per-day tooltip and table say "unknown" too (`ChartSeries.text`).
- `components/insights/insights-charts.tsx`: plain CSS charts (no dependency). Text equivalents everywhere: `aria-label` summary per chart, labelled legend with totals for ≥ 2 series, per-day tooltip, "Show as table" with every value; outcome colours never carry meaning alone (legend + counts + %). Marks: ≤ 24px columns, 4px rounded tops, 2px gaps between segments and grouped bars. Outcome colours are the app's tones, ordered succeeded / cancelled / failed / needs recovery / in progress so green and red are never adjacent (validator: normal-vision ΔE ≥ 16.6; CVD 7.8 is in the band that needs the secondary encoding above).
- `lib/api/insights.ts`: types, fetchers, formatting, and `insightsKeys` (`['ol','project',id,'insights',range]`, `['ol','ws',id,'insights',range]`, so scope-wide invalidation reaches them). `staleTime` 60 s.
- Snapshot with synthetic data: `insights-workspace.png`.

## 6. MCP (31 tools)

`openlinear_get_insights` (read-only, `read`/`tasks:read`): exactly one of
`projectId` / `workspaceId`, `range` (default 30d), `includeDaily` (default
false, keeps answers short). Output is the document with `unknownCostRuns`
described as "never counted as $0"; per runner / model / day `costUsd` is
`number | null` (null = unknown; decoder and output schema nullable). Server instructions mention it; fake API
route + view, contract test (scope/range forwarding, unknown cost, daily
toggle, both/neither/bad range refused), protocol lists; catalogue
regenerated; docs site group, nav entry and page (`/tools/insights`).

## 7. Validation (local, 2026-10-27, DB `openlinear_insights_test`)

| Suite | Result |
|---|---|
| API | full suite **959 + 3 skipped, 83 files, exit 0** (baseline at start 829 + 3 / 79; the rest are other agents' new suites), then one more insights test → `insights.test.ts` **21**: window math; outcomes incl. both recovery sources; latest evidence; PR rate; percentiles; known vs unknown cost; runner fallback to lower-cased agent; daily UTC buckets; ranges; label cap (12 runners/models → 10 + `(other)`, 120-char truncation); created (archived, sub-issues); completed by last move (activity and agent), reopened excluded, untracked, cycle time; `updateMany` bumps `updatedAt` (the pre-filter's premise); open/blocked (cancelled blocker, archived excluded); plan approvals/awaiting; empty project; workspace aggregate; denied project left out; viewer/denied/stranger/other-workspace access; PAT `tasks:read` vs `projects:read`; range validation; statement budget. Route inventory 14, PAT policy 47, authorization matrix 4 (existing `project` / `workspace` fixtures cover the new rows). |
| desktop-ui | 1228 + 9 skipped (exit 0); `components/insights/insights.test.mjs` 13 |
| MCP | 114 (+1 contract test) |
| typecheck | api, desktop-ui, mcp, mcp-docs: 0 |
| migration / drift | none added (no schema change) |
| cost fix (2026-10-27, DB `openlinear_insfix_test`) | `insights.test.ts` **22** (+ stored 0 / negative unknown, running run's cost excluded, null per-row cost), `agent-runs.test.ts` **6** (+ co-member PATCH 403 with insights unchanged, zero/negative/out-of-range cost and negative tokens 400, owner PATCH 200, unknown run 404); with route inventory 14, PAT policy 47, authorization matrix 4, principal context 12, deny surfaces 16, events access 10, events policy 11: **142 / 9 files**. desktop `insights.test.mjs` **15**; MCP **119**; typecheck api / desktop-ui / mcp 0; catalogue regenerated (unchanged: the description stays the same). |
| biome | `apps/api/src/{services,routes,schemas}/insights.ts`, `__tests__/insights.test.ts`, `apps/mcp/src`, `apps/mcp/test`: clean |

## 8. Limits / open

- Attribution is the issue's **current** project; a run on an issue moved later counts in the new project (same as `/api/usage`).
- Workspace insights cover the workspace's projects only (project-less team issues are not in any workspace view).
- Chat/title/voice usage is not in insights (per-user ledger; workspace-wide exposure needs an owner decision).
- `unknownCostRuns` cannot tell "free model" from "unknown price": the control plane stores a reported 0 as no cost. Recording `costBasis` from the v2 engine would separate them.
- The run owner can still rewrite their own run's status/cost through the legacy PATCH, including a run the control plane manages (one with an execution attempt). Refusing PATCH on attempt-managed runs would close that; no in-tree caller uses the PATCH today (`packages/api-client` `updateAgentRun` has no callers).
- Duration starts at the claim (preparation/setup time is not measured here; the run journal has it).
- Done before activity logging existed → `completedUntracked`, never guessed.
- The largest bench workspace (39,600 issues, 90d) answers in ~220 ms; a much larger workspace would want a cache (or a per-day rollup table) — not needed at current sizes.

## 9. Lines needed in files owned by others

- `components/layout/sidebar.tsx`: `const isInsightsActive = pathname === "/projects/insights" && searchParams.get("id") === project.id` and a sub-nav `Link` to `/projects/insights?id=…&name=…` with `<BarChart3 className="w-3.5 h-3.5 flex-shrink-0" />` and `Insights` (same shape as Recurring).
- Root `package.json` lint list: `apps/api/src/services/insights.ts apps/api/src/schemas/insights.ts apps/api/src/routes/insights.ts apps/api/src/__tests__/insights.test.ts`.
- Optional `lib/query/keys.ts`: `insights: { project: (projectId, range) => ['ol','project',projectId,'insights',range], workspace: (workspaceId, range) => ['ol','ws',workspaceId,'insights',range] }` (same shapes as `insightsKeys`).
- Optional `lib/api/routes.test.mjs`: module `insights: await import('./insights.ts')`, rows for `fetchProjectInsights('p1','7d')` → `GET /api/projects/p1/insights?range=7d` and `fetchWorkspaceInsights('w1','30d')` → `GET /api/workspaces/w1/insights?range=30d` (cloud), and `NOT_REQUESTS` for `insights.formatRate/formatUsd/formatCount/formatDuration/formatDay/plural`. (`insights.test.mjs` already checks both paths land on the cloud API.)
- `apps/api/src/registry.ts` row `PATCH /api/agent-runs/:id`: guard text should read `"assertTaskAccess('full') + run owner (userId)"` (route-inventory does not compare it; owned by another engineer).
- AGENTS.md MCP table: `openlinear_get_insights` — project/workspace insights over 7/30/90 days (runs, rates, duration, known cost with unknown-price runs counted, delivery); tool count 31.
