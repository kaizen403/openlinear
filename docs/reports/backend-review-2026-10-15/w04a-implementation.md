# W04a request-hash idempotency — 2026-10-25

Status: this slice is implemented and verified locally. It is not committed. It adds the transactional reservation and result-state part of W04 for task creation. W04 itself (immutable events, transactional outbox, claim/ack/retry) and gate G1 stay in progress. No frontend, deployment, live database, paid inference or MCP/client changes were made.

Audit context: [api-data.md](api-data.md) A09 found that the existing helper in `lib/http.ts` reads, then mutates, then stores. Two concurrent same-key requests both execute, a crash before the store duplicates the write on retry, and a changed body replays an unrelated response. This slice replaces that pattern on the task creation routes. The legacy helper stays on project/team/workspace routes (see W04b).

## Contract

| Aspect | Behavior |
|---|---|
| Header | `Idempotency-Key` is optional. It must be 8–128 characters from `A-Z a-z 0-9 . _ : ~ + / = -`. The IETF structured-field form `"<key>"` is accepted and means the same key. An empty, malformed or repeated header (Node joins repeats with `", "`) gets `400 IDEMPOTENCY_KEY_INVALID` before any write. The database enforces the same length bound. |
| No header | Same as before: no record is written, and identical requests create separate tasks. |
| Scope | (principal, workspace, operation kind, key). Principal = the authenticated user, whether the credential is a JWT or a PAT. Workspace = the workspace that owns the target project/team, or `''` if none can be resolved. Operation = `tasks.create` or `tasks.bulk_create`. |
| Request equality | SHA-256 hex of canonical JSON (sorted keys, `undefined` dropped, array order kept) over `{v:1, method, operation, params, body}`. `body` is the Zod-validated body, so key order, explicit defaults and stripped unknown fields don't change the hash. |
| Equal retry | Replays the stored status and the exact response bytes (stored as `TEXT`, not `jsonb`, so key order is preserved), with `Idempotency-Replayed: true`. Content type matches the original. Domain writes and post-commit side effects do not run again. |
| Different request, same key | `409 IDEMPOTENCY_CONFLICT`, `details: { operation, retentionSeconds }`. Nothing is written. |
| Concurrent duplicate | Waits up to 5 s (`IDEMPOTENCY_LOCK_WAIT_MS`) for the in-flight holder. It then replays the result (equal body), conflicts (different body), or takes the key over and executes if the holder rolled back. If the holder is still running when the 5 s run out: `409 IDEMPOTENCY_IN_PROGRESS`, `Retry-After: 1`, `details.retryAfterSeconds`. |
| Failed mutation | The reservation rolls back with the domain writes and the issue-number increment. Retrying with the same key executes normally. |
| Authorization | The caller's current authority over the target resource is checked **before** any replay or conflict answer. A principal who has lost access gets 403/404, not the stored body. Validation (labels, assignee, parents) runs only when the request actually executes, so a replay returns the original result even if that validation state has changed since. |
| Retention | Records expire after 24 h (`IDEMPOTENCY_RETENTION_MS`). An expired record is forgotten as of the request's arrival time, and the same key then executes again. `pruneIdempotencyRecords` deletes expired rows in the hourly maintenance run. |
| Size bound | A stored response is at most 2 MiB (code constant plus DB `CHECK`). With the 256 KiB request limit, a valid task response stays under this. If a result is larger, the whole transaction rolls back and the client gets `422 IDEMPOTENCY_RESPONSE_TOO_LARGE`; nothing is written. |
| Errors | All errors use the existing `buildErrorEnvelope` shape through `HttpError`: `{ error: { code, message, details }, code, message, details, requestId }`. |

## Enabled call paths

| Endpoint | Operation | Notes |
|---|---|---|
| `POST /api/tasks` | `tasks.create` | Workspace comes from team → project. The task insert, issue-number allocation and record completion share one transaction. |
| `POST /api/tasks/bulk` | `tasks.bulk_create` | Workspace comes from the project. The existing partial semantics are unchanged: invalid labels/parents are reported in `failed` and stored in the replayed result. The issue-number range is allocated once. |

