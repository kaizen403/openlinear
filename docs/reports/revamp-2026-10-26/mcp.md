# MCP server v2: stable SDK, tests, safe retries, management toolset (2026-10-25)

Status: implemented and verified locally. Not committed, not deployed (no `wrangler deploy`, no remote change, no call to the production API or MCP host). Scope: `apps/mcp/**` and `apps/mcp-docs/**` only, plus the `apps/mcp` importer in `pnpm-lock.yaml`.

## Outcome

- `apps/mcp` moves from `@modelcontextprotocol/server` / `node` `2.0.0-alpha.2` on Express and the `cloudflare:node` HTTP shim to `@modelcontextprotocol/server` **2.4.0** with a web-standard `fetch` handler (`createMcpHandler`). The handler serves both the 2025 revisions (initialize handshake) and the stateless 2026-07-28 revision. It is still stateless Streamable HTTP on Workers, and existing client configs work unchanged.
- **Auth.** The worker now verifies the PAT with the API before serving any MCP method, `initialize` and `tools/list` included. Unauthenticated requests get 401 with an RFC 6750 `WWW-Authenticate` challenge that points at new RFC 9728 protected-resource metadata. Requests from a disallowed browser `Origin` get 403.
- **Safe retries.** Issue, plan, project and team creation send a deterministic `Idempotency-Key`, so retried calls replay the stored result instead of duplicating. `bulk_create_plan` reports exactly what it created and resumes cleanly when called again with identical arguments.
- **Tools.** 12 → **19**. New tools: search, list/get issues (get returns comments and sub-issues), assign, label, bulk status, comment. Every tool now has a title, all four annotations, described inputs, strict input schemas, an `outputSchema` and compact `structuredContent`.
- **Tests.** The MCP app had none; it now has **78 vitest tests in 6 files**. They use real MCP clients (v1 SDK and v2 in both eras) against a fake OpenLinear API on 127.0.0.1. The run uses no network or database and takes about 0.5 s.
- **Docs.** `apps/mcp-docs` renders its tool reference from a catalogue generated from the live `tools/list`, and a test fails when the catalogue drifts. Known false statements are fixed.

## 1. SDK decision

Checked against the npm registry on 2026-10-25 (`npm view`, tarballs inspected offline):

| Line | Package | Latest | Notes |
|---|---|---|---|
| v2 (stable since 2.0.0, 2026-07-27) | `@modelcontextprotocol/server` | **2.4.0** (2026-10-23) | README: "v2 of the MCP TypeScript SDK, the stable release line, implementing the 2026-07-28 MCP spec". Deps: `zod ^4.2.0`, `@modelcontextprotocol/core` 2.4.0 |
| v2 | `@modelcontextprotocol/client` / `core` | 2.4.0 | used by tests / transitively |
| v2 | `@modelcontextprotocol/node` | 2.1.2 | no longer needed |
| v1 (maintenance) | `@modelcontextprotocol/sdk` | 1.32.2 (2026-10-23) | README points to v2 |

**Decision: pin `@modelcontextprotocol/server` 2.4.0 exactly, with `zod` 4.4.3 exactly** (already in the lockfile, satisfies `^4.2.0`).

Why v2 rather than v1:
- **Current stable line.** v2 is GA and is the line the alpha already used. Moving to v1 would have been a downgrade and a rewrite.
- **`createMcpHandler(factory)`** is a web-standard handler built for Workers. It has two legs:
  - **Modern:** serves 2026-07-28 traffic per request (no `initialize`, per-request `_meta` envelope, `server/discover`, `Mcp-Method`/`Mcp-Name` header checks).
  - **Legacy (`legacy: 'stateless'`, the default):** serves 2025-era clients through a fresh `WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })` per POST. This is the same stateless idiom the worker used before. Supported revisions are 2024-10-07, 2024-11-05, 2025-03-26, 2025-06-18 and 2025-11-25.

  One factory backs both legs, so the two eras cannot drift. v1 has no 2026-07-28 support.
- **Workers runtime.** The `workerd` export condition selects the `@cfworker/json-schema` validator, so Ajv and Node built-ins are not bundled. The dry-run bundle contains no `node:` imports.
- **Auth helpers.** The SDK has web-standard auth helpers and Origin validation (`originValidationResponse`, `validateOriginHeader`).

Why 2.4.0 rather than 2.3.1: it is the current release. Its fixes are a modern-revision binding fix for per-request `Server` instances and `Allow: POST` on 405. Its breaking changes (`x-mcp-header` on numbers, a `{result}` wrap for `.meta({id})` output schemas, the fast-uri `$id` rule) do not touch this server. If a regression appears, 2.3.1 is a drop-in fallback.

