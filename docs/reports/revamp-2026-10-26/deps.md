# W17a — task dependencies ("blocked by")

Date: 2026-10-27. Engineer id: `deps` (coordinator, working alone).
Status: **implemented and locally validated; not committed, not deployed.**

## 1. Problem

Issues had a parent/sub-issue tree but no ordering. An agent could be started
on "Build the API" before "Design the schema" existed, and a batch ran its
members in whatever order they were selected. Plans written by an AI through
MCP (`bulk_create_plan`) had no way to say "this before that". This is the
first edge of the W17 plan graph.

## 2. Semantics

- `task_dependencies(taskId, dependsOnTaskId)`: `taskId` is **blocked by**
  `dependsOnTaskId`. Unique pair, no self-edge (DB CHECK), FK cascade on
  either task.
- **Same scope only**: both tasks in the same project, or (project-less) the
  same team. Anyone who can see one task can see the other, so reads leak
  nothing across projects. Moving a task to another project drops its edges
  (in the update transaction).
- **Acyclic**: the add runs under a transaction-scoped advisory lock per
  project/team (`hashtextextended('openlinear-task-deps:<scope>')`), re-reads
  both tasks' scope inside the lock, then a recursive CTE refuses the edge if
  the blocker already (transitively) waits on the task. Two concurrent
  opposite edges cannot both pass (tested).
- **Resolved = done.** Cancelled still blocks: a failed agent run also ends
  as `cancelled`, and building on failed work is waste. The UI says so and
  offers "remove" / "run anyway".
- Limits: 50 blockers per task; edge query 100 tasks.

## 3. API (apps/api)

| Route | Notes |
|---|---|
| `GET /api/tasks/:id/dependencies` | `{ blockedBy, blocking }`, each `{ id, identifier, title, status, archived, resolved }`. View access. |
| `POST /api/tasks/:id/dependencies` `{ dependsOnTaskId }` | 201 created / 200 already there. Write access on the task, view on the blocker. 400 `DEPENDENCY_SELF` / `DEPENDENCY_SCOPE`, 409 `DEPENDENCY_CYCLE` / `DEPENDENCY_LIMIT` / `DEPENDENCY_SCOPE_CHANGED`. Emits `task:dependencies` (outbox) + activity `task_updated`. |
| `DELETE /api/tasks/:id/dependencies/:dependsOnTaskId` | 204, idempotent. |
| `GET /api/tasks/dependencies?taskIds=a,b` | Edges among the listed tasks (each must be viewable); the sidecar orders batches with it. |

All four are registry rows (PAT `tasks:read` / `tasks:write`, workspace
binding enforced). Task payloads (list, detail, events) gain `blockedByIds`
and `openBlockerCount`; `GET /api/tasks/:id` also returns `blockedBy` /
`blocking` (one extra SQL statement — both directions in one UNION query;
perf budget 14 → 15).

**Run gate:** `POST /api/executions/attempts` refuses a task with open
blockers — 409 `TASK_BLOCKED` with `details.blockers` — unless the body says
`allowBlocked: true`. Both sidecar engines and the prisma store apply the
same gate. Follow-up turns always pass `allowBlocked` (the user already
started that work).

## 4. Batches (sidecar v2, W13a coordinator)

- At create, the coordinator asks the control plane for the edges among the
  batch's tasks and orders members **topologically, stable otherwise**; the
  in-batch blockers are stored in the batch's `settings_json.dependsOn`
  (durable, no journal schema change).
- **Parallel:** members without in-batch blockers start at once; a member
  waiting on another starts when every blocker **completed** (the API gate
  then passes on its own — the blocker is done).
- **Queue:** blockers come first by construction.
- A member whose blocker failed, was cancelled or was skipped is **skipped**
  ("Skipped: it is blocked by X, which did not finish"), transitively.
- A blocker *outside* the batch is the API gate's job: that member fails with
  `TASK_BLOCKED`, the rest run.
- After a restart (no in-memory credential) waiting members start on
  `approve` — now also for parallel batches.
- Status responses gain per-member `blockedBy` (in-batch task ids).
- The legacy engine does not order batches; a legacy member with an open
  blocker fails with `TASK_BLOCKED` (409 kept, not the legacy 400).

## 5. Desktop

- Task sidebar → **Dependencies**: "Blocked by N unfinished tasks" with each
  blocker (status dot, identifier, done ✓ / "cancelled" note), remove ✕, and a
  project search picker to add one; "Blocking" list read-only.
- Board cards show **Blocked** while a blocker on the board is not done
  (live: marking the blocker done clears it immediately); blockers off the
  board fall back to the server's `openBlockerCount`.
