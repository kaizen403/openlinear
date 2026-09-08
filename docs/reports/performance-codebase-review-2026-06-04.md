# OpenLinear Performance Codebase Review

Date: 2026-06-04
Agent: Codex
Goal: Review the codebase for P95 readiness and produce a concrete performance improvement plan.

## Scope

This was a static, line-level codebase review across tracked source, configuration, documentation, tests, schemas, scripts, and package manifests. Runtime output, vendored dependency directories, `.git`, generated build artifacts, and untracked uploads were excluded from the performance scope.

Inventory used for the review:

- 989 tracked files in git.
- 121,194 tracked text lines across TypeScript, TSX, JavaScript, Rust, Prisma, SQL, Markdown, JSON, TOML, YAML, CSS, and shell files.
- 368,996 total tracked lines when lockfiles and other tracked artifacts are included.

Review method:

- Repo-wide inventory and line counts with `git ls-files`, `wc`, and targeted file enumeration.
- Static scans with `rg` for database access, pagination, `include`/`select`, timers, EventSource usage, cache headers, rate limiting, JSON parsing, console logging, and type escape hatches.
- Manual line reads of the hot paths: API routes/services, Prisma schema, desktop board, SSE providers, chat streaming, sidecar execution, batch execution, repository cloning, and usage/reporting routes.
- Cross-check against existing docs and `ISSUES.md`.

Important boundary:

This report does not claim production P95 latency numbers yet. No production RUM, Lighthouse CI, k6/autocannon load test, or production database `EXPLAIN ANALYZE` evidence was found in application code. The findings below are code-path risks that are likely to hurt P95 at scale and should be validated with measurements in the first plan phase.

## P95 Standard Used

OpenLinear should treat these as the initial P95 budgets until real production baselines replace them:

| Area | Target |
| --- | --- |
| API health, no DB dependency | p95 < 50 ms |
| Authenticated lightweight API routes | p95 < 120 ms |
| Board first task page | p95 < 250 ms server time |
| Project/team/workspace lists | p95 < 200 ms server time |
| Search | p95 < 300 ms for scoped workspace search |
| Inbox count/list | p95 < 150 ms count, < 250 ms list |
| Chat stream first byte | p95 < 500 ms before model latency |
| Board drag/drop interaction | INP < 200 ms, visual response < 100 ms |
| Authenticated app LCP | < 2.5 s |
| CLS | < 0.1 |
| Execution start, warm repo | p95 < 2 s before model call |

## Executive Result

OpenLinear is not P95-ready yet for large workspaces, high task counts, or sustained AI execution streams.

The codebase has good foundations: strict TypeScript conventions, bounded task page size, cursor pagination in several chat/tool paths, scoped SSE delivery, pino logging, API rate limits, React virtualized log rendering in one area, and sidecar delta buffering. The main P95 risks are concentrated in four areas:

1. Board actions and render paths scale linearly with selected task count.
2. Core task, inbox, activity, analytics, and search queries lack the composite or text indexes needed by their filters and ordering.
3. Auth/session middleware performs database work on every authenticated request.
4. Sidecar execution emits frequent events through database lookup paths and stores unbounded in-memory logs.

## Strengths Already Present

- Task API limits page size to 200 in request schemas (`apps/api/src/schemas/pagination.ts`, `apps/api/src/schemas/tasks.ts`).
- Chat sessions and messages use cursor pagination (`apps/api/src/routes/chat.ts`).
- Task list service has cursor-aware helper paths even though the HTTP board route still uses page pagination (`apps/api/src/services/tasks.ts`).
- SSE delivery is scoped by user, team, workspace, project, chat session, or task instead of always broadcasting globally (`apps/api/src/sse.ts`).
- Sidecar delta buffering reduces frontend update frequency for OpenCode text deltas (`apps/sidecar/src/services/delta-buffer.ts`).
- Frontend execution logs use `useSyncExternalStore` and cap displayed task logs (`apps/desktop-ui/lib/execution-state-store.ts`).
- API has a global rate limiter and JSON body limit (`apps/api/src/app.ts`).