Dependency changes in `apps/mcp/package.json`:
- **Removed:** `@modelcontextprotocol/node`, `express`, `@types/express`, `@cfworker/json-schema` (the server bundles its validators).
- **Added (dev):** `vitest` 4.0.18 (the version the API uses), `@modelcontextprotocol/client` 2.4.0 and `@modelcontextprotocol/sdk` 1.32.2. The last is the client most hosts embed today, used to prove 2025 compatibility.
- **Unchanged:** wrangler `^4.39.0` (lockfile 4.93.0), `@cloudflare/workers-types`.
- **Package version:** 1.0.0 → 2.0.0. `serverInfo.version` is now 2.0.0 and is also returned by `/healthz`.

`wrangler.toml` changes:
- Dropped `enable_nodejs_http_server_modules`. `nodejs_compat` is kept as a safety net, although the bundle no longer needs it.
- Added empty `MCP_ALLOWED_ORIGINS` and `MCP_AUTHORIZATION_SERVERS` vars and `[observability] enabled = true`. The worker now emits structured warn/error lines, and none contain tokens.
- `workers_dev` and the route are unchanged (see leftovers).

## 2. Architecture

```
src/index.ts          Workers entry: env → readConfig, ctx.waitUntil; worker cached per isolate
src/worker.ts         routes: POST /mcp (Origin check → PAT gate → createMcpHandler), GET|DELETE /mcp → 405,
                      /.well-known/oauth-protected-resource[/mcp], /healthz, / ; 2 MiB body cap; no stack traces
src/auth.ts           PAT format check, verification via GET /api/users/me, 60 s per-isolate cache keyed by
                      SHA-256(token), RFC 6750 challenges
src/openlinear/       own HTTP client (timeouts, cancellation, safe retries, Idempotency-Key, X-Request-Id)
                      and zod-validated endpoint wrappers
src/mcp/server.ts     the 19 tools in deterministic order + server instructions
src/mcp/tool.ts       defineTool(): registration, annotations, output parsing, error mapping, usage logging
src/mcp/tools/*.ts    tools; src/mcp/errors.ts API error → actionable message; src/mcp/idempotency.ts keys
```

Per request the SDK calls the factory with the `authInfo` the worker passes. The worker puts a `RequestScope` (token, principal, services) in `authInfo.extra`, and the factory builds a fresh `McpServer` from it. Tool handlers get an API client whose requests share one `X-Request-Id`.

The worker no longer uses `packages/api-client`. That package has no per-request headers, timeouts or idempotency keys, and it is not mine to change (see follow-ups). `tsconfig.json` no longer includes it.

## 3. Tool catalogue

Annotation legend: RO = readOnlyHint, D = destructiveHint, I = idempotentHint. `openWorldHint` is `false` for every tool, because the tools only touch the caller's own OpenLinear data. All four hints are always set explicitly; clients default `destructiveHint` and `openWorldHint` to true.

| Tool | Status | RO | D | I | Scopes | API routes |
|---|---|---|---|---|---|---|
| `openlinear_list_workspaces` | kept | ✓ | – | ✓ | read | GET /api/workspaces |
| `openlinear_list_projects` | kept, + `query`, `limit` | ✓ | – | ✓ | read | GET /api/projects |
| `openlinear_get_project` | kept, + labels/phases | ✓ | – | ✓ | read | GET /api/projects/:id, GET /api/labels |
| `openlinear_create_project` | kept, keyed | – | – | ✓ | write | POST /api/projects |
| `openlinear_list_teams` | kept, members exposed | ✓ | – | ✓ | read | GET /api/teams |
| `openlinear_create_team` | kept, keyed | – | – | ✓ | write | POST /api/teams |
| `openlinear_list_labels` | kept, + `phasesOnly` | ✓ | – | ✓ | read | GET /api/labels |
| `openlinear_create_label` | kept, ensure semantics | – | – | ✓ | write | POST/GET /api/labels |
| `openlinear_create_phase` | kept, ensure semantics | – | – | ✓ | write | POST/GET /api/labels |
| `openlinear_search` | **new** | ✓ | – | ✓ | read | GET /api/search |
| `openlinear_list_issues` | **new** | ✓ | – | ✓ | read | GET /api/tasks |
| `openlinear_get_issue` | **new** (+ comments, sub-issues, identifier lookup) | ✓ | – | ✓ | read | GET /api/tasks/:id, …/comments, /api/tasks (`identifier`) |
| `openlinear_create_issue` | kept, keyed, + `idempotencyKey` | – | – | ✓ | write | POST /api/tasks |
| `openlinear_update_issue` | kept (rejects empty updates) | – | ✓ | ✓ | write | PATCH /api/tasks/:id |
| `openlinear_assign_issue` | **new** (`"me"` / uuid / null) | – | ✓ | ✓ | write | PATCH /api/tasks/:id |
| `openlinear_label_issue` | **new** (add/remove) | – | ✓ | ✓ | write | GET + PATCH /api/tasks/:id |
| `openlinear_bulk_update_status` | **new** | – | ✓ | ✓ | write or tasks:write | PATCH /api/tasks/bulk-status |
| `openlinear_add_comment` | **new** | – | – | ✗ | write | POST /api/tasks/:taskId/comments |
| `openlinear_bulk_create_plan` | kept, keyed, + `idempotencyKey` | – | – | ✓ | write or tasks:write | projects, teams, labels, POST /api/tasks/bulk |

