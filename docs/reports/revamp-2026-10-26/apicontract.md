# W14 slice: API contract, safety and agent read paths (engineer: apicontract)

Status: implemented and verified locally, uncommitted. Base: `922dbd7` + `round3-base.patch` (tree `a7c4d7e8…`). Scope: `apps/api`, one migration, root lint list. Private loopback databases only on 127.0.0.1:54330: `openlinear_apicontract_test` (suite), `openlinear_apicontract_bench` (seeded, kept for re-measuring), `…_scratch` and `…_infra_test` (dropped). No deploys, no remote services.

## 1. Contract changes (all additive unless marked **behaviour change**)

### 1.1 `GET /api/tasks`

| Param | Meaning |
|---|---|
| `status` | One or more of `todo,in_progress,done,cancelled`; repeated (`status=a&status=b`) or comma-separated. Bad value → 400 `VALIDATION_ERROR`. |
| `labelId` | One or more label ids (repeat/comma, ≤ 20); a task matches when it has **any** of them. |
| `q` | 1–200 chars, case-insensitive substring of title, description or identifier. `%`/`_` are literal (see 1.6). |
| `parentId` | A task id (its sub-issues) or `none` (top-level issues only). |
| `assignee` | Existing `me` / user id, plus `none` (no primary assignee). Matches `Task.assigneeId` as before (co-assignees in `TaskAssignee` are not matched; see leftovers). `assignee`+`creator` keep their original OR. |
| `pagination=cursor` / `cursor=<token>` | Keyset mode. |
| `includeTotal=true` | Keyset mode only: adds `total` (exact COUNT). |
| `view=compact` | Omits `executionLogs` from every row (both modes). |

Response:
- **Default (offset) mode** keeps `{ items, total, page, pageSize, hasMore }` and adds `nextCursor` (string when `hasMore`, else null) so a caller can switch to keyset paging after page 1. Order is now `createdAt DESC, id DESC` (was `createdAt DESC` with an undefined tie order — same order except among equal timestamps).
- **Keyset mode**: `{ items, pageSize, hasMore, nextCursor }` (+ `total` with `includeTotal`). No COUNT by default (perf finding 6). Order `createdAt DESC, id DESC`. The cursor is opaque base64url (`lib/keyset.ts`, `v:1`). Rows that existed when paging started are returned exactly once, in order, while other clients insert (new rows sort first); proven with interleaved inserts and with a page boundary inside a three-way `createdAt` tie.
- Errors: 400 `INVALID_CURSOR` (malformed/forged token), 400 `PAGINATION_CONFLICT` (`cursor` with `page`, or with `pagination=offset`).

