# TanStack Query as the client data layer (engineer `dataui`, round 3)

Status: done for this slice. Uncommitted; frontend only (`apps/desktop-ui`). Base tree `ef9d881` (HEAD `922dbd7` + `round3b-base.patch`). No API, schema or sidecar change; nothing deployed.

## Outcome

- `@tanstack/react-query` **5.104.5** (pinned exactly) is the cache for the app's server state. One `QueryProvider` sits at the top of the tree. It works in the static export and in Tauri because it is client-only.
- One SSE → cache bridge (`lib/query/sse-bridge.ts`, mounted once as `<QuerySseBridge/>` inside `SSEProvider`) applies every domain event to the cache. It removes the refetch-on-every-event patterns in `useProjects`, `TeamsProvider`, My Issues, Project Issues and the comments thread.
- **Migrated to the cache:**
  - workspaces, projects (provider + Projects page share one entry), teams;
  - workspace members (assignee options), chat sessions list;
  - task detail + comments + task-team members (comments thread), project labels (label picker);
  - My Issues / Project Issues;
  - the board task list and settings.
- **Board:** the optimistic bulk/rollback logic is untouched. Every write now goes through a `setTasks` adapter that writes the board's cache entry, and all 15 board-hook tests pass unchanged.
- **Mutations:**
  - task create: form → `useCreateTask`, Idempotency-Key reused on retry, result inserted into every matching cached list;
  - comments: create/update, plus delete with optimistic removal and rollback;
  - project create/update/delete: server copy applied at once, then refetched.
- **Measured** (table below):
  - board open: 6 → 3 requests;
  - project switch and back: 8 → 1;
  - 100-event SSE burst: 100 → 0 requests;
  - no extra commits except one trivial commit on board open (noted).

## Architecture

### Keys (`lib/query/keys.ts`)

Every key starts with `ol`. The hierarchy is `ol → ws/<id> → resource`.

| Resource | Key |
|---|---|
| workspaces | `['ol','workspaces']` |
| members / chat sessions | `['ol','ws',ws,'members' \| 'chat-sessions']` |
| project / team lists | `['ol','ws',ws,'projects' \| 'teams',{teamId\|projectId, fields}]` — the field list is sorted and part of the key |
| labels / team members | `['ol','project',id,'labels']`, `['ol','team',id,'members']` |
| task lists | `['ol','tasks','list',scope]`, where scope is `{kind:'board',projectId,teamId,pageSize}` \| `{kind:'mine',filter}` \| `{kind:'project-issues',projectId}` |
| task detail / comments | `['ol','tasks','detail',id]`, `[…,'comments']` |
| settings | `['ol','settings']` |

Project-, team- and task-owned keys are not nested under a workspace, because their SSE payloads carry project/team ids but no workspace id.

The project list's field set is the union the app reads (`PROJECT_FIELDS`). `ProjectProvider` and the Projects page therefore hit one cache entry. `REQUIRED_PROJECT_FIELDS` makes `teams` a compile-time requirement; it also satisfies the scroll gate's `'teams'` source guard.

### Defaults (`lib/query/client.ts`)

- **staleTime per resource:**
  - workspaces, members, labels, settings: 5 min;
  - projects, teams: 60 s;
  - tasks, task detail, chat sessions: 30 s;
  - `gcTime`: 5 min.
- **No refetch triggers** for window focus or `online`. Tauri fires focus constantly, and the bridge resyncs on stream reconnects. `networkMode: 'always'`.
- **Read retries** follow `lib/api/errors.ts`:
  - never a 4xx except 408/429;
  - always network/5xx, at most 2 retries;
  - never `AuthExpiredError` or unknown errors;
  - delay = server `retryAfterSeconds` (≤ 30 s), else 1 s/2 s/4 s (≤ 8 s).
  - The board keeps its own initial-load policy: 5 × 1.5 s for network/5xx.
