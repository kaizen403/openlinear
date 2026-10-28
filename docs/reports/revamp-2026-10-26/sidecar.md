# W03a — Sidecar runs API-only (sidecar engineer ledger)

Date: 2026-10-25 (round 1). Base tree: `0a41ea8b12376965324b4668fc4d0e6c816e5fe9`.
Owner constraint honoured: local work only, no deployments, no cloud operations, no commits.

## Outcome

Acceptance status:

- **No database or cloud secrets.** The sidecar runs with no `DATABASE_URL`, no JWT signing secret, no token-encryption key and no GitHub client secret. Production persistence and authorization go through `OPENLINEAR_API_URL` and the scoped API client (`@openlinear/api-client`).
- **Execute, status, cancel and logs work in API-only mode.** An end-to-end test proves it with:
  - the real API app;
  - the sidecar as a child process with a scrubbed environment;
  - a fake OpenCode server;
  - a loopback GitHub stub.
- **No Prisma on the enabled path.**
  - The sidecar reaches Prisma only through `persistence/prisma-loader.ts`.
  - The packaged build aliases that loader to `prisma-loader.packaged.ts`, so the bundle contains no `@prisma/*`, `packages/db`, `apps/api` or `jsonwebtoken`. Both a build guard and a test enforce this.
  - The `@openlinear/api` dependency is gone entirely.
- **Foreign-principal and stale/terminal callbacks are denied.** The control plane decides every resource question. Attempt callbacks accept only the attempt's run-scoped capability, and it is revoked at close or release.
- **Fails closed when the API is down.**
  - API unreachable or returning 5xx: `503 CLOUD_API_UNREACHABLE`.
  - No API configured: `503 CLOUD_API_NOT_CONFIGURED`.
  - `401` is returned only when the control plane says the token is invalid.
- **Batches fail closed in API mode** with `501 BATCH_REQUIRES_API_PERSISTENCE`. The batch tests stay green in Prisma mode.

## Control-plane contract (apps/api, `/api/executions`)

### User-authenticated routes (session JWT or PAT)

| Route | PAT scope | Decision |
|---|---|---|
| `GET /principal` | any (read) | Returns `{ userId, username, authSource: 'session'\|'pat', scopes, workspaceId }` with `Cache-Control: no-store`. The sidecar uses it to validate principals. |
| `GET /tasks/:taskId/access` | read | `assertTaskAccess('view')` plus a full probe. Returns `{ permission: 'full'\|'view', canWrite, authority }`. `canWrite` requires full permission and, for a PAT, `tasks:write`. |
| `GET /tasks/:taskId/logs` | read | `assertTaskAccess('full')`. Returns `{ logs }`, the persisted `executionLogs`. |
| `POST /tasks/:taskId/cancellation` | tasks:write | `assertTaskAccess('full')` plus an active attempt. Sets `cancelRequestedAt` and returns 202. `404 NO_ACTIVE_ATTEMPT` if there is none. |
| `POST /tasks/:taskId/refresh-pr` | tasks:write | `assertTaskAccess('full')`. Batch siblings are limited by `scopedTaskWhere(principal, {}, 'full')`. Returns `403 PAT_WORKSPACE_RESTRICTED` for workspace-bound PATs, because the GitHub token is account-wide. Moved here from sidecar Prisma. |
| `POST /attempts` `{ taskId }` | tasks:write | See details below. |

`POST /attempts` details:

- Authorizes with `assertTaskAccess('full')`.
- Returns `409 TASK_ARCHIVED`, `409 TASK_ALREADY_RUNNING`, or `409 TASK_SELECTION_CHANGED` (the binding moved during the check).
- Records an immutable snapshot (task, authority, execution settings) and mints the capability.
- Does **not** touch the task row.
- Responds `201 { attempt, capability: { token, expiresAt, scopes }, snapshot }`.

### Capability routes (`POST /attempts/:attemptId/...`, `Authorization: Bearer olx_…` only)

