# W02b authorization follow-ups and auth-primitive hardening (authz)

Status: implemented and locally validated in an isolated worktree, uncommitted. Base: `922dbd7` + `round1-base.patch` (CI fixes, W02a, W04a). Private disposable database `openlinear_authz_test` on the shared loopback cluster (:54330). Nothing deployed, no remote service touched, the remediation script was never run against a real database.

Starting backlog: the W02a ledger's limitations list (`docs/reports/backend-review-2026-10-15/w02a-implementation.md`), the PRD W02 row and "Additional requirements" paragraph, plus the coordinator addendum (a)–(e).

## What changed and why

### 1. SSO login state (routes/sso.ts, services/sso.ts)
- Before: `state` was base64url JSON `{workspaceId, codeVerifier, nonce, ts}` plus an HMAC — signed, not encrypted. The PKCE verifier travelled in the authorization URL and the redirect back (defeating PKCE), the state was not bound to the browser, and it was replayable for 10 minutes.
- Now: `GET /api/auth/sso/check` creates an `sso_auth_states` row keyed by SHA-256 of a 32-byte random opaque `state`. The verifier (encrypted at rest with `TOKEN_ENCRYPTION_KEY`; no plaintext fallback), nonce, workspace, config id/issuer/client id and redirect URI stay server-side; TTL 10 min. The response sets an HttpOnly, SameSite=Lax cookie `ol_sso_binding` (Path `/api/auth/sso`, Secure in production or with an https redirect URI) whose hash is stored on the row.
- Callback: the row is claimed with one conditional UPDATE (single use; of N concurrent callbacks exactly one proceeds), only with the matching binding cookie. A foreign browser is refused without consuming the state. The callback also refuses when the workspace's SSO config changed (id, issuer, client id) since the flow started. Nonce validation on the ID token is kept (`expectedNonce`), state checked by openid-client (`expectedState`).
- Related hardening in the same files: SSO config body is Zod-validated (https issuer, valid domains); domain verification now requires the TXT record on every allowed domain (one verified domain used to verify all of them) and `OPENLINEAR_SSO_SKIP_DNS` is ignored in production; email-domain comparison is case-insensitive.

### 2. SSE tickets bound to the issuing session (routes/events.ts, events/hub.ts, services/sessions.ts)
- `sse_tickets.sessionId` records the minting session (from the new `req.sessionId`, set by the auth middleware for session JWTs).
- Ticket consumption is one conditional UPDATE (previously read-then-write: parallel connections could all consume one ticket), then requires the issuing session to be live. Tickets without a session are refused unless `OPENLINEAR_ALLOW_SESSIONLESS_JWT=1` (tests).
- Every session revocation path (logout, `DELETE /api/sessions/:id`, revoke-others, refresh rotation, refresh-reuse family revocation) goes through `afterSessionsRevoked`: outstanding tickets of those sessions are marked consumed, local streams opened by them are closed at once, and a `session:revoked` user event is published so other replicas close theirs on delivery (hub handles it, only for the addressed owner). Backstops: the stream re-checks its session right after registering (closes the revoke/connect race) and on every 30 s heartbeat (uncached, by session id), for ticket and bearer streams alike.
- Binding is to the exact session row: a refresh rotation ends streams of the rotated session (the client reconnects with a fresh ticket and replays). Chosen over family binding so a stream never outlives the token that opened it.
- Bug fixed on the way: `POST /api/sessions/revoke-others` compared `Session.id` with the bearer token's hash, so it also revoked the caller's own session.

### 3. Replay cursor (events/replay.ts, routes/events.ts, events/hub.ts)
- `replaySince` read one 200-row page and filtered it; a fully filtered page delivered nothing and never advanced Last-Event-ID (stall; anything visible behind it was never replayed). The route now uses `replayVisibleSince`: it pages forward (200 rows/query) to the end of the outbox or a 5 000-row budget and returns the highest id examined. After the replay the stream sends a cursor frame — an unnamed `message` event with `id: <cursor>` and data `{"type":"replay:cursor","cursor":"…"}`. The desktop UI's `onmessage` already records `event.lastEventId`, so its cursor advances (verified by reading `providers/sse-provider.tsx`; no UI change needed).
- Budget reached: the stream sends the cursor and ends; the client reconnects from it (progress on every connection, no livelock). Live events held during that replay are not delivered, so they cannot move the client past unscanned rows.
- Live events arriving during replay are held (`beginReplayHold`/`endReplayHold`), events the replay already covered (id ≤ cursor) are dropped, the rest are delivered in order. A principal refresh in flight keeps holding and flushes later.