- **Mutations** never retry. Keyed writes use `sendWithIdempotencyKey`.
- **Synchronous notifications** (`notifyManager.setScheduler(cb => cb())`). Every migrated hook replaced a `useState`, so cache writes render with exactly the old timing: the same React batch, and `act()` flushes them. That is why the existing board tests pass unchanged. Nothing subscribes to the QueryCache during render.
- **Devtools:** not added (a new dependency, not essential).
- **Outside the provider:** `useAppQueryClient()` returns the provider client, or a private per-component client. Hooks rendered outside the provider (unit tests, isolated trees) behave like the `useState` they replaced.
- **Hooks that used to apply SSE themselves** (workspace/project/teams providers) keep their subscription. They apply events only when no bridge feeds their client (`hasSseBridge`), so no event is applied twice. A test asserts exactly one `setQueryData` per event when the bridge is mounted.

### Bridge (`lib/query/sse-bridge.ts`, pure; `providers/query-provider.tsx`)

Events arrive through `useSSESubscription`, after the provider's (stream, id) dedupe.

| Event(s) | Cache effect |
|---|---|
| `task:created`/`updated` | Precise merge into every cached board/issue list and the detail. A task leaving a scope is removed. A task possibly entering a server-filtered list marks that list stale. Board scope rules are shared with the board: `lib/query/task-cache.ts`, now also used by `use-task-sse`. |
| `task:deleted`, `tasks:bulk-deleted` | Removed from lists; unobserved detail and comments queries are dropped. |
| `tasks:bulk-created` | Ids only, so affected lists are invalidated. |
| `tasks:bulk-updated` | Ignored: per-task `task:updated` events follow it (verified in `services/tasks.ts`). |
| `batch:completed` | PR URL applied to cached boards. |
| `task:label:*`, `label:*` | Label lists, plus the labels embedded in tasks. |
| `comment:*` | Thread patch. |
| `project:*` | Patch; `created` also refetches, for `_count`/`teams`. |
| `project:access-changed`, `team:*`, `workspace:member-*` | Invalidate. |
| `workspace:joined/updated/left/deleted` | Patch; scope queries dropped on left/deleted. |
| `chat:session:updated` | Patch (auto-titles now appear live). |
| `settings:updated` | Patch. |

- **Invalidations** are coalesced per key and flushed every 50 ms. A burst costs at most one refetch per list, and the flush cancels a refetch already in flight, since its response may predate the event.
- **Resync:**
  - first cloud `connected`: task queries only (parity with the old `fetchTasks` on connect), with `cancelRefetch:false` so an initial load still in flight is reused, not re-sent;
  - cloud reconnect or `replay-gap`: every active query, with inactive ones marked stale;
  - local (sidecar) stream: no resync on first connect, task queries only after that.
- **Board ownership:** a mounted board owns its list. The bridge skips a board list that has observers for the events `use-task-sse`/the board handle themselves (`BOARD_OWNED_META`), so nothing is applied twice. Unmounted (cached) boards are patched by the bridge.
- **User changes:** a sign-out or user switch clears the whole cache.

### Board (`components/board/use-kanban-board.ts`)

- `tasks` is `useQuery(boardTasksQuery(scope))`. `setTasks` writes that key; it is a no-op until the first load lands, exactly like writes to the old empty state that the load then overwrote.
- `loading` = no data yet. `error` = a failed load with nothing to show, and it produces one toast, as before (none for 401 or silent resyncs).
- `fetchTasks` refetches without aborting an in-flight fetch.
- Settings (`taskDeletionMode`) come from the settings query; `setTaskDeletionMode` writes it.
- `structuralSharing` is off for writes, which go through the identity-preserving board helpers. Fetches go through `replaceEqualDeep`, so a resync that returns what is shown keeps every task object. On reconnect, card renders go from 200 → 100 (only the 100 changed tasks).
- **Pagination seam:** `fetchBoardTasks` in `lib/query/task-queries.ts` (marked). Keyset pages load there, or the key moves to `useInfiniteQuery`; the key, the bridge and the optimistic code keep working on one flat list.

## Measurements

