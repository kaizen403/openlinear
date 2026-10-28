# Board and execution surfaces: client contract debt (round 1, `board`)

Status: done for this slice. Uncommitted; frontend only (`apps/desktop-ui`). Base tree `0a41ea8` (HEAD `922dbd7` plus `round1-base.patch`).

Scope: the "W01 backend contract update" and "Existing client integration debt" items in `~/Downloads/frontend work pending.md`. The changes cover four areas:

- the board's bulk actions
- `Idempotency-Key` on task creation (W04a)
- one mapping from error codes to user messages
- showing W01 execution and publication outcomes

On top of that, the board now re-renders far less on each SSE update; before/after numbers are in the Measurements section.

## What changed and why

### 1. Bulk board actions use the bulk endpoints

Before, each bulk action sent one request per task:

- `handleBulkChangeStatus`, `handleBatchMoveToInProgress` and the batch-group drag sent `PATCH /api/tasks/:id`.
- `handleBulkDelete` sent `DELETE /api/tasks/:id`.

Any failure rolled back the whole selection (C4 A-20).

Now (`components/board/bulk-actions.ts`, `use-kanban-board.ts`):

| Action | Endpoint | Requests |
|---|---|---|
| Status change (selection bar, keys 1–4 with a selection, "Move N Todos") | `PATCH /api/tasks/bulk-status` | 1 per project per 100 ids |
| Archive (archive mode) | `POST /api/tasks/bulk-archive` | 1 per project per 100 ids |
| Delete (delete mode) | `POST /api/tasks/bulk-delete` with `permanent: true` | 1 per project per 100 ids |

- **Normal case:** a selection of up to 100 tasks in one project is exactly one request. Tests assert this for every action.
- **Unscoped tasks:** tasks without a project (team-only) can't be sent to the project-scoped bulk endpoints. They fall back to their single endpoint; see backend follow-ups.
- **Placeholders:** optimistic `temp-` placeholders are never sent.
- **Optimistic update:** applied before the request.
- **Reconciliation, per item:**
  - Server copies from `updated[]` replace the optimistic tasks, in one pass and without re-adding tasks removed in the meantime.
  - `already[]` items count as success.
  - Only the ids in `failed[]`, or every id of a request that was rejected, roll back. Removed tasks are re-inserted next to their old neighbours (`restoreRemovedTasks`).
  - Ids the server didn't report count as failed.
- **Partial failure display:**
  - Toast title, e.g. "Couldn't move 1 of 3 tasks to Done".
  - Toast description: per-item reasons grouped by reason, e.g. "KT-12: Issue was not found in the selected project", plus the mapped error if a whole request failed.
  - The failed tasks are re-selected for a retry, unless the user started a new selection meanwhile.
- **Single-task actions keep their single endpoint:** drag, the "Move" button, and keys 1–4 on the open task. These keys did nothing before: they read the empty multi-selection. They now act on the open task, and skip tasks locked by a running batch.
- **Safety guard:** `bulkUpdateTaskStatus` refuses an empty `taskIds`. The API would treat that as "every task in the project".

### 2. Idempotency-Key on task creation (W04a)

`lib/api/idempotency.ts` provides:

- `createIdempotencyKey()`: a UUID v4, with a `getRandomValues` fallback. It fits the server's 8–128-character alphabet.
- `sendWithIdempotencyKey(key, request)`: re-sends with the **same** key on:
  - `NetworkError`
  - 409 `IDEMPOTENCY_IN_PROGRESS`, after waiting `details.retryAfterSeconds`
  - 502/503/504, with backoff

  It never retries 409 `IDEMPOTENCY_CONFLICT` or other errors. Three attempts by default.
- `IdempotencyIntent`: one key per draft.

The header goes through `apiFetch`'s existing `headers` option. `fetch.ts` and `client.ts` are unchanged, and a 401-refresh retry re-sends the same headers, so the key is reused there too.

Where keys are used:

- **Task form (`task-form.tsx`):**
  - The key is reused while the same values are re-submitted: manual retry after an error, or a double submit.
  - Changed values get a new key.
  - Success or reopening the dialog starts a new draft.
  - On a conflict the key is dropped so the next submit goes through.
  - A ref guard stops ⌘+Enter double submits while a request is in flight. Before, ⌘+Enter ignored the disabled button.
- **Inline create (`handleInlineCreateTask`):** one key per action, reused by automatic retries.
- **Bulk create:** `bulkCreateTasks(body, key)` in `lib/api/task-commands.ts` is ready. The desktop UI has no bulk-create caller today; chat and plan imports run server-side.