Every route was checked against `apps/api/src/registry.ts` and its route file.

Design notes:
- **`list_issues` filters.** `projectId`, `teamId`, `assignee` (`me` or a UUID) and `creator` are applied by the API. `status[]`, `labelId`, `query` and `assignee: "none"` are not supported by `GET /api/tasks`. The MCP server applies them itself over at most 3 pages of 100 issues, and reports `scanned` and `complete`.
  - The API ORs `assignee` with `creator`. When both are given, the MCP server sends only `assignee` and applies `creator` locally, so the two filters AND as an agent expects.
- **`get_issue`.**
  - Identifiers such as `ENG-12` are resolved through `GET /api/tasks?identifier=…&q=…` (exact filter since 2026-10-27; `q` keeps older APIs working) with an exact, case-insensitive match. Ambiguous identifiers are refused and the candidates are listed; so is a lookup whose pages were not all read, even with a single match (another workspace can share the team key).
  - Returns the newest `commentLimit` comments (default 30) in chronological order.
  - Sub-issues are found by scanning the project's issues for a matching `parentId` (same 300-issue bound). The API has no `parentId` filter.
- **`label_issue`** is a read-modify-write through `PATCH labelIds`, because that path checks that labels belong to the issue's project. The direct `POST /api/labels/tasks/:id/labels` does not (see follow-ups). Concurrent label edits can race; this is documented.
- **`bulk_update_status`** requires 1–100 explicit `taskIds`. When `taskIds` is omitted, the API changes every issue in the project; the schema makes that unreachable, and a test proves it.
- **Strict inputs.** Unknown argument names are now rejected as tool errors. Before, they were silently dropped (e.g. `labels` instead of `labelIds`). Ids use the lenient 8-4-4-4-12 pattern (`z.guid()`), the same check as the API's zod 3 `.uuid()`. Each tool call is capped at 5 000 elements (`maxToolInputElements`).
- **Outputs.**
  - Every tool returns `structuredContent` that is parsed through its `outputSchema`, so it always validates, including under the v1 client's Ajv. The same JSON (compact) is in the text block.
  - Issue rows are compact: no `executionLogs`, `sessionId` or nested execution data.
  - The old `structuredContent` bug (arrays spread into `{0:…,1:…}`) is gone, because list tools now return `{ workspaces | projects | teams | labels | issues: [...] }`.
- **Phase labels.** Labels named `phase:N — Name` are parsed into `phase: { number, name }` on labels and issues.

## 4. Auth behaviour

| Request | Answer |
|---|---|
| No `Authorization` | 401, `WWW-Authenticate: Bearer realm="OpenLinear MCP", resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"` (no `error`, RFC 6750 §3.1). Body `{error:"invalid_token", error_description, error_uri}` |
| Malformed (not `Bearer ol_pat_` + 32 lowercase hex) | 401 `error="invalid_token"`. No API call |
| Unknown, expired or revoked (API 401) | 401 `error="invalid_token"` |
| Token with no read access (API 403) | 403 `error="insufficient_scope", scope="read"` |
| API unreachable or 5xx during verification | 503, `Retry-After: 5`. Not cached; no upstream body is forwarded |
| Valid | cached 60 s per isolate (SHA-256 key, at most 500 entries) |
| Tool call gets API 401 (revoked inside the cache window) | tool error "rejected the personal access token…". The cache entry is evicted, so the next MCP request gets HTTP 401 |
| Browser request whose `Origin` is not in `MCP_ALLOWED_ORIGINS` | 403 (SDK `originValidationResponse`), before auth. Allowed origins get CORS headers, including on 401 answers |

