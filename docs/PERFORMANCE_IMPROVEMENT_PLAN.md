# OpenLinear P95 Performance Improvement Plan

Date: 2026-06-04
Related report: `docs/reports/performance-codebase-review-2026-06-04.md`

## Objective

Bring OpenLinear to measurable P95 readiness for large workspaces and active AI execution workloads. The plan starts with measurement, then removes the highest-amplification bottlenecks in API, database, frontend, and sidecar execution paths.

## Success Criteria

OpenLinear can claim P95 readiness when all of the following are true in a production-like environment:

- Board first page server p95 is under 250 ms at 50,000 tasks per workspace.
- Board drag/drop INP remains under 200 ms with 200 visible tasks.
- Bulk move/archive/delete of 100 tasks completes with one API call and p95 under 500 ms server time.
- Auth middleware adds less than 25 ms p95 overhead on warm cache.
- Search p95 is under 300 ms for workspace-scoped task/project/team search.
- Inbox count p95 is under 150 ms.
- Chat stream first byte is under 500 ms before model latency for messages without large attachments.
- Warm single-task execution starts in under 2 s before the model call.
- API, database, frontend web-vitals, and sidecar execution metrics are visible in dashboards.
- Load-test and query-plan regressions fail CI or block release promotion.

## Phase 0: Baseline And Instrumentation

Target duration: 1 to 2 days

Status: Not started

Deliverables:

- Add route timing logs with route name, status code, response bytes, user scope, and duration buckets.
- Add Prisma slow-query logging for queries over 100 ms in development and over 250 ms in production.
- Add web-vitals collection for LCP, INP, CLS, FCP, and TTFB in the desktop web UI.
- Add a lightweight liveness endpoint that does not query Postgres, while keeping a deep readiness endpoint.
- Add repeatable benchmark scripts for board load, search, inbox, bulk moves, and chat stream TTFB.
- Add seed data or fixtures for 50,000-task performance testing.

Acceptance checks:

- Baseline p50/p95/p99 is captured for the key routes listed in the review report.
- Baseline frontend vitals are captured for app shell, board, grouped board, and drag/drop.
- Baseline `EXPLAIN ANALYZE` output is saved for task list, inbox, search, usage, and activity queries.

## Phase 1: Database And Query Quick Wins

Target duration: 2 to 4 days

Status: Not started

Deliverables:

- Add Prisma migration for task list and inbox composite indexes:
  - `Task(projectId, archived, updatedAt, id)`
  - `Task(teamId, archived, updatedAt, id)`
  - `Task(teamId, archived, status, inboxRead, updatedAt, id)`
  - `Task(projectId, status, archived, updatedAt, id)` if query plans prove it helps.
- Add missing activity-log indexes for common `teamId`, `userId`, and created-at filters.
- Replace search `contains` scans with Postgres full-text search or trigram indexes.
- Convert usage summary daily charts to SQL aggregation instead of loading all rows into application memory.
- Replace usage-by-task total group counting with SQL `count(distinct task_id)`.
- Add query-plan regression snapshots for the new indexes.

Acceptance checks:

- Task list query uses index scans on the seeded performance database.
- Inbox count/list uses matching composite indexes.
- Search no longer performs sequential scans for common workspace queries.
- Usage summary memory stays flat as historical rows grow.

## Phase 2: API Request Consolidation And Payload Control

Target duration: 3 to 5 days

Status: Not started

Deliverables:

- Add `PATCH /api/tasks/bulk-status` using the existing `bulkUpdateTaskStatus` service.
- Add bulk archive/delete endpoints using existing bulk service paths.
- Update frontend board multi-select, batch group drag, and bulk actions to call the new endpoints.
- Emit one aggregate SSE event for bulk operations, with targeted task updates only where needed.
- Make thin field projections the default for project, team, and workspace list routes.
- Add explicit pagination or include gates for heavy workspace structure responses.
- Add response byte-size logs for task, project, team, workspace, and search routes.
- Cache or throttle settings/repository metadata calls that currently reload during reconnects.

Acceptance checks:

- Moving 100 tasks creates one API request from the browser.
- Bulk update server p95 is under 500 ms on seeded data.
- Project/team/workspace list payloads are bounded and documented.
- SSE event count for a bulk operation is predictable and capped.