### 3. Error codes mapped in one place

`lib/api/errors.ts` holds the mapping:

- `describeApiError(err)` returns `{ code, status, message, hint, retryable, retryAfterMs }`.
- `toastApiError(err, { title?, action? })` shows the toast.
- `formatApiError(err)` returns a single line for inline errors.

Coverage:

- **Required codes:** `INVALID_RUNNER`, `RUNNER_NOT_SUPPORTED`, `TASK_SELECTION_CHANGED`, `BATCH_SELECTION_CHANGED`, `TASK_ARCHIVED`, `TASK_ALREADY_RUNNING`, `PAT_WORKSPACE_RESTRICTED`, `IDEMPOTENCY_CONFLICT`, `IDEMPOTENCY_IN_PROGRESS`.
- **Validation, permission, lookup and rate limits:** `VALIDATION_ERROR` (first field error), `OWNERSHIP_REQUIRED` (404 vs 403, named resource), `FORBIDDEN`, `INSUFFICIENT_SCOPE`, `SESSION_REQUIRED`, `NOT_FOUND`/`TASK_NOT_FOUND`/`P2025`, `RATE_LIMITED` (shows the wait).
- **Forward-compatible codes:** `SANDBOX_UNAVAILABLE` and `BATCH_REQUIRES_API_PERSISTENCE`. These keep the server message and add a next step.
- **Sidecar batch and execution codes:** `CANCEL_INCOMPLETE`, `EXECUTION_STOPPED`, `MODEL_NOT_CONFIGURED`, `LOCAL_BATCH_NOT_SUPPORTED`, `BATCH_REPOSITORY_*`, `BATCH_MODEL_MISMATCH`, `INVALID_BATCH`, `BATCH_NOT_READY`, `NO_QUEUED_TASK`, among others.
- **Client errors:** `NetworkError` and `AuthExpiredError`.
- **Unknown codes, or no code:** fall back to the server message.

Used by:

- every board toast: fetch, create, update, single and bulk status/archive/delete, execute, cancel
- batch start, cancel and approve
- the task form
- the "check for PR" action

Stop failures get a "Retry stop" toast action, except when the task is simply not running.

### 4. W01 execution outcomes

`components/board/execution-outcome.ts` mirrors `BatchStatusResponse`/`BatchPublication` from `execution-core` and parses the sidecar's outcome strings in one place. Until W05, the retained branch/path exists only inside `outcome`.

The rules:

- **Confirmed PR:** only a GitHub `/pull/<n>` URL counts.
- **Branch evidence:** a `/compare/` URL (or `isCompareLink`) means "branch pushed — no pull request confirmed", with "Open branch comparison" and "Check for pull request". The latter calls the existing `refresh-pr`.
- **Ready to publish:** a batch member that is `completed` while the batch is `pending`/`running` shows "Ready to publish", not "Done". So does a `running` member whose task row says `in_progress` + `Local commit ready…`; that's the durable signal, because the `batch:progress` committed event isn't delivered to the board. While the batch is `merging` these show "Publishing", and "Published" only after `completed`.
- **Failed vs failed publication:**
  - "Run failed — work retained".
  - "Publication failed (— work retained)": the reason mentions PR, publication or push.
  - "Failed after the pull request was opened": a PR is recorded in the outcome.
  - A failed batch member is back in Todo with its retained branch shown.
- **Cancelled:**
  - "Cancelled — work retained".
  - "Cancelled — the pull request was still opened": the PR was accepted while the cancel was in flight.
  - A stale success outcome from an earlier run isn't attributed to this cancellation.
- **Batch outcome (`describeBatchOutcome`):**
  - confirmed PR vs `publication.branchUrl` (pushed branch, no PR)
  - `publication.error`
  - receipt path
  - members with `cancelUnconfirmed`
  - retained members

Where it's shown:

- **`BatchProgress`:**
  - Per-member phase labels.
  - Header counts: "N/M ready to publish", "publishing N", or "<outcome>".
  - "Open PR" only for a confirmed PR.
  - An outcome box with the error, a "Retry stop" button for unconfirmed stops, the pushed-branch link and the receipt path, with copy buttons.
  - The expanded rows list each member's error and retained branch.