Not covered in this slice:

- **Sidecar `POST /api/tasks/:id/execute` and `/cancel`, and sidecar batch start/cancel.** These start in-memory processes, provider sessions, Git work and SSE streams in the sidecar. None of that can join a database transaction. A reservation committed before the effect would need `in_progress` → `completed`/`outcome_unknown` transitions with reconciliation after a crash. That means a durable operation/run record, which belongs to W05. It cannot be added without touching sidecar internals, so it is left for W04b. The schema already has the `in_progress` state, and the helper treats a committed `in_progress` record as `409 IDEMPOTENCY_IN_PROGRESS`.
- **Legacy `lib/http.ts` cache** on `POST /api/projects`, `/projects/:id/access(/bulk)`, `POST /api/teams`, `/teams/join`, `POST /api/workspaces`, `/workspaces/:id/members(/bulk)`. Unchanged and still unsafe (A09). Their services don't take a transaction client yet.
- **Other task mutations** (`PATCH /:id`, bulk status/archive/delete, `/:id/execution`) ignore the header, as before.

Chat tools (`createTask`, `bulkCreateTasks`) and plan import (`services/project-plan.ts`) call the same commands through `runCommand`. They behave as before and have no key.

## Schema and migration

- Migration `packages/db/prisma/migrations/20261025120000_w04a_idempotency_records/migration.sql` is additive: enum `IdempotencyState` (`in_progress`, `completed`) and table `idempotency_records`. No existing table is altered or locked.
- Columns: `id`, `principalId`, `workspaceId`, `operation`, `key`, `requestHash`, `state`, `responseStatus?`, `responseBody? TEXT`, `createdAt`, `completedAt?`, `expiresAt`.
- Indexes: unique `(principalId, workspaceId, operation, key)` (the reservation arbiter) and a `(expiresAt)` index for the sweep.
- `CHECK` constraints:
  - key length 8–128
  - `requestHash` is 64 lowercase hex characters
  - a `completed` row has a status, body and `completedAt`
  - `octet_length(responseBody) <= 2 MiB`
- Migration safety: the file carries `-- migration-safety: allow` with a stated reason. Its two `CREATE INDEX` statements index the table created in the same migration, which is empty and invisible until commit. `CONCURRENTLY` cannot run inside Prisma's migration transaction. The file has no destructive DDL.
- `prisma migrate diff` from the migrated local database to the schema shows no drift from this change. The only output is the preexisting `personal_access_tokens.scopes` default drift, which is unrelated and left alone.
- No foreign key to `users`: rows last 24 h and are pruned, and leaving it out keeps the migration lock-free and the `User` model untouched (avoids a merge conflict with W02a).
- New model `IdempotencyRecord`. The legacy `IdempotencyKey` model and table are unchanged and now carry a comment marking them superseded.

## Concurrency design

`respondIdempotently` in `apps/api/src/services/idempotency.ts`:

1. Parse the key. If the header is absent, run the command exactly as before.
2. `authorize()`. Route-specific access checks build an `IdempotentCommand` (`resolveWorkspaceId`, read-only `prepare`, `mutate(tx)`, optional `afterCommit`).
3. Resolve the scope through `resolveIdempotencyPrincipal(req, resourceWorkspaceId)` and compute `requestHash`. Capture `now` once.
4. Fast path: `findUnique` on the scope. An unexpired record answers immediately: conflict, replay, or in-progress.
5. Run `prepare()` (validation) outside the transaction.
6. In one interactive transaction (`PRISMA_TX_OPTIONS`, 15 s):
   - Set a transaction-local `lock_timeout` (5 s).
   - Delete an expired record for the scope.
   - `createMany({ skipDuplicates: true })`, i.e. `INSERT … ON CONFLICT DO NOTHING`.
     - If another transaction holds an uncommitted row for the scope, PostgreSQL blocks this insert on the unique index until that transaction ends.
     - Inserted: restore `lock_timeout` and run `mutate(tx)`. Serialize the body, enforcing the size bound. Update the record to `completed` with status and body. Commit.
     - Conflict: re-read in a new READ COMMITTED snapshot and return the committed record (replay/conflict). If the row vanished or expired between statements, retry up to 3 times, then answer IN_PROGRESS.