### 4. Workspace-bound PATs vs account-level resources, registry as single source of truth (registry.ts, middleware/auth.ts)
- The PAT path of the middleware now looks up the matched route in `ROUTE_REGISTRY` (route pattern when the route is known, concrete path for router-level mounts) and enforces the row: undeclared → 403 `PAT_ROUTE_UNDECLARED` (default deny); `session` rows → 403 `SESSION_REQUIRED`; scopes = registry ∪ inline `requireAuth([...])`; workspace binding stance.
- Binding stances are now `enforced` (workspace-scoped resource, policy helpers confine the PAT), `account-read` (GET only, mandatory `bindingJustification`), `refused` (bound PAT → 403 `PAT_WORKSPACE_RESTRICTED` before the handler), `not-applicable`. The old catch-all `account-level` is gone.
- Decisions: `account-read` only for `GET /api/auth/me`, `GET /api/users/me` (identity of the token owner; no workspace data, no secret) and `GET /api/models` (public catalogue). Refused for bound PATs: settings, repositories (except below), GitHub/SCM token, uploads and attachment upload, MCP usage and MCP log, notification preferences and read-all (account-wide), `PATCH /api/auth/me`. `GET /api/repos/:id` is workspace-scoped for bound PATs: allowed only when the repository backs a project the PAT can view inside its workspace (the MCP/sidecar use case).
- `assertRegistryComplete` now also requires a binding stance for every PAT route, justification for `account-read`, and a `scopeJustification` for any generic `read`/`write` requirement. `registerRouteDeclarations()` lets another app that reuses the middleware (the sidecar) declare its routes.

### 5. PAT scope tightening (registry.ts)
- Before: bare `requireAuth` meant generic `read`/`write`, which any narrow scope satisfies (`labels:write` could create tasks, delete projects or workspaces; `tasks:read` could read settings or repositories).
- Now every PAT route declares a family scope: tasks/comments/task labels/agent runs/inbox/notifications/activity/usage → `tasks:read|write`; projects/teams/label reads → `projects:read|write`; label writes → `labels:write`; workspace reads/members/own invitations → `workspaces:read`; membership, access grants, invitations, team join, workspace create/update/delete, audit log, SCM token → `admin`; own account data → `account:read|write`; chat → `chat:read|write`. `account:*`/`chat:*` are requirement names that only generic `read`/`write`/`admin` satisfy (the closed enum in `packages/api-core` is unchanged). Generic requirements remain only on `GET /api/models` (any PAT) and `POST /api/mcp/log` (any write-capable PAT), both justified in the registry.
- Resolves W02a ledger item 7: workspace delete and audit log need `admin`; label writes need `labels:write`.

### 6. One-off PAT remediation + coordinator (a)/(b)
- (a) DB fail-safe: trigger `personal_access_tokens_revoke_on_unbind` revokes a token in the same statement whenever `workspaceId` goes from set to NULL, including the FK's ON DELETE SET NULL (verified: deleting a workspace with plain SQL revokes its tokens). Expand-only: function + trigger, FK unchanged.
- (b) Audit: new `account_audit_logs` table. `POST /api/pats` and `DELETE /api/pats/:id` write `pat.created`/`pat.revoked` for every token (account-wide ones were unaudited because `logAudit` needs a workspace), in the same transaction as the token write; bound tokens are also still written to the workspace `audit_logs`. Refresh-token reuse and remediation actions are audited there too.
- Script: `apps/api/src/scripts/remediate-pats.ts` → `services/pat-remediation.ts`. Dry run by default; `--apply`, `--revoke-wildcard`, `--sunset-days=N` (default 30), `--created-before=<iso>`, `--user=<id>`. Classes: (1) live account-wide tokens with surviving evidence of a bound creation (`audit_logs` or `account_audit_logs` `pat.created` carrying a workspace) → revoked; (2) legacy `*` tokens → expiry set to now + N days (never extended; or revoked with `--revoke-wildcard`); (3) report-only count of live account-wide tokens created before the cut-off. Every change is conditional (idempotent) and audited (`pat.remediated`) in the same transaction.
- Important finding: the W02a ledger assumed `audit_logs` `pat.created` rows identify tokens widened by workspace deletion. They do not survive: `audit_logs.workspaceId` is ON DELETE CASCADE, so the evidence is deleted with the workspace (proven by the control test). For hard-deleted workspaces the widened tokens are indistinguishable from intentional account-wide tokens; the script counts them (class 3) and the owner must decide (notify/force rotation). New widenings are impossible (route + trigger).