- **Cancel is awaited:** "Cancelling" resets if the sidecar rejects the stop (W01: acknowledge only on the HTTP result). The same applies to the task card's Cancel and the detail view's Stop.
- **Retention:** the finished batch is now kept (`useBatchExecution.settledBatch`) until the user dismisses it. Before, `use-task-sse` cleared failed/cancelled batches after 5 s.
- **Detail fetch:** `GET /api/batches/:id` is fetched once per terminal state or failed member. It fills in branch, error, `cancelUnconfirmed` and publication without moving any status backwards.
- **After a reload:** `reconcileActiveBatches` also surfaces the newest finished batch when it still has unconfirmed stops or a publication error.
- **In Progress batch group:** derived phase pills. The group is no longer draggable while it runs: dragging it used to PATCH task rows under a running batch, which W01 fences (publication fails), and dragging to Cancelled didn't stop the agents.
- **`TaskCard`:**
  - A "Ready to publish — waiting for the batch" state replaces the stale "Committing…" spinner.
  - "Compare branch" vs "View PR".
  - A "Work retained on <branch>" hint on failed/cancelled tasks.
- **`TaskDetailView`:** an `ExecutionOutcomePanel` for every non-trivial outcome, with retained branch/path and copy buttons. Done tasks only show "View Pull Request" for a confirmed PR. The sidebar link is labelled "Compare branch (no pull request yet)" for compare links.
- **`ExecutionDrawer`:** this component is unused today. It now gets the same PR vs compare labelling and a close-button `aria-label`.

### 5. Board performance

These are the re-render storms found and fixed. "SSE update" means a `task:updated` event.

| Problem | Fix |
|---|---|
| The whole board re-rendered, and every `Draggable` re-rendered, on each SSE update. TaskCard's memo stopped only the card. | Memoized `BoardColumn` and `BoardTaskItem` with handlers whose identity never changes (`useStableCallback`). |
| The four columns were rebuilt by 8+ O(n) filters per render (C4 P-03). | One-pass `bucketTasksByStatus` with `stabilizeBuckets`, so unchanged columns keep their array identity. The same applies after the assignee filter. |
| The global `keydown` listener was removed and re-added on every board render (C4 P-04). | Registered once, latest-handler pattern. |
| `bucketSelection` ran a `find` for every selected id (O(S×N)); the bulk paths ran `includes` per task. | A `Map` lookup and `Set`s. |
| `ProjectConfigPanel` recounted all tasks and took the whole list. | Memoized, takes primitive props. |
| The locked-batch id `Set` was rebuilt on every batch event, re-rendering every column. | Kept stable by content. |

## User-visible behaviour

- **Bulk actions:**
  - Bulk move, archive and delete are one request (one per project/100).
  - On partial failure only the failed cards jump back; they stay selected, and the toast says which failed and why.
  - The "Archived N tasks" / "Deleted N tasks" success toast is unchanged.
- **Keys 1–4:** with an open task and no selection, they now change that task's status.
- **Creating tasks:** double submits and retries of the same values no longer create duplicates.
- **Toasts:** headline plus next step. Examples:
  - "Codex can't execute tasks yet." / "The execution engine currently supports OpenCode…"
  - "This task changed while execution was starting." / "…Refresh the board…"
- **Batches:**
  - Committed lanes show "Ready to publish".
  - Failed or cancelled batches stay on screen with errors, retained branches, the receipt path and "Retry stop".
  - "Open PR" appears only for a confirmed PR.
- **Running batch group:** it can no longer be dragged; use Cancel.
- **Tasks:** a compare link reads "Compare branch", never "View PR". Failed and cancelled tasks show the retained branch/path.

## Tests

100 new tests in 11 new files plus three added to `board-state.test.mjs`. All `.mjs`, following the package's existing style.