Other behaviour:
- **Protected-resource metadata.** Served at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`, with `Access-Control-Allow-Origin: *` and a 1 h cache. It contains `resource`, `resource_name`, `resource_documentation` and `bearer_methods_supported: ["header"]`.
  - `authorization_servers` appears only when `MCP_AUTHORIZATION_SERVERS` is set. MCP's authorization spec wants at least one, but OpenLinear has no authorization server, and advertising one that does not exist would send OAuth clients into a dead end. Valid-PAT clients never see a 401, so they are unaffected.
- **Discovery needs a token.** `tools/list` and `initialize` now need a valid token; before, any string matching the format worked (C5 §4.3).
- **Usage telemetry.** `POST /api/mcp/log` is called once per tool call, with the MCP tool name and an error code, never the message. It runs via `ctx.waitUntil` and is off the response path.
  - Before, the worker logged every client method name (`createProject`, `listTeams`, …), and each log was an awaited extra round trip (C5 §4.5).
  - Read-only tokens get 403 on the log route; the worker remembers that per cached token and stops trying.

## 5. Error mapping (API → MCP tool error)

All failures are `isError: true` tool results with an actionable text and no `structuredContent`; the v1 client validates any `structuredContent`, even on errors. Bodies that are not JSON (e.g. HTML from a proxy) are never forwarded. When the API returned a request id, the message includes it.

| API answer | Message gist | Usage code |
|---|---|---|
| 400 `VALIDATION_ERROR` etc. | "rejected the request as invalid (CODE): message (field: reason; …). Fix the arguments" | API code |
| 401 | rejected token → create a new PAT, update the client header (and cache eviction) | `UNAUTHORIZED` |
| 403 `INSUFFICIENT_SCOPE` | "lacks the scope <tool> needs (write or tasks:write)" | API code |
| 403 `PAT_WORKSPACE_RESTRICTED` | bound to workspace `<id>` → use that workspace's ids or an account-wide token | API code |
| 403 `SESSION_REQUIRED` | not available to PATs | API code |
| 403 `OWNERSHIP_REQUIRED` | "Access denied to <type> <id>: role / project access / token bound to another workspace" (+ request id) | API code |
| 404 | "Not found: <type> <id> … look it up with list/search tools" | API code |
| 409 `IDEMPOTENCY_CONFLICT` | key used for different arguments → repeat exact arguments or pass a new `idempotencyKey` | API code |
| 409 `IDEMPOTENCY_IN_PROGRESS` | auto-retried (Retry-After ≤ 2 s, 3 attempts); then "still being processed… call again with the same arguments, not a duplicate" | API code |
| 409 `TEAM_PROJECT_CONFLICT` | omit teamId/teamIds; every project gets a default team | API code |
| 409 `P2002` | unique conflict (fields) → reuse the existing one or choose another value | API code |
| 413 | 256 KB per request → send fewer or shorter items | `PAYLOAD_TOO_LARGE` |
| 422 `IDEMPOTENCY_RESPONSE_TOO_LARGE` | split the work | API code |
| 429 | "rate limit reached (scope). Wait N seconds" | `RATE_LIMITED` |
| 5xx, timeout, network | "error/unreachable. <retry advice>": "identical arguments is safe" for read and idempotent tools, otherwise "may or may not have been applied: check state first" | API code / `API_TIMEOUT` / `API_UNREACHABLE` |
| 2xx with an unexpected shape | "returned an unexpected response …" (logged) | `UNEXPECTED_RESPONSE` |
| Semantic argument errors in a tool | e.g. "Nothing to update", "Either projectId or teamId is required" | `INVALID_ARGUMENTS` |

Automatic retries are bounded to 3 attempts with 250 ms / 750 ms backoff, and wait for `Retry-After` only up to 2 s. They apply only to:
- GETs;
- keyed POSTs to the transactional W04a routes (`/api/tasks`, `/api/tasks/bulk`);
- on 502/503/504, network errors and timeouts (15 s per attempt), and `IDEMPOTENCY_IN_PROGRESS`.

Legacy-cache writes (projects, teams) and unkeyed writes are never auto-retried.

## 6. Safe retries (Idempotency-Key)

**Derivation** (`src/mcp/idempotency.ts`):

`key = "mcp1." + step + "." + hex(SHA-256(canonicalJson({ v: 1, tool, step, material })))`

- Canonical JSON sorts object keys, drops `undefined` and keeps array order.
- `material` is the tool's validated arguments, including the optional `idempotencyKey` argument. Multi-step tools add the ids the step depends on.
- Keys are at most 111 characters from `[a-z0-9.-]`, inside the API contract (8–128 characters from `A-Za-z0-9._:~+/=-`).

The key is derived from the call's content, not from the JSON-RPC id, and this is deliberate. Clients retry with a new request id, a new connection, or after the model repeats the call, and the 2026-07-28 spec requires a broken stream to be re-issued with a new id. So identical arguments → identical key → the API replays (`Idempotency-Replayed: true`, surfaced as `idempotency.replayed`). Changed arguments → a new key, so there is no stale replay and no 409 conflict. To create a second identical item deliberately, pass a new `idempotencyKey`. The API already scopes records per user, workspace and operation.

| Tool | Steps / keys | API store | Window |
|---|---|---|---|
| `create_issue` | `issue` | W04a `idempotency_records`, transactional | 24 h |
| `bulk_create_plan` | `plan.project` (from the plan hash); `plan.team` (fallback only); `plan.phase.N.C` per phase chunk (plan hash + projectId + chunk body incl. label id) | project/team: legacy `idempotency_keys` (non-atomic). Chunks: W04a | project 1 h, chunks 24 h |
| `create_project` / `create_team` | `project` / `team` | legacy cache | 1 h |
| `create_label` / `create_phase` | none: "ensure" semantics on the unique `(projectId, name)` (409 → return existing, `created: false`) | n/a | permanent |
| `add_comment` | none: the API has no key support, so it is marked `idempotentHint: false` | n/a | n/a |

**`bulk_create_plan` partial-failure contract:**
- If the project cannot be created, the tool returns an error and nothing exists.
- Otherwise phases run in order:
  - phase labels are found by name or created; chunks are at most 100 tasks and about 200 KB;
  - each phase result has `taskIds` (also on failure), `failed[]` (per-task API refusals), `error`, `replayed` and `labelReused`;
  - after `UNAUTHORIZED`, `INSUFFICIENT_SCOPE`, `RATE_LIMITED` or `CANCELLED`, the remaining phases are marked `Skipped:`.
- The result carries `status: "complete" | "partial"` and a `summary`. A partial summary starts with `PARTIAL` and tells the agent to repeat with identical arguments within 1 h.
- The repeat replays the project and the completed chunks, reuses the labels, and creates only what is missing. Tests prove there are no duplicate projects, labels or tasks.
- After 1 h the project step is no longer remembered, so a repeat creates a new complete project. It does not get 409s, because chunk keys include the new label ids and project id. This is tested and documented.
- Backward compatible: the old fields (`projectId`, `projectKey`, `projectName`, `totalTasks`, `phases[].name/labelId/labelName/taskCount/taskIds/failed/error`) keep their names and meaning.

## 7. Tests (`apps/mcp/test`, vitest 4.0.18)

The harness (`harness.ts`) starts two servers on `127.0.0.1:0` (ephemeral ports):
- `fake-api.ts`: an in-memory OpenLinear API, written against `apps/api/src`. It mirrors:
  - the error envelope, PAT scope rules and W02a workspace binding;
  - W04a idempotency (replay, `Idempotency-Replayed`, 409 conflict, 400 key validation) and the legacy 1 h cache;
  - label uniqueness, `generateProjectKey`, pagination shapes, the bulk-status "all issues" behaviour, search and comments;
  - failure injection: status/body/HTML/dropped connection/`after N`.
- The worker, through a small node:http → `Request` adapter.

Clients are real: `@modelcontextprotocol/sdk` 1.32.2 (2025-11-25 handshake, Ajv output validation) and `@modelcontextprotocol/client` 2.4.0, in default legacy mode and pinned to 2026-07-28. Raw-HTTP probes cover protocol versions 2024-11-05 … 2025-11-25.

| File | Tests | Proves |
|---|---|---|
| `protocol.test.ts` | 19 | For each of 3 clients: negotiated revision, serverInfo/instructions, 19 tools in fixed order, all annotations, output schemas, every top-level input described, **every tool called end to end**, text block equal to `structuredContent`, one usage row per call named after the tool. Raw HTTP: stateless initialize for 4 protocol versions (no `Mcp-Session-Id`), GET/DELETE 405 with `Allow: POST`, 415, 413, `/healthz`, `/`, 404 |
| `auth.test.ts` | 14 | 401 challenge format (missing / malformed without an API call / unknown / revoked after caching → tool error then HTTP 401); `tools/list` needs a token; case-insensitive scheme; cache hit; 403 insufficient_scope; 503 without caching or leaking upstream HTML; PRM document and configured authorization servers; cache TTL; Origin 403 / CORS preflight / CORS on 401 / no Origin OK |
| `errors.test.ts` | 19 | `PAT_WORKSPACE_RESTRICTED`; a real workspace-bound PAT (list narrowed, foreign project → OWNERSHIP message + request id); IDEMPOTENCY_CONFLICT; IN_PROGRESS auto-retry with the same key, and persistent IN_PROGRESS; 404; 400 field summary; cross-project label refused; 429 wait; 500 not retried with tool-specific advice; 502/dropped-connection retried for GET only; HTML never forwarded and a long Retry-After not waited; scope error naming the scope and usage logging stopped for read-only tokens; TEAM_PROJECT_CONFLICT; P2002; unexpected response shape; usage codes are codes; `describeFailure` units |
| `idempotency.test.ts` | 12 | Key contract, determinism and sensitivity; chunking; a retried `create_issue` over **another client, protocol era and JSON-RPC id** replays the same issue; different arguments create anew; explicit key creates and replays; project legacy-cache replay; **plan partial failure (500 on phase 2) reports exactly, then the repeat completes with 6 tasks, no duplicate labels/projects, phases 1/3 replayed**; repeat after 1 h cache expiry builds a full new project; per-chunk distinct keys; 429 skips later phases; project failure creates nothing |
| `validation.test.ts` | 12 | For v1 and modern clients: unknown keys rejected; refine rules (projectId/teamId, empty update, empty label change, both add+remove, get_issue without id); ids, enums, sizes, date format, phase count; bulk-status without/empty `taskIds` never reaches the API; argument size cap; identifier exact / ambiguous / missing. Each rejection is asserted to make **no API call** |
| `catalog.test.ts` | 2 | `apps/mcp-docs/lib/tool-catalog.json` equals the catalogue rebuilt from the live `tools/list` (`UPDATE_TOOL_CATALOG=1` regenerates); type summariser |

**Mutation checks.** Each was a temporary edit, reverted and verified with `cmp`:
- Dropping `Idempotency-Key` on single create fails 2 idempotency tests.
- Disabling cache eviction on API 401 fails the revoked-token auth test.
- Removing `projectId` from the chunk-key material is not detected, and that is correct: the chunk body already carries project-specific label ids, so the keys still differ. The after-expiry test documents this.

**Workerd smoke (manual, local only).** A scratch script (deleted) ran the real worker under `wrangler dev` (workerd, 127.0.0.1:4951) against the fake API:
- 401 challenge correct;
- v1 (2025-11-25) and v2 (2026-07-28) clients listed 19 tools and created plans;
- identical repeats replayed with no duplicate tasks;
- usage rows were written via `ctx.waitUntil`.

## 8. Validation

| Check | Result |
|---|---|
| `pnpm --filter @openlinear/mcp typecheck` (worker tsconfig with workers-types + test tsconfig with node types) | pass |
| `pnpm --filter @openlinear/mcp test` | **6 files, 78 passed**, about 0.5 s; 3 further consecutive runs identical (no flakes); also passes via `turbo run test --filter=@openlinear/mcp` |
| `pnpm --filter @openlinear/mcp lint` (`biome check --error-on-warnings`, root config) | pass, 32 files |
| `pnpm lint` (root, CI list) | pass, 41 files. `apps/mcp` is not in the root list; see merge notes |
| `turbo run typecheck` for mcp, mcp-docs, api-client | 3/3 pass |
| `wrangler deploy --dry-run --outdir /tmp/…` (offline bundle only) | pass: 715.56 KiB, 144.30 KiB gzip. No Express, Hono, Ajv or `node:` imports |
| `apps/mcp-docs`: `tsc --noEmit`; `next build` | pass; 19 static pages (`ignoreBuildErrors` is still set, so the separate typecheck is the gate) |

## 9. Client-visible changes and compatibility

Unchanged for existing configs: the URL `https://mcp.openlinear.tech/mcp`, the header `Authorization: Bearer ol_pat_…`, and stateless POST-only Streamable HTTP with SSE answers on the 2025 leg. All 12 old tool names stay, and their old arguments are still accepted. The exception is `update_issue` with only `taskId`, which is now an error rather than a no-op write.