## High Priority Findings

### 1. Board bulk actions fan out into one HTTP request per task

Severity: Critical for P95 under multi-select, batch moves, and high task counts.

Evidence:

- `apps/desktop-ui/components/board/use-kanban-board.ts:323` updates selected task status optimistically.
- `apps/desktop-ui/components/board/use-kanban-board.ts:338` sends `Promise.all(ids.map(...PATCH /api/tasks/:id...))`.
- `apps/desktop-ui/components/board/use-kanban-board.ts:384` bulk delete sends one `DELETE /api/tasks/:id` per task.
- `apps/desktop-ui/components/board/use-kanban-board.ts:396` bulk status change sends one `PATCH /api/tasks/:id` per task.
- `apps/desktop-ui/components/board/use-kanban-board.ts:401` moves a batch group by gathering all task IDs and calling the same fan-out path.
- `apps/api/src/services/tasks.ts:365` already has `bulkUpdateTaskStatus`.
- `apps/api/src/services/tasks.ts:453` already has `bulkArchiveTasks`.
- `apps/api/src/routes/tasks.ts:63` exposes only bulk create, not bulk status/archive/delete.

Impact:

Moving 100 tasks can produce 100 HTTP requests, 100 auth/session checks, 100 database updates, 100 activity logs, and 100 SSE events. That pattern will dominate p95 and p99 latency even if each individual request is fast.

Recommendation:

- Add route-level bulk endpoints for status/archive/delete.
- Reuse existing service functions instead of looping in the UI.
- Emit one aggregate event plus targeted task updates where required.
- Keep optimistic UI behavior, but reconcile once from the bulk response.

### 2. Task list, inbox, and search queries do not have matching indexes

Severity: Critical for large workspaces.

Evidence:

- Task list route uses page/pageSize offset pagination (`apps/api/src/routes/tasks.ts:47`).
- Task list service counts and fetches with `skip`, `take`, and `updatedAt desc` ordering (`apps/api/src/services/tasks.ts:781`).
- Task search uses `contains` over title, description, and identifier (`apps/api/src/services/tasks.ts:110`).
- Prisma Task indexes include `[teamId, archived]`, `[projectId, archived, createdAt]`, `[status]`, `[assigneeId]`, and `[creatorId]` (`packages/db/prisma/schema.prisma:192`).
- There is no composite index matching common board ordering by `updatedAt desc, id`.
- Inbox list filters by status, archived, teamId, inboxRead, and orders by `updatedAt desc` (`apps/api/src/routes/inbox.ts:59`).
- Search route uses case-insensitive `contains` across tasks, projects, and teams (`apps/api/src/routes/search.ts:84`).

Impact:

Offset pagination and unmatched sort/filter patterns become slow as task count grows. Search can devolve to sequential scans. Counts can become a repeated expensive tax on board loads.

Recommendation:

- Add composite indexes for common list paths:
  - `Task(projectId, archived, updatedAt, id)`
  - `Task(teamId, archived, updatedAt, id)`
  - `Task(teamId, archived, status, inboxRead, updatedAt, id)`
  - `Task(projectId, status, archived, updatedAt, id)` if board filtering by project and status is common.
- Convert board list to cursor pagination where practical.
- Add Postgres full-text or trigram indexes for search.
- Run `EXPLAIN ANALYZE` against production-like data before and after the migration.

### 3. Auth/session middleware performs database reads and writes on every request

Severity: High.

Evidence:

- JWT middleware verifies the token, hashes it, checks session revocation, and touches the session on every authenticated request (`apps/api/src/middleware/auth.ts:82`).
- `isSessionRevoked` performs a `findUnique` (`apps/api/src/services/sessions.ts:63`).
- `touchSession` performs `updateMany` (`apps/api/src/services/sessions.ts:56`).
- PAT auth looks up the token hash and best-effort updates last used time on every PAT request (`apps/api/src/services/pats.ts:47`, `apps/api/src/services/pats.ts:63`).

Impact:

Every UI request, SSE reconnect, and API client call has an added database read. Many requests also trigger a write. Bulk fan-out amplifies this heavily.

Recommendation:

- Cache session revocation status for a short TTL, such as 30 to 60 seconds.
- Throttle `lastActiveAt`/`lastUsedAt` updates to once every 5 to 15 minutes per token.
- Keep logout/revocation correctness by invalidating cache on revoke/logout paths.
- Measure auth middleware latency separately in request logs.

### 4. SSE and execution event paths can amplify database lookups and reloads

Severity: High.

Evidence:

- `broadcastToTaskById` loads task metadata from the database for task-scoped events (`apps/api/src/sse.ts:150`).
- Sidecar progress and log events call task broadcast helpers frequently (`apps/sidecar/src/services/execution/state.ts:216`, `apps/sidecar/src/services/execution/state.ts:239`, `apps/sidecar/src/services/execution/state.ts:249`).
- Frontend reconnect handling triggers full task reload, active repository refresh, and batch reconciliation on `connected` (`apps/desktop-ui/hooks/use-task-sse.ts:198`).
- SSE provider can connect to both API and sidecar stream URLs when they differ (`apps/desktop-ui/providers/sse-provider.tsx:268`).

Impact:

During active executions, log/progress volume can create repeated DB reads and frontend reload storms. Reconnects can make this worse by reloading the whole board.

Recommendation:

- Store task routing metadata in active execution state after the initial task load.
- Broadcast progress/logs using cached user/team/workspace/project routing where possible.
- Debounce `connected` reconciliation and avoid full board reload unless event versioning indicates stale state.
- Confirm whether API and sidecar streams are both needed in each runtime mode and document the intended behavior.

### 5. Project, team, and workspace structure routes are unbounded by default

Severity: High for growing tenants.

Evidence:

- Project list route is unpaginated and can include teams, repository, workspace, and counts (`apps/api/src/routes/projects.ts:78`, `apps/api/src/services/projects.ts:18`).
- Team list route is unpaginated and can include members/tasks/projects depending on fields (`apps/api/src/routes/teams.ts:69`).
- Workspace structure returns a full graph with members, projects, teams, and team members (`apps/api/src/services/workspaces.ts:372`, `apps/api/src/services/workspaces.ts:455`).
- Frontend project and team providers wisely request thin field sets in some places, but the routes still allow heavy defaults.

Impact:

These routes will degrade as customers add projects, teams, and members. They also increase payload size and JSON serialization cost.

Recommendation:

- Make thin field projections the default.
- Add pagination or explicit `include` gates for heavy relationship graphs.
- Add response byte-size logging for these routes.
- Cache stable workspace/team metadata with short TTLs.

### 6. Analytics routes materialize too much data in application memory

Severity: High for usage-heavy tenants.

Evidence:

- Usage summary loads all recent agent run rows to build a daily chart in memory (`apps/api/src/routes/usage.ts:52`).
- Usage by task uses `groupBy` for one page and a second full `groupBy` to count total groups (`apps/api/src/routes/usage.ts:132`, `apps/api/src/routes/usage.ts:146`).
- MCP usage summary loads recent tool call rows to build daily usage in memory (`apps/api/src/routes/mcp-usage.ts:48`).

Impact:

Usage pages become slower as historical events grow. The total group count path is especially risky because it can load all grouped keys just to count them.

Recommendation:

- Move daily usage aggregation to SQL with `date_trunc` or a materialized summary table.
- Use SQL `count(distinct task_id)` for total grouped counts.
- Add date-window caps and default limits.

### 7. Board rendering loads and renders every fetched task

Severity: Medium to high, depending on tenant size.

Evidence:

- Board fetch currently requests up to 200 tasks and does not fetch additional pages (`apps/desktop-ui/components/board/use-kanban-board.ts:242`).
- Board columns map through all loaded tasks and render draggable cards (`apps/desktop-ui/components/board/kanban-board.tsx:338`, `apps/desktop-ui/components/board/kanban-board.tsx:504`).
- Assignee grouped view maps members and tasks in nested render loops (`apps/desktop-ui/components/board/kanban-board.tsx:434`).
- Each active task card owns a one-second interval for live duration display (`apps/desktop-ui/components/task-card.tsx:55`).
- `use-kanban-board` calls `useBatchExecution` twice, including one placeholder call that is later overridden (`apps/desktop-ui/components/board/use-kanban-board.ts:159`, `apps/desktop-ui/components/board/use-kanban-board.ts:179`).

Impact:

The board is capped before it becomes complete, and it still risks expensive renders at the cap. Future increases in page size would worsen interaction latency.

Recommendation:

- Use virtualized columns or a virtualized grouped list.
- Add cursor pagination or load-by-column.
- Memoize grouped task buckets.
- Replace per-card active duration intervals with one shared ticker.
- Remove the duplicate `useBatchExecution` hook call.

### 8. Chat attachments can be large and are parsed in the API process

Severity: Medium to high.

Evidence:

- Chat attachment upload limit is 50 MB (`apps/api/src/routes/chat-attachments.ts:15`).
- Chat service reads image, PDF, and text files from disk during message handling (`apps/api/src/services/chat.ts:319`).
- Images are read fully and base64 encoded (`apps/api/src/services/chat.ts:327`).
- PDFs are read fully and parsed inline (`apps/api/src/services/chat.ts:333`).
- Text files are read fully and sliced after reading (`apps/api/src/services/chat.ts:340`).

Impact:

Large attachments can block the API process, increase memory pressure, and delay chat stream first byte.

Recommendation:

- Lower limits per MIME type.
- Extract text asynchronously at upload time or in a worker.
- Store attachment metadata and extracted previews.
- Avoid base64 encoding large images in the hot request path where possible.

### 9. Single-task execution reclones repositories and uses temporary storage

Severity: Medium to high for execution latency and resource use.

Evidence:

- `cloneRepository` deletes any existing path and shallow-clones for task execution (`apps/sidecar/src/services/execution/git.ts:77`).
- Batch/worktree services already have a bare-repo plus worktree pattern (`apps/sidecar/src/services/worktree.ts:8`, `apps/sidecar/src/services/worktree.ts:96`).
- Default repo storage uses `/tmp/openlinear-repos` (`apps/sidecar/src/services/repo-storage.ts:3`).

Impact:

Warm executions cannot benefit from cached repos. Temporary storage can be wiped or fill unexpectedly. Clone latency can dominate execution start p95.

Recommendation:

- Reuse the bare clone/worktree strategy for single-task executions.
- Add cleanup, quotas, and age-based pruning.
- Move production storage to a managed volume.
- Measure cold clone, warm fetch, and worktree creation separately.

### 10. In-memory execution state and log buffers have incomplete bounds

Severity: Medium.

Evidence:

- Frontend execution store caps logs per task but keeps maps by task ID in memory (`apps/desktop-ui/lib/execution-state-store.ts:6`).
- Sidecar execution logs append to in-memory arrays (`apps/sidecar/src/services/execution/state.ts:249`).
- Batch shared state stores active batches, session mappings, completing sessions, and task logs in process memory (`apps/sidecar/src/services/batch/shared.ts:17`).
- Batch logs append to in-memory arrays (`apps/sidecar/src/services/batch/shared.ts:63`).

Impact:

Long sessions, many active executions, or frequent logs can create memory pressure. Sidecar restarts also lose live execution state.

Recommendation:

- Add global LRU limits and per-user caps.
- Persist structured logs incrementally rather than writing only full JSON blobs at completion.
- Consider Redis or database-backed queues for active execution state if multi-instance sidecar is planned.

### 11. Batch routes use avoidable sequential ownership checks

Severity: Medium.

Evidence:

- `assertTaskOwned` performs a task lookup and access check per task (`apps/sidecar/src/routes/batches.ts:41`).
- Batch start calls the ownership check through guards (`apps/sidecar/src/routes/batches.ts:77`).
- Active batch listing loops active batches and task IDs to confirm ownership (`apps/sidecar/src/routes/batches.ts:84`).