### 7. Atomic auth primitives (services/totp.ts, routes/totp.ts, lib/auth-tokens.ts, routes/users.ts)
| Primitive | Verified broken? | Fix |
|---|---|---|
| TOTP step replay | Yes: stateless check, a code was reusable for ~90 s (window ±1) | `users.totpLastUsedStep`; accept only for a strictly later step via conditional UPDATE (login, verify, disable); reset on setup/disable |
| Backup codes | Yes: read-modify-write of the whole array (same code spent twice concurrently; concurrent different codes could restore each other) | `array_remove` guarded by `= ANY(...)`; only the request that removed the hash proceeds |
| 2FA challenge | Yes: findUnique then update | conditional UPDATE claim |
| Refresh rotation | Yes: non-atomic revoke, every rotation started a new `familyId` (no family), rotated tokens returned 401 silently (no reuse detection) | rotation = conditional revoke (`revokedAt` + new `rotatedAt`) + successor in the same family, one transaction; reuse of a rotated token after a 10 s grace (`OPENLINEAR_REFRESH_REUSE_GRACE_MS`, max 60 s) revokes the whole family, closes its streams and is audited; concurrent duplicates inside the grace get 401 without revoking; legacy NULL-family sessions become the family root |
| SSE ticket | Yes: read-then-write | conditional UPDATE (item 2) |
| Email-change confirm | Yes: checks outside the transaction | conditional claim inside the transaction |

### Coordinator (c)–(e)
- (c) `x-openlinear-client`: `isDesktopClient` now requires an interactive session (`authSource === 'jwt'`); the header is only a client hint. PATs can no longer set or change `localPath` (403 `DESKTOP_REQUIRED`) whatever header they send. Not solved: a collaborator with a session can still set `localPath` on a shared project (needs per-user local checkouts, W08, or a device credential, W03).
- (d) Logging: base logger and HTTP logger share `LOG_REDACT_PATHS` (credential headers, `Location` redirects, `set-cookie`, query `ticket/token/code/state/refresh_token/…`, body `password/secret/token/refreshToken/tempToken/clientSecret/code/…`, and those field names at top level and one level deep), the logged request URL has sensitive query values replaced, and a `streamWrite` hook masks PAT, SSE-ticket and JWT shapes anywhere in a line.
- (e) PAT `lastUsedAt`: written at most once per 60 s per token (in-process throttle + conditional UPDATE so other replicas skip too). Validity is still read from the database on every request.

## Client-visible behaviour changes
- PATs (MCP, API clients). Narrow scopes no longer reach other families:
  - Projects and teams need `projects:write`; labels and phases need `labels:write`.
  - Membership changes, access grants, invitations, team join, workspace create/update/delete, the audit log and the SCM token need `admin`. `write` PATs lose these.
  - Account data needs generic `read`/`write`.
  - `INSUFFICIENT_SCOPE` responses now include `details.requiredScopes`.
  - `write`/`admin`/legacy `*` tokens keep everything except the new admin-only routes (for `write`).
  - MCP `bulk_create_plan` needs `projects:write` + `labels:write` + `tasks:write`, or `write`.