7. SQLSTATE `55P03` during the reservation phase only becomes `409 IDEMPOTENCY_IN_PROGRESS` + `Retry-After`. A lock failure inside the domain writes keeps its own error.
8. After commit, run `afterCommit` (SSE fan-out, activity, notification) once. A failure there is logged and does not change the committed response.

Consequences:

- For these transactional operations, a committed record is always `completed`.
- `mutate` uses only `tx`, so waiting duplicates cannot starve the owner's pool connection. Waiters hold one connection each for at most the lock wait.
- The 5 s lock wait is shorter than the 15 s transaction timeout, so the in-progress outcome is deterministic.

Empirical basis, checked against the installed Prisma 7.4 + `@prisma/adapter-pg` on PostgreSQL 14:

- The lock timeout surfaces as `DriverAdapterError` with `cause.code === '55P03'`, not as `PrismaClientKnownRequestError`. The helper walks the cause chain.
- `createMany({ skipDuplicates })` waits on an uncommitted duplicate, returns `count: 0` after it commits, and the committed row is then visible.
- `set_config(..., true)` does not leak beyond the transaction.

### Principal seam (W02a)

`resolveIdempotencyPrincipal(req, resourceWorkspaceId)` is the only place idempotency reads request identity. Today it uses `req.userId` plus the resource workspace resolved after authorization. When W02a's `PrincipalContext` lands, change this one function, e.g. to `req.principal.userId` / `req.principal.workspaceId ?? resourceWorkspaceId`. A workspace-bound PAT and the resource it is authorized for name the same workspace, so the scope does not change for authorized requests. Records live only 24 h, so a change in scoping at the switch is harmless.

## Tests

New file `apps/api/src/__tests__/idempotency.test.ts`: 23 cases, real PostgreSQL. The race cases hold real row locks or uncommitted reservations from a separate transaction and wait until `pg_stat_activity` shows the expected number of lock-blocked backends. The interleavings are forced, not timing-based. Fixtures create uniquely named users/workspaces/projects and delete only their own rows. A temporary `plpgsql` trigger is created and dropped by the test.