- Running a blocked task shows "Blocked by ENG-1" with a **Run anyway**
  action (`allowBlocked`).
- SSE `task:dependencies` patches cached lists and refreshes both tasks'
  dependency panels.

## 6. MCP

- `openlinear_get_issue` returns `blockedBy` / `blocking` (with `resolved`).
- New `openlinear_set_blockers { taskId, add?, remove? }` (one call per edge,
  idempotent, loops refused) — tool count 20.
- `openlinear_bulk_create_plan` tasks take `key` + `blockedBy: [keys]`;
  validated before anything is created (unknown key, duplicate key, self,
  loop), edges added after the tasks, reported in `dependencies`
  (`requested/added/existing/failed`); a re-run adds none twice.

## 7. Validation (local, 2026-10-27)

| Suite | Result |
|---|---|
| API | 789 passed + 3 skipped (75 files) — new `task-dependencies.test.ts` (10) |
| Sidecar | 1124 + 3 (75 files) — 6 new batch/gate tests, 1 route test |
| Sidecar integration | 26 |
| execution-core / evals | 69 / 83 |
| desktop-ui | 1071 + 9 (82 files), exit 0 — 9 new |
| MCP | 108 — set_blockers, get_issue, plan keys; catalogue regenerated |
| typecheck / lint | 11/11 / 349 files |
| fresh-DB drift | 0 (migration `20261027120000_w17a_task_dependencies`) |

Also fixed: `components/layout/sidebar.tsx` fired its Tauri window setup
without a catch (an unhandled rejection that failed the desktop test run
intermittently, and a leaked resize listener on fast unmount).

## 8. Fix found on the way: "In Progress" is not "running"

The board's flow is *Move → In Progress → Execute* (the card's Play button
only exists for `in_progress` tasks, and batches only take In Progress
tasks). The W03a control plane treated `status = in_progress` as "already
running", so in API mode (the desktop default) **every card Execute and every
In-Progress batch answered 409 `TASK_ALREADY_RUNNING`** — only Execute from
the detail view on a Todo task worked. Now "held by an execution" means
`in_progress` **with a bound provider session** (`isHeldByExecution`): start
check, claim fence (`NOT (in_progress AND sessionId IS NOT NULL)`), the
rejected-claim reason, the sidecar prisma store and the test fake. Every
path that ends an execution clears `sessionId` (terminal write, sweeper,
status reset), so a stale session cannot hold a task. Regression tests: API
"starts and claims a task the user moved to In Progress", sidecar batch "runs
members the user staged in the In Progress column".

## 9. FE-10 slice: Run with blockers

- `GET /api/tasks/:id/dependencies/closure` → every unfinished blocker,
  transitively (a done blocker ends its branch), ≤ 100 with `truncated`.
- Dependencies panel → **Run with blockers** (while a blocker is unfinished);
  the TASK_BLOCKED toast offers **Run with blockers** and **Run anyway**.
- It starts one parallel v2 batch of the closure plus the task; the
  coordinator runs blockers first and the task only after they succeed.
  Refused with a reason when a batch is already live, more than 19 blockers,
  a blocker is archived, or a blocker is running right now; with no
  unfinished blocker left it simply runs the task.
- Validation after both: API 791 + 3; sidecar 1125 + 3; desktop-ui 1075 + 9
  (exit 0); integration 26; MCP 108; typecheck 11/11; lint 349.

## 10. Open / next

- Owner: confirm "cancelled still blocks" (reversible: `isResolvedTaskStatus`).
- W17 next: TaskSpec/PlanRevision (versioned plan with acceptance criteria),
  "related"/"duplicate" relation kinds, dependency view on the board.

## 11. FE-11 slice: duplicate hints

- `GET /api/tasks/similar?projectId&title[&limit][&excludeTaskId]` — open
  (not archived, not cancelled) issues in the project whose title is similar
  (`pg_trgm` `%` on the existing `tasks_title_trgm_idx`, `similarity()`
  score), best first; titles under 4 characters answer nothing. View access;
  registry row (`tasks:read`). Read-only: nothing is merged or written.
- New-issue form: after 300 ms of typing (≥ 6 characters) a "Similar issues
  in this project — check it isn't a duplicate" note lists up to 3 matches.
- MCP `openlinear_find_similar_issues` (read-only; 25 tools) so agents check
  before creating.
- Validation: API 801 + 3; desktop-ui 1086 + 9; MCP 111; typecheck 11/11;
  lint 354.

## 12. Self-review fix and FE-12 slice