Impact:

The batch limit is 20, so this is not the top bottleneck today, but it is avoidable and noisy under concurrent usage.

Recommendation:

- Replace per-task checks with a single bulk task query scoped to the user/team access model.
- Cache active-batch ownership metadata while the batch is live.

### 12. Measurement pipeline is missing

Severity: Critical for proving P95 compliance.

Evidence:

- Repo scan found dependency-level OpenTelemetry mentions in the lockfile, but no application-level RUM, APM, Lighthouse CI, or web-vitals pipeline wired into app code.
- API request logging exists, but no route-level p95 dashboard or slow-query budget was found.
- Existing scripts include useful local/dev tooling, but no complete production-like performance harness was found for board/API/sidecar flows.

Impact:

The team cannot know whether P95 standards are met after each change.

Recommendation:

- Add route timing metrics, slow query logs, and web-vitals collection.
- Add repeatable load tests for board list, search, inbox, chat TTFB, and bulk task moves.
- Add dashboards and alert thresholds before claiming P95 compliance.

## Secondary Findings

- Console logging exists in several browser/server paths. This is usually not a direct P95 blocker, but noisy logs make production performance diagnosis harder.
- Some frontend API response typing uses broad `any` in board settings fetch (`apps/desktop-ui/components/board/use-kanban-board.ts:306`), which weakens payload discipline.
- `/health` checks the database on every request (`apps/api/src/app.ts:225`). Keep a deep health endpoint, but add a lightweight liveness endpoint that does not depend on Postgres.
- Static `/uploads` are served from the API process (`apps/api/src/app.ts:216`). This should move to object storage or a CDN path as attachment volume grows.
- Compression is not visible in the Express app. It may be handled by edge/proxy infrastructure, but should be verified and documented.

## Immediate P95 Risks By User Flow

| Flow | Current risk | Main files |
| --- | --- | --- |
| Board load | Offset pagination, heavy includes, count, missing indexes | `apps/api/src/services/tasks.ts`, `packages/db/prisma/schema.prisma` |
| Multi-select status move | N API calls and N DB writes/events | `apps/desktop-ui/components/board/use-kanban-board.ts`, `apps/api/src/routes/tasks.ts` |
| Search | Case-insensitive contains without text index | `apps/api/src/routes/search.ts` |
| Inbox | Count/list filters lack matching composite index | `apps/api/src/routes/inbox.ts`, `packages/db/prisma/schema.prisma` |
| Chat with files | Inline large file read/parse/base64 before stream | `apps/api/src/services/chat.ts` |
| AI execution progress | Frequent broadcast path can do repeated DB lookups | `apps/api/src/sse.ts`, `apps/sidecar/src/services/execution/state.ts` |
| Single task execution | Fresh clone per task | `apps/sidecar/src/services/execution/git.ts` |

## Recommended Validation

Before implementing changes:

- Capture baseline API route p50/p95/p99 and response bytes for:
  - `GET /api/tasks`
  - `PATCH /api/tasks/:id`
  - `GET /api/projects`
  - `GET /api/teams`
  - `GET /api/search`
  - `GET /api/inbox`
  - `POST /api/chat/:sessionId/messages`
- Capture frontend web vitals for login, app shell, board load, drag/drop, and grouped view.
- Seed a performance database with at least:
  - 1 workspace
  - 10 teams
  - 100 projects
  - 50,000 tasks
  - 500,000 activity/log/usage rows
  - 10,000 chat messages
- Run `EXPLAIN ANALYZE` for all task, inbox, search, usage, and activity queries listed in this report.
- Run sidecar execution benchmarks for cold clone, warm fetch, worktree setup, execution event throughput, and log persistence.

## Conclusion

The highest-return work is not a broad rewrite. The first P95 wins should come from measurement, database indexes, auth write throttling, bulk task routes, board render/pagination fixes, and sidecar event/log routing. Those changes target the paths most likely to dominate real user latency while preserving the current architecture.
