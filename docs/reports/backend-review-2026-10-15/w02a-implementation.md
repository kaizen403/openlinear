# W02a central principal and resource policy — implementation ledger

Status: the bounded W02a slice is implemented and locally verified in an isolated worktree, uncommitted. W02 as a whole is not complete; the W02b remainder is listed at the end. No frontend source, deployment, live database, paid inference, commit or push.

Scope taken from the [master plan](../../../tasks/prd-backend-agent-platform.md) §8 W02 and review unit 3 ("central PrincipalContext with PAT workspace and resource checks, then migrate replay/live audiences and comments/reporting"), the W01 handoff ("comment/usage/chat/search and event/PAT authorization gaps") and audit findings A03, A04 and A05 in [api-data.md](api-data.md).

## Contract

**PrincipalContext.** `TenancyContext` in `apps/api/src/tenancy/types.ts` is extended (and aliased as `PrincipalContext`) with `credentialId` and `workspaceRestriction`. The auth middleware builds it once per request from the verified credential (session JWT, or PAT with `scopes` and `PersonalAccessToken.workspaceId`) and binds it to the request's async context. For a workspace-bound PAT the membership maps are already narrowed to that workspace. Model or request arguments cannot set it.

**One enforcement path.** Policy helpers keep their `userId` signatures, but consult the bound principal when `userId` is the caller (`principalFor` / `workspaceRestrictionFor` in `tenancy/context.ts`). Checks about other users (mention recipients, assignees) are unaffected. This propagates PAT scopes and workspace binding into every consumer without per-route plumbing, including services, chat tools and the sidecar (which imports `requireAuth`/`assertTaskOwned` from the API package):

| Choke point | Rule added |
|---|---|
| `assertProjectAccess` | project must be in the PAT's workspace |
| `assertTaskAccess` | team-only tasks need current team membership **and** no deny on the team's project; orphan tasks unreachable by bound PATs |
| `assertTeamRole` | team's project must not deny the caller; team must be in the PAT's workspace |
| `assertWorkspaceRole` | workspace must be the PAT's workspace (checked before membership, no probing) |
| `projectAccessWhere` / `scoped{Project,Task,Team,Activity}Where` | AND `workspaceId = restriction`; team-only rows inherit team-project deny |
| `getUserTeamIds`, `listWorkspacesForUser`, `ensureDefaultWorkspaceForUser` | narrowed to the bound workspace; bound PATs never create a default workspace |
| `assertPrincipalMayEnterWorkspace` | new workspace, invite-code team join and invitation accept refused outside the binding (`403 PAT_WORKSPACE_RESTRICTED`) |
| `resolvePrincipalForUser` | services that previously rebuilt an unrestricted session context from `userId` (tasks, search, teams, usage, notifications, chat list) now receive the request principal |
| `dispatchTool` | a PAT principal must hold `read` (read tools) or `write` (mutating tools) |

**Comments.** `assertCommentAccess(id, user, 'update' | 'delete')` requires current full task permission, then author, or (delete only) team owner/admin. `assertCommentOwned` delegates to the strict delete policy. Mention recipients and every task-bound notification (`createNotification`: mention, assignment, status change) are filtered to users who can currently view the task. Notification list, unread count and mark-read hide rows for tasks the principal cannot read.

**Reporting and reads.** Usage summary/by-task and own run history intersect the previous own/team scope with current task visibility. Workspace-scoped search (chat tool path) now filters tasks by workspace, as projects and teams already did. Chat session reads/updates/archives re-check project access; the list hides sessions of denied projects. `GET /api/teams` and `listTeams` use `scopedTeamWhere`.

**Realtime.** Every persisted domain event carries a resource binding (`user`, `workspace`, `team` + team project, `project` + project workspace) in two new nullable columns. Audience arrays are routing hints only. `canReceiveEvent` (`tenancy/visibility.ts`) is a snapshot mirror of `resolveProjectAccess`, evaluated for every live delivery and every Last-Event-ID replay row against the stream's own principal (resolved fresh and uncached at connect). Legacy unbound rows/wire events reach only explicitly addressed users. Chat session events go to the owner only (they previously fanned out to the workspace). Execution progress binds to its task.

**Revocation on open streams.** Every membership/grant mutation already calls `invalidateTenancyCache(userId)` after committing; the hub subscribes, synchronously pauses that user's streams, re-resolves the principal and evaluates held events in order under it. Membership events received over the bus trigger the same refresh in other processes. Each heartbeat (30 s) revalidates the principal and closes bearer-JWT streams whose session was revoked. A held buffer over 500 events, or a failed refresh, closes the stream (the client reconnects and replays under a fresh principal).

**Other.** Deleting a workspace revokes PATs bound to it in the same transaction (the `SetNull` FK would otherwise widen them to account-wide). `GET /api/users/me/scm-token` refuses workspace-bound PATs (account-wide credential). `GET/POST /api/pats` expose `workspaceId` (additive).

