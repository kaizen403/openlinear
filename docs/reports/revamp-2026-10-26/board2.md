# Board: keyset pages, team-scoped bulk actions, delete dedupe (engineer `board2`, round 7)

Status: done for this slice. Uncommitted; frontend only (`apps/desktop-ui`). Base: HEAD `922dbd7` + `round7-base.patch` (tree `02c6fdc`). No API, schema or sidecar change; nothing deployed.

Backlog source: `apicontract.md` §7–§8 "Desktop UI" follow-ups (board leftovers 1 and 2 from `board.md`).

## Outcome

| Item | Before | After |
|---|---|---|
| Board list | One `GET /api/tasks?pageSize=200` page; `hasMore` ignored, so tasks beyond 200 were unreachable | First page `pageSize=200&pagination=cursor&view=compact` (1 request), then "Load more" per column (`status=<column>&cursor=…`, 50 rows, 1 request per click). Every task is reachable. |
| Resync (reconnect, `replay-gap`, Retry, stale remount) | Re-fetched the single 200-task page | Re-fetches the first page, then each column the user extended, to the same depth (pages of up to 200). The board never collapses under the user. |
| Unloaded task in an SSE `task:updated` | Ignored on a mounted board | Placed by a defined rule (below); never at a guessed position |
| Task opened | Sidecar logs only | Also loads the full row (`GET /api/tasks/:id`, same cache entry as the comments thread, so no extra request when it is fresh); the persisted `executionLogs` are the fallback when the sidecar has no history |
| Team-only (project-less) bulk selection | One `PATCH`/`DELETE` per task | One bulk request per team (`teamId`), max 100 ids; mixed selections are one request per scope |
| `TASK_IDS_REQUIRED`, `BULK_SCOPE_INVALID`, `INVALID_CURSOR` | Server text | Mapped copy in `lib/api/errors.ts` |
| Bulk delete by another client | `tasks:bulk-deleted` removed the cards, then each per-task `task:deleted` wrote a new list (re-render per event) | The first announcement removes; later ones write nothing and re-render nothing |
| `task-commands.ts` | Stale "API strips assigneeIds" comment | Comment fixed; `assigneeId` added to `CreateTaskRequest` |

## Design

### Pagination (`lib/query/task-queries.ts`)

- **One flat list per scope.** The cache entry stays the same `Task[]` under `queryKeys.tasks.list(scope)`, and the cursor is never in the key. The SSE bridge, `use-task-sse` and the optimistic bulk/rollback code run unchanged on it. `useInfiniteQuery` was rejected: its `{pages}` shape breaks the bridge and every `setTasks` helper.
- **Paging state** (`BoardPaging`, per column: `cursor`, `hasMore`, `boundary`, `extraLoaded`, `loading`) lives in a registry keyed by query client plus `hashKey(queryKey)`.
  - The board reads it with `useSyncExternalStore`.
  - Entries are dropped on the QueryCache `removed` event, so paging lives exactly as long as its list (gc, sign-out `clear()`).
  - Keys stay factory-built: `keys.ts` is not edited, and `BOARD_PAGE_SIZE` = 200 remains the first-page size.
- **First page:** all four columns start at its cursor. Each column is always a prefix of its server order (`createdAt DESC, id DESC`), so the combined cursor is a valid start for a per-status page. This relies on the API cursor being a position that is not bound to filters (`apps/api/src/lib/keyset.ts`). If the API ever refuses a cursor (`INVALID_CURSOR`), that column restarts from its first page with `pageSize = loaded + 50`, and rows already shown are skipped.
- **Column page merge (`mergeColumnPage`):** rows are appended after the column's last task. A row already on the board keeps its copy and position, so a page never reverts an optimistic or SSE copy.
- **Generations:** each full load bumps a generation counter that is not part of the rendered snapshot. A column page started before a full reload is dropped, and a full load that lost the race to a newer one doesn't commit its paging.
- **Identity:** a reload reuses unchanged task objects by id (`replaceEqualDeep` per id). Before, reuse was by index, so one new task at the top re-rendered every card. When nothing changed, the previous array is kept.
- **"Load more" instead of infinite scroll** (decided): the board has no virtualization (`@hello-pangea/dnd` measures every Draggable), and its search/assignee filters are client-side. An auto-loading sentinel in a filtered column with no visible matches would chain requests through every page. One click is one request and 50 more cards. The button is hidden while the column is complete. Column badges read `N+`, and the scope panel reads `N+ issues`, while more exist. An empty column that may have older tasks shows no "No … tasks" empty state.