## Phase 3: Auth, Session, And SSE Load Reduction

Target duration: 2 to 4 days

Status: Not started

Deliverables:

- Add short TTL caching for JWT session revocation checks.
- Throttle session `lastActiveAt` updates to once every 5 to 15 minutes per token.
- Throttle PAT `lastUsedAt` updates to once every 5 to 15 minutes per token.
- Invalidate auth caches on logout, revocation, and PAT revoke.
- Cache task routing metadata for active execution progress/log broadcasts.
- Debounce frontend `connected` reconciliation and prevent duplicate full board reloads.
- Confirm and document API versus sidecar SSE stream ownership in web and desktop modes.

Acceptance checks:

- Auth middleware p95 overhead is less than 25 ms on warm cache.
- Normal board interactions do not write to the sessions table on every request.
- Execution logs/progress do not require a task lookup for every event.
- SSE reconnect triggers at most one debounced state reconciliation.

## Phase 4: Frontend Board Performance

Target duration: 3 to 6 days

Status: Not started

Deliverables:

- Remove the duplicate `useBatchExecution` hook call in `use-kanban-board`.
- Add cursor pagination or load-by-column for tasks.
- Virtualize board columns or grouped task lists.
- Memoize task buckets by status and assignee.
- Replace per-card active-duration intervals with one shared ticker.
- Patch project/task update events locally where possible instead of refetching full lists.
- Add Playwright interaction tests for large board drag/drop, grouped view, and bulk actions.

Acceptance checks:

- Board interaction INP remains under 200 ms with 200 visible tasks.
- Grouped view render time stays stable as member count grows.
- Board can load beyond 200 tasks through pagination without freezing.
- Task drag/drop does not trigger full tree rerenders outside the affected columns.

## Phase 5: Sidecar Execution Scalability

Target duration: 1 to 2 weeks

Status: Not started

Deliverables:

- Reuse the bare clone/worktree strategy for single-task execution.
- Add per-user or per-workspace execution queues instead of only checking global active execution count.
- Add cleanup, quotas, and age-based pruning for repo storage.
- Move production repo storage away from unmanaged `/tmp`.
- Add global and per-user caps for active execution logs and batch logs.
- Persist structured logs incrementally or in chunks instead of only full JSON blobs at completion.
- Add event batching or coalescing for high-frequency progress/log updates.
- Evaluate Redis or database-backed active execution state if multiple sidecar instances are planned.

Acceptance checks:

- Warm repo setup p95 is under 2 s before the model call.
- Cold clone, warm fetch, and worktree timings are logged separately.
- Sidecar memory remains bounded during long-running executions.
- Restart behavior is documented and tested.

## Phase 6: Production Verification And Release Gates

Target duration: ongoing after phases 1 through 5

Status: Not started

Deliverables:

- Add dashboards for API route p95, Prisma slow queries, database pool health, web vitals, sidecar execution lifecycle, queue depth, and memory.
- Add alert thresholds for p95 regression, slow query spikes, failed execution starts, and SSE reconnect storms.
- Run load tests before release promotion.
- Add a performance changelog section to release notes.
- Re-run this review after the first production baseline and update targets based on real user data.

Acceptance checks:

- Performance gates run in CI or pre-release workflow.
- Dashboard links and current p95 values are documented.
- Each high-priority finding from the review has an owner, status, and measurement outcome.

## Priority Order

1. Phase 0 instrumentation and baseline.
2. Phase 1 indexes and query fixes.
3. Phase 2 bulk task routes and frontend bulk action consolidation.
4. Phase 3 auth/session/SSE reduction.
5. Phase 4 board rendering and pagination.
6. Phase 5 sidecar execution scalability.
7. Phase 6 production gates and continuous verification.

## First Implementation Batch

Recommended first sprint:

- Add route timing and Prisma slow-query logs.
- Add task/inbox composite indexes.
- Add `PATCH /api/tasks/bulk-status`.
- Update board bulk status changes and batch group moves to use the bulk endpoint.
- Throttle session/PAT touch updates.
- Remove duplicate `useBatchExecution`.
- Add one seeded benchmark for board list and one benchmark for 100-task bulk move.

This first batch targets the highest amplification paths and should produce visible p95 improvement before larger architectural work begins.