- **Move vs add race:** moving a task to another project dropped its edges
  without the dependency lock, so a concurrent add could leave a
  cross-project edge. The move now takes the task's scope lock first
  (`lockTaskDependencyScope`): an add either lands before the move (and is
  dropped with the rest) or sees the new scope and gets 409
  `DEPENDENCY_SCOPE_CHANGED`. API 801 + 3.
- **FE-12 — issues from review comments:** each draft comment in the diff
  review has **Make an issue from this comment**: a sub-issue of the
  reviewed task (bulk create with `parentId`, keyed per comment so a retry
  never duplicates) whose description keeps the evidence — the comment, the
  file and line (or "removed line"), the commit it was written against, and
  the quoted code. The draft is then removed. Offered only when the task has
  a project. Tests: model (title/evidence/key), panel (request, evidence,
  draft removal, toast; hidden without a project). desktop-ui 1089 + 9.

## 13. "Unblocked" notifications

When a task becomes done — by PATCH, Home Chat, bulk status or an agent run
(terminal `done`) — each task it was blocking that has no open blocker left
notifies its assignee (else creator): "DP-12 is unblocked: everything it
waited on is done" (type `status_change`, so the existing preference and
task-access filters apply; no enum migration). A person who did it is not
notified about their own action; an agent completion has no actor
(`actorUserId` may now be null). Best-effort, after commit. API 802 + 3.

## 14. Board filters: Blocked / Ready

The board filter bar has **Blocked** (tasks waiting on an unfinished task,
live from the board's blocked set) and **Ready** (open tasks nothing blocks),
one at a time, kept in the URL (`deps=blocked|ready`) and combined with the
assignee filter. Fixed on the way: the filter bar's change handler called
one URL setter per filter, each starting from the same URL, so one change
could undo another; it now writes every filter in one update
(`setFilters`). Tests: `board-filters.test.mjs` (3). desktop-ui 1104 + 9.

## 15. Independent review (2026-10-27) — findings and fixes

A read-only reviewer went over dependencies, plans, the run gate, batches
and redirect. Fixed:

| Finding | Fix |
|---|---|
| Home Chat "move issue" kept dependency edges across projects (leaked blocker titles to the new project; broke the per-project lock); project deletion left edges on the orphaned tasks | One helper, `dropDependenciesOnScopeChange`, used by both update paths under the old scope's lock; project deletion removes the project's edges under its lock |
| Batch `cancelTask` raced a member whose start was in flight: marked "cancelled" while its run went on | Decided under the batch lock (the start finishes first); a started member's run is cancelled through the run service |
| Stop-on-failure ignored a member refused at start | `progress` skips the waiting members ("did not start") |
| Plan views showed tasks after they moved to another project (both directions) | Plan task lists, counts and the issue → plan link only consider tasks still in the plan's project |
| Large approvals: three round trips per edge in one 15 s transaction | Stale edges deleted in one statement; new edges inserted with one `createMany` unless hand-made edges touch the plan's tasks (only then per-edge loop checks) |
| Redirect of a queued/preparing turn cancelled it and lost the instruction | 409 `REDIRECT_NOT_READY` before cancelling when the turn has no worktree yet |
| Chat plan titles > 200 chars hit the DB check (500); bulk "done" of two blockers sent the "unblocked" note twice | Title validated in the plan service (all callers); one deduplicated notification pass per bulk change |

Tests added: batch (cancel during start; stop on failure at start), redirect
(not ready), existing suites re-run. Not changed (noted): a Prisma-mode
legacy batch marks members in progress without a session, so a v2 run could
claim one — only if both engines share a database.

Gate after the fixes: API 801 + 3 and sidecar 1132 + 4 in a parallel run
with one timing-sensitive failure each (`run-engine.e2e` b1 SIGKILL
reattach; `local-worktree` eight concurrent acquires) — both pass alone
(5/5, 12/12, twice); desktop-ui 1105 + 9; integration 26; MCP 111;
typecheck 11/11; lint 355; drift 0.

## 16. Blocked chip names its blockers; Run ready

- The card's **Blocked** chip names its open blockers in its tooltip and for
  screen readers ("Blocked by ENG-1, ENG-3", off-board ones counted); the
  label map keeps its identity while unchanged so columns stay memoized (the
  render-count regression test passes).
- With the **Ready** filter on, **Run N ready** (two-step confirm) starts
  one parallel batch of the open tasks nothing blocks and no execution
  holds, highest priority first then oldest, within the user's batch size;
  refused while a batch is running. Tests: `readyToRun`, `blockerSummary`,
  filter-bar confirm flow.