| Route | Scope | Semantics |
|---|---|---|
| `claim` `{ sessionId, runner, model }` | execution:status | See details below. |
| `events` `{ events: [{ seq, type, payload }] }` (1–50) | execution:progress | `(attempt, seq)` idempotency (see below). Delivered through `persistAndDeliver` with the task resource binding. Audience is user + creator, plus team/workspace ids. The response piggybacks `{ lastSeq, cancelRequested }`. |
| `heartbeat` | execution:status | Updates `heartbeatAt`. Returns `{ cancelRequested, heartbeatAt }`. |
| `logs` `{ logs }` (≤2000 entries, 4 MB parser) | execution:logs | W01 log fence: while running, the bound row must be in_progress with this session and unchanged project/team/creator. After a confirmed terminal write, the bound row must have `sessionId: null` and the terminal status. A replacement execution's row is never overwritten. |
| `terminal` `{ status: done\|cancelled, … }` | execution:terminal | See details below. |
| `run` `{ status, usage, prUrl?, errorMessage? }` | execution:terminal | `updateMany where status: 'running'`. `succeeded` requires a confirmed done (`409 RUN_SUCCESS_UNCONFIRMED`). `cancelled` requires the stop acknowledgement (`409 CANCEL_NOT_ACKNOWLEDGED`). Writes the activity log row. |
| `cancellation` `{ stopConfirmed: true }` | execution:status | Positive stop receipt. Sets `cancelAcknowledgedAt`. |
| `git-credential` `{ purpose: clone\|publish }` | execution:git-credential | See details below. |
| `close` `{ reason? }` | execution:terminal | Unclaimed attempts become `released`. A claimed attempt with no terminal becomes `closed` with reason `abandoned`, and the task is not touched. Otherwise it becomes `closed`/`completed`. Revokes **every** capability of the attempt. |

`claim` details:

- Re-authorizes the initiator (see below).
- Performs the conditional in_progress transition: `updateMany where` not archived, status ≠ in_progress, and the recorded project/team/creator. In the same transaction it binds the session, clears the batch link and creates the `AgentRun`.
- A rejected claim releases the attempt and revokes its capability. Possible rejections: `409 TASK_ALREADY_RUNNING`, `409 TASK_SELECTION_CHANGED`, `409 TASK_ARCHIVED`, `409 TASK_SCOPE_CHANGED`, `403 EXECUTION_ACCESS_REVOKED`.

`terminal` details:

- W01 terminal fence: `updateMany where` in_progress, this sessionId and the recorded project/team/creator.
- `done` needs a confirmed GitHub PR URL on the attempt's repository (`422 PUBLICATION_UNVERIFIED`).
- Repeating the same terminal is idempotent (`repeated: true`). A different terminal returns `409 ATTEMPT_TERMINAL_CONFLICT`. A lost fence returns `409 TASK_FENCE_REJECTED`.
- Broadcasts `task:updated`.

`git-credential` details:

- Re-authorizes the initiator.
- `publish` additionally requires the task to still be bound to this attempt.
- Workspace-bound PAT attempts get `403 PAT_WORKSPACE_RESTRICTED` (account-wide token).

**Capability authentication.** Handled by `middleware/execution-capability.ts`; `middleware/auth.ts` is untouched.

- Token format is `olx_` + base64url(32 bytes). Only the SHA-256 is stored (DB CHECK `^[0-9a-f]{64}$`).
- Each capability is bound to attempt, task and user. Scopes: `execution:status`, `progress`, `logs`, `terminal`, `git-credential`. TTL is 2 h.
- Failure responses:
  - 401 `CAPABILITY_REQUIRED`, `CAPABILITY_INVALID`, `CAPABILITY_REVOKED`, `CAPABILITY_EXPIRED`;
  - binding-integrity check;
  - 403 `CAPABILITY_ATTEMPT_MISMATCH`, `CAPABILITY_SCOPE_DENIED`.
- A capability is never accepted as a user credential, and JWTs and PATs get 401 on callbacks. Both directions are tested.

**Initiator re-authorization (`reauthorizeInitiator`)** runs before the claim and before every git credential.

- For PAT attempts it confirms the PAT still exists, belongs to the user, and is neither revoked nor expired.
- It then runs `assertTaskAccess('full')` under `runWithPrincipal` with the recorded `workspaceRestriction`. That covers current membership and grants, explicit denies, and the workspace binding.
- It requires the task to be unarchived with an unchanged binding.
- Interactive-session revocation is not re-checked (see leftovers).

