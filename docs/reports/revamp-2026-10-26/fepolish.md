# Frontend polish: token leftovers, page data on TanStack Query, burst renders (engineer `fepolish`, round 6)

**Status:** done for this slice. Uncommitted, frontend only (`apps/desktop-ui`), nothing deployed.

**Base tree:** `65f96b2` (HEAD `922dbd7` plus `round6-base.patch`). Backlog: the leftover lists in `tokens.md` and `dataui.md`, plus the coordinator's `view=summary` request.

## Outcome

| Area | Before | After |
|---|---|---|
| Tailwind palette classes in `app/` (`text-red-400`, `bg-emerald-500/10`, …) | 65 | **0** (now a test failure anywhere in `app/` or `components/`) |
| Error pages with thinned text (`text-muted-foreground/70`) | 9, at **3.33:1** | **0**, at **5.63:1** (thinned text tokens are now a test failure) |
| Translucent white/black overlays | 29 (app 10, components 19) | **13**, all in `components/execution/` (not mine; mapping documented) |
| Enforced contrast pairs | 417 | **513** (+96 rows on state layers); 18 decorative reported |
| Accent preset checks | 792 | **888**; 0 failures |
| Saved pre-token accents | kept their failing solids (2.94–3.77:1); the boot script still reset legacy users to `#059669` (3.77:1) | migrated on load to the contrast-safe preset (4.63–4.66:1), one table for the boot script and the picker |
| Pages fetching outside the cache | teams, team settings, Settings → Members, project settings, Inbox (list + count), sidebar badge, Archived, Settings → Workspaces | **0** |
| Card renders, 100 `task:updated` in one batch | 175 | **100** (cause found and fixed) |

## 1. Tokens

### Palette classes (65 → 0)

The same tone mapping as the round-4 codemod: red → `danger`, amber/yellow → `warning`, green/emerald → `success`, violet/purple → `discovery`. The tones are the Tailwind 400s, so `text-red-400`, `text-amber-400`, `text-purple-400` and `text-green-400` are pixel-identical. Tints keep their variant and opacity (`bg-danger/10`, `border-success/30`).

| File | Change |
|---|---|
| `archived/page.tsx` (16) | Priority icons and chips: `text-red-600` → `text-danger` (3.91 → 6.83:1), `yellow-600` → `warning`, `emerald-600` → `success`; delete buttons `text-red-400 hover:text-red-300 hover:bg-red-500/10` → `text-danger hover:bg-danger/10` (no lighter-red token exists; the tint carries the hover). |
| `inbox/page.tsx`, `inbox/inbox-utils.ts` (12) | Type chips: mention → `warning`, status → `discovery`, comment → `success`. |
| `my-issues/page.tsx`, `projects/issues/page.tsx` (16) | Status icons → `warning`/`success`/`danger`; priority dots `bg-{emerald,yellow,red}-700` → `bg-success`/`bg-warning`/`bg-danger` (the dots are brighter than the 700s); PR link `text-purple-400 hover:text-purple-300` → `text-discovery hover:text-linear-text`. |
| `teams/page.tsx`, `teams/manage/page.tsx` (12) | Copy check `text-green-500` → `text-success`; join error, trash icons and their hover tint → `danger`. |
| `usage/page.tsx` (5), `login/page.tsx` (3), `auth/callback`, `auth/session` (3) | Error text → `text-danger`; stat accents → `discovery`/`warning`; sign-in success banner → `success`. |

### Error pages

The 9 section error boundaries drop `/70` from the digest line: `text-muted-foreground` on `card` is 5.63:1 (it was 3.33:1). A new test fails on any `text-{muted-foreground,foreground,linear-text*}/NN` in `app/` or `components/`.

### Translucent overlays: state layers

New tier-2 tokens and Tailwind colours:

| Token | Value | Tailwind | Used for |
|---|---|---|---|
| `state-layer` | `neutral-100` | `bg-layer-faint` (0.02), `hover:bg-layer-hover` (0.04), `divide-layer-divider` (0.04), `border-layer-outline` (0.10) | unread rows, sticky group headers, row hover, row dividers, chip outlines |
| `scrim` | new primitive `neutral-0` (`#000`) | `bg-scrim/40`…`/80` | modal, drawer and mobile-sidebar backdrops |