## Route inventory

[`apps/api/src/registry.ts`](../../../apps/api/src/registry.ts) lists all 136 routes `createApp()` registers: auth mode, permission, actual PAT scopes, enforcement point (closed enum), deciding function, PAT workspace stance (`enforced`, `account-level`, `refused`, `not-applicable`) and tenant path params. [`route-inventory.test.ts`](../../../apps/api/src/__tests__/route-inventory.test.ts) enumerates the live Express router (`route-collector.ts` records mount paths while the app is built) and fails on any registered route missing from the inventory or any stale row. It also probes every row over HTTP:

- non-public routes: 401 unauthenticated (optional routes: not 401);
- session-only routes: 403 `SESSION_REQUIRED` for a PAT; `/api/events`: 401 for a PAT;
- every PAT route: 403 `INSUFFICIENT_SCOPE` for a scope-less PAT and for a near-miss PAT holding every closed scope that does not satisfy the declared one; 401 for revoked and expired PATs; a PAT with exactly the declared scopes passes the gate;
- every GET/DELETE row with tenant params (29 routes): 403/404 for another tenant's ids; for `enforced` rows (23), 403/404 for a PAT bound to another workspace whose owner can read the same resources with a session (control), and every probed resource survives.

The previous registry (111 rows) was hand-maintained and only checked against itself: it missed 26 registered routes, listed one nonexistent route (`GET /api/dashboard`) and declared PAT scopes the middleware did not enforce. The inventory now records what is enforced; tightening is a W02b policy decision.

## Gaps closed and the tests that prove them

| Gap (audit) | Proof |
|---|---|
| PAT workspace binding stored but not enforced (A04): lists, task/label/project/agent-run reads and writes, bulk ops, progress ingest, search, inbox, activity, notifications, usage, members, audit, chat, invitations | `principal-context.test.ts` (MCP client surface), `route-inventory.test.ts` bound-PAT probe |
| Bound PAT could create a workspace, join a team by code, accept an invitation, or obtain the account-wide SCM token | `principal-context.test.ts` "cannot widen itself", "does not release the account-wide SCM token" |
| Workspace deletion widened bound PATs to account-wide | `principal-context.test.ts` "revokes PATs bound to a deleted workspace" |
| Bound PAT triggered default-workspace creation | `principal-context.test.ts` "never creates a default workspace…" |
| PAT scopes not applied to chat tools | `principal-context.test.ts` "still enforces PAT scopes…" |
| Revoked membership on next request (workspace, team) | `principal-context.test.ts` last case; `deny-surfaces.test.ts` "revoked team membership" |
| Comment edit/delete by a denied author, a view-only author, a denied team admin (A05) | `deny-surfaces.test.ts` "comment mutations…" |
| Mentions/status notifications leaking task content to users without access | `deny-surfaces.test.ts` "notifications never carry task content…" |
| Historical usage and own run history on denied tasks (A05) | `deny-surfaces.test.ts` "historical reporting…" |
| Chat reads after project deny | `deny-surfaces.test.ts` "chat reads re-check project access" |
| Workspace-scoped task search returning other workspaces' tasks | `deny-surfaces.test.ts` "workspace-scoped search" |
| Teams of denied projects listed/readable; team-only tasks ignored team-project deny; cross-team isolation | `deny-surfaces.test.ts` "teams and team-only tasks" |
| Live events to denied users via workspace/team audiences; execution progress via workspace audience; chat session events to the workspace (A03) | `events.policy.test.ts` live cases and the real SSE connection case |
| Replay by broad audience union; legacy rows (A03) | `events.policy.test.ts` replay case and real SSE replay |
| Grant revocation / workspace removal not affecting open streams; changes with no event | `events.policy.test.ts` revocation (refresh gated to observe the paused window) and periodic revalidation cases |
| Fail closed when a stream principal cannot be refreshed or its buffer overflows | `events.policy.test.ts` "closes a stream…" |

Mutation checks: disabling the PAT binding in the middleware fails 9 tests (including destructive cross-workspace DELETEs succeeding in the inventory probe); removing the hub's invalidation listener fails both revocation tests; reverting delivery to audience-union semantics fails 7 realtime tests; restoring the pre-W02a `comments`, `usage`, `chat`, `notifications` route files and search service fails 8 deny-surface tests. All mutations were reverted.

## Schema

`packages/db/prisma/migrations/20261015120000_domain_event_resource_binding`: two nullable `ADD COLUMN IF NOT EXISTS` on `domain_events` (`resource_type`, `project_id`). Metadata-only in PostgreSQL, no index, no destructive DDL; passes the CI migration-safety rule. Existing rows stay NULL (legacy, fail closed). Applied only to the disposable local cluster.

## Verification

Disposable Homebrew PostgreSQL 14 cluster in the worktree (`.context/pg`, loopback port 54332, trust auth, `openlinear_test`); all migrations applied with `prisma migrate deploy`. Removed after verification.