**Idempotency for `(attempt, seq)`.** The attempt row is locked `FOR UPDATE`. Events with `seq ≤ lastEventSeq` are dropped, and the high-water mark plus `heartbeatAt` are advanced in the same transaction. A retried batch is delivered exactly once.

**Rate limiting.** There is a per-attempt limiter (1200/min, keyed by a hash of the auth header). The default IP limiter is skipped for `/api/executions/attempts/`.

## Migration `20261026030000_w03a_execution_attempts`

The migration is additive. It creates:

- enum `execution_attempt_statuses` (preparing, running, finishing, closed, released);
- table `execution_attempts`, with snapshot JSON, recorded bindings, `sessionId`, `agentRunId` (unique), `terminalStatus`, `lastEventSeq`, `cancelRequestedAt`, `cancelAcknowledgedAt`, `heartbeatAt`, and the timestamps `claimedAt`, `finishedAt`, `closedAt`, `closeReason`;
- table `execution_capabilities`.

It adds three indexes: `[taskId, createdAt]`, `[userId, createdAt]` and `[status, heartbeatAt]`. The header carries `migration-safety: allow`, which covers the indexes on the new tables.

CHECK constraints:

- `authSource IN ('session','pat')`;
- `lastEventSeq >= 0`;
- terminal status is null or done/cancelled;
- a preparing attempt is unclaimed;
- capability hash format.

`schema.prisma` gets the back-relations on Task, User and AgentRun. `prisma migrate diff --exit-code` against my private test DB reports no difference, and `migrate status` reports the schema up to date.

## Sidecar

### Authentication (`src/auth/principal.ts`)

- Every sidecar route except `/health` requires `Authorization: Bearer <cloud access token>`. The token is validated by `GET /api/executions/principal`.
- **Caching:**
  - positive cache keyed by sha256(token): 30 s TTL, at most 500 entries;
  - single-flight per token;
  - no negative cache: a 401 is passed through and re-checked on the next request.
- **Error mapping:**
  - network failure or 5xx: `503 CLOUD_API_UNREACHABLE`;
  - unset URL: `503 CLOUD_API_NOT_CONFIGURED`;
  - malformed principal response: 503.
- `OPENLINEAR_API_URL` must be https unless it is loopback, with no credentials, query or fragment (`config/cloud-api.ts`).
- **PAT decision (explicit, tested):**
  - PATs are accepted at the sidecar boundary exactly as the control plane validates them, with scopes and workspace binding kept on the principal.
  - The sidecar never widens a PAT: every resource decision is made by the API using that PAT's own scopes and binding.
  - A read PAT can read logs but gets `403 INSUFFICIENT_SCOPE` on execute. A `tasks:write` PAT executes with `authSource: 'pat'` recorded on the attempt. A workspace-bound PAT cannot execute (`403 PAT_WORKSPACE_RESTRICTED` at the clone credential; the attempt is released).
  - Tests: `auth/principal.test.ts` and the e2e "accepts PATs only as far as the control plane allows" test.

### Persistence modes (`persistence/store.ts`, `persistence/boot.ts`)

- **`api`** (production): an API URL and no DB, or any non-test process. This is `api-store.ts`.
- **`prisma`**: `--with-cloud-api` plus a loopback `*_test` DATABASE_URL, or a test process unless it is production-shaped. This is `prisma-store.ts`, with W01 fences identical to the old `state.ts` and authorization delegated to `auth/task-access.ts`.
- **`unconfigured`**: `503 CLOUD_API_NOT_CONFIGURED` for every persisted operation.
- `env.ts` scrubs `JWT_SECRET`, `TOKEN_ENCRYPTION_KEY` and `GITHUB_CLIENT_SECRET` from `process.env` in API mode, so neither git, OpenCode nor tools inherit them. It refuses `OPENLINEAR_TRUST_PROXY_AUTH`.

### Call paths in API mode