Changes clients may notice:
1. **Auth.** Invalid tokens fail at `initialize` / `tools/list` with HTTP 401 and a challenge; before, only `tools/call` failed, and as tool text. Revocation takes effect within at most 60 s, or immediately after any refused tool call.
2. **Strict inputs.** Unknown argument names are rejected (previously silently dropped).
3. **New result shapes.**
   - List tools wrap results (`{workspaces:[…]}` instead of a bare array).
   - Entities are compact, normalized shapes instead of raw API rows. Field names that existed keep their meaning, e.g. `id`, `key`, `name`.
   - Creates include `idempotency`.
   - `bulk_create_plan` adds `status`, `summary`, `teamId`, `number`, `labelReused`, `replayed` and `idempotency`, and keeps every old field.
4. **Retries no longer duplicate.**
   - Identical `create_issue` calls within 24 h, and identical plan/project/team calls within 1 h, return the original.
   - Identical `create_label` / `create_phase` calls return the existing label (`created: false`) instead of a 409 error.
5. **Other behaviour.**
   - `create_phase` now sets label priority `N-1`, consistent with the plan tool.
   - `DELETE /mcp` answers 405 (was 204). Clients only send DELETE with a session id, which this server never issues.
   - The 2026-07-28 revision is now supported, alongside the 2025 revisions.