The harness is `lib/query/data-layer.bench.test.mjs`. It renders the real providers, the board page body (`KanbanBoard` + `TaskFormDialog`) and My Issues, with fake network, auth and SSE. The default run asserts the budgets. `DATAUI_BENCH=1` prints the numbers instead, and the same file runs unchanged on the base tree (a `git archive` copy with `node_modules` symlinked).

jsdom, React dev build; the request counts are exact. Data: 200 tasks per project; My Issues holds 100.

| Scenario | Requests before → after | React commits before → after |
|---|---|---|
| App start (providers) | 4 → 4 (workspaces, projects, teams, chat sessions) | 5 → 5 |
| First `connected` | 0 → 0 | — |
| Board open | **6 → 3** (members 4 → 1; tasks 1, settings 1) | 5 → 6 (one 1.3 ms commit: settings and members resolve separately) |
| Switch p1 → p2 | **4 → 1** (tasks only; settings and members cached) | 6 → 4 |
| Switch back p2 → p1 | **4 → 0** (cached list shown at once) | 6 → 2 |
| 100 `task:updated`, one batch | **100 → 0** (My Issues refetched per event) | board 2 → 2, total 3 → 2 |
| 100 `task:updated`, one per tick | **100 → 0** | board 200 → 200, total 215 → 200 |
| Cloud reconnect | 2 → 9: by design, see notes | 2 → 3 |

Card renders:

- unchanged for board open, the switches, and the per-tick burst;
- reconnect: 200 → 100;
- one-batch burst: 100 → 175.

The extra 75 in the one-batch burst are bail-out re-renders in a second, near-empty commit (0.2 ms). Each re-renders a TaskCard with the same props object.

- They are not caused by parent props: an instrumented `BoardTaskItem` saw only `task` changes.
- Not by TaskCard's store hook: they persist with `useExecutionProgress` stubbed.
- Not by its effects: no mount or status effect ran.
- Not by the scheduler: they persist with a microtask scheduler.

They occur only when 100 events land in one tick. The realistic per-tick case is identical to before. Recorded as an open item.

Also unit-tested:

- three `useTeamMembers` consumers make 1 request;
- 100 coalesced invalidations make 1 refetch;
- an in-flight load is reused on the first `connected`;
- a mounted board is never resynced by the bridge.

## Behaviour notes (manual test list)

- **Project switch and remount:** switching back to a project, or remounting the board (the board page remounts it after the task form succeeds), shows the cached list at once, with no skeleton. It refetches only when older than 30 s. A task created in the form is already in the list.
- **Live lists:** My Issues and Project Issues update in place on SSE, and refetch (coalesced) only when a task may have entered the list. Before, they refetched on every `task:updated`/`created`, and never on delete.
- **Label picker:** labels are cached per project for 5 min and kept live by `label:*` events (before: a session-long module map). After a load error, reopening the picker retries (before: only the Retry button). `invalidateLabelCache` still works, through the mounted app client.
- **Comments:** the thread is cached per task. Errors keep the same inline message; delete is still optimistic with rollback.
- **Chat sessions:** the list picks up `chat:session:updated` (auto-title).
- **Retries:** reads of workspaces, projects, teams, members and chat sessions now retry network/5xx failures twice before falling back to an empty list (before: no retry).
- **Teams provider:** `isLoading` is true for the first load only (nothing reads it).
- **Context values** of the workspace/project/teams/chat providers are memoized: consumers re-render only when a value changes.

## Validation

