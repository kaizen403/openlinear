# MCP follow-ups to the W14 API contract (engineer: mcp2, round 7)

Status: implemented and verified locally, uncommitted, not deployed (no `wrangler deploy`; the only wrangler run was `--dry-run --outdir`, and every test talks to the fake API on 127.0.0.1). Base: `922dbd7` + `round7-base.patch` (tree `02c6fdc3…`). Scope: `apps/mcp/**`, `apps/mcp-docs/**`, this ledger.

Source of truth for the follow-ups: `apicontract.md` §8. Two related changes merged in the base also had to be honoured because the worker would otherwise be wrong against the merged API: W02b family PAT scopes (`authz.md` §5) and W04b transactional idempotency on projects/teams (`outbox.md`, `routes/projects.ts`/`teams.ts`).

## 1. Tool changes

| Tool | Change | API used |
|---|---|---|
| `openlinear_list_issues` | All filters are server-side and ANDed: `projectId`, `teamId`, `assignee` (`me`/`none`/uuid), `creator`, `status[]`, `labelId` (one uuid **or up to 20**, any-of), **`parentId`** (uuid or `none`), `query` (literal, 1–200). Keyset paging: new `cursor` input, output `nextCursor`/`hasMore`; new `includeTotal` (default false → `total: null`). The 3×100 client-side scan is gone; one API request per call. | `GET /api/tasks?pagination=cursor&view=compact&pageSize=…&status=a,b&labelId=x,y&q=&parentId=&cursor=&includeTotal=true` |
| ″ (assignee **and** creator) | The API ORs these two. With both, only `assignee` goes to the API and the creator is checked in the worker. It asks for `limit − found` rows per keyset page (≤ 5 pages per call), so every fetched row is returned or skipped and the API's own `nextCursor` stays exact. A page can then hold fewer than `limit` issues with `hasMore: true`; `total` is `null`. | same |
| ″ (old API guard) | If `GET /api/tasks` answers an offset page (`page` field) to a `pagination=cursor` request, the API predates W14 and has ignored the filters. The tool fails with `UNEXPECTED_RESPONSE` instead of returning unfiltered issues. | — |
| `openlinear_get_issue` | Uses `parent` + `subtasks` from `GET /api/tasks/:id` (no project scan). New top-level output `parent` (`{id, identifier, title, status}` or null). `subtasks.items` are now that compact ref shape, and `complete` is false at the API cap of 100. An identifier (`ENG-12`) is resolved through `GET /api/tasks?q=<identifier>&view=compact` keyset pages (100 per page, ≤ 3 pages), keeping only exact case-insensitive matches. `ENG-1` no longer confuses `ENG-12` or text that mentions it, and an ambiguous identifier is refused with the candidates. `/api/search` is no longer used. | `GET /api/tasks/:id`, `GET /api/tasks?q=` |
| `openlinear_label_issue` | Calls `POST /api/labels/tasks/:id/labels` per added label and `DELETE …/labels/:labelId` per removed label, then one `GET` for the result. There is no read-modify-write `PATCH labelIds`, so concurrent edits are never overwritten. 409 `P2002` (already attached) and 404 `P2025` (not attached) are skipped as no-ops. Adds run before removes, so a refused label (`LABEL_NOT_IN_TASK_PROJECT`) in a "replace phase" call has removed nothing. The output shape is unchanged. | attach/detach endpoints |
| `openlinear_bulk_update_status` | `projectId` is now optional, plus a new `teamId` (that team's project-less issues). Exactly one is required, enforced client-side (no API call otherwise). `failed` is described. `taskIds` stays 1–100. | `PATCH /api/tasks/bulk-status` `{projectId|teamId, status, taskIds}` |
| `openlinear_create_issue` | New `assigneeIds` (1–50, `"me"` or uuids, deduplicated; the first is the primary assignee). A team-only create (`teamId` without `projectId`) is documented as project-less with no labels. | `POST /api/tasks` |
| `openlinear_create_project` | `teamIds` (max 1) now means "move this team into the new project" (the API fix). Description and docs explain the rules. The window text is now 24 h. | `POST /api/projects` |
| `openlinear_bulk_create_plan` | `teamId` has the same move semantics; the project adopts it (`teamId` in the output, issues numbered by it). The resume window is now **24 h** (W04b transactional key on the project step). | ″ |
| `openlinear_create_team` | Window text is now 24 h. | `POST /api/teams` |
| `openlinear_search` | Additive: issue hits gain `status`, `priority`, `projectId`, `teamId`; project hits `key`, `status`, `workspaceId`; team hits `projectId` (all nullable). | `GET /api/search` |
| all | `scopes` now list W02b alternatives, e.g. `['write', 'tasks:write']`, `['read', 'tasks:read + projects:read']` for search, `['write', 'projects:write + labels:write + tasks:write']` for the plan, `['write', 'labels:write + projects:read']` for label/phase ensure. They are rendered in the docs badges and scope errors. | registry.ts |
| server instructions | One added line: lists page with `cursor = nextCursor` while `hasMore`. | — |

HTTP client: keyed `POST /api/projects` and `POST /api/teams` now use `retry: 'safe'` (W04b made them transactional). They are auto-retried on 502/503/504, network errors and `IDEMPOTENCY_IN_PROGRESS` with the same key, like task creates.

### Error mapping (src/mcp/errors.ts)
| Code | Message gist |
|---|---|
| 400 `INVALID_CURSOR` | pass `nextCursor` back unchanged with the same filters, or call again without `cursor` |
| 400 `PAGINATION_CONFLICT` | API message + "page with cursor/nextCursor only" (the worker never sends `page`) |
| 400 `TASK_IDS_REQUIRED` | list 1–100 issue UUIDs in `taskIds` |
| 400 `BULK_SCOPE_INVALID` | exactly one of `projectId` (project issues) / `teamId` (team's project-less issues) |
| 400 `LABEL_NOT_IN_TASK_PROJECT` | names the label and issue; "labels must belong to the issue's project" or "the issue has no project"; earlier adds stay, nothing removed, retry skips done work |
| 409 `TEAM_PROJECT_CONFLICT` | per team, from `details.teams[].reason` (`OTHER_WORKSPACE`, `LAST_TEAM_OF_PROJECT`, `TEAM_HAS_PROJECT_TASKS`, `TEAM_KEY_TAKEN`; unknown reasons fall back to "cannot move (REASON)"); "Nothing was created" plus the remedy. Without details: generic text |
| 429 `RATE_LIMITED` | `scope: principal` → "for this personal access token (… every client using the token shares one budget)"; `default` → "for this network address"; other scopes as before; waits for `retryAfterSeconds` |
| 403 `INSUFFICIENT_SCOPE` | adds "this step asked for X + Y" from the new `details.requiredScopes` |

### Auth: narrow-scope PATs (src/auth.ts)
Under W02b, `GET /api/users/me` (the worker's verification call) needs `account:read`, which only the generic `read`/`write`/`admin` scopes satisfy. Before this change, every token with only family scopes (`tasks:write`, `projects:*`, `labels:write`) got **HTTP 403 at `initialize`** and could not use the MCP at all. The API checks the token before its scopes, so `403 INSUFFICIENT_SCOPE` there proves a valid token. The verifier now caches it with `principal.userId = null`. Every tool call is still scope-checked by the API. Any other 403 still answers 403 `insufficient_scope` at the edge. With an unknown owner, tools that must turn `"me"` into a uuid (`assign_issue`, `create_issue.assigneeIds`, the worker-side creator check of `list_issues`) return `INVALID_ARGUMENTS` asking for the user id. `assignee: "me"` / `creator: "me"` filters are passed to the API, which resolves them.

## 2. Compatibility notes (client-visible)
- Unchanged: URL, headers, tool names and order (19), annotations, and every old input of the shipped (v1) tools. The v2 tools (`list_issues`, `get_issue`, `label_issue`, `bulk_update_status`, `search`) have never been deployed: mcp.md v2 is uncommitted and the production MCP still runs the 12-tool worker. So their v2 shapes were changed without compat shims:
  - `list_issues`: removed input `page` (strict inputs reject it); output dropped `page`, `complete` and `scanned`; `total` is now `number | null`; added `nextCursor`, `cursor`, `includeTotal`, `parentId`; `labelId` also accepts an array; `query` min length 2 → 1.
  - `get_issue`: `subtasks.items` are now `{id, identifier, title, status}` instead of full issue summaries; added `parent`; `includeSubtasks` no longer scans.
  - `bulk_update_status`: `projectId` is optional (exactly one of `projectId`/`teamId`); existing calls with `projectId` work unchanged.
- Shipped tools: `create_project.teamIds` / plan `teamId` used to always fail (409). They now move the team when allowed, so a call that used to fail can now succeed. Window texts changed from 1 h to 24 h. `create_issue.assigneeIds` is additive.
- Narrow-scope tokens now connect (they used to get HTTP 403 at `initialize`).
- Error texts changed for the codes above. Usage-log codes are unchanged (API codes).
- **Deploy order:** the API (W14 + W02b + W04b) must be live before this worker. Against an older API, `list_issues` and identifier lookup fail closed (`UNEXPECTED_RESPONSE`, see the guard above) instead of returning unfiltered data. `get_issue` returns `subtasks: null`/`parent: null` when the API lacks those fields. `label_issue` needs the attach endpoint's project check, which is only in W14.

## 3. Tests
`apps/mcp/test`, vitest. The fake API (`fake-api.ts`) was rewritten from the real route, schema and service code:
- registry scope rows and binding stance for every route the worker calls;
- scope matching exactly as in `packages/api-core` (incl. `X:read` ⇐ `read`/`X:write`);
- `INSUFFICIENT_SCOPE.details.requiredScopes`; `PAT_WORKSPACE_RESTRICTED` on `/api/mcp/log` for bound PATs;
- the `listTasksQuerySchema` validation (repeated/comma lists, trims, limits) and `buildTaskListWhere` semantics (team membership, user resolution, assignee+creator OR, any-label, `parentId` none, literal `q`);
- `createdAt DESC, id DESC` order, base64url `{v,c,i}` cursors, `INVALID_CURSOR`, `PAGINATION_CONFLICT`, offset `nextCursor`, `includeTotal`, `view=compact`;
- `getTask` `parent` (visible only) and `subtasks` (non-archived, number order, ≤ 100);
- `assignLabelToTask`/`removeLabelFromTask` (existence-oracle order, `LABEL_NOT_IN_TASK_PROJECT` details, P2002, P2025);
- `bulkUpdateTaskStatus` (`TASK_IDS_REQUIRED` before the scope check, `BULK_SCOPE_INVALID`, team scope = project-less, per-scope not-found text);
- `authorizeCreateTask` (project → default team; team-only → `projectId: null`; explicit assignee 403; `assigneeIds` 400 "Users are not members of this team"; no labels without a project);
- `moveTeamsIntoProject` with rollback and reasons;
- W04a/W04b keys for tasks/bulk/projects/teams scoped per credential, 24 h (`expireIdempotency()`);
- W14 search fields.

| File | Tests | New / changed |
|---|---|---|
| `contract.test.ts` (new) | 22 | list: every filter in one keyset request with the exact query string; parentId none; single label; paging 5 issues by 2 with a 3-way createdAt tie and an insert mid-way (each once, in order, 3 pages, `includeTotal` = 5); pre-W14 offset answer refused; `INVALID_CURSOR`; assignee+creator AND with exact cursor (`pageSize` 2,1,2; creator never sent). get_issue: parent/subtasks with no list call; `eng-1` vs `ENG-12` and a description mentioning it via `?q=`, no `/api/search`. label_issue: request sequence `POST 201, POST 409, DELETE 404, GET 200`, no PATCH, idempotent repeat; project-less issue message. bulk: teamId scope (project task reported in `failed`, body has no `projectId`); both/neither refused with no API call; `TASK_IDS_REQUIRED`/`BULK_SCOPE_INVALID` texts. create_issue: `["me", bob, "me"]` → `[alice, bob]`, primary alice; stranger 400; team-only create, labels refused. Team moves: project adopts team; `TEAM_HAS_PROJECT_TASKS` reason with nothing created; plan `teamId` numbers `GRW-1`. 429 principal. Narrow token: `assignee:"me"` filter passes through, `assign_issue "me"` refused without PATCH, scope error names `write or projects:write` + `projects:write`. describeFailure: `PAGINATION_CONFLICT`, default scope, conflict without/unknown reasons |
| `protocol.test.ts` | 19 | e2e list/get/search assertions updated to the new shapes (3 clients incl. v1 Ajv output validation) |
| `auth.test.ts` | 14 → 15 | "no read scope → 403" replaced by "narrow token accepted and cached" + "other 403 → 403 insufficient_scope" |
| `errors.test.ts` | 19 | label test → `LABEL_NOT_IN_TASK_PROJECT`; TEAM_PROJECT_CONFLICT test → `LAST_TEAM_OF_PROJECT` reason, nothing created, team unmoved |
| `idempotency.test.ts` | 12 → 13 | project/team keys transactional (cross-client replay, team replay); new: keyed project create retried once on 503 with the same key, one project; partial summary says 24 hours; "after 24 h" repeat builds a new project |
| `validation.test.ts` | 12 | +5 rejections: empty `cursor`, bad `parentId`, 21 labels, empty/invalid `assigneeIds` (no API call) |
| `catalog.test.ts` | 2 | catalogue regenerated |

Mutation checks (temporary edits, reverted, `cmp`-verified): sending `creator` in the combined mode fails the AND test; not skipping 409 on attach fails the label test; ignoring `task.subtasks` fails the tree test; refusing every 403 at verification fails the narrow-token auth test.

## 4. Validation
| Check | Result |
|---|---|
| `pnpm --filter @openlinear/mcp typecheck` (worker + test tsconfigs) | pass |
| `pnpm --filter @openlinear/mcp test` | **7 files, 102 passed** (baseline 6 files / 78); 3 more consecutive runs identical, ~0.95 s each |
| `pnpm --filter @openlinear/mcp lint` | pass, 33 files |
| root `pnpm lint` (CI list, includes `apps/mcp/src`, `apps/mcp/test`) | pass, 283 files |
| `wrangler deploy --dry-run --outdir <tmp>` (from `apps/mcp`, bundle only) | pass, 726.04 KiB / gzip 147.34 KiB (was 715.56 / 144.30); 0 `node:` imports; output dir deleted |
| `apps/mcp-docs`: `tsc --noEmit`; `next build` | pass; 19 static pages (`.next/` and `tsconfig.tsbuildinfo` removed afterwards) |
| `UPDATE_TOOL_CATALOG=1 pnpm --filter @openlinear/mcp test` | `apps/mcp-docs/lib/tool-catalog.json` regenerated (scopes, descriptions, new inputs) |

Docs updated (`apps/mcp-docs`):
- `tools/issues`: filters and cursor paging with an example, get_issue parent/subtasks and identifier rules, `assigneeIds` and team-only issues, label attach/detach semantics, bulk scope;
- `tools/projects`: team adoption and a table of the 4 reasons;
- `tools/bulk-create-plan`: `teamId`, 24 h;
- `authentication`: W02b scope table, narrow tokens and `"me"`, 403 row;
- `guides/troubleshooting`: scopes, `"me"`, 24 h windows, new error rows, per-token vs per-IP limits.

`apps/mcp/README.md`: auth and lists bullets updated.

## 5. Leftovers / API gaps (recorded, not mine to change)
1. **Owner identity for narrow PATs.** `GET /api/users/me` / `GET /api/auth/me` need `account:read`, so `tasks:*`/`projects:*` tokens cannot learn their own user id, and `"me"` cannot be written by the worker. Options: declare `GET /api/users/me` with a generic `['read']` (any valid PAT, like `/api/models`; identity only, already `account-read` for bound PATs), or accept `"me"` in `PATCH /api/tasks/:id` `assigneeId` and `POST /api/tasks` `assigneeIds`.
2. **Multi-assignee is write-only.** `assigneeIds` are stored as `TaskAssignee`, but the task payload does not return them and `assignee=<id>` matches only `Task.assigneeId`. The comment in `schemas/tasks.ts` ("Matches the primary assignee or any TaskAssignee assignee") disagrees with `buildTaskListWhere`, which uses only `assigneeId`, as `apicontract.md` §9 says. Needs the product decision listed there.
3. **No exact identifier filter.** Lookup is `q` substring + client-side exact match over ≤ 300 rows; an `identifier=` filter (or `GET /api/tasks/by-identifier/:key`) would make it one indexed query.
4. Attach/detach answer raw Prisma codes for no-ops (409 `P2002`, 404 `P2025`). The worker relies on those codes; idempotent 200/204 no-ops would be cleaner (the worker would keep working).
5. `GET /api/search` needs `tasks:read + projects:read` even for `types=tasks`.
6. Unchanged from mcp.md §11: comments have no `Idempotency-Key` (`add_comment` stays non-idempotent); `POST /api/mcp/log` is refused for workspace-bound PATs (their telemetry is lost); worker-side rate limiting is now less urgent because the API keys PATs individually.
7. MCP (mine, deferred): `list_projects` still filters `query` client-side over the full project list (no API `q` on `/api/projects`); resources/prompts as in mcp.md §11.

## 6. Merge hazards
- `apps/mcp/test/fake-api.ts` is rewritten (exported `FakeTask` type, `addTask` accepts `teamId`/`projectId: null`, `expireLegacyIdempotency()` → `expireIdempotency()`, per-credential keys, registry scope rules). Anyone else editing MCP tests should rebase on it.
- `PatPrincipal.userId` is now `string | null` (`src/auth.ts`); any new worker code that reads it must handle null.
- `apps/mcp-docs/lib/tool-catalog.json` is generated: after merging any other MCP tool change, run `UPDATE_TOOL_CATALOG=1 pnpm --filter @openlinear/mcp test`.
- Depends on the base's W14 (`routes/tasks.ts`, `routes/labels.ts`, `services/projects.ts`), W02b (`registry.ts`) and W04b (`routes/projects.ts`, `routes/teams.ts`) contracts. A later change to those route shapes needs matching edits in `src/openlinear/api.ts` and the fake. Deploy the API before the worker (§2).
- No lockfile, root `package.json` or files outside `apps/mcp/**`, `apps/mcp-docs/**` and this ledger are touched.

## 7. AGENTS.md MCP-section edits needed (coordinator)
- Auth sentence: "Every request … needs a PAT the API accepts" → add: "PATs with only family scopes (`tasks:*`, `projects:*`, `labels:write`) are accepted without an owner lookup (they cannot read `/api/users/me`); tools then need explicit user ids instead of `"me"` for writes."
- "Creates send a deterministic `Idempotency-Key` …" → add "kept 24 h by the API (issues, plans, projects, teams)".
- Tool table rows:
  - `openlinear_list_issues` / `openlinear_get_issue`: "List with server-side filters (status, labels, parent, text, assignee incl. none) and cursor paging (`nextCursor`); get one issue (+ parent, sub-issues, comments, exact `ENG-12` lookup)".
  - `openlinear_label_issue`: "add/remove labels (one attach/detach call per label, no overwrite)".
  - `openlinear_bulk_update_status`: "Status change for 1–100 explicit task ids in one project (`projectId`) or one team's project-less issues (`teamId`)".
  - `openlinear_create_project` / `openlinear_bulk_create_plan`: "`teamIds`/`teamId` moves a movable team into the new project".
  - `openlinear_create_issue`: "+ `assigneeIds`".
- MCP test count: `pnpm --filter @openlinear/mcp test` runs 102 tests in 7 files.