6. **Telemetry.** `mcp_tool_calls.toolName` now records MCP tool names (`openlinear_*`) instead of client method names, and `error` holds a code. `/api/mcp/usage` aggregates change accordingly; no UI consumes them today.

## 10. OAuth 2.1: design note (not implemented)

**Implemented now (cheap and spec-aligned):**
- RFC 9728 metadata, path-aware at `/.well-known/oauth-protected-resource/mcp`.
- RFC 6750 challenges with `resource_metadata` on 401/403.
- `insufficient_scope` with `scope`.
- Configurable `authorization_servers`.

None of this changes anything for valid-PAT clients.

**Remaining work:**
1. **Authorization server.** Either `apps/api` (it owns users, sessions and the GitHub login) or `@cloudflare/workers-oauth-provider` inside the worker, backed by an API endpoint that mints workspace-bound, scoped credentials after consent. Requirements:
   - Authorization code + PKCE (S256);
   - RFC 8414 metadata;
   - RFC 9207 `iss`;
   - client registration via Client ID Metadata Documents (2026-07-28 deprecates DCR, keep it only for older clients);
   - refresh-token rotation;
   - no `offline_access` in challenges.
2. **Consent UI** in the desktop/web app: choose a workspace and scopes (`read`, `write`, `tasks:write`). Tokens should be workspace-bound by default.
3. **Audience binding** (RFC 8707). Tokens are issued for `https://mcp.openlinear.tech/mcp`, and the worker validates `aud` (signature via JWKS, no API round trip; short TTL for revocation). **No token passthrough:** the worker must not forward an MCP-audience token to the API. It exchanges it (RFC 8693) or calls the API with a derived credential. Today's PAT forwarding is acceptable only because the API issues PATs.
4. **Step-up.** Per-tool `scopeChallenge` (SDK v2 supports it) answers 403 `insufficient_scope` with the needed scope, instead of a tool error.
5. **PAT stays as a legacy path.** The `ol_pat_` prefix is detected first, and both are documented.
6. **Rollout.** Set `MCP_AUTHORIZATION_SERVERS` once the AS is live; nothing else in the worker changes for discovery. Exit criterion (Phase 6): the OAuth flow works from Claude Desktop, Cursor and Codex, and a scoped token cannot exceed its scopes.