| File | Tests | Covers |
|---|---|---|
| `lib/api/errors.test.mjs` | 15 | Every required code; details-driven copy (runner, Retry-After, resource, field error); unknown-code and no-code fallback to the server message; client errors; toast shape and actions |
| `lib/api/idempotency.test.mjs` | 9 | UUID format vs the server alphabet; fallback generator; retry policy; **same key on every automatic retry** (network → in-progress → success); no retry on conflict; attempt budget; `IdempotencyIntent` |
| `lib/api/task-commands.test.mjs` | 5 | Paths, methods and bodies; the `Idempotency-Key` header on create and bulk create; refuses empty/oversized bulk calls (the empty-ids "whole project" footgun) |
| `components/board/bulk-actions.test.mjs` | 10 | Grouping/chunking/unscoped/placeholders; **exactly one request** for status/archive/delete; per-item outcome mapping; request failure → all items failed with the code; unreported ids; mixed projects plus single-endpoint fallback |
| `components/board/use-kanban-board.test.mjs` | 15 | **One request per bulk action** (status, archive, delete, move todos); optimistic first, then server copies; **per-item rollback plus re-selection plus toast**; full rollback with the mapped 403; archive restore order; single-task shortcut endpoint; `tasks:bulk-deleted` handling; **inline create reuses its key across `IN_PROGRESS` and 503 retries**; new key per action; conflict not retried; execute error mapping; cancel → `false` plus "Retry stop" (none for "not running"); network error copy |
| `components/task-form.test.mjs` | 2 | **Same key on manual re-submit, new key after an edit**; conflict → mapped message, fresh key |
| `components/board/execution-outcome.test.mjs` | 21 | URL classification; every sidecar outcome string format (paths with spaces, `; pull request` suffix, batch formats, recovery); every task outcome kind; member phases incl. the persisted-row signal; batch outcome views |
| `components/board/batch-state.test.mjs` | 4 | Detail mapping; merge never moves backwards; detail-only fields carried across SSE replacements; needs-attention |
| `hooks/use-batch-execution.w01.test.mjs` | 6 | Failed batch kept after the live batch clears, enriched from detail; cleared by a new batch; cancel acknowledged only by HTTP; `CANCEL_INCOMPLETE` retry; admission error mapping; reload surfaces a batch needing attention, ignores a clean one |
| `components/board/batch-progress.test.mjs` | 9 | Ready-to-publish vs done; persisted-row ready; confirmed PR only; failed publication with branch evidence, error and receipt; unconfirmed stop with Retry stop; Cancel re-enabled when rejected; outcome panel: PR / branch evidence + check / retained work |
| `components/board/kanban-board.render.test.mjs` | 1 | **Regression guard:** at 400 tasks one SSE update re-renders exactly 1 card and only the In Progress column, and adds no `keydown` listener. It **fails on the base tree** (all four columns re-render) and passes now. |
| `components/board/board-state.test.mjs` | +3 | `replaceBoardTasks`, `restoreRemovedTasks`, `bucketTasksByStatus`/`stabilizeBuckets` |
| `components/board/board-render.bench.test.mjs` | opt-in | Benchmark; skipped unless `BOARD_BENCH=1` |

No existing test was changed, and none failed at any point. `hooks/use-batch-execution.test.mjs` (11) still passes unchanged: cancel now also fetches the detail, and the existing assertions still hold.

## Validation

| Check | Result |
|---|---|
| `pnpm --filter @openlinear/desktop-ui test` | Vitest **34 files passed, 1 skipped; 342 tests passed, 1 skipped**. Baseline 23 files / 242. The skip is the opt-in benchmark. Fonts check: 4 fonts plus fallback ok. Scroll gate passed, run alone: 3/3 passes, p95 16.8 ms, max 16.8 ms, 0 long tasks. |
| Root `pnpm typecheck` | 11/11 turbo tasks passed; `desktop-ui:typecheck` was a cache miss and executed |
| Root `pnpm lint` | Passed. Biome scope is unchanged and covers only API files. Desktop-ui's own `lint` is `tsc` and passes. |
| `pnpm --filter @openlinear/desktop-ui build` | Passed: 20/20 static pages. `next-env.d.ts` was rewritten by the build and restored by hand. |
| Biome on the changed desktop-ui files, informational (not a gate) | New files: 0 diagnostics. Modified files: 17 errors / 20 warnings after vs 45 / 29 on the base copy. The base copy ran without the root config, so this comparison is approximate. Nothing I added remains except `useExhaustiveDependencies` on intentional deps (unchanged count). |
| Strict TS | No `any`, `@ts-ignore` or `@ts-expect-error` added. One existing `(data: any)` in `use-kanban-board.ts` was replaced with a typed `apiFetch<{ taskDeletionMode?: unknown }>`. |

No backend tests were run: no backend files changed.

## Measurements

Command, reproducible, opt-in:

~~~sh
BOARD_BENCH=1 BOARD_BENCH_SIZES=500,1000,2000 BOARD_BENCH_UPDATES=10 \
  pnpm --filter @openlinear/desktop-ui exec vitest run components/board/board-render.bench.test.mjs
# BOARD_BENCH_DND=mock swaps in the test-setup dnd stub to isolate our components
~~~

The benchmark renders the real `KanbanBoard`, mocking only network, auth, SSE and the heavy dialogs. It measures:

- mount
- a single-task `task:updated` SSE event: wall time around `act()`, and render-phase time from the React Profiler `actualDuration`
- select-all (⌘A)

Card renders are counted exactly. The "before" numbers came from an untouched copy of the base board files, exported from the git index to `/tmp`, run with the same harness and node_modules. The environment is jsdom, a React dev build and a shared machine: compare runs relative to each other, not as absolute production numbers.

**Real `@hello-pangea/dnd`:** 10 updates after 2 warm-ups; latency columns show p50 / p95.

| Tasks | SSE update wall, before | SSE update wall, after | SSE render, before | SSE render, after | Mount wall before → after | Select-all before → after |
|---|---|---|---|---|---|---|
| 500 | 3 865 / 4 095 ms | **11.3 / 12.2 ms** | 28.2 / 37.9 ms | **2.2 / 2.5 ms** | 4.45 s → 3.43 s | 195 → 158 ms |
| 1 000 | 20 280 / 21 151 ms | **21.8 / 23.8 ms** | 59.4 / 168.5 ms | **2.7 / 3.1 ms** | 19.8 s → 19.2 s | 306 → 249 ms |
| 2 000 | 73 434 / 75 201 ms | **44.0 / 45.2 ms** | 88.9 / 233.2 ms | **1.7 / 2.1 ms** | 81.3 s → 85.6 s | 509 → 528 ms |

The before wall time grows superlinearly because every `Draggable` re-rendered on each event. In development builds, each of those re-renders runs dnd's per-render validation, which scans the DOM, so the cost is O(n²). Production builds strip that validation, but the per-`Draggable` re-render itself remains. After the change, one item re-renders per event.

Mount is still dominated by dnd's dev-mode registration of every `Draggable`; virtualization is deferred, see leftovers.

**dnd stub, which isolates our components:** 20 updates after 3 warm-ups; p50 / p95.

| Tasks | SSE wall before → after | SSE render before → after | Mount render before → after |
|---|---|---|---|
| 500 | 6.4 / 12.2 → **0.9 / 2.3 ms** | 4.0 / 10.0 → **0.5 / 0.8 ms** | 208 → 220 ms |
| 1 000 | 9.4 / 12.2 → **1.0 / 2.1 ms** | 6.5 / 7.8 → **0.6 / 0.8 ms** | 226 → 256 ms |
| 2 000 | 21.4 / 38.8 → **3.9 / 6.8 ms** | 14.9 / 26.6 → **2.7 / 3.0 ms** | see repeat below |

The first 2 000-task mount looked slower after (660 → 1 037 ms wall), so I repeated it three times per side:

| | Mount wall (3 runs) | SSE render p50 (3 runs) |
|---|---|---|
| Before | 760 / 783 / 854 ms | 12.4 / 16.9 / 24.7 ms |
| After | 923 / 750 / 735 ms | 2.1 / 2.5 / 1.2 ms |

That puts mount within run-to-run noise, with no regression.

Renders per single-task SSE update (deterministic, from the render test):

| | Before | After |
|---|---|---|
| Cards re-rendered | 1 (TaskCard's memo already stopped the rest) | 1 |
| Columns re-rendered | 4 | 1 |
| `keydown` listeners re-registered | 1 | 0 |

Caveat: in production the board still loads at most 200 tasks (`pageSize=200`, no pagination). The 500–2 000 numbers apply once pagination lands (leftover 1).

## Decisions

- **New files instead of appending to `lib/api/tasks.ts`.** New commands live in `lib/api/task-commands.ts`. The desktop engineer is editing the `sidecar:` flags at the end of `tasks.ts`, and a new file can't conflict. `tasks.ts` and `lib/api/index.ts` are untouched.
- **Error copy uses message + hint**, rather than replacing server text everywhere. Codes whose server message carries specifics (validation, `CANCEL_INCOMPLETE`, the forward-compatible codes) keep it.
- **Automatic retry is limited to cases where the same key can't duplicate work:** network errors, `IN_PROGRESS`, 502/503/504. 500 isn't retried; it's likely deterministic. 429's window is too long to wait out automatically.
- **Single-task status changes keep `PATCH /api/tasks/:id`.** It sends creator notifications and resets `batchId`; `bulk-status` does neither (backend follow-up).
- **Archive mode uses `bulk-archive`, not `bulk-delete {permanent:false}`.** `bulk-archive` emits a per-task `task:deleted`, so other clients update live.
- **Ready-to-publish is derived from the persisted task row as well as member status.** The committed event (`batch:progress`) isn't delivered to the board, and the row is the durable signal W01 documents.
- **The board consumes the SSE provider; it doesn't modify it.** A board-owned `useSSESubscription` handles `tasks:bulk-deleted`; it is a no-op until the provider lists the event. `use-task-sse.ts` and `sse-provider.tsx` are untouched (desktop engineer's files).
- **Kept `TaskCard`'s custom memo comparator.** The board's handlers are now stable, so the C4 #3 correctness concern no longer applies on the board. Removing the comparator is a separate cleanup.
- **The running batch group is non-draggable.** This is a deliberate behaviour change; see section 4.