### 1.2 Bulk endpoints (`PATCH /api/tasks/bulk-status`, `POST /api/tasks/bulk-archive`, `POST /api/tasks/bulk-delete`)
- **Behaviour change:** bulk-status with `taskIds` omitted or `[]` → 400 `TASK_IDS_REQUIRED` (it used to change every active issue in the project). bulk-delete keeps its schema rule (empty → 400 `VALIDATION_ERROR`); bulk-archive keeps "taskIds or identifiers" (400 `VALIDATION_ERROR`). Chat (`bulk_update_issues`) always passed an exact non-empty list, desktop-ui and MCP refuse empty lists client-side: no in-repo caller changes.
- New scope: exactly one of `projectId` (as before) or `teamId` (the team's **project-less** tasks — the "team-only" issues the board had to send one by one). Neither/both → 400 `BULK_SCOPE_INVALID`. Team scope requires owner/admin/member on the team (project deny + PAT binding apply via `assertTeamRole`); project tasks are not reachable through team scope (reported in `failed`). Events for team scope go to the team (`tasks:bulk-updated`/`tasks:bulk-deleted` payload `{ projectId: null, teamId }`).
- Parity with single-task writes (board leftover 3): bulk-status now also clears `batchId` when leaving the running states and sends the creator `status_change` notification; REST activity rows carry `source: 'bulk'` (chat keeps `chat_bulk`). bulk-delete now checks the team role per task (like bulk-archive; **behaviour change**: a workspace admin outside the team gets 404 `OWNERSHIP_REQUIRED`), writes `task_deleted`/`task_archived` activity, and appends a per-task `task:deleted` besides `tasks:bulk-deleted` (clients without the bulk event now drop cards live).

### 1.3 `POST /api/tasks`
- Accepts `assigneeIds` (≤ 50, team members of the task's team; others → 400 `VALIDATION_ERROR`, same rule/message as PATCH) and `assigneeId`. Stored as `TaskAssignee` rows (role `assignee`); the primary `assigneeId` (what the board shows) is the explicit `assigneeId`, else the first of `assigneeIds`. Every assignee except the creator gets an assignment notification. The desktop task form already sent `assigneeIds`; it was silently dropped.
- **Behaviour change (security):** `labelIds` are now validated on team-only creates too (`assertLabelsInProject`, as PATCH): a project-less task takes no labels (400). Before, a team-only create attached any label id unchecked.
- `POST /api/tasks/bulk`: `assigneeIds` are validated against the project team (invalid → per-item `failed`, legacy partial semantics; they were written unchecked) and the first becomes `assigneeId`. Duplicate label/assignee ids are de-duplicated (were a 409 P2002).

### 1.4 Projects with `teamIds` (cause and fix)
Cause: `Team.projectId` is required, so every existing team "belongs to a different project"; the conflict query (`projectId ≠ new project`) matched every team → always 409. `PATCH` had the same bug (its first `updateMany` was a no-op).
Fix — `teamIds` now **moves** teams into the project when nothing is left inconsistent (`services/projects.ts`, `moveTeamsIntoProject`):
- caller is owner/admin of the team (was any member) and has full access to its current project;
- same workspace; the source project keeps ≥ 1 team; the team has no tasks in its source project (project-less tasks follow the team); the key is free.
- Otherwise 409 `TEAM_PROJECT_CONFLICT` with `details.teams: [{ teamId, reason }]`, `reason ∈ OTHER_WORKSPACE | LAST_TEAM_OF_PROJECT | TEAM_HAS_PROJECT_TASKS | TEAM_KEY_TAKEN`; the whole create rolls back.
- Create with `teamIds` adopts the teams instead of creating a default team (as intended before). `project:created` + `project:updated` for each source project commit with the move; moved members' tenancy cache is invalidated.

### 1.5 Labels
- `POST /api/labels/tasks/:id/labels`: the label must belong to the task's project → else 400 `LABEL_NOT_IN_TASK_PROJECT` (task without a project gets the same code). A label of a project the caller cannot see still answers 403/404 first (no existence oracle). **Behaviour change**: before, any label visible to the caller was attached.
- Routes now delegate to `services/labels.ts` (list order gains a `name` tiebreak).

### 1.6 Other agent read paths
- `GET /api/tasks/:id` adds `parent` (`{id, identifier, title, status}` or null) and `subtasks` (non-archived, visible, ≤ 100). Chat `get_issue` returns them too.
- `GET /api/search` task hits add `status`, `priority`, `projectId`, `teamId`; project hits `key`, `status`, `workspaceId`; team hits `projectId`.
- **Bug fix:** user text in `q` (tasks list, chat `list_issues`, search) was passed to `ILIKE` unescaped: `q=1_0` matched "100", `%` matched anything. `lib/like.ts` escapes `\ % _`.

## 2. Indexes and query plans

Seed: `docs/reports/revamp-2026-10-26/apicontract-seed.sql` — 198 000 tasks, 120 projects in 51 workspaces, 198 000 task labels; the bench user sees ~45 % (workspace 0: one 60 000-task board + 19 × 2 000, plus member of 5 more), user 137 sees ~1 % (one small workspace). Driver: `apps/api/src/scripts/bench-task-list.ts` (calls the real service functions, captures Prisma's SQL, prints `EXPLAIN (ANALYZE, BUFFERS)`; refuses non-`bench` databases). Shared machine: treat ±25 % as noise; p50 over 20 runs.

Migration `20261026090000_task_list_indexes` (expand-only, all `CONCURRENTLY IF NOT EXISTS`, passes `scripts/ci/migration-safety.sh`; Prisma 7.4 applied the multi-statement CONCURRENTLY file on a fresh DB; `migrate diff` → "No difference detected"; schema.prisma declares all six):

| Index | Evidence (before → after) |
|---|---|
| `tasks (archived, createdAt, id)` | Unscoped list (`GET /api/tasks` without project, MCP `list_issues`): plan was Parallel Seq Scan + **external merge sort of 178 k rows (32 MB on disk)** then the visibility filter; after: `Index Scan Backward using tasks_archived_createdAt_id_idx`, stops after 51 rows. p50 110–1 166 ms (noisy) → 3.4 ms (user 0); user 137 135.6 → 15.3 ms; `status=todo` unscoped 38–117 → 3.9 ms. |
| `tasks (parentId)` | `parentId` without project: Parallel Seq Scan (66 000 rows removed × 3) 15.7 → 3.0 ms; also the self-FK `ON DELETE SET NULL` no longer scans `tasks`. |
| `task_labels (labelId)` | Label-only filter 9.1 → 6.9 ms; label delete cascade no longer seq-scans 198 k rows. |
| `tasks` GIN `gin_trgm_ops` on `title`, `description`, `identifier` (+ `CREATE EXTENSION pg_trgm`) | `GET /api/search` rare term: Parallel Seq Scan (66 000 removed × 3, 77 ms exec) → BitmapOr of the three trigram indexes, 1.3 ms exec; p50 83.8 → 2.5 ms. `q` rare, unscoped 46.6 → 2.8–4.6 ms; in the 60 k board 30.1 → 3.4 ms. Common terms unchanged (search sorts ~26 k matches by `updatedAt`, ~95 ms) → FTS/rank is the next step (perf #3). |

Not added (measured unnecessary): a `(projectId, archived, status, createdAt, id)` index — board keyset pages already use the existing `(projectId, archived, createdAt)` index with `Index Cond: createdAt <= $c` (the service adds this redundant bound so the cursor is an index condition; ties are a 1-row filter): deep page (row 25 000) 0.17 ms exec, status filters 2.7–4.4 ms p50 including the 13-statement request overhead. An `(archived, updatedAt)` index for search did not help on this seed (identical `updatedAt` values) and was dropped. Deep **offset** page 500 stays 64–124 ms (it spills the sort; keyset replaces it).

### Visibility as id sets (perf finding 5)
`GET /api/tasks` no longer evaluates `scopedTaskWhere`'s correlated-EXISTS OR per task row. `buildTaskListVisibilityWhere` (services/tasks.ts) resolves the caller's visible projects (`scopedProjectWhere`) and teams (`ctx.teams ∩ scopedTeamWhere`) once — same rules, evaluated over the small `linear_projects`/`teams` tables — and filters `projectId = ANY($projects) OR (projectId IS NULL AND teamId = ANY($teams)) OR (own orphan, unbound principals only)`. Above 500 visible projects or teams it falls back to the correlated form (bounded bind lists; C1 F-060). Plans:
- user 137, unscoped list: before `Filter: ((projectId IS NOT NULL) AND (NOT (hashed SubPlan 2)) AND (((hashed SubPlan 4) AND (j2.id IS NOT NULL)) OR …` over joined rows, 13.3 ms exec; after `Filter: (("projectId" = ANY ('{…}')) OR …)` on the index scan, **1.27 ms** exec (p50 13.8 → 5.0 ms).
- offset COUNT on the 60 k board: hash join with the visibility subplans 24.4 ms → 12.0 ms exec (p50 26.1 → 18.9 ms).
- Cost: +2 statements per list call (≈ 0.3 ms on loopback); user 0 unscoped p50 3.1 vs 4.1 ms (noise).
Semantics are covered by `tasks.list.test.ts` (denied project, other tenant, team-only, orphans, member vs owner, workspace-bound PAT) and the existing tenancy / authorization-matrix / principal-context / deny-surfaces suites.

## 3. Rate limiting (`middleware/rate-limit.ts`)
- Authenticated requests: bucket per principal — session JWT → `user:<userId>` (all sessions of a user), PAT → `pat:<tokenId>` (each token its own budget). Unauthenticated, malformed or unverifiable credentials → per-IP bucket (`ipKeyGenerator`, IPv6 /56).
- Classification runs before body parsing and auth: JWTs are signature/expiry/claim-verified (no DB); PATs are never looked up — the token hash is mapped to its id only after `requireAuth` accepted it on an earlier request (`res.on('finish')` reads `req.patId`; LRU 10 000, TTL 10 min). Random or revoked-unknown tokens therefore count against the IP, so guessing cannot mint buckets; the first request of a token per process/TTL is counted against the IP.
- MCP: every PAT behind the worker's egress IPs now has its own bucket (was one shared 100/min IP bucket). Users behind one NAT likewise.
- Config (env; invalid numbers fall back): `RATE_LIMIT_ENABLED` (default on; off under `NODE_ENV=test` unless `1`), `RATE_LIMIT_WINDOW_MS` 60000, `RATE_LIMIT_PRINCIPAL_PER_WINDOW` **300**, `RATE_LIMIT_IP_PER_WINDOW` 100, `RATE_LIMIT_AUTH_PER_WINDOW` 60, `RATE_LIMIT_GITHUB_OAUTH_PER_WINDOW` 120, `RATE_LIMIT_REPOS_URL_PER_WINDOW` 10. Auth/OAuth/repo-URL limiters stay per IP. Probes, `/api/events` and W03a attempt callbacks stay unlimited (unchanged).
- 429 envelope unchanged in shape: `code: RATE_LIMITED`, `details/extras.scope` = `principal` (new) or `default` (IP bucket, as before) …; `retryAfterSeconds` is now the real reset time (was always the window); `Retry-After` header set.
- **Behaviour change:** authenticated callers get 300/min per principal instead of 100/min per IP. Stores are in-process (per replica), as before.

## 4. W04b: converted post-commit emit sites (outbox.md §1.3 list)
Now appended in the write's transaction (`transactionWithEvents` + `events/targets.ts`):
- `services/projects.ts`: `updateProject` (chat), `updateProjectFull` (PATCH; plus team moves), `deleteProject` (`project:deleted` to workspace / each team / each grantee / else actor — same audiences; team rows are bound to the project's workspace instead of the previous null binding resolved after the cascade).
- `services/teams.ts`: `updateTeam`.
- `services/workspaces.ts`: `updateWorkspace` (chat; payload shape kept), `updateWorkspaceRoute`.
- `services/labels.ts` + `routes/labels.ts`: label created/updated/deleted, `task:label:assigned`/`removed`.
- `routes/settings.ts`: `settings:updated`. `services/chat.ts`: auto-title `chat:session:updated` (owner audience).
- `services/activity.ts` `logActivity` and `routes/notifications.ts` `createNotification`: the row and its event now commit in one transaction (no row without its event, no event for a rolled-back row). They still run after the caller's mutation commits, so they are not atomic with the parent write (leftover).
Tests: 11 new HTTP sites in `outbox.transactional.test.ts` (deferred-trigger commit failure → 5xx, state unchanged, no event; disarmed → success with a `source_id`-sequenced event), plus logActivity/createNotification rollback cases. Mutation check: moving the label insert out of the transaction fails "POST /api/labels" (`expected 1 to deeply equal 0`); restored.
Not converted (not mine / by design): `routes/agent-runs.ts` execution:progress (run journal, W05/W06), `services/execution-control.ts`, `routes/events.ts` session-revoked (local hub signal), sidecar sites.

## 5. Test infrastructure
- `src/__tests__/http.ts`: `useTestServer(makeApp)` registers `beforeAll`/`afterAll` that start one server per file/describe bound to `127.0.0.1:0` (awaited) and returns `http()` → supertest client for that base URL; `startTestServer(app)` for per-test apps (env-dependent CORS, mini apps).
- Migrated every `request(app)` caller (33 existing files, ~385 call sites) — the flaky ones first (outbox.idempotency, auth, chat.*, executions) and the rest (principal-context 58 sites, tasks, teams, deny-surfaces, projects, …). `grep 'request(app)'` in `__tests__` now finds only the helper's doc comment; remaining `request(…)` calls use loopback base URLs.
- The pre-change full run hit the known collision once (spurious 401 in `outbox.idempotency` "unkeyed requests…", decided environmental: session-JWT request rejected before any changed code runs; passes alone). Not seen after the migration.
- `sidecar-api-only.e2e.test.ts`: one assertion read `executionLogs` from a row captured when the status turned `done`; the snapshot is written afterwards (attempt `finishing`). Failed once in 6 full runs → decided a test race, not a regression; it now re-reads the row after the attempt closes.

## 6. Validation (merged base + this patch, local PG 14 on :54330)
| Check | Result |
|---|---|
| `pnpm typecheck` | 10/10 tasks successful |
| `pnpm lint` | 172 files, no findings (10 new files added to the root list) |
| fresh-DB `prisma migrate deploy` (scratch DB) + `migrate diff --exit-code` | all migrations applied; "No difference detected" |
| `scripts/ci/migration-safety.sh --files` (new migration) | passes |
| API suite, 3 consecutive full runs | see §6a |
| MCP suite | 6 files, 78 passed |

### 6a. API suite runs
Baseline 601 + 2 skipped. New: `tasks.list.test.ts` 17, `tasks.contract.test.ts` 22, `rate-limit.test.ts` 8, `outbox.transactional.test.ts` +13 → 661 + 2 skipped (57 files).

| Run (consecutive, after the last code change) | Files | Passed | Skipped | Duration |
|---|---|---|---|---|
| 1 | 57/57 | 661 | 2 | 51.8 s |
| 2 | 57/57 | 661 | 2 | 53.9 s |
| 3 | 57/57 | 661 | 2 | 52.0 s |

Earlier runs during the work (for the record): pre-migration full run 1 failure = the known port-collision 401 (`outbox.idempotency`, environmental); after migration 4 further full runs, one failure = the e2e log-snapshot race (§5, test fixed), others green.
Also run: sidecar suite 47 files, 763 passed + 1 skipped (it imports API middleware); no failing test was weakened or skipped.

## 7. Client-visible changes (manual test list)
1. Bulk status with no/empty `taskIds` → 400 `TASK_IDS_REQUIRED`; bulk calls need exactly one of `projectId`/`teamId` (`BULK_SCOPE_INVALID`).
2. Bulk delete by a workspace admin who is not on the task's team → 404 (now consistent with bulk-archive/single delete).
3. Bulk status now clears `batchId` and notifies creators; bulk delete emits per-task `task:deleted`.
4. Task form assignees now stick on create (first = primary assignee); team-only creates with labels → 400.
5. Attaching a label from another project → 400 `LABEL_NOT_IN_TASK_PROJECT`.
6. Project create/PATCH with `teamIds` can succeed (team moves); conflicts list per-team reasons.
7. Rate limits: 300/min per user session or PAT, 100/min per IP when anonymous; 429 `scope` may be `principal`.
8. Task list order ties broken by id; `nextCursor` in list responses; GET task has `parent`/`subtasks`; search hits carry status/project ids; `%`/`_` in search are literal.
9. Some events that were best-effort after commit now fail the request (500) if they cannot be written (W04b semantics).

## 8. Follow-ups unlocked (not edited here)
MCP (`apps/mcp`):
- `openlinear_list_issues`: send `status`, `labelId`, `q`, `parentId`, `assignee=none`, `view=compact` and `pagination=cursor` to the API; drop the 3×100 client-side scan and report `nextCursor` instead of `scanned/complete`.
- `openlinear_get_issue`: use `parent`/`subtasks` from `GET /api/tasks/:id` (no project scan); identifier lookup can use `GET /api/tasks?q=` exact match.
- `openlinear_label_issue`: can call `POST/DELETE /api/labels/tasks/:id/labels` directly (project check now enforced) — no read-modify-write race.
- `openlinear_bulk_update_status`: may also accept `teamId` for project-less issues; map `TASK_IDS_REQUIRED`/`BULK_SCOPE_INVALID`.
- `openlinear_create_project`/`bulk_create_plan`: `teamIds` works when the team is movable; update the description and map the new `details.teams[].reason`. `openlinear_create_issue` can take `assigneeIds`.
- Errors: add `RATE_LIMITED` scope `principal`, `INVALID_CURSOR`, `PAGINATION_CONFLICT`, `LABEL_NOT_IN_TASK_PROJECT`. Worker-side per-token limiting is now less urgent (the API keys PATs individually).
Desktop UI:
- Board: page with `pagination=cursor` (+ `view=compact`) instead of one 200-task page (board leftover 1); send team-only selections with `teamId` (removes the per-task fallback, board leftover 2); handle `tasks:bulk-deleted` (still) — per-task `task:deleted` now also arrives.
- `lib/api/task-commands.ts`: drop the "API strips assigneeIds" comment.

## 9. Leftovers
- `assignee=<id>` matches only `Task.assigneeId`; `TaskAssignee` (multi-assignee) is written but never read anywhere — needs a product decision (one model).
- logActivity / createNotification are atomic with their own event but still run after the parent mutation (crash between = lost activity). Moving them into the mutation transaction (with `createManyAndReturn`) also fixes the per-row write amplification (perf #4/#9).
- Common-term search (~95 ms on 198 k tasks): FTS or rank + LIMIT; the trigram indexes only fix selective terms.
- Rate-limit buckets are per process; a shared store (Redis) is needed for exact multi-replica limits. Per-user aggregate across many PATs is not capped.
- `validateQuery`/`validateBody` take `ZodSchema<T>` (input = output); schemas with transforms need an input/output-aware generic — avoided here (`includeTotal` is compared as a string), not changed (shared middleware).
- Search still uses the correlated visibility form; it could reuse the id-set helper.
- Offset mode keeps an exact COUNT for compatibility; clients should move to keyset.
- `routes/agent-runs.ts` execution:progress remains post-commit (run engine).

## 10. Merge hazards
- `apps/api/src/app.ts` (not mine): `makeRateLimiter` removed; import of `./middleware/rate-limit`; the four limiter constants now come from `readRateLimitConfig()`. Mounting order unchanged.
- `services/tasks.ts`: `listTasksPaginated` signature extended (filters, `compact`), new `listTasksByCursor`, `bulkUpdateTaskStatus`/`bulkArchiveTasks`/`bulkDeleteTasks` take `BulkScopeInput` (`projectId` now optional) and a `source`; `getTask` returns `parent`/`subtasks`; `authorizeCreateTask` takes `assigneeIds`; `prepareBulkCreate(input, teamId)`.
- `schemas/tasks.ts`: bulk schemas' `projectId` optional (+`teamId`); list schema rewritten.
- `services/projects.ts`: `updateProjectFull` transaction rewritten (team moves + event inside); `deleteProject` events inside; `sse` broadcast imports removed.
- Small edits in files outside my list: `services/activity.ts` (transactional row+event; exported to the sidecar as `@openlinear/api/activity`, signature unchanged), `routes/notifications.ts` (`createNotification` body), `routes/settings.ts` (PATCH), `services/chat.ts` (auto-title), `services/workspaces.ts` (two update functions), `services/teams.ts` (`updateTeam`).
- `registry.ts`: `enforcedBy` text of GET/POST `/api/tasks`, the three bulk rows, `POST /api/labels/tasks/:id/labels`, POST/PATCH `/api/projects`. No scope/binding changes.
- `packages/db/prisma/schema.prisma`: six `@@index` lines on `Task`/`TaskLabel`; migration folder `20261026090000_task_list_indexes`.
- Root `package.json` lint list: 10 paths appended at the end.
- `__tests__`: 33 files switched from `request(app)` to `useTestServer`/`http()` (mechanical: `const http = useTestServer(() => app)` after `const app = createApp()`, `request(app)` → `http()`); anyone else editing those files: keep using `http()`. `outbox.transactional.test.ts` gained 13 cases; `sidecar-api-only.e2e.test.ts` one assertion re-reads the task after the attempt closes.

## Files changed
- New: `apps/api/src/middleware/rate-limit.ts`, `lib/keyset.ts`, `lib/like.ts`, `scripts/bench-task-list.ts`, `__tests__/{http,rate-limit.test,tasks.list.test,tasks.contract.test}.ts`, `packages/db/prisma/migrations/20261026090000_task_list_indexes/migration.sql`, `docs/reports/revamp-2026-10-26/{apicontract.md,apicontract-seed.sql}`.
- Modified: `apps/api/src/{app,registry}.ts`; `routes/{tasks,labels,search,settings,notifications}.ts`; `schemas/tasks.ts`; `services/{tasks,projects,labels,teams,workspaces,search,activity,chat}.ts`; `packages/db/prisma/schema.prisma`; root `package.json`; 34 test files under `apps/api/src/__tests__/`.