- **execute** (`POST /api/tasks/:id/execute`):
  1. `requireSidecarAuth`.
  2. `authorizeTaskAccess` (write).
  3. `store.startAttempt` (with the principal's own token) returns the snapshot and capability.
  4. Local admission (`admit(settings)`); on rejection the attempt is closed.
  5. `getGitCredential('clone')` using the capability.
  6. Clone/worktree.
  7. OpenCode session.
  8. **claim** (the only in_progress transition).
  9. The prompt is submitted.
  10. While running: the relay batches progress/log events, a heartbeat runs every 30 s, logs are persisted through the capability, and `authorizePublication`, which is `git-credential('publish')`, re-authorizes before the push and PR.
  11. `terminal`, then `run`, then `close`.

  Edge cases:
  - A rejected claim aborts the session, cleans up the worktree and releases the attempt, with no terminal write.
  - A 401/403/404/503 before the claim is returned to the caller unchanged.
- **status/running**: comes from in-memory state for the owner. Otherwise the decision is `GET /tasks/:id/access`.
- **cancel**: owner shortcut, else `access` with canWrite. After a **confirmed** provider abort the order is `cancellation` ack, then `terminal` (cancelled), then `run` (cancelled), then `close`. An unconfirmed stop writes nothing.
- **cloud cancel**: `POST /api/executions/tasks/:id/cancellation` sets the flag. The next heartbeat or relay response carries `cancelRequested`, and the sidecar runs the local cancel path.
- **logs**: in-memory logs for a running owner. Otherwise `GET /tasks/:id/logs` (the API applies the full-access check).
- **refresh-pr**: `POST /api/executions/tasks/:id/refresh-pr`.

### What still needs Prisma (and how it fails closed)

- **Batch engine** (`routes/batches.ts`, `services/batch/*`): loaded lazily and only in Prisma mode. In API mode every `/api/batches/**` route returns `501 BATCH_REQUIRES_API_PERSISTENCE`. The packaged bundle does not contain the orchestrator.
- **`prisma-store.ts`**: tests and `--with-cloud-api` (loopback `*_test` DB) only. It is never bundled.
- **Journal recovery projection** (`recordRecoveryOutcome`):
  - In API mode it logs and does nothing, because capabilities live only in memory and a restarted sidecar has no authority over a previous attempt.
  - The control plane sees the dead attempt through the heartbeat (see the design below).

### Local SSE (`src/sse/local.ts`)

- **Authentication:** `Authorization: Bearer` (the fetch-based stream), or a single-use 60 s ticket from `POST /api/events/ticket` for EventSource.
- **Errors:**
  - missing token: 401 `SSE_TOKEN_REQUIRED`;
  - reused or invalid ticket: `INVALID_TICKET`;
  - unreachable control plane: 503.
- **Delivery is owner-only:**
  - task events go only to the execution's initiating user;
  - user events go to that user;
  - global events (`opencode:status`) go to everyone authenticated.
- **Event ids and replay:**
  - every frame carries `id: <bootId>:<seq>`;
  - `Last-Event-ID` replays from a 500-event buffer, filtered by the reconnecting principal;
  - an unknown boot or a cursor older than the buffer emits `replay-gap` with reason `sidecar_restarted`, `invalid_cursor` or `buffer_exceeded` (with `buffer_exceeded` the retained events are still replayed after the gap).
- The principal is re-validated on each 30 s heartbeat, and the stream closes when it becomes invalid.

## Packaging blockers (coordinator items)

1. **Tauri `DATABASE_URL` injection removed** (`apps/desktop/src-tauri/src/sidecar.rs`).
   - The sidecar command now uses `.env_clear()` and an explicit inherited allowlist (`INHERITED_ENV_EXACT` / `INHERITED_ENV_PREFIXES`).
   - `SIDECAR_FORBIDDEN_ENV` covers DATABASE_URL, JWT_SECRET, TOKEN_ENCRYPTION_KEY and the GitHub client secret.
   - It passes `OPENLINEAR_API_URL`, resolved in this order: store `cloud_api_url`, then env `OPENLINEAR_API_URL`, then compile-time `option_env!`, then `https://openlinear.tech`.
   - `OAUTH_INTERCEPTOR_PORT` and `CARTESIA_API_KEY` are passed through.
   - The JWT/secret generation and its test were replaced by `test_sidecar_never_inherits_cloud_only_credentials`.
   - **Uncompiled:** there is no cargo toolchain on this machine.
2. **Node 22 target.**
   - `scripts/build-sidecar.sh` targets pkg `node22-*` with `--options experimental-sqlite` (pkg-fetch 3.5.16 ships v22.10.0) and uses `node esbuild.config.js --packaged` (CJS, node22).
   - The Prisma artifact copy is removed.
   - The default ESM build also targets node22.
   - **Not run end to end:** pkg needs a network download of the Node 22 base binary (only v18 is cached). The esbuild packaged bundle itself was built and smoke-run with Node 22: health reported `persistence: 'api'`, 401 unauthenticated, 503 when the API was unreachable, and the secrets were scrubbed.
3. **OpenCode download pin** (`scripts/download-opencode.sh`, `scripts/opencode.sha256`).
   - Upstream is `anomalyco/opencode` (formerly sst/opencode) at **v1.18.30**, matching the pinned `@opencode-ai/sdk 1.18.30`.
   - Assets are `opencode-darwin-{arm64,x64}.zip` and `opencode-linux-{x64,arm64}.tar.gz`, with zip/tar extraction and a binary lookup at the archive root, `bin/` or `package/bin/`.
   - The checksums come from the GitHub release API `digest` field, which is a single source. Re-verify them independently before release.
   - The phantom `plugin: ['opencode-openlinear']` was removed from the OpenCode config (it is not a published package).
4. **Unused dependencies removed** from `apps/sidecar/package.json`: `@anthropic-ai/sdk`, `openai`, `@openlinear/api`, `jsonwebtoken` and `@types/jsonwebtoken`. Nothing imports them. The lockfile was refreshed with `pnpm install --ignore-scripts` (61 lines removed).

## Client-visible changes (desktop-ui / Tauri)

- **Sidecar calls need the cloud token.** All sidecar calls need `Authorization: Bearer <cloud access token>` (JWT or PAT): execute, cancel, logs, running, refresh-pr, `/api/batches/**`, `/api/opencode/**`, `/api/transcribe` and `/api/events`. The sidecar no longer verifies JWTs locally.
- **Status codes:**
  - 401 means only that the control plane rejected the token;
  - 503 `CLOUD_API_UNREACHABLE` or `CLOUD_API_NOT_CONFIGURED` means the API is down or unset, so the UI should show "offline", not "log in";
  - 403 `OWNERSHIP_REQUIRED` or `INSUFFICIENT_SCOPE` means the caller may not act on the task.
- **Error body:** `{ error, code, message, details?, requestId? }`.
- **Execute failures:** execute may now fail with the control plane's 409 codes: `TASK_ALREADY_RUNNING`, `TASK_SELECTION_CHANGED`, `TASK_ARCHIVED` or `TASK_SCOPE_CHANGED`.
- **Batches** return `501 BATCH_REQUIRES_API_PERSISTENCE` in production builds. The UI should hide or disable batch execution.
- **SSE** frames carry `id:`. The client sends `Last-Event-ID` on reconnect and handles `replay-gap` by refetching. Task events reach only the initiating user.
- **`/health`** returns `{ ok, service: 'sidecar', persistence: 'api'|'prisma'|'unconfigured' }`.
- **Cloud SSE** (`apps/api` `/api/events`) now receives `execution:progress`/`execution:log` for API-mode runs through the outbox, so other viewers see progress from the cloud stream rather than the sidecar.

## Registry rows (convert to W02b format)

My tree still uses the pre-W02b signature, mapped as follows:

- `scope` becomes `family`;
- `patScopes` becomes `SCOPES`;
- `enforcement` becomes `resource`;
- `enforcedBy` becomes `policyNote`;
- `'account-level'` becomes `'account-read'`.

`AuthMode` needs a `'capability'` member and resources need an `'attempt'` value. The consistency rules are that capability routes use resource `'attempt'` and declare no PAT scopes, so they are never PAT-callable. In W02b format:

```ts
route('GET',  '/api/executions/principal', 'session_or_pat', 'self', ['read'], 'self', 'req.userId (sidecar principal validation)', 'account-read'),
route('GET',  '/api/executions/tasks/:taskId/access', 'session_or_pat', 'execution:read', ['read'], 'task', "assertTaskAccess('view') + full probe + PAT tasks:write", 'enforced', { params: { taskId: 'task' } }),
route('GET',  '/api/executions/tasks/:taskId/logs', 'session_or_pat', 'execution:read', ['read'], 'task', "assertTaskAccess('full')", 'enforced', { params: { taskId: 'task' } }),
route('POST', '/api/executions/tasks/:taskId/cancellation', 'session_or_pat', 'execution:write', ['tasks:write'], 'task', "assertTaskAccess('full') + active attempt", 'enforced', { params: { taskId: 'task' } }),
route('POST', '/api/executions/tasks/:taskId/refresh-pr', 'session_or_pat', 'execution:write', ['tasks:write'], 'task', "assertTaskAccess('full') + scopedTaskWhere(principal,'full') siblings; refuses workspace-bound PATs (GitHub token)", 'enforced', { params: { taskId: 'task' } }),
route('POST', '/api/executions/attempts', 'session_or_pat', 'execution:start', ['tasks:write'], 'task', "assertTaskAccess('full') + admission; mints the attempt capability", 'enforced'),
// capability-only (never PAT-callable):
route('POST', '/api/executions/attempts/:attemptId/claim',          'capability', 'execution:status',         [], 'attempt', 'capability + reauthorize initiator + conditional in_progress claim', 'not-applicable'),
route('POST', '/api/executions/attempts/:attemptId/events',         'capability', 'execution:progress',       [], 'attempt', 'capability + (attempt, seq) high-water + task resource binding', 'not-applicable'),
route('POST', '/api/executions/attempts/:attemptId/heartbeat',      'capability', 'execution:status',         [], 'attempt', 'capability + active attempt', 'not-applicable'),
route('POST', '/api/executions/attempts/:attemptId/logs',           'capability', 'execution:logs',           [], 'attempt', 'capability + session/terminal + project/team/creator fence', 'not-applicable'),
route('POST', '/api/executions/attempts/:attemptId/terminal',       'capability', 'execution:terminal',       [], 'attempt', 'capability + session/status/project/team/creator fence; done needs a confirmed PR', 'not-applicable'),
route('POST', '/api/executions/attempts/:attemptId/run',            'capability', 'execution:terminal',       [], 'attempt', 'capability + run still running; success needs done; cancelled needs stop receipt', 'not-applicable'),
route('POST', '/api/executions/attempts/:attemptId/cancellation',   'capability', 'execution:status',         [], 'attempt', 'capability + positive stop receipt', 'not-applicable'),
route('POST', '/api/executions/attempts/:attemptId/git-credential', 'capability', 'execution:git-credential', [], 'attempt', 'capability + reauthorize initiator (+ bound task for publish); refuses workspace-bound PAT attempts', 'not-applicable'),
route('POST', '/api/executions/attempts/:attemptId/close',          'capability', 'execution:terminal',       [], 'attempt', 'capability; revokes every capability of the attempt', 'not-applicable'),
```

W02b PAT default-deny applies as follows:

- PATs reach the six user routes with the listed scopes.
- `GET /principal` must stay callable by every PAT, like `/api/auth/me`, because the sidecar validates PAT callers through it.
- The nine capability routes refuse PATs at the capability middleware (401 `CAPABILITY_REQUIRED`) before any PAT logic.

## Tests

### New

- **API (43):**
  - `executions.test.ts` (35): start authorization/snapshot, capability authentication both ways, claim fence including two concurrent claims, re-authorization (revoked PAT, new deny), events idempotency/binding, terminal/log fences, publication verification, run/cancellation/close, git credential, the read surface, and refresh-pr.
  - `sidecar-api-only.e2e.test.ts` (8), described in the outcome section.
  - Fixture: `fixtures/opencode-stub.mjs`.
- **Sidecar (44):**

  | File | Tests |
  |---|---|
  | `auth/principal.test.ts` | 10 |
  | `events/relay.test.ts` | 7 |
  | `sse/local.test.ts` | 6 |
  | `persistence/api-store.test.ts` | 7 |
  | `api-only-mode.test.ts` (includes the packaged-bundle graph check) | 7 |
  | `services/execution/lifecycle-attempt.test.ts` | 7 |

### Stale tests (retargeted, not weakened)

- **Mocks of removed modules.** These tests mocked `@openlinear/api/{sse,logger,env,app,services/*}` or `@openlinear/db` for modules the sidecar no longer imports, so the same assertions now run against the new seams (`lib/logger`, `events/publisher`, `persistence/store`, `auth/task-access`):
  - `opencode-model`, `opencode`, `routes/opencode`, `transcribe`, `index`, `routes/execution`;
  - `lifecycle`, `lifecycle-worktree`, `events`;
  - `admission`, `orchestrator`, `completion`, `routes/batches`, `persistence.integration`.

  Vestigial mocks were removed from `app.test.mjs`, `session-manager.test.ts` and `opencode.test.mjs`.
- **`opencode.test.mjs`:** "config has the openlinear plugin" became "config has no plugin". The plugin package does not exist, so the old assertion encoded the bug.
- **`state.test.mjs`:** two broadcast-retry tests were merged into one. Retry and backoff of cloud delivery is now the relay's job, and `relay.test.ts` covers it.
- **`agent-run.test.mjs`:**
  - rewritten because AgentRun creation moved into the claim (API side) and the activity row moved into `prisma-store` / `/run`;
  - finalization assertions are kept, including success-needs-done and cancel-needs-receipt.
- **`runner-selection.test.ts`:**
  - now uses the real `prisma-store` with stubbed Prisma;
  - the authorization denial is a rejected 403, where it used to be a returned error. This is the same denial with a different transport.
- **`events.test.mjs`:** the publication repository, title and description come from the attempt snapshot instead of a re-read.

No regressions were found. Every failure was a stale seam, and the fences have equal or stronger assertions server-side.

## Validation (this worktree, private DB `openlinear_sidecar_test` only)

| Check | Result |
|---|---|
| `pnpm typecheck --force` (root) | 10/10 tasks successful |
| `pnpm lint` | 70 files, clean |
| `pnpm --filter @openlinear/api test` | 33 files, 329 passed, 2 skipped (includes executions 35, e2e 8, route-inventory 11) |
| `pnpm --filter @openlinear/sidecar test` | 44 files, 704 passed |
| `pnpm --filter @openlinear/sidecar test:integration` | 26 passed |
| `pnpm --filter @openlinear/sidecar build` and `node esbuild.config.js --packaged` | OK; packaged bundle has 304 inputs, no Prisma, no `@openlinear/api` |
| `prisma migrate diff --exit-code` and `migrate status` | No difference; up to date |
| E2E stability | 3 consecutive green runs |
| Rust (`sidecar.rs`) | **Not compiled** (no cargo) |

The coordinator's merged-tree counts (API 487 + 2 skipped, sidecar 662) come from a different base. Expect roughly +43 API and +44 sidecar after the merge.

## Decisions

- **Two-phase start and claim.** The W01 fence needs the provider session id, so `start` authorizes and snapshots, and the `claim` (after OpenCode returns a session) performs the single conditional in_progress transition.
- **The control plane makes every authorization decision, in both modes.** This let the sidecar drop `@openlinear/api` entirely, and there is no local JWT secret.
- **Snapshot-based execution text.** The PR title and body and the repository come from the start snapshot, which is immutable and recorded. Publication re-authorizes and re-checks the binding server-side.
- **Capability TTL is 2 h with no renewal.** Close and release revoke immediately. Long runs are a W05 item (see leftovers).
- **Local SSE is owner-only.** Team and workspace viewers get execution events from the cloud SSE via the outbox. The sidecar cannot evaluate workspace or team visibility without Prisma.
- **No negative cache for principals**, so a newly issued token works immediately. Revocation takes effect within 30 s or less (the positive TTL).

## Lease/heartbeat crash-detection design (record only; implementation is W05/W12)

- **What exists now:**
  - The sidecar heartbeats each claimed attempt every 30 s (configurable from 1 s to 5 min). Events also advance `heartbeatAt`.
  - There is an index `execution_attempts(status, heartbeatAt)`.
  - Capabilities expire after 2 h even if the sidecar dies.
- **Sweeper (proposed):** a periodic API job selects `status IN ('preparing','running') AND heartbeatAt < now() - 3×interval` (`preparing` uses `createdAt`). For each attempt, in one transaction:
  1. lock the attempt `FOR UPDATE`;
  2. revoke its capabilities;
  3. mark it `closed`/`abandoned` (`preparing` becomes `released`);
  4. if it was `running`, release the task with the W01 fence `updateMany where status in_progress, sessionId = attempt.sessionId, and the recorded project/team/creator`. That moves it to `todo` (or a `failed` outcome) and sets `AgentRun` to `failed`/`interrupted`. A replacement execution, which has a different session, is never touched.
  5. emit `task:updated` and `execution:progress {status: 'failed', reason: 'sidecar_lost'}` through the outbox.
- **Restarted sidecar:** it re-adopts nothing, because capabilities live in memory only. Its local journal recovery reports to the user, and the cloud sweeper owns the task state.
- **Renewal:** a `POST attempts/:id/renew` that rotates the capability while the heartbeat is fresh would remove the 2 h ceiling.

## Leftovers

- **Dev scripts.** `scripts/dev-live.sh` and `scripts/dev.sh` (not edited) must:
  - start the API on 3001;
  - start the sidecar on 3003 with `OPENLINEAR_API_URL=http://127.0.0.1:3001` and **without** `DATABASE_URL`. A DATABASE_URL without `--with-cloud-api` makes the sidecar refuse to boot, which is pre-existing behaviour.

  Without the URL the sidecar is `unconfigured`: every call returns 503 and the UI cannot authenticate against it.
- `apps/desktop-ui/components/desktop/opencode-setup-dialog.tsx` `OPENCODE_RELEASES_URL` still points at `opencode-ai/opencode`. It is not mine; it should be `anomalyco/opencode`.
- **OpenCode checksums** are single-source (GitHub `digest`). Re-verify them before release.
- **`sidecar.rs` is uncompiled.** Run `cargo test` and check that `env_clear()` plus the allowlist still gives OpenCode/git what they need.
  - The allowlist covers PATH, HOME, locale, temp dirs, proxies, CA bundles, and the `OPENCODE_*` / `OPENLINEAR_GIT_*` / `LC_*` / `XDG_*` prefixes.
  - Behaviour change: shell-exported provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) and `SSH_AUTH_SOCK` are no longer inherited. OpenCode's own auth store still works, and git uses an HTTPS token. Decide whether to allowlist provider keys.