- Workspace-bound PATs get `403 PAT_WORKSPACE_RESTRICTED` on account-level routes (list above). This includes `POST /api/mcp/log`, so the MCP worker's telemetry for bound tokens is no longer recorded (the worker ignores the failure).
- Undeclared routes refuse PATs with `403 PAT_ROUTE_UNDECLARED`. This includes every sidecar route using the API's `requireAuth` until the sidecar declares them. Sessions are unaffected.
- `POST /api/auth/logout` with a PAT: `403 SESSION_REQUIRED` (was a 200 no-op).
- Sessions and SSE:
  - Logout and session revocation close that session's SSE streams at once and invalidate its unused tickets.
  - A refresh rotation also ends streams opened by the rotated session; clients reconnect and replay.
  - Tickets minted without a session (pre-deploy) are refused.
- Replay: after Last-Event-ID replay the stream may send an unnamed event `{"type":"replay:cursor","cursor":"<id>"}` with an SSE id. When more than 5 000 rows remain, the stream ends after the cursor and the client reconnects.
- Refresh:
  - Reusing a rotated refresh token more than 10 s after rotation revokes every session of that login (user is signed out on all of that login's tokens).
  - Concurrent refreshes with one token: one succeeds, the rest get 401.
- 2FA:
  - A TOTP code works once per 30 s step, including the code used to enable 2FA.
  - A 2FA challenge and a backup code are single-use under concurrency.
- SSO:
  - `/api/auth/sso/check` sets the `ol_sso_binding` cookie. The callback requires it (`400 SSO_STATE_INVALID` with `details.reason`), so the check must be called from the browser that completes the login, same-site with the callback.
  - SSO config requires an https issuer and valid domains.
  - Domain verification requires the TXT record on every allowed domain.
- `localPath` cannot be set by a PAT.
- `POST /api/sessions/revoke-others` no longer signs out the caller.

## Tests added (all new files listed in the root biome list)
| File | Tests |
|---|---|
| `sso-state.test.ts` | 6: verifier/nonce never in URL or state, verifier encrypted at rest, cookie attributes; replay; foreign browser (no burn); expired; tampered + old signed format; 5 concurrent callbacks → 1 |
| `sse-session-binding.test.ts` | 7: ticket records session; logout closes ticket+bearer streams and invalidates unused tickets, other session unaffected; device revoke closes stream; revoked-by-other-path session refuses ticket; 6 concurrent connects → 1; cross-replica signal scoped to owner; revoke-others keeps caller |
| `sse-replay-cursor.test.ts` | 5: control (old `replaySince` stalls); visible event behind 450 invisible rows delivered; cursor past trailing invisible rows; budget exhaustion makes progress each connection; replay hold dedupe/order |
| `auth-atomicity.test.ts` | 8: TOTP concurrent/sequential replay + next step; disable replay; backup code concurrent same/different; challenge single use; refresh concurrency + family + reuse revocation + stream close + audit; legacy family chain; email confirm concurrency |
| `pat-policy.test.ts` | 47: undeclared default deny (route- and router-level), registry over weaker inline scope, binding stance, registration validation; 40-row read/write matrix covering every module; bound PAT repository rule; `lastUsedAt` throttle (in-process, cross-replica, revocation still immediate); `localPath` vs header |
| `pat-remediation.test.ts` | 7: trigger on workspace delete and direct unbind; control: workspace audit cascades; account audit of PAT create/revoke; remediation dry run, apply + idempotent re-run (no extension), revoke-wildcard |
| `log-redaction.test.ts` | 3: HTTP log line free of PAT/ticket/JWT/refresh/code/state/password/client secret with context kept; token shapes masked anywhere; URL helper |
| `route-inventory.test.ts` (extended) | +3: scopes satisfiable by a mintable PAT, generic scopes justified, account data never `enforced`; every `refused` row → 403 `PAT_WORKSPACE_RESTRICTED` for a bound PAT; every other PAT row passes the gate for a bound PAT. Probes now go to a 127.0.0.1-bound server (see flakes) |

Negative checks, each a temporary source edit through a script that restored the files (source checksums compared identical afterwards): 23 reverts, every one failing its tests. The reverts were:
- SSO: verifier back in state; binding and single-use removed.
- Tickets: non-atomic consume; no revocation close; old revoke-others; cross-replica signal ignored.
- Replay: old page filter; no dedupe.
- Middleware: old method-default scopes; generic registry scopes; bound PATs not refused.
- Repositories: bound read ignoring project linkage.
- Atomicity: stateless TOTP; read-modify-write backup codes; read-then-write challenge; no reuse detection; non-atomic rotation with new family; non-atomic email confirm.
- Coordinator items: header-trusted `localPath`; old redaction; unthrottled `lastUsedAt`; unaudited account PAT; remediation extending expiry.
- Trigger: disabled in the private database, failing the two trigger tests; re-enabled and confirmed (`tgenabled = O`).

## Validation
| Command | Result |
|---|---|
| `TEST_DATABASE_URL=…/openlinear_authz_test pnpm --filter @openlinear/api test` | 38 files, **372 passed**, 2 skipped (baseline 31 files, 286 + 2) |
| `pnpm --filter @openlinear/sidecar test` | 38 files, 661 passed |
| `TEST_DATABASE_URL=… pnpm --filter @openlinear/sidecar test:integration` | 26 passed |
| `pnpm typecheck` (root) | 11/11 tasks |
| `pnpm lint` | 53 files, clean |
| `prisma migrate deploy` (private DB) + `prisma migrate diff --from-migrations --to-schema --exit-code` (private shadow DB) | applied; "No difference detected" |
| route-inventory + pat-policy repeated 6× | 6/6 green |

`execution-core` was not touched and not re-run.

Full API suite run twice after the flake fix: 38 files, 372 passed + 2 skipped, both runs.

### `route-inventory` "socket hang up" flake: root cause
The coordinator saw 3/401 failures on the merged tree, all in this file's HTTP probes, all `socket hang up`.

**Root cause.**
- supertest's `request(app)` calls `app.listen(0)` for every request. That listens on the wildcard address, and supertest then connects to `127.0.0.1:<port>`.
- On this shared machine the kernel gave those wildcard listeners ephemeral ports that other processes already held on 127.0.0.1. The more specific 127.0.0.1 listener wins, so the probe never reached the app.

**Evidence.**
- A temporary diagnostic (deleted) made 1 500 `request(app)` calls and recorded the port of each failure. Two failed, on ports 55616 and 55618. `lsof` at that moment showed other developers' `postgres` processes listening on `127.0.0.1:55616/55618`.
- In the failing suite runs, the failed probes have no server-side log line. One run returned a stray 401 with no envelope code.
- A standalone Node check confirmed the precedence: with a wildcard listener and a 127.0.0.1 listener on the same port, a request to 127.0.0.1 reaches the 127.0.0.1 listener.

**Probed routes checked.** None can end a connection without a response:
- Every `fetch` the network stub can hit is awaited inside the request; there is no fire-and-forget call. `GET /api/models` turns the stubbed failure into a JSON 500 (visible in the logs). GitHub routes answer 403 `GITHUB_NOT_LINKED` before any fetch. SSO check answers 400 without an email.
- The SSE route (`/api/events`) and the chat streaming route (`POST /api/chat/sessions/:id/messages`) both reject probe requests with JSON (401/400/404) before flushing headers.

**Fix.**
- `route-inventory.test.ts` and my new test files start one server per file in `beforeAll`, explicitly bound to `127.0.0.1` (`auth-helpers.listen`). They send every probe to it and close it in `afterAll`. A 127.0.0.1 bind cannot share such a port: it gets EADDRINUSE.
- The suggested `app.listen(0)` + `request(server)` would still bind the wildcard address, once per file.
- Results: 6/6 green repeats of route-inventory + pat-policy (2/6 failed before), and two clean full-suite runs.

**Tried and rejected.** A suite-wide `setupFiles` patch forcing `listen(0, '127.0.0.1')`. Any host argument makes Node resolve the address asynchronously, so supertest's synchronous `address()` returns null.

**Still exposed.** Other existing test files still use `request(app)` and can hit the same environmental collision (seen once in `chat.messages.test.ts`). They are lower-volume and not in my area; converting them to the same helper fixes it.

## Schema
`packages/db/prisma/migrations/20261026010000_w02b_auth_hardening`, expand-only:
- nullable `sse_tickets.sessionId`, `sessions.rotatedAt`, `users.totpLastUsedStep`;
- new tables `sso_auth_states` and `account_audit_logs`, with indexes only on these new tables (opt-in comment for the safety rule);
- function `openlinear_revoke_unbound_pat` and trigger `personal_access_tokens_revoke_on_unbind`.

No existing index, column or constraint is altered. `schema.prisma` is in sync; the trigger is not represented in Prisma and does not show as drift.

## Left, and why
- Wildcard (`*`) tokens still grant everything until the owner runs the remediation (`--apply`, ideally after notifying users); account-wide tokens widened before W02a whose workspace was hard-deleted cannot be identified (evidence cascaded) — only counted.
- Cross-replica stream close relies on the domain-event bus (Redis) or the 30 s heartbeat; the session revocation cache on other replicas is still 30 s (pre-existing).
- Bound-PAT MCP telemetry: make `mcp_tool_calls` workspace-scoped (stamp the PAT's workspace) to allow it again.
- Sidecar routes refuse PATs until declared; `registerRouteDeclarations` is exported from `apps/api/src/registry.ts` but `@openlinear/api` has no `./registry` export yet (one-line `package.json` change for the sidecar owner).
- `localPath` cross-collaborator risk: per-user local checkouts (W08) or device credential (W03).
- Narrow mintable scopes for account/chat/workspace writes would need `packages/api-core` `PAT_SCOPES` changes; desktop UI scope picker and `apps/mcp-docs` text (says the dashboard mints `*`) are stale.
- SSO has no UI; the redirect URI is `FRONTEND_URL/api/auth/sso/callback`, so the deployment must serve `/api` on the frontend host for the binding cookie to reach the callback.
- No scheduled pruning job for `sso_auth_states`/`sse_tickets` (opportunistic per-flow/per-user pruning only; `jobs/index.ts` is not mine).
- Backup codes remain scrypt (argon2id is a Phase 1.4 item).

## Merge hazards
- `packages/db/prisma/schema.prisma` (User, Session, SseTicket, PersonalAccessToken comment, two new models) and the new migration folder; other engineers' migrations must sort around `20261026010000_`.
- `apps/api/src/registry.ts`: any new or renamed route needs a row with family `patScopes` and a binding stance. `assertRegistryComplete` is stricter: generic `read`/`write` need `scopeJustification`; `account-read` needs `bindingJustification`. The desktop engineer's new route in `routes/auth.ts` needs a row (as before), otherwise the parity test fails and PATs are refused.
- `apps/api/src/middleware/auth.ts`: PATs are default-denied on undeclared routes (affects `apps/sidecar` routes using `@openlinear/api/middleware`); `AuthRequest.sessionId` added; `verifyAccessToken` exported and now rejects tokens without a `userId` claim.
- `apps/api/src/events/hub.ts` (`SSEClient.sessionId/replaying/replayCursor`, `closeStreamsForSessions`, replay hold, `session:revoked` handling) and `routes/events.ts` (no longer calls `replaySince`; `events/replay.ts` mirrors its filter — keep in sync with any outbox change).
- Outside my list, kept minimal:
  - `apps/api/src/app.ts`: the pino-http redaction is now `...httpLogRedaction()` (import line + 3 lines).
  - `apps/api/src/logger.ts`.
  - `apps/api/src/routes/projects.ts`: `isDesktopClient` body only.
  - Root `package.json`: lint list appended.
- `lib/auth-tokens.ts`: `issueSession` no longer goes through `services/sessions.createSession` (still exported). `rotateRefreshToken` and `revokeSessionByTokenHash` signatures are unchanged, so `routes/auth.ts` is untouched.
- `routes/totp.ts`: the validate limiter now skips in `NODE_ENV=test` (like the app limiters).
- `__tests__/route-inventory.test.ts`: changed in three ways.
  - Probes go through a 127.0.0.1-bound server (`send(target, …)`, imports `listen`/`closeServer` from the new `__tests__/auth-helpers.ts`).
  - Three W02b tests are added.
  - The header comment is updated.
  If another branch edits this file, keep the server change; it is the flake fix.