### SSE rule for paged lists

- **Loaded task** (`task:updated`): merged in place by `use-task-sse`, as before. It is never hidden, even if a status change moves it into a column beyond that column's loaded window. The column's next page skips its id.
- **Unloaded task** (`placeUnloadedBoardTask`, applied by the board's own subscription after `use-task-sse`). A task is inserted only if all of the following hold:
  1. Its project/team match the board scope by the event's own fields.
  2. It isn't archived.
  3. It carries `createdAt`.
  4. Either its column is complete, or it sorts at or before the column's boundary. The boundary is the last row the server sent for that column, taken from the row itself, never decoded from the token.

  It goes to its sorted position among that column's tasks. Otherwise it is left out, and that column's next page brings it in order, with no refetch.
- **`task:created`:** prepended, as before (a new task is the newest row, inside every window).
- **Unmounted cached boards (bridge, unchanged):** loaded tasks are patched. An unloaded task in the same project marks the list stale, so the next mount does a depth-preserving reload.

### Team-only bulk actions (`components/board/bulk-actions.ts`, `lib/api/task-commands.ts`)

- `planBulkRequests` groups tasks by project. Project-less tasks are grouped by their team. Batches are chunked at 100 and typed as `{scope:'project',projectId} | {scope:'team',teamId}`.
- Only persisted tasks with neither a project nor a team keep the single-task fallback.
- `bulkUpdateTaskStatus`/`bulkArchiveTasks`/`bulkDeleteTasks` take `BulkTaskScope`, which is exactly one of `projectId`/`teamId`. Neither or both throws `RangeError` before any request, mirroring `BULK_SCOPE_INVALID`. Empty ids still throw, mirroring `TASK_IDS_REQUIRED`.
- The JSON body order is unchanged for project scope.

### Delete dedupe (`use-kanban-board.ts` `removeTasksFromBoard`, `hooks/use-task-sse.ts`)

- **One removal path** handles both `tasks:bulk-deleted` (board subscription) and `task:deleted`. `use-task-sse` delegates to the new optional `onTasksRemoved` prop.
- **Presence check:** it runs against the query cache, not a render-time ref, because the announcements arrive back to back before React re-renders. Ids not on the board cause no cache write and no selection update. No toast is emitted for remote deletes.
- **Why presence, not a TTL:** a TTL would wrongly swallow a second delete of a task that was restored within the window.
- **Payload filter:** the old `projectId` filter on the bulk event is gone. Team-scope payloads carry `projectId: null`, and ids that aren't on the board are no-ops anyway.
- **Fallback:** without the prop, `use-task-sse`'s removal is now identity-preserving too.

## Numbers

2,000-task benchmark `components/board/board-pagination.test.mjs`:

- Setup:
  - the real `KanbanBoard` with the test-setup dnd stub
  - a fake keyset server (`lib/query/task-queries.fixture.mjs`) holding 2,000 tasks, 500 per column
- Default run: request counts and DOM counts are asserted at every step.
- `BOARD2_BENCH=1` also prints wall times (jsdom, React dev, shared machine; two runs).

| Step | Requests | Cards in DOM | Wall (run 1 / run 2) |
|---|---|---|---|
| Open | **1** (`pageSize=200&pagination=cursor&view=compact`) | **200** | 152 / 129 ms |
| One "Load more" (Todo) | +1 (`status=todo&cursor&pageSize=50`) | 250 | 45 / 43 ms |
| Drain Todo (9 clicks) | 1 + 9 = **10** in total | 650 (every one of the 500 todos, no duplicates) | 246 / 292 ms |
| SSE `task:updated`, unloaded, beyond the window | 0 | 650 (not inserted) | — |
| SSE, unloaded, column complete | 0 | 651 (inserted at its sorted index) | — |
| SSE, moved into the project inside the Done window | 0 | 652 (index 1 of Done) | — |
| Resync (`connected`) | **4** = first page + Todo pages of 200, 200, 50 | 650 (depth kept) | 29 / 26 ms |

Context:

- **Before:** 1 request and 200 cards, with the other 1,800 tasks unreachable.
- **Not paging is no option:** `board.md` measured a 2,000-card mount at 735–923 ms wall with the same dnd stub (81 s with real dnd in dev mode). The first page bounds the mount at 200 cards.
- **`data-layer.bench` budgets are unchanged and pass:**
  - board open: 1 tasks request;
  - reconnect: 1 tasks request when nothing was extended;
  - SSE bursts: 0 requests.

## Tests

- **Before:** desktop-ui baseline 844 passed + 8 skipped (55 files + 3 skipped).
- **After:** **880 passed + 8 skipped** (58 files + 3 skipped).
- Fonts check ok. Scroll gate ok: 3/3 passes, p95 16.7 ms, max 16.8 ms.
- No existing test was changed or weakened.

| File | New tests | Covers |
|---|---|---|
| `lib/query/task-queries.test.mjs` (new) | 17 | URL shape (pageSize first; compact; status/cursor); bare-array and offset responses are complete; one first-page request with every column at its cursor and boundary; one request per column page, appended in server order; draining a column with bounded requests and no duplicates; a double click is ignored; subscriber notify plus cleanup on `clear()`; depth-preserving reload (2 requests, same array back); id-based identity reuse; a column page started before a reload is dropped; `INVALID_CURSOR` restart; sort-key order and window; merge keeps local copies; the SSE placement rule (inside window, beyond window, complete column at either end, and five never-guess cases) |
| `components/board/board-pagination.test.mjs` (new) | 2 | The 2,000-task benchmark above; an empty-first-page column shows Load more and no empty state |
| `components/board/use-kanban-board.scopes.test.mjs` (new) | 9 | Team-only selection is one `teamId` request; a mixed selection is one request per scope (2 projects + 2 teams); `BULK_SCOPE_INVALID` rollback with mapped copy; bulk+per-task delete announcements cause 0 extra renders, the same list reference and no toasts; same end state when they arrive in one batch; a lone `task:deleted` still removes and clears the open task; a team-scope `tasks:bulk-deleted` (`projectId: null`); detail fetched once per open window plus the persisted-log fallback; sidecar history preferred |
| `components/board/bulk-actions.test.mjs` | +4 | Team scope, chunking, orphan fallback, `TASK_IDS_REQUIRED`/`BULK_SCOPE_INVALID` mapping |
| `lib/api/task-commands.test.mjs` | +2 | `teamId` bodies; exactly-one-scope guard (no request sent) |
| `hooks/use-task-sse.test.mjs` | +2 | Identity-preserving fallback; delegation to `onTasksRemoved` |

Mutation checks (each made the targeted tests fail, then was reverted):

- removing the dedupe → "removes once…" fails;
- routing team tasks back to the single endpoint → 6 failures;
- disabling SSE placement → the 2,000-task test fails (650 vs 651);
- disabling the depth-preserving reload → the reload test fails (1 vs 2 requests).

## Validation

| Check | Result |
|---|---|
| Root `pnpm typecheck` | 11/11 tasks successful |
| Root `pnpm lint` | 282 files, no findings (desktop-ui is not in the biome list). Informational biome run on my new files: clean; on modified files, only pre-existing findings remain (import-type style, `<img>`, existing effect deps) |
| `pnpm --filter @openlinear/desktop-ui test` | 880 passed + 8 skipped; fonts ok; scroll ok |
| `pnpm --filter @openlinear/desktop-ui build` | Success, 20/20 static pages; `next-env.d.ts` was rewritten by the build and restored |
| Strict TS / tokens | No `any`, `@ts-ignore` or `@ts-expect-error`; no hard-coded colours (the Load more button uses `linear-*` tokens and `disabled:opacity-disabled`); the token test passes |

## Leftovers

1. **Search and the assignee filter are client-side over loaded tasks.** The API now has `q`/`assignee`/`labelId` filters. Searching tasks that aren't loaded needs a server-filtered board view (a new scope kind in `keys.ts`, which isn't my file).
2. **Group-by-assignee lanes show loaded tasks only** (no Load more there).
3. **No per-column totals.** `includeTotal` would cost one COUNT per column, so badges read `N+`. A column with nothing on the first page shows `0+` and a Load more until one click settles it.
4. **Out-of-order edge case.** A loaded task that another client moves into a column beyond that column's window sits at the end of the loaded part. That column's next page is appended after it, so it can appear above older rows until a resync re-orders it. It is never duplicated and never hidden.
5. **Cost of a cached paged board.** An unmounted cached board (bridge) marks itself stale for updates to unloaded tasks in its project. The next mount pays 1 + Σ ceil(extra/200) requests. Applying `placeUnloadedBoardTask` in the bridge (`sse-bridge.ts`/`task-cache.ts`, not mine) would avoid that.
6. **`taskDetailQuery` is typed `TaskWithTeam`** (`resources.ts`), but the API returns the full row. The board reads `executionLogs` through a runtime guard. A full `TaskDetail` type would help (`resources.ts` and `types/task.ts` aren't mine).
7. **jsdom/dev numbers only.** A Chromium production-build board benchmark is still not done (board leftover 9).
8. **Archived page** (`app/(app)/archived`): still per-task deletes. Not mine.

## Merge hazards

- **`lib/api/errors.ts` (outside my file list; the brief asked for the mapping there):** three entries were added after `RATE_LIMITED` (`TASK_IDS_REQUIRED`, `BULK_SCOPE_INVALID`, `INVALID_CURSOR`). Additive.
- **`lib/query/task-queries.ts`:** rewritten.
  - `fetchBoardTasks(client, scope)`: was `fetchBoardTasks(scope)`; it is the full-load query function.
  - New exports: `boardTasksPath`, `fetchBoardTaskPage`, `loadMoreBoardColumn`, `getBoardPaging`, `subscribeBoardPaging`, `placeUnloadedBoardTask`, `mergeColumnPage`, sort-key helpers.
  - It imports `BOARD_STATUSES` from `components/board/board-state.ts` and `taskFromCreatedEvent` from `task-cache.ts`.
  - The request URL keeps `pageSize` first: `data-layer.bench` matches `/api/tasks?pageSize=`.
- **`hooks/use-task-sse.ts`:** new optional prop `onTasksRemoved`. `task:deleted` delegates to it when set; otherwise the removal is identity-preserving. Nothing else changed.
- **`components/board/use-kanban-board.ts`:**
  - `handleBulkEvent` was replaced by `handleBoardEvent` (bulk delete plus unloaded-task placement), and `removeTasksFromBoard` was added.
  - `handleTaskClick` loads `taskDetailQuery`.
  - `UseKanbanBoardReturn` gains `columnPaging`, `hasMoreTasks`, `loadMoreTasks`.
- **`components/board/bulk-actions.ts`:** `BulkRequestPlan.batches` is now a discriminated union (`scope: 'project' | 'team'`), and `tasksById` needs `teamId`.
- **`lib/api/task-commands.ts`:** bulk functions take `BulkTaskScope` (`projectId` xor `teamId`), and `CreateTaskRequest` has `assigneeId`. No new lib/api functions, so `routes.test.mjs` CASES are unchanged; the existing rows still pass.
- **`components/board/column.tsx` / `kanban-board.tsx`:**
  - `Column` gains `hasMore`, `loadingMore`, `onLoadMore`.
  - `BoardColumn` gains the same plus `onLoadMore(status)`.
  - `ProjectConfigPanel` gains `moreIssues`.
  - Each card wrapper gets `data-board-task={id}`.
- **API contract dependency:** per-status pages start from the combined page's cursor, which is valid while the keyset cursor is a position not bound to filters. If the API binds cursors to filters, the `INVALID_CURSOR` restart keeps the board working at extra cost; keep `apps/api/src/lib/keyset.ts` semantics or tell the board.
- **Not touched:** `keys.ts`, `sse-bridge.ts`, `task-cache.ts`, `providers/**`, `app/**`, `components/{review,execution,teams,settings,inbox}/**`, `lib/design/**`, `ISSUES.md`.

## Files

- **New:**
  - `apps/desktop-ui/lib/query/task-queries.test.mjs`
  - `apps/desktop-ui/lib/query/task-queries.fixture.mjs`
  - `apps/desktop-ui/components/board/board-pagination.test.mjs`
  - `apps/desktop-ui/components/board/use-kanban-board.scopes.test.mjs`
  - this ledger
- **Modified:**
  - `apps/desktop-ui/lib/query/task-queries.ts`
  - `apps/desktop-ui/lib/api/task-commands.ts` (+ test)
  - `apps/desktop-ui/lib/api/errors.ts`
  - `apps/desktop-ui/components/board/bulk-actions.ts` (+ test)
  - `apps/desktop-ui/components/board/board-state.ts` (`removeBoardTasks`)
  - `apps/desktop-ui/components/board/use-kanban-board.ts`
  - `apps/desktop-ui/components/board/kanban-board.tsx`
  - `apps/desktop-ui/components/board/column.tsx`
  - `apps/desktop-ui/hooks/use-task-sse.ts` (+ test)