| Check | Result |
|---|---|
| `pnpm typecheck` (root) | 10/10 tasks successful |
| `pnpm lint` (root biome list) | 162 files, no findings. New desktop-ui files are also clean under `biome check` (informational; desktop-ui is not in the lint list). |
| `pnpm --filter @openlinear/desktop-ui test` | **828 passed + 2 skipped**, 54 files + 2 skipped. On this base the baseline is 795 + 2 (measured on the base copy; the brief's 794 predates the last base). Fonts `ok`; scroll gate `ok` p95 16.7 ms / max 16.8 ms. **No existing test was changed.** |
| New tests (+33) | `lib/query/sse-bridge.test.mjs` 16, `lib/query/client.test.mjs` 13, `providers/query-provider.test.mjs` 3, `lib/query/data-layer.bench.test.mjs` 1 (budgets) |
| `pnpm --filter @openlinear/desktop-ui build` | success, 20/20 static pages. `next-env.d.ts` was rewritten by the build and restored. |
| Strict TS | no `any`, `@ts-ignore` or `@ts-expect-error`; `--noUnusedLocals` is clean on the changed files |

## Leftovers

1. **Not migrated (own fetch plus refetch-on-event):**
   - `app/(app)/teams/page.tsx` and `teams/manage/page.tsx`: they fetch teams without a workspace id, so they need a key decision;
   - `settings/members`;
   - `projects/manage` (project detail, access, labels in page state; it calls `refreshProjects()`, which refetches the shared list);
   - `inbox` and the sidebar unread badge (refetches on every pathname change);
   - `archived`.

   Team edit mutations live on those pages and are not migrated.
2. **Reconnect cost:** a cloud reconnect refetches every active query (9 requests in the harness vs 2 before), as the brief asked ("full resync on connected"). The cloud stream already replays from `lastEventId`, so if that is too eager, it is a one-line policy change in `applySseEventToCache` (`'connected'` case: resync tasks only unless `replay-gap`).
3. **Open render item:** the one-batch burst's 75 bail-out card renders (see Measurements).
4. **Inline create:** the board's inline create keeps its direct `sendWithIdempotencyKey` (optimistic temp row in the board list). Other lists get the task from the `task:created` event.
5. **Pre-existing:** a task moved into a mounted board's scope still appears only after a refetch (`use-task-sse` kept as is). Unmounted lists are marked stale by the bridge.
6. **Devtools** not added.

## Merge hazards

- **`app/layout.tsx`** (outside listed ownership, required): `QueryProvider` wraps `AuthProvider`, and `<QuerySseBridge/>` is the first child of `SSEProvider`. Anyone editing the provider tree must keep the bridge inside both `SSEProvider` and `AuthProvider`.
- **`components/board/use-kanban-board.ts`:**
  - `tasks`/`loading`/`error`/`taskDeletionMode` state is replaced by queries;
  - `fetchTasks` is rewritten;
  - the initial-load effect is removed.

  Board work that adds `setTasks` calls is unaffected. Anything that reintroduces local task state must write the cache instead.
- **`hooks/use-task-sse.ts`:** `task:created`/`task:updated` now use the shared helpers in `lib/query/task-cache.ts`, with the same semantics.
- **Global notification scheduler:** `lib/query/client.ts` sets TanStack's `notifyManager` scheduler to synchronous delivery for the whole app.
- **Pages and components** (consumer edits, minimal):
  - `app/(app)/my-issues/page.tsx` and `projects/issues/page.tsx` use `useMyIssues`/`useProjectIssues`;
  - `components/comments-thread.tsx` uses `useTaskComments`;
  - `components/label-picker.tsx` uses `useProjectLabels` (`invalidateLabelCache` is kept);
  - `components/task-form.tsx` uses `useCreateTask`; the key handling is unchanged.
- **Rewritten providers** (public context APIs unchanged): `hooks/use-workspace.tsx`, `hooks/use-project.tsx`, `providers/teams-provider.tsx`, `hooks/use-chat-sessions.tsx`, `hooks/use-projects.ts`, `hooks/use-team-members.ts`.
- **`GET /api/tasks` filters/keyset** (other engineer): integrate in `fetchBoardTasks` (`lib/query/task-queries.ts`). The issues lists use `fetchMyIssues`/`fetchProjectIssues` from `lib/api/tasks.ts`, unchanged.
- **Dependencies:** `apps/desktop-ui/package.json` + `pnpm-lock.yaml` add `@tanstack/react-query` 5.104.5 (and `@tanstack/query-core`).
- **Not touched:**
  - `lib/api/{client,fetch,auth,routes,event-stream}.ts`, `providers/sse-provider.tsx`, `components/execution/**`, `lib/run-model/**`, `components/ui/**`, `scripts/**`;
  - no new `lib/api` request functions, so `routes.test.mjs` is unchanged.