| Test | Proves |
|---|---|
| canonical JSON | Sorted keys, dropped `undefined`, kept array order. Non-finite numbers and functions throw. |
| request hash | Stable across key order and method case. Changes with operation, body or params. 64-hex output. |
| header parsing | Absent → null. Bare and quoted forms are equal. Empty, too short, too long, space, repeated (`", "`) and control characters → 400 `IDEMPOTENCY_KEY_INVALID`. |
| no header | Backward compatible: two identical POSTs → two tasks, no record. |
| same key + same body | 201 twice. Second has `Idempotency-Replayed: true`, byte-identical body, same content type. One task. Issue counter +1. One `completed` record with scope, hash, stored body and ~24 h expiry. |
| canonical equality | Reordered keys, explicit defaults and the quoted key form replay instead of conflicting. |
| same key + different body | 409 `IDEMPOTENCY_CONFLICT` (envelope and details). No task. Counter unchanged. Stored record unchanged. |
| malformed keys over HTTP | 400 before any write. No task or record. |
| authorize before replay | After an explicit project deny, the same key + body gets 403 and none of the stored body. |
| mutation failure | Trigger-injected insert failure → 500. No record, no task, counter rolled back. Same key + body then succeeds (not a replay). |
| forced race (5 requests) | The owner reserves, then blocks on a held team-row lock. Four duplicates pass the empty fast path and block on the uncommitted reservation (no record visible). On release: all 201, exactly one executed, four byte-identical replays, one task, counter +1, one record. |
| burst (20 requests) | 20 unsynchronized identical requests (more than the 10-connection pool): all 201, one executed, one shared body, one task, counter +1. |
| concurrent different body | Waits for the holder, then 409 CONFLICT. No second task. |
| holder rollback | A request blocked on an uncommitted foreign reservation takes over after rollback: 201, executed, one completed record. |
| bounded wait | A holder still open after 5 s → 409 `IDEMPOTENCY_IN_PROGRESS`, `Retry-After: 1`, wait ≥ the bound, no task. A retry after the holder ends succeeds. |
| committed `in_progress` | Equal hash → 409 IN_PROGRESS + `Retry-After`. Different hash → 409 CONFLICT. No task. (Covers how W04b's record state will be answered.) |
| principal scope | Another user with the same key and body creates its own task. Two records. |
| operation scope | The same key on single and bulk create executes both. |
| workspace scope | The same key in a second workspace executes (no conflict). Records carry each workspace. |
| expiry and sweep | An expired record is replaced by a different body (new id, new hash, future expiry); the next equal request replays. The sweep removes expired rows only. |
| bulk replay | Partial failure (`failed[1]`) is stored and replayed byte-identically. A changed body gets 409. Counter +2 once. Two tasks. |
| bulk burst (8 × 10 items) | One batch: counter +10, 10 tasks, one shared body. |
| size bound | With a lowered bound, the real task command → 422 `IDEMPOTENCY_RESPONSE_TOO_LARGE`. Task and record both rolled back. The unkeyed request still succeeds. |

**Mutation checks** (temporary edits, reverted byte-identically and verified with `cmp`):

1. Committing the reservation in its own transaction before the mutation fails 7 tests: failure rollback, forced race, burst, concurrent conflict, takeover, bulk burst and size bound.
2. Removing the in-transaction reservation (check-then-act, like the legacy cache) fails 6 tests, including the forced race, burst and bulk burst. Each of those created duplicate tasks.

## Verification

| Check | Result |
|---|---|
| API full suite | 27 files, **236 passed**, 2 preexisting skips (baseline 213 + 23 new). |
| Sidecar unit/HTTP/real-Git/SDK fixture suite | 38 files, 661 passed. |
| Sidecar PostgreSQL integration suite | 1 file, 26 passed. |
| execution-core | 2 files, 28 passed. |
| Root `pnpm typecheck` | 11/11 turbo tasks passed: 10 package typechecks (api, sidecar, mcp, mcp-docs, execution-core, desktop-ui, db, api-client, api-core, telemetry) plus the `api:build` dependency. |
| Root `pnpm lint` | Passed. The new files are outside the configured biome list but pass `biome check --error-on-warnings` when checked explicitly. |
| CI migration-safety logic, run locally | New migration skipped by opt-in. No destructive DDL. |
| `git diff --check` | Clean. |

Total: **951 passing tests** (236 + 661 + 26 + 28), up from 928.

Database: a disposable Homebrew PostgreSQL 14.17 cluster under the worktree's ignored `.context/pg`, on `localhost:54333` with trust auth, database `openlinear_test`. All migrations were applied with `prisma migrate deploy`. The cluster was stopped and its data directory deleted after verification. No other database was contacted.

~~~sh
DATABASE_URL=postgresql://openlinear@localhost:54333/openlinear_test pnpm --filter @openlinear/db exec prisma migrate deploy
TEST_DATABASE_URL=postgresql://openlinear@localhost:54333/openlinear_test pnpm --filter @openlinear/api test
pnpm --filter @openlinear/sidecar test
TEST_DATABASE_URL=postgresql://openlinear@localhost:54333/openlinear_test pnpm --filter @openlinear/sidecar test:integration
pnpm --filter @openlinear/execution-core test
pnpm typecheck && pnpm lint && git diff --check
~~~

### Descriptive timing

This is not a performance claim. 60 sequential supertest requests of each kind, single process, loopback PostgreSQL, logging silenced, 10 warmups:

| Path | p50 | p95 |
|---|---|---|
| Unkeyed `POST /api/tasks` | 2.96 ms | 4.43 ms |
| Keyed, executed | 4.21 ms | 6.02 ms |
| Keyed, replayed | 1.93 ms | 2.64 ms |

A keyed execution adds 8 statements:

- workspace lookup
- fast-path read
- `lock_timeout` read, set and restore
- expired-row delete
- reservation insert
- completion update

A replay skips validation and writes. Remote-database round trips will dominate in production. W14 can fold the reservation into one statement if measurements justify it.

## Client-visible behavior changes

- New and opt-in: `Idempotency-Key` on `POST /api/tasks` and `POST /api/tasks/bulk`, with the responses above (`Idempotency-Replayed`, 409 `IDEMPOTENCY_CONFLICT` / `IDEMPOTENCY_IN_PROGRESS` + `Retry-After`, 400 `IDEMPOTENCY_KEY_INVALID`, 422 `IDEMPOTENCY_RESPONSE_TOO_LARGE`).
- A client that already sends a malformed or short key (under 8 characters) to these two routes now gets 400. Previously the header was ignored there. No in-repo client sends it.
- Post-commit side-effect failures (SSE fan-out, activity log, notification preference lookup) on task creation are now logged, and the committed 201 is returned for both keyed and unkeyed requests. Previously a throw there (activity logging already swallowed its own errors) could turn a committed create into a 500. The chat-tool `createTask`/`bulkCreateTasks` paths behave the same way.
- Unkeyed responses, status codes, body shapes, bulk partial semantics and chat/plan behavior are otherwise unchanged. Bulk calls with zero valid items now open an empty transaction; this is not observable.

## Limitations

- Post-commit side effects are still outside the transaction. A crash between commit and fan-out loses the SSE event/activity for that create, the same as before. A replay does not re-emit them. A transactional outbox (W04b) fixes this.
- Expiry is judged against application time (`new Date()` on arrival), not database time. Clock skew between replicas shifts the 24 h boundary by the skew.
- Authorization runs before replay; validation does not.
- A record is scoped to the resource's workspace. Reusing one key for "the same" create in two workspaces executes twice, by design of the contract.
- `pruneIdempotencyRecords` runs in the in-process hourly job (`runScheduledJobs`), the same path as the legacy prune. It is not registered as a pg-boss job, and the delete is unbounded. Rows are small and expire after 24 h.
- The new files are not added to the `apps/api` biome lint list, to avoid a one-line merge conflict with parallel work. They pass when checked explicitly.

## W04b remainder

1. **Execute/cancel and batch start/cancel idempotency.** Needs a durable operation record. Commit an `in_progress` reservation with the operation ID before the sidecar effect, then move it to `completed`/`failed`/`outcome_unknown` with reconciliation after a crash or restart. Expose it at `GET /api/operations/:id`. Depends on W05.
2. **Migrate the legacy `lib/http.ts` routes** (projects, project access, teams, team join, workspaces, workspace members) to commands plus `respondIdempotently`. Then retire `IdempotencyKey`/`idempotency_keys` and `pruneIdempotencyKeys` (expand → migrate → drop, with `migration-safety: allow`).
3. **Transactional outbox:**
   - Write `DomainEvent` rows inside the same `mutate(tx)` (`emitOutbox(tx, …)`) so the domain write, idempotency record and event commit atomically.
   - Remove the post-commit `persistAndDeliver`/local-fallback paths.
   - Durable relay claim (lease + fencing), ack and retry with bounded attempts. No "published" mark after a failed publish.
   - Immutable event payloads (no upsert over an existing sequence: `agent-runs` progress ingest).
   - Replay of more than 500 events across restart/replica with a gap signal.
4. **Client support.** `packages/api-client` needs an optional idempotency key per request, plus automatic retry only for keyed or otherwise safe requests. The MCP `openlinear_bulk_create_plan` should send a per-invocation key on its bulk create. A random key without client retry gives no benefit, so this was not added in W04a.
5. **PrincipalContext switch-over** (above) after W02a merges. Add a PAT-vs-JWT same-user replay test and a workspace-bound PAT test at that point.
6. Register the prune job with pg-boss once the single-scheduler fix lands (audit item 9). Consider a bounded batch delete.