| Check | Result |
|---|---|
| API full suite | 30 files; 263 passed, 2 preexisting skips (baseline 213 + 2; 50 new) |
| New W02a files | route-inventory 11, principal-context 12, deny-surfaces 16, events.policy 11 |
| Sidecar suite | 38 files, 661 passed |
| Sidecar PostgreSQL integration | 26 passed |
| execution-core | 28 passed |
| API / sidecar / MCP / execution-core typechecks | passed; root `pnpm typecheck` 11/11 turbo tasks passed |
| `pnpm lint` (CI scope) | passed; new tests/helpers also clean under the same Biome config |

Total local backend: 263 + 661 + 26 + 28 = **978 passing** (previous 928), plus the 2 existing skips (obsolete many-team project association).

~~~sh
TEST_DATABASE_URL=postgresql://openlinear@localhost:54332/openlinear_test pnpm --filter @openlinear/api test
pnpm --filter @openlinear/sidecar test
TEST_DATABASE_URL=postgresql://openlinear@localhost:54332/openlinear_test pnpm --filter @openlinear/sidecar test:integration
pnpm --filter @openlinear/execution-core test
pnpm --filter @openlinear/api typecheck && pnpm --filter @openlinear/sidecar typecheck
pnpm --filter @openlinear/mcp typecheck && pnpm --filter @openlinear/execution-core typecheck
pnpm lint
~~~

No latency claim is made. Policy checks add queries: `assertTeamRole` is one joined query; mention and notification filtering add one access check per recipient; event delivery evaluates an in-memory snapshot per stream (no per-client query); each membership change re-resolves the affected user's open streams (three indexed queries).

## Compatibility and client-visible behavior

- Account-wide PATs (`workspaceId` NULL) and sessions keep their previous access, minus the deny/membership corrections below.
- Workspace-bound PATs (MCP worker, API client): lists narrowed to the bound workspace; other-workspace reads/writes return the existing `403/404 OWNERSHIP_REQUIRED`; new workspace, team join and invitation accept outside the binding, and the SCM token, return `403 PAT_WORKSPACE_RESTRICTED`; `POST /api/projects` without `workspaceId` defaults to the bound workspace.
- Desktop UI (deny/membership corrections): denied users stop receiving project/task/comment/label/activity/progress events for denied projects; chat session events reach only the owner; `GET /api/teams` hides denied-project teams and `GET /api/teams/:id` returns 403 for them; team-only tasks honor the team project's deny; comment edit requires current full permission (view-only authors can no longer edit) and team-admin deletes require current access; notifications about unreadable tasks are hidden (unread counts change) and no longer created; usage totals exclude runs on tasks the user can no longer read; project-scoped chat sessions of denied projects are hidden and return 403.
- Deleting a workspace revokes its bound PATs. `GET/POST /api/pats` add `workspaceId`.
- Pre-migration `domain_events` rows replay only to directly addressed users (rows are pruned after 24–48 h). During a rolling deploy, wire events from old processes lack a binding and reach only directly addressed users.

## Limitations and W02b remainder

1. SSE tickets are not bound to the issuing session: ticket-opened streams survive logout until disconnect (bearer-JWT streams close at the next heartbeat). Needs a ticket→session column and atomic consumption (A12).
2. Events are emitted fire-and-forget without a total order. In-process revocation is closed by the synchronous invalidation hold; across processes it depends on the membership event arriving before later events, otherwise it is bounded by the 30 s heartbeat revalidation. Durable ordered outbox and cursor contract are W04.
3. Replay filters after the 200-row page; a fully filtered page does not advance the cursor (A08, W04).
4. Sidecar batch progress uses user-bound events to the batch initiator (a user who loses access mid-batch keeps receiving that batch's progress); the sidecar's local SSE router has no principal/resource checks; sidecar routes are not in an inventory. W03.
5. `project:deleted`/`workspace:deleted` are bound to workspace/team audiences, so denied members learn a deleted project's id.
6. Account-level surfaces remain reachable by workspace-bound PATs: repositories (including `GET /api/repos/:id` used by MCP/sidecar), uploads, settings, MCP usage, models, profile. Repositories need a workspace/project binding model first (W02b/W10).
7. Scope policy decisions recorded truthfully, not changed: workspace delete needs only `write`; audit log needs `read` plus owner/admin role; labels need generic `write`, not `labels:write`; chat messages require `chat:write`, which is not a mintable closed scope, so only `write`/`admin` PATs can chat. Per-tool scopes beyond read/write belong to W18a.
8. Tokens whose workspace was deleted before this change already have `workspaceId` NULL (account-wide). `audit_logs` `pat.created` rows record the original workspace and can drive a one-off revocation backfill.
9. The process-local tenancy cache (30 s, disabled in tests) can keep a stale legacy-team list on other processes; single-resource assertions and correlated EXISTS filters always read the database.
10. Notifications created before W02a for now-unreadable tasks are hidden, not deleted.