## 11. Leftovers and follow-ups

API (not in my ownership; recorded, not changed):
1. **`GET /api/tasks` filters.** Expose `status`, `labelId`, `q` (`listTasks` in `services/tasks.ts` already supports status/query) and `parentId`. Stop returning `executionLogs` in list rows, or add `fields`. This would remove the MCP's 300-issue client-side scan and sub-issue scan.
2. **`POST /api/projects` with `teamIds` always answers 409 `TEAM_PROJECT_CONFLICT`.** `Team.projectId` is required, so every existing team "belongs to a different project"; the project is created, then deleted. Fix or remove the parameter. The MCP keeps the argument for compatibility and documents it.
3. **`POST /api/labels/tasks/:id/labels`** does not check that the label belongs to the task's project (`assertLabelsInProject`). The PATCH path does.
4. **`PATCH /api/tasks/bulk-status` without `taskIds` updates every issue in the project.** It should require an explicit selection or flag. The chat tool path (`bulk_update_issues`, revamp status report) is exposed to this too.
5. **Rate limiting is by IP (100/min).** Every MCP user shares the worker's egress IPs. Key PAT/JWT requests by principal.
6. **`POST /api/mcp/log`** needs `write`, so read-only PATs cannot record usage. `McpToolCall` lacks a user FK, `workspaceId`, `patId` and latency (C5).
7. **Legacy idempotency on projects/teams** is non-atomic with a 1 h TTL (W04b #2). Moving it to `respondIdempotently` would make plan resumes 24 h and race-free.
8. **Comments have no `Idempotency-Key` support.** With it, `add_comment` could become retry-safe.
9. **`packages/api-client`** needs per-request headers, idempotency keys, timeouts and safe retries (W04b #4). The MCP's `src/openlinear/client.ts` can serve as the reference, and the MCP can then switch back.
10. **`GET /api/search`** drops status and projectId from task hits. **`GET /api/tasks/:id`** has no sub-issues or parent.

MCP / ops (mine, deferred):
- **Worker config.** Per-token rate limiting (Cloudflare Rate Limiting binding keyed on the token hash); `workers_dev = false` (it bypasses the custom-domain WAF and rate rules, and Origin/Host checks do not cover it); `[env.staging]`; a CI job that runs the dry-run bundle; deploy from CI. I did not change `workers_dev`, because it alters what a deploy exposes. It is the owner's call.
- **Unused MCP features.** Resources (`openlinear://project/{id}`), prompts (plan-project, triage), completions for ids, and MRTR confirmation (2026-07-28 `inputRequired`) before large `bulk_create_plan` runs.
- **`nodejs_compat`** can be dropped (the bundle has no `node:` imports) after one live check.
- **Docs site.** Deployment ownership (this app versus the Mintlify site the landing page links to) and the `anthropic-sans` font licence (C5 §4.10) are not addressed. `next.config.mjs` still has `ignoreBuildErrors`.

## 12. AGENTS.md edits needed (coordinator)

In the MCP section:
- "8 registered tools" → 19, list as in §3.
- `openlinear_get_project` returns project, teams, repository and labels, not tasks.
- Key files: replace `transport.ts` with `src/worker.ts` (routing/auth) and `src/mcp/server.ts` (tool list). `src/openlinear/client.ts` is now the worker's own HTTP client.
- `wrangler.toml` points at `https://api.openlinear.tech` (not `https://openlinear.tech`).
- Add `pnpm --filter @openlinear/mcp test` to Key Commands.
- Note the stateless 2025 + 2026-07-28 support and the PAT verification/401 behaviour.

## 13. Merge hazards

- **`pnpm-lock.yaml`** (shared): only the `apps/mcp` importer and new packages changed:
  - `@modelcontextprotocol/{server,core,client}@2.4.0`, `@modelcontextprotocol/sdk@1.32.2`, plus `ajv-formats`, `eventsource`, `eventsource-parser`, `pkce-challenge`, `json-schema-typed`, `zod-to-json-schema`;
  - alpha packages removed; `@cfworker/json-schema` marked optional.

  If another patch also touches the lockfile, re-run `pnpm install --ignore-scripts` after applying both.
- **Root `package.json` `lint` list** (not mine): add `apps/mcp/src apps/mcp/test apps/mcp/vitest.config.ts` so CI lints the worker. The files pass the root biome config today.
- **`turbo run test` now includes `@openlinear/mcp`** (new `test` script). It needs no env and no DB, and uses ephemeral loopback ports.
- **`packages/api-client` is no longer imported** by `apps/mcp`. Anyone changing that package no longer affects the worker.
- **Generated catalogue.** `apps/mcp-docs/lib/tool-catalog.json` is generated. Any later change to tool names, descriptions or inputs must regenerate it (`UPDATE_TOOL_CATALOG=1 pnpm --filter @openlinear/mcp test`), or the MCP test fails.

## Files changed

- `apps/mcp/package.json`, `tsconfig.json`, new `tsconfig.test.json`, new `vitest.config.ts`, `wrangler.toml`, `README.md`
- `apps/mcp/src/`:
  - new: `version.ts`, `config.ts`, `worker.ts`
  - rewritten: `index.ts`, `auth.ts`
  - `openlinear/`: `client.ts` (own client), new `errors.ts`, `api.ts`
  - `mcp/`: `server.ts`; new `tool.ts`, `context.ts`, `errors.ts`, `idempotency.ts`, `inputs.ts`, `shapes.ts`
  - `mcp/tools/`: `workspaces.ts`, `projects.ts`, `teams.ts`, `labels.ts` (now with phases), `issues.ts`, `plan.ts`; new `search.ts`
  - deleted: `app.ts`, `env.ts`, `cloudflare-node.d.ts`, `mcp/transport.ts`, `mcp/tools/result.ts`, `mcp/tools/phases.ts`
- `apps/mcp/test/` (new): `fake-api.ts`, `harness.ts`, `helpers.ts`, `protocol.test.ts`, `auth.test.ts`, `errors.test.ts`, `idempotency.test.ts`, `validation.test.ts`, `catalog.test.ts`
- `apps/mcp-docs/`:
  - new: `lib/tool-catalog.json` (generated), `lib/tool-catalog.ts`, `components/tool-reference.tsx`
  - updated: `lib/nav.ts`; pages `/`, `/quickstart`, `/authentication`, `/clients/{claude-desktop,opencode,other}`, `/tools` and all 7 tool pages, `/guides/{troubleshooting,plan-from-prompt}`
  - fixes:
    - fake `workspace-<hex>` ids;
    - nonexistent `"failed": true`;
    - wrong team advice;
    - Claude Desktop config (now the `mcp-remote` bridge);
    - v1 SDK example (now the v2 client);
    - "12 tools" (now generated);
    - added Claude Code and Codex configuration;
    - scopes and workspace-bound tokens;
    - error and retry guide.
- `pnpm-lock.yaml` (apps/mcp importer)
- `docs/reports/revamp-2026-10-26/mcp.md` (this ledger)