## Leftovers / backend follow-ups

1. **Pagination:** the board fetches one page of 200 tasks and ignores `hasMore` (`use-kanban-board.ts` `fetchTasks`; C4 #8). It needs pagination or column virtualization, the latter blocked on the dnd choice (C4 P-01).
2. **Bulk endpoints are project-scoped.** Team-only tasks (no `projectId`) still use one request each. A team-scoped or id-only bulk endpoint would remove the fallback.
3. **`bulk-status` vs single PATCH:**
   - doesn't reset `batchId`
   - sends no `status_change` notifications to creators
   - logs activity with `source: 'chat_bulk'`

   `bulk-delete` (permanent):
   - writes no `task_deleted` activity
   - doesn't check team role, unlike `bulk-archive`
   - broadcasts only `tasks:bulk-deleted`
4. **`POST /api/tasks` drops `assigneeIds`.** The schema has no such field, so the task form's assignee picker is silently ignored on create. This predates this change.
5. **Stale `outcome`/`prUrl` (W05):** a single user cancel doesn't overwrite `outcome` or `prUrl`, and a single execution start doesn't clear them. The UI therefore shows the latest *recorded* outcome. I handled the known stale-success case.
6. **Sidecar errors without a `code`:** `POST /api/batches` validation (`{ error: 'Validation failed' }`), task cancel failures, "Parallel limit reached", "No active project selected". These fall back to the server text. Giving them codes would allow actionable copy.
7. **Archived-page per-task delete loop:** `app/(app)/archived/page.tsx` bulk-deletes archived tasks one request each. That file isn't mine, and there is no bulk endpoint for archived tasks.
8. **No UI caller for bulk create.** `bulkCreateTasks` (with key) is ready for plan import or brainstorm when it moves client-side.
9. **Production-build benchmark:** the numbers above are jsdom and React dev; a Chromium/production-build board benchmark is not done.

## Merge hazards

- **`providers/sse-provider.tsx` (desktop engineer):** needs `tasks:bulk-deleted`, `tasks:bulk-updated` and `batch:progress` added to `SSEEventType` and `ALL_EVENT_TYPES`. Until then:
  - Permanent bulk deletes by another client don't disappear live; they do on reconnect or refetch. Single deletes did before.
  - The committed-phase event isn't delivered (the row-based signal covers it).
- **`hooks/use-task-sse.ts` (desktop engineer):**
  - It imports `ActiveBatch` from `use-kanban-board.ts`. I extended that type additively (optional `branch`, `error`, `cancelUnconfirmed`, `publication`); the existing construction compiles.
  - Its 5 s auto-clear of failed/cancelled batches is now visually superseded by `settledBatch`. If they remove the timer, nothing breaks.
- **`sidecar: true` call sites in my rewritten files:** `use-kanban-board.ts` (execute, cancel, logs) and `use-batch-execution.ts` (batches list, detail, create, cancel, approve). Both files changed heavily, so a global sidecar/cloud reclassification will conflict there. Re-apply the flag changes on top of mine.
- **`hooks/use-batch-execution.ts`:**
  - The `setActiveBatch` prop is widened to `Dispatch<SetStateAction>`.
  - `handleCancelBatch` now returns `Promise<boolean>`.
- **`lib/api/errors.ts` is a new file.** If another engineer also adds a file with that name, that's an add/add conflict; mine is the board/execution error map.
- **`components/task-detail-view.tsx`:**
  - New optional prop `onCheckPullRequest`.
  - `onCancel` may now return a promise.
- **`apiFetch` usage:** no change to `fetch.ts`, `client.ts` or `auth.ts`. Keys go through `init.headers`. If `apiFetch` stops forwarding custom headers on its 401-refresh retry, retries would lose the key.
- **Files not touched:** `scripts/verify-onboarding-repo-scroll.mjs`, `types/task.ts`, `lib/execution-state-store.ts`, `ISSUES.md`.