- **The pkg Node 22 binary build was not run**, because it needs a network download. Run `scripts/build-sidecar.sh` once online.
- **Capability renewal and the stale-attempt sweeper:** W05/W12, see the design above.
- **Session revocation:** interactive-session (JWT) revocation is not re-checked for attempts already started. PAT revocation is re-checked.
- **`--with-cloud-api` (Prisma) mode** broadcasts locally only. It no longer relays events to the cloud outbox (dev only).
- **Batches:** not converted. Making them work in API mode needs a batch-attempt API (multi-task claim, shared worktree credential), which is W05.
- **Journal recovery** in API mode does not project to the cloud (see the sweeper design).
- **API rate limits:** `/api/executions/attempts` uses a per-attempt limiter, not the IP limiter. Re-check this against the W02b/W04 limiter strategy.

## Merge hazards

| File | Hazard |
|---|---|
| `apps/api/src/app.ts` | `app.use('/api/executions', executionsRouter)` is mounted **before** the global `express.json({ limit: '256kb' })`, because the logs callback needs a 4 MB parser and the routes parse their own bodies. The IP-limiter `skip` for `/api/executions/attempts/` was also added. Keep both when merging. |
| `apps/api/src/registry.ts` | `AuthMode` `'capability'`, `EnforcementPoint` `'attempt'`, the `attemptCallback()` helper, two consistency rules, and 15 rows in the old format. Convert to the W02b rows above. |
| `packages/db/prisma/schema.prisma` | Back-relations added on `Task`, `User` and `AgentRun`, plus two models and one enum. |
| `package.json` (root) | Twenty new paths appended to the `lint` biome list. |
| `pnpm-lock.yaml` | Sidecar dependency removals. Regenerate after merge if it conflicts. |
| `apps/sidecar/src/services/opencode.ts` | Sandbox engineer's file: I changed only the broadcast import (alias `publishGlobalEvent as broadcastToAll`) and removed the phantom `plugin` entry. The spawn function is untouched. |
| `apps/sidecar/src/services/execution/git-credentials.ts` | Untouched. Hardening args are the sandbox engineer's. |
| `apps/desktop/src-tauri/src/sidecar.rs` | Spawn environment rewritten (`env_clear` + allowlist). Conflicts with anyone touching the sidecar spawn. |
| `apps/sidecar/src/sse/local.ts` | Rewritten. The desktop-ui fetch-stream client must match (`id:`, `Last-Event-ID`, `replay-gap`). |
| ISSUES.md | Not touched (per instructions). |