- The alphas are `STATE_LAYER` in `lib/design/tokens.ts`, emitted as `--state-layer-{faint,hover,divider,outline}`. `layer-*` bakes the alpha in, like `primary-hover`. A light theme would point `state-layer` at a dark neutral.
- Contrast: the text ladder and every tinted token are now checked on `layer-faint` and `layer-hover` over `background`, `linear-bg` and `linear-bg-secondary`. Tightest: tertiary on a hovered row is 4.99:1. Dividers and outlines are reported as decorative.
- Converted (16): `app/` 10 (inbox, my-issues, usage), scrims in `components/ui/{dialog,alert-dialog,sheet}.tsx`, `brainstorm-popup`, `brainstorm-drawer` and `layout/app-shell`. Two alphas were normalised: my-issues headers `0.015` → `0.02`, and row hovers `0.03` (my-issues) and `0.02` (usage) → `0.04`.
- Left: 13 classes in `components/execution/` (not my ownership). The mapping is in `docs/design-tokens.md`. The test allows overlays only there.

### Saved accent migration

- **`lib/design/accent-migration.ts`** (new):
  - `ACCENT_MIGRATION_TABLE`: every hex a picker ever saved maps to its current preset. That covers the current presets (as identity), the pre-token presets (`LEGACY_PRESET_VALUES`) and the retired blues (→ default).
  - `migrateStoredAccent()` is used by the Appearance section.
  - `accentBootScript()` emits the ES5 snippet for `app/layout.tsx`. It has its own `try`, so a corrupt preference no longer skips the runtime/platform dataset lines after it, which it did before. Channel fallbacks are now the default solid (`3 133 91`) instead of `5 150 105`.
- **Effect:** Emerald `#059669` (3.77:1), Green `#16a34a` (3.30), Orange `#ea580c` (3.56), Teal `#0d9488` (3.74), Yellow `#ca8a04` (2.94) and Pink `#db2777` move to solids at 4.63–4.66:1. The old Purple/Pink/Red brand colours move to the lightened ones, so the picker marks them selected again. The default no longer has a second copy in `layout.tsx`.
- **`accent-migration.test.ts`** (8 tests):
  - each legacy preset maps to its new preset; the blues reset; current and unknown values are untouched; it is idempotent; every target solid is ≥ 4.5:1;
  - the inlined boot script runs in a `vm` sandbox against the TypeScript function for every input, and corrupt JSON leaves the CSS defaults in place without throwing.
- **Built output:** checked in the static output (`"#059669":["#10b981","#03855b"]` is in the inlined script). Tauri computes the CSP hashes of inline scripts at build time, so the changed script needs no CSP edit.

### Token test

`lib/design/tokens.test.ts` (16 → 19 tests). New failures for:

- palette classes in `app/` or `components/`;
- thinned text tokens;
- white/black overlays (outside `components/execution/`);
- `layer("…")` helpers in `tailwind.config.ts` without a matching variable.

The Tailwind rule test also checks the `layer-*` and `scrim` utilities. `scripts/design-tokens.mjs --inventory` reports overlays and thinned text.

## 2. Data layer

### New cache entries (key factory `lib/query/keys.ts`)

| Key | Endpoint | Used by |
|---|---|---|
| `['ol','teams','directory',{projectId}]` | `GET /api/teams[?projectId]`, full rows | Teams page. Not workspace-scoped, because the command palette opens it unfiltered and it lists every workspace's teams, as before. |
| `['ol','team',id,'detail']` | `GET /api/teams/:id` | team settings and Settings → Members (teams tab), shared |
| `['ol','projects','directory']` | `GET /api/projects?fields=id,name` | create-team dialog. Loaded the first time the dialog opens; it used to refetch on every `project:*` event even when never opened. |
| `['ol','project',id,'detail' \| 'access']` | `GET /api/projects/:id[/access]` | project settings. Labels use the label picker's entry, members the assignee-options entry. |
| `['ol','ws',id,'structure','summary']` | `GET /api/workspaces/:id/structure?view=summary` | Settings → Workspaces; the list is the shared `workspaces` entry |
| `['ol','notifications','list',{pageSize}]`, `['ol','notifications','unread-count']` | `GET /api/notifications?pageSize=100 \| 1` | Inbox and sidebar badge. The list response writes its `unreadCount` into the count entry. |
| `['ol','archived-tasks']` | `GET /api/tasks/archived` | Archived page. It sits outside `['ol','tasks']` so the first stream `connected` doesn't refetch it (parity). |

### SSE

`lib/query/page-caches.ts` is called by the bridge for every event. Where the payload is a full row, it is patched in place, so a page's own write is not followed by a refetch of that page:

- `team:created/updated` (full team), `team:member-added/updated` (member);
- `project:updated`, `project:access-changed` (all three payload shapes);
- `notification:created` (deduped by id);
- `workspace:member-added/updated`.

Where the payload is partial, the entry is marked stale through the coalescing invalidator:

- `team:member-removed` and `workspace:member-removed` (`{userId}` only): only the entries that still list that user are refetched, so the echo of the user's own removal costs nothing;
- `task:deleted` / `tasks:bulk-deleted` (archiving), on the archive;
- `team:joined/left`;
- summaries, on project, team and member events.

A deleted team or project's own entries are dropped. If a page still shows them, they are marked stale without a refetch, and a 404 on the next visit shows "not found" even with an old copy cached.

### Writes (board discipline: optimistic, server copy, per-item rollback)

| Hook | Writes |
|---|---|
| `useTeamMutations` | Team edit is optimistic in the directory, the detail and the workspace team lists (sidebar/filters, only the fields those rows carry). A failure restores only the fields this edit set, and only where they still hold its values. Delete is optimistic and restored at its index. Create and join insert the server row. Member role and removal are optimistic with rollback. |
| `useWorkspaceMemberAdmin` | Role change and removal are optimistic with rollback; invite inserts the server row. |
| `useProjectSettings` | Save and delete apply the server copy to every project list (no `refreshProjects()` refetch). Access grant and revoke apply the server copy; a permission change is optimistic with rollback, as before. Label create/update/delete write the shared label entry (the picker sees them at once). |
| `useNotifications` | Mark read / mark all read are optimistic in the list and the count. A failure now rolls back; before, the failure was only logged. |
| `useArchivedTasks` | Deletes are optimistic. A partial bulk failure restores only the failed rows, in place. Before, the whole list was restored and refetched. |

### Request counts

From the new tests and the bench:

| Scenario | Before | After |
|---|---|---|
| Route change (sidebar badge) | 1 count request each | 0 while fresh (30 s), then 1 |
| Open Inbox | list 1 + count 1 | list 1 (count shared and seeded) |
| Re-open Inbox within 30 s | 2 | 0 |
| Read a notification | PATCH; badge stale until the next route change | PATCH; badge and header update together |
| Teams page, any `team:created/updated/deleted` in the system | 1 refetch each, plus 1 projects refetch per `project:*` | 0 (patched) |
| Team edit (dialog or settings) | PATCH + 2 GET (explicit reload + reload on its own event) | PATCH + 0 |
| Team create / delete | POST/DELETE + 2 GET | + 0 |
| Remove team member | DELETE + 1 GET | DELETE + 0 (echo free) |
| Settings → Members, workspace tab | 1 GET per tab visit | 0 when the board loaded members (shared), else 1 |
| Workspace member role change | PATCH | PATCH (the echo now patches; it used to invalidate every active member list) |
| Project settings open | project + access, then members, + labels = 4 | 4 on a cold cache; members and labels 0 when the board/picker have them |
| Project save / delete | PATCH/DELETE + projects refetch | + 0 |
| Archived, partial bulk failure | DELETEs + 1 GET | DELETEs + 0 |
| Archived, re-open | 1 GET | 0 unless an archive happened since (then 1) |
| Settings → Workspaces | list 1 + N full structures (each workspace's members with users) | 0 list (shared) + N `view=summary` |

### Dedupe tests (+20)

- **`hooks/inbox-badge.test.mjs`** (real Sidebar + InboxPage under the real provider and bridge):
  - one count request shared across Sidebar and Inbox, and across route changes while fresh; a stale count refreshes once;
  - a read and a new notification move the badge and the header together with no refetch, and a repeated event is not counted twice;
  - mark-all is optimistic and rolls back.
- **`hooks/team-pages.test.mjs`** (Teams page + team settings mounted together):
  - an edit is optimistic in both, then no refetch even on its own event;
  - a failure rolls both back and keeps the typed form;
  - delete is restored in place;
  - member events patch, and a removal refetches only teams still listing the user;
  - Settings → Members and the assignee options make one members request.
- **`hooks/settings-pages.test.mjs`**:
  - project settings: one request per resource; labels shared with the picker; own writes and their events cost no refetch;
  - archive: per-item rollback; the cached list is shown on re-open, and an archive event makes it refetch once;
  - workspaces: no list request, `?view=summary` per workspace, counts from `_count`.
- **`lib/query/page-caches.test.mjs`** (8): access patches for all payload shapes; project detail/directory; archive staleness and one refetch per 100-event burst; summaries; team rows; workspace member patching; in-place archive rollback.

### Coordinator request: `view=summary`

- The parameter lives on `GET /api/workspaces/:id/structure`, not `/api/workspaces` (checked in the integration tree: `WORKSPACE_STRUCTURE_VIEWS`). `GET /api/workspaces` already returns `_count` and no member lists, so the switcher needs nothing.
- Added `fetchWorkspaceStructureSummary()` (+ types and `structureMemberCount()`) to `lib/api/workspaces.ts`, and a cloud `CASES` row (+ a `NOT_REQUESTS` entry for the helper) to `routes.test.mjs`.
- Settings → Workspaces reads `_count.members` and falls back to `members.length`, so it also works against this base's API, which ignores `view`.
- No UI reads `/api/activity`, so the `N+` / `count=exact` note needs no change here.

### Bug found and fixed

`fetchTeamMembers` (`lib/api/comments.ts`) typed `GET /api/teams/:id/members` as an array, but the route answers `{ data, nextCursor }`. The comment thread's @-mention list therefore never had members: the hint said "⌘+Enter to send", and typing `@` called `.filter` on an object. It now unwraps either shape.

## 3. The 75 extra card renders: cause found and fixed

- **What happened.** In a one-batch burst of 100 `task:updated` events, the 75 cards that rendered twice were exactly the `todo` and `done` ones (50 + 25); the 25 `in_progress` cards rendered once. A second batch over the same cards rendered 100.
- **Cause.** `TaskCard` had `useEffect(() => { if (task.status !== 'in_progress') setCancelling(false) }, [task.status])`. On mount, every non-running card called `setCancelling(false)`. React takes its eager bail-out for such a call, but leaves the update queued on the hook. The first later batch that re-rendered the card then rendered it a second time (a bail-out render with the same props object, in the near-empty second commit).
- **Confirmation:** removing the call drops the burst to 100.
- **Fix** (`components/board/task-card.tsx`, 1 line): reset during render with a guard, `if (cancelling && task.status !== 'in_progress') setCancelling(false)` (React's "adjust state when a prop changes" pattern). Behaviour is identical: a pending cancel ends when the task leaves `in_progress`, and a new run starts clean (`task-card-cancel.test.mjs`).
- **Bench:** batched burst 175 → **100** card renders. Per-tick burst 100 → 100. Board open and switches are unchanged. The budget in `data-layer.bench.test.mjs` is now `≤ BURST`; I checked that it fails at 175 without the fix.
- **Wider effect:** after a board opens, every non-running card's first update used to cost two renders, whichever batch delivered it.

## Behaviour notes (manual test list)

- **Teams page:** no skeleton flash on team events, and edits appear at once. The create-team project picker loads on first open, and retries on reopen after a failure or an empty result.
- **Team settings:** the form follows server changes (load, own save, others' edits) but is no longer reset by unrelated team events. A failed save keeps the typed values.
- **Settings → Members:** removals are optimistic; the dialog still shows "Removing…".
- **Project settings:**
  - labels are listed highest priority first, as before; a new label appears at its priority position, where it used to be prepended until the next reload;
  - an access-load failure toasts "Failed to load project" but shows the project, where it used to show "Project not found".
- **Inbox:** clicking a notification navigates at once; the read request no longer delays navigation.
- **Archived:** a failed partial delete keeps the successful deletions; it used to restore everything and refetch.
- **Settings → Workspaces:** refresh keeps the list visible and spins the button.
- **Visual:** the archived, my-issues and project-issues priority/status colours move to the tones (red-600 → danger, emerald → success green, yellow → amber). Row hover alphas are normalised to 0.04.

## Validation

| Check | Result |
|---|---|
| `pnpm typecheck` (forced, uncached) | 10/10. The worktree first needed `pnpm --filter @openlinear/db db:generate` (install was `--ignore-scripts`). |
| `pnpm lint` | Pass: biome, 227 files. The 14 new desktop-ui modules are also clean under `biome check` (informational). |
| `pnpm --filter @openlinear/desktop-ui test` | Vitest **61 files passed + 3 skipped; 878 passed + 8 skipped**. Baseline on this base: 844 + 8. **+34 tests:** tokens +3, accent migration 8, routes +2 (one row × 2 runtimes), inbox-badge 3, team-pages 5, settings-pages 4, page-caches 8, task-card-cancel 1. No existing test was changed except the bench budget, tightened from `< 2×BURST` to `≤ BURST`. Fonts: ok. Scroll gate: 3/3 passes, p95 16.7–16.8 ms, max 16.8 ms, 0 long tasks (two full runs). |
| `node scripts/design-tokens.mjs` | Block in sync; 513/513 pairs; 888/888 preset checks. |
| `pnpm --filter @openlinear/desktop-ui build` | Pass: 20/20 static pages. The built CSS carries the `layer-*` and `scrim` utilities, and the HTML the migrated boot script. `next-env.d.ts` was rewritten by the build and restored. |
| Strict TS | No `any`, `@ts-ignore` or `@ts-expect-error`. `--noUnusedLocals` reports nothing new in the changed files; six pre-existing unused imports/vars were left alone. |

## Leftovers

1. **13 overlays in `components/execution/`** (run kit; not mine). The mechanical mapping is in `docs/design-tokens.md`, and the test allows them only there.
2. **Workspace team lists** (`TeamsProvider`, field-limited) still refetch on every `team:*` event: dataui's rule, unchanged; the existing bridge test asserts it. They could be patched like the directory.
3. **`/api/teams/:id/members`** is paginated (50 by default). The mention list now gets the first 50; a team with more members needs paging or `limit=200`, which needs a path change and a `routes.test` row.
4. **No `notification:read` event:** reads on another device reach the badge only when it goes stale (30 s) or on reconnect.
5. **Pre-existing:** project settings shows "No explicit access rules" when the access load fails; `canManageTeam` in Settings → Members is computed and never used.

## Merge hazards

- **`lib/query/sse-bridge.ts`:**
  - imports `page-caches` and calls `applyPageCacheEvent` before its own switch;
  - the team case's generic invalidation now skips `…,'detail'` keys;
  - the `workspace:member-*` case is now a no-op: page-caches patches member lists from the payload and only refetches what it can't apply.
- **`lib/query/keys.ts`, `client.ts`:** new key families (`teams.detail/directory`, `projects.detail/access/directory`, `workspaces.structureSummary`, `notifications`, `archivedTasks`) and `STALE_TIME` entries.
- **`lib/api/routes.test.mjs`:** one `CASES` row (`workspaces.fetchWorkspaceStructureSummary`) and one `NOT_REQUESTS` entry. The review-loop engineer also adds rows here, so expect a textual conflict near the workspaces block.
- **`lib/api/workspaces.ts`:** new summary types/function. **`lib/api/comments.ts`:** `fetchTeamMembers` unwraps `{data}`.
- **`components/board/task-card.tsx`:** the cancel-reset effect is replaced by a render-time guard (one hunk).
- **`components/ui/{dialog,alert-dialog,sheet}.tsx`, `brainstorm-{popup,drawer}.tsx`, `layout/app-shell.tsx`:** `bg-black/N` → `bg-scrim/N`.
- **`components/layout/sidebar.tsx`:** the badge uses `useUnreadNotificationCount` + `prefetchQuery` on route change; `apiFetch`/`useSSESubscription` imports removed.
- **`app/layout.tsx`:** the boot script's accent part is `${ACCENT_BOOT_SCRIPT}` from `lib/design/accent-migration`; the rest of the script and the provider tree are unchanged.
- **Tokens:**
  - `lib/design/{palette,tokens,css,contrast,index}.ts`: `neutral-0`, `state-layer`, `scrim`, `STATE_LAYER`, new pairs;
  - `app/globals.css`: regenerated block, never hand-edited;
  - `tailwind.config.ts`: `layer()` helper, `layer.*` and `scrim` colours;
  - `scripts/design-tokens.mjs`: inventory patterns.

  A parallel token edit must re-run `--write`.
- **New test guards:** a parallel branch that adds a palette class, a thinned text token or a white/black overlay outside `components/execution/` fails `tokens.test.ts` after merge.
- **Pages rewritten in their data sections:** `teams/page.tsx`, `teams/manage/page.tsx`, `settings/members/page.tsx`, `projects/manage/page.tsx`, `inbox/page.tsx` (now imports `inbox-utils`), `archived/page.tsx`, and `components/settings/{workspaces,appearance}-section.tsx`.
- **New files:**
  - `hooks/use-{team-directory,team-mutations,workspace-member-admin,project-settings,notifications,archived-tasks,workspace-structures}.ts`;
  - `lib/query/{page-caches,teams,project-settings,notifications,archived,workspace-structure}.ts`;
  - `lib/design/accent-migration{,.test}.ts`;
  - tests: `hooks/{inbox-badge,team-pages,settings-pages}.test.mjs`, `lib/query/page-caches.test.mjs`, `components/board/task-card-cancel.test.mjs`.
