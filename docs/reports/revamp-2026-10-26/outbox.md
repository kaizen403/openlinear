# W04b — durable event delivery, transactional outbox and idempotency migration (engineer: outbox)

Status: implemented and verified locally, uncommitted. Base: `922dbd7` + `round1-base.patch` (tree `0a41ea8b…`). Scope: `apps/api` only; no deploy, no remote services, no Redis server, private loopback database `openlinear_outbox_test` only.

## 1. What changed and why

### 1.1 Event pipeline (apps/api/src/events)

```
domain tx ──appendDomainEvent(tx)──► domain_event_outbox   (pending, immutable, rolls back with the write)
sequencer (pg_advisory_xact_lock) ──move──► domain_events  (the ordered stream; id = Last-Event-ID)
relay: claim (lease) ─► publish to bus ─► ack (fenced) | retry w/ backoff | dead-letter
per-process StreamConsumer: bus message / local flush / poll ─► hub (exactly once, id order)
replay: bounded pages over domain_events, cursor = id, live/replay boundary = consumer position
```

| File | Change |
|---|---|
| `events/outbox.ts` | `appendDomainEvent(tx, input)` (alias `emitOutbox`) inserts into `domain_event_outbox` inside the caller's transaction; `transactionWithEvents(fn)` = `$transaction` + post-commit flush request; `persistAndDeliver` (legacy post-commit path used by `sse.ts`) now appends + flushes + returns the delivered stream event. The old local fallback that delivered with SSE id `0` (which reset clients' Last-Event-ID to the beginning) now delivers with no id. Re-exports replay/DLQ helpers. |
| `events/stream.ts` (new) | Stream storage: `sequencePendingEvents` (one transaction: `SET LOCAL lock_timeout`, `pg_advisory_xact_lock`, `DELETE … RETURNING` pending rows `FOR UPDATE SKIP LOCKED` → `INSERT … ORDER BY id` into `domain_events`); leased claim (`UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`), fenced ack/release, dead-letter list/requeue, `readOutboxHealth`, `pruneStream` (+ retention watermark). All raw-SQL timestamps are `now() AT TIME ZONE 'UTC'` (the local server runs in Asia/Kolkata; Prisma reads `timestamp(3)` as UTC). |
| `events/relay.ts` | `OutboxRelay` (sequence → claim → publish → ack/retry/DLQ, crash hooks for tests), backoff 250 ms·2^(n−1) capped 60 s ±20 %, `maxAttempts` 8, permanent errors dead-lettered at once; process wiring: coalesced fast flush (`flushOutbox`/`requestOutboxFlush`, deferred by `setImmediate` so post-commit `invalidateTenancyCache` runs first), relay loop, `startRealtime({ role })`, `stopRealtime`. |
| `events/consumer.ts` (new) | `StreamConsumer`: one position per process; drops ids ≤ position, delivers position+1 from the message, reads the stream on any gap; periodic poll; `liveStreamPosition()` for the replay boundary. |
| `events/replay.ts` (new) | `readReplayPage`, `replayEvents` (async generator), `replaySince` (compat, now pages past filtered rows), `isReplayTruncated`, `parseLastEventId`. Pages bounded by result count (default 200) and scanned id range (default 5 000); the cursor advances past filtered rows. |
| `events/bus.ts` | `MemoryBus` now really fans out in-process; `RedisBus`: connect-once (fixes concurrent connect leak), `publish` throws (relay retries) instead of silently degrading, 1 MiB message cap (`PermanentPublishError`), Zod-validated messages, `onResync` after reconnect, injectable client factory (`RedisClientLike`) for tests; `useEventBus` test seam. |
| `events/types.ts` | `PendingDomainEvent`, `sourceId`, strict `parseWireEvent`, `wireEventPosition`, `EVENT_IMMUTABLE_SQLSTATE = 'OLI01'`. |
| `events/config.ts` (new) | Relay ownership and intervals (§4.3). |
| `events/targets.ts` (new) | Transaction-scoped equivalents of the `sse.ts` audience/binding resolution (`user/workspace/team/project/task/teamOrUser` targets, `appendToTarget`). Parity with `sse.ts` is asserted by a test. |
| `jobs/index.ts` | `pruneOutbox` → `pruneStream` (prunes by sequencing time regardless of publish state, records `pruned_through_id`); legacy `pruneIdempotencyKeys` kept only for rows written by older versions. |
| `routes/events.ts` (authz-owned, minimal edit) | Replay now iterates `replayEvents(…, { upTo: liveStreamPosition() })` (captured synchronously at registration) instead of one `replaySince` page — drains > 500 events and removes the replay/live duplicate. 3 hunks; see §8. |

### 1.2 Schema — migration `20261026020000_w04b_durable_outbox` (expand-only)

- New `domain_event_outbox` (pending appends) and `domain_event_retention` (single row, `pruned_through_id`, CHECK id = 1).
- `domain_events` + `source_id`, `attempts` (NOT NULL DEFAULT 0, metadata-only), `next_attempt_at`, `lease_owner`, `lease_expires_at`, `last_error`, `dead_lettered_at`.
- Triggers: `domain_events_immutable` (deny-by-default: `to_jsonb(NEW) − bookkeeping ≠ to_jsonb(OLD) − bookkeeping` → `RAISE … ERRCODE 'OLI01'`; only the seven relay bookkeeping columns may change) and `domain_event_outbox_immutable` (no UPDATE at all; DELETE allowed for move/prune).
- No CREATE INDEX, no destructive DDL, `SET LOCAL lock_timeout = '5s'`. CI migration-safety logic passes (run under bash); `prisma migrate diff --from-config-datasource --to-schema` → "No difference detected" on a freshly migrated DB. Partial indexes were rejected because Prisma 7.4 cannot express them (they would show as drift). The old rolling-deploy API only updates `published_at`, which stays writable.

### 1.3 Transactional appends converted (coordinator addendum a)

Event appended inside the write's transaction (`transactionWithEvents` or idempotent command `mutate(tx)`):

- **Tasks** (`services/tasks.ts`): create (command), bulk create (command), `updateTask` (chat), `updateTaskRoute` (PATCH; task update + assignee/watcher sync + event now one transaction — previously three separate steps), `bulkUpdateTaskStatus` (bulk + per-task events), `bulkArchiveTasks`, `bulkDeleteTasks`, `deleteTaskRoute`, `addComment` (chat; comment + notifications + events).
- **Comments** (`routes/comments.ts`): create (+ mention notifications), edit, delete.
- **Projects** (`services/projects.ts`): create (HTTP command; team-conflict 409 now rolls back instead of create-then-delete), create (chat), grant access, bulk grant, revoke (deny).
- **Teams** (`services/teams.ts`): create, join, add member (HTTP + chat invite), change role, remove member, delete team.
- **Workspaces** (`services/workspaces.ts`, `services/members.ts`): create, add member, bulk add, change role (HTTP + chat), remove member, delete workspace.
- Membership changes call `invalidateTenancyCache` synchronously right after commit (or first in `afterCommit`), before the deferred flush can deliver anything. Added invalidations where membership changed without one (team create/join/delete, workspace create/delete, project create).

Remaining post-commit (non-atomic) sites, by file — for the next round:

| File | Sites |
|---|---|
| `apps/api/src/services/projects.ts` | `updateProject` (project:updated), `updateProjectFull` (project:updated), `deleteProject` (project:deleted to workspace/teams/users) |
| `apps/api/src/services/workspaces.ts` | `updateWorkspace`, `updateWorkspaceRoute` (workspace:updated) |
| `apps/api/src/services/teams.ts` | `updateTeam` (team:updated) |
| `apps/api/src/services/labels.ts` | createLabel, updateLabel (label:created/updated) |
| `apps/api/src/routes/labels.ts` | label created/updated/deleted; task label assigned/removed (`broadcastToTaskById`) |
| `apps/api/src/services/activity.ts` | `logActivity` → activity:created (called post-commit by most mutations) |
| `apps/api/src/routes/notifications.ts` | `createNotification` → notification:created (status/assignment notifications) |
| `apps/api/src/routes/settings.ts` | settings:updated |
| `apps/api/src/services/chat.ts` | chat:session:updated (`broadcastToChatSession`) |
| `apps/api/src/routes/agent-runs.ts` | execution:progress (`persistAndDeliver` for the last item; per-item `deliverToLocalClients` with run-journal SSE ids — mixed cursor, A08) |
| `apps/sidecar/src/routes/execution.ts` | task:updated |
| `apps/sidecar/src/services/execution/state.ts` | task events/logs (`broadcastToTask`, `broadcastToTaskById`, hot path) |
| `apps/sidecar/src/services/batch/shared.ts`, `batch/completion.ts` | batch user events, execution:log/progress, task:updated |
| `apps/sidecar/src/services/opencode.ts` | `broadcastToAll` opencode:status — local-only by design, never persisted |

`sse.ts` (authz-owned) keeps its helpers; they now route through the stream (append + flush) instead of insert + inline publish.

### 1.4 Idempotency migration (item 5)

All nine users of the legacy `lib/http.ts` cache now use `respondIdempotently` (W04a service) with commands: `projects.create`, `projects.access.grant`, `projects.access.bulk_grant`, `teams.create`, `teams.join`, `teams.members.add`, `workspaces.create`, `workspaces.members.add`, `workspaces.members.bulk_add`. Authorization runs before replay; `prepare` holds validation and (project create) the GitHub repository connection, skipped on replay; the domain writes, events and the idempotency record commit together. The legacy helpers (`getIdempotencyRecord`/`storeIdempotencyRecord`/`replayIdempotencyRecord`) are deleted; no code reads or writes `idempotency_keys`. The table/model stay (dropping is destructive; contract migration later), and the hourly job still prunes rows written by older versions. Wrapper functions with the old signatures remain for chat tools (`runCommand`/`runCommandWithStatus`).

### 1.5 Principal scoping (item 6) — decision

Keys are scoped **per credential**: session principal = `<userId>` (all of a user's sessions, so refresh/second device keep the scope), each PAT = `<userId>:pat:<tokenId>`, read from the W02a `PrincipalContext` (`req.tenancy`, ALS fallback). Rationale: idempotency keys are a client concept; the desktop session, the MCP worker PAT and a CI PAT are different clients and must neither replay nor conflict with each other's keys, and a PAT must never receive a response stored for another credential. Workspace partition unchanged (resource workspace = binding for bound PATs). No migration needed (same column); W04a records written before this change by PATs are not deployed anywhere. Existing W04a tests (sessions) unaffected.

## 2. Delivery semantics now

Guaranteed (with tests):
- **Atomicity** for converted sites: write and event commit or roll back together (deferred-constraint commit failure test on 19 HTTP sites + keyed create).
- **No loss after commit**: a pending row survives any crash; the sequencer move is one transaction; a claimed row becomes claimable when its lease expires (crash after claim, crash after publish-before-ack).
- **At-least-once publication** to the bus with leases, fenced acks, exponential backoff, dead-letter after `maxAttempts` (log at error + `dead_lettered_at`/`last_error` + `listDeadLetteredEvents`/`requeueDeadLetteredEvents`/`readOutboxHealth`). Two concurrent relays never claim the same row while a lease is valid.
- **Commit-ordered stream ids**: only the sequencer inserts, under a transaction-scoped advisory lock; a reader that saw id N never later sees an id < N.
- **Exactly-once, in-order delivery per process**: consumers drop duplicates by id and fill gaps from the stream (bus loss, reordering, Redis reconnect, dead letters).
- **Lossless ordered replay** > 500 events with bounded pages; restart between pages; filtered stretches never stall; truncation by retention is detectable.
- **Exactly-once across the replay/live boundary** at connect (route uses the consumer position).
- **Immutability** of event columns, enforced by the database.

Not guaranteed / known limits:
- The ~20 remaining post-commit sites (§1.3) are still non-atomic (crash between commit and append loses that event).
- Ordering across *different* transactions follows sequencing time; conflicting writes order correctly only when the append follows the write (documented rule in `outbox.ts`).
- Live events arriving while a connecting stream's replay is still being written can interleave before older replayed rows (no loss; can cause a duplicate on a later reconnect). Needs a hub-side hold during replay (authz-owned files).
- A client killed every few pages inside a long run of events it may not see rescans that run on reconnect; the route can fix this by emitting `id: <nextCursor>` checkpoints (test covers both client models).
- Truncation is detectable (`isReplayTruncated`) but the route does not yet tell the client to resync.
- During a rolling deploy, old API instances still insert into `domain_events` directly; ordering guarantees apply once all instances run this version.
- `agent_run_events` (run journal) still allows payload overwrite via upsert in `routes/agent-runs.ts` (not owned; W06).

## 3. Client-visible behaviour changes

- `Idempotency-Key` on the nine migrated routes now follows the W04a contract: malformed keys (<8, >128 chars, spaces, repeated header) → `400 IDEMPOTENCY_KEY_INVALID` (legacy accepted anything); same key + different request → `409 IDEMPOTENCY_CONFLICT` (legacy replayed the unrelated response); concurrent duplicate waits then replays, or `409 IDEMPOTENCY_IN_PROGRESS` + `Retry-After: 1`; retention 24 h (legacy 1 h); replay is byte-identical with `Idempotency-Replayed: true`. Keys are per credential (session vs each PAT) and per workspace + operation, so reusing one key for two different resources in the same workspace now conflicts (legacy keyed per route path). No in-repo client sends the header on these routes.
- `POST /api/teams/join` replay returns the stored 200 instead of `409 ALREADY_MEMBER`.
- `POST /api/projects` with a team owned by another project: still 409, but nothing is created at all (no transient project/labels/default team).
- SSE: Last-Event-ID replay now drains all missed events (previously ≤ 200 rows, stalling on filtered pages); events emitted when the outbox write fails carry no `id:` (previously `id: 0`, which made the next reconnect replay from the beginning); stream ids remain the `domain_events.id` sequence (no renumbering).
- Events that previously were best-effort post-commit now fail the request (500) if the event cannot be written — the write is rolled back instead of committing silently without its event.
- Cross-process delivery without Redis now works (consumers poll the stream every 500 ms; previously a worker/sidecar-published event never reached API clients).

## 4. Operations

### 4.1 Env switches
| Var | Default | Meaning |
|---|---|---|
| `OPENLINEAR_OUTBOX_RELAY` | `api` | Role owning the periodic relay: `api`, `worker`, or `off`/`0` (per-process opt-out, legacy). Set the same value in every container. |
| `OPENLINEAR_PROCESS_ROLE` | — | `api`/`worker`, used when `startRealtime` is not given a role (else entry file `worker.ts|js` → worker, else api). |
| `OPENLINEAR_OUTBOX_FAST_FLUSH` | on | Post-commit sequencing in the committing process. `0` → events wait for the owner relay (≤ relay interval). Consider `0` for any sidecar that still has DB access (avoids sidecars contending for the global sequencer lock). |
| `OPENLINEAR_OUTBOX_POLL_MS` | 500 (no Redis) / 2000 (Redis) | Stream catch-up poll in API processes. |
| `OPENLINEAR_OUTBOX_RELAY_INTERVAL_MS`, `_MAX_ATTEMPTS` (8), `_LEASE_MS` (30 000), `_BATCH_SIZE` (200) | | Relay tuning. |
| `OPENLINEAR_OUTBOX=0` | | Unchanged: local-only delivery, nothing persisted. |

### 4.2 Wiring needed in files I do not own (ship engineer)
- `apps/api/src/worker.ts`: `await startRealtime({ role: 'worker' })`; on shutdown `stopRealtime()` before `stopEventBus()`. Today the role is inferred from the entry file name, so the unchanged worker already does **not** run the relay while `OPENLINEAR_OUTBOX_RELAY` is unset/`api` — exactly one owner (the API) without any edit.
- `apps/api/src/index.ts`: `startRealtime({ role: 'api' })`; shutdown `stopRealtime()` (replaces `stopOutboxRelay()`; both exist).
- When the worker is deployed: set `OPENLINEAR_OUTBOX_RELAY=worker` in **both** API and worker containers. Multiple replicas of the owner role are safe (leases + advisory lock) and share the work.
- Worker processes no longer subscribe to the bus or poll the stream (no SSE clients there).

### 4.3 Cross-replica fan-out (items 4, d)
A Redis implementation existed; it is now correct and tested with an in-memory fake (no Redis server used, none running locally). The DB stream is the source of truth; Redis is a latency accelerator. Without Redis, every API replica still receives every event via the stream poll (≤ 500 ms). **Single channel `ol:domain-events` kept**, consumer-side filtering (the hub authorizes every stream against the event binding). Per-workspace channels are not needed now and would break global gap detection (each channel would see only a subsequence of the one total order; the consumer could no longer tell a gap from another workspace's event without per-workspace sequences). Revisit when per-replica fan-in (messages/s × `canReceiveEvent` cost) is measured to be a bottleneck; then shard with per-shard sequences. No infrastructure added.

## 5. Tests added (71; all real PostgreSQL)

| File | Tests | Proves |
|---|---|---|
| `outbox.relay.test.ts` | 20 | tx rollback → no event; append order; commit-order ids (deterministic held-tx case + 6×16 concurrent stress); sequencer serialization (held lock blocks a second sequencer, short lock timeout fails cleanly); sequencer failure mid-batch rolls back and retries without loss/dup; DB immutability (Prisma model update and raw UPDATE of 7 columns → OLI01; bookkeeping allowed; pending rows immutable); two concurrent relays (300 events, each published once, disjoint claims, all acked); crash after claim (lease expiry → rescue); crash before ack (republish, consumer drops dup); fencing (stale relay's ack changes nothing); transient failure → backoff → success; poison → dead-letter after 3 attempts (+ log, query, still in stream, requeue); permanent error → immediate DLQ; relay sequences then publishes; consumer exactly-once/in-order with drops, duplicates, reordering; consumer starts at head; ownership config; `startRealtime` ownership by role. |
| `outbox.bus.test.ts` | 2 | Two replicas over fake Redis: exactly-once in order through 2 publish failures (retry), a subscriber outage (resync on `ready` recovers), duplicate publication; oversized → `PermanentPublishError`; malformed/zero-id/other-channel messages dropped; one connection under concurrent callers. |
| `outbox.replay.test.ts` | 6 | > 500 events lossless + ordered with 50/120 bounds; page bounds + fully filtered pages advance (and `replaySince` no longer stalls); restart between pages with concurrent writes (two client models); truncation watermark; real SSE: 700 missed events replayed in order + 3 later events live exactly once. |
| `outbox.idempotency.test.ts` | 22 | Per migrated endpoint (9): burst of 8 → 1 execution, 7 byte-identical replays, 1 event, 1 record, later retry replays, different body → 409 CONFLICT; per endpoint: in-progress → 409 + Retry-After; malformed keys → 400; unkeyed unchanged; session vs PAT vs second PAT scopes; refreshed JWT shares the session scope; bound PAT records its workspace. |
| `outbox.transactional.test.ts` | 21 | 19 HTTP sites: injected commit failure → 5xx, domain state unchanged, no event; then success with an event sequenced from the outbox; keyed create rollback leaves no record and the retry executes; `targets.ts` ≡ `sse.ts` bindings (project, team, project task, team-only task, user, workspace). |

Mutation checks (temporary edits, restored and verified): removing the sequencer advisory lock fails the serialization test (the stress test alone does not catch it — window too small — hence the deterministic test); removing the lease filter from the claim fails the two-relay and crash tests (events published 3–7×); disabling bus resync fails the outage case; dropping the route's live boundary yields 703 frames instead of 700; routing `POST /api/teams` around `respondIdempotently` fails the burst (7× unique violation); reverting comment edit to post-commit emission fails its rollback test (200 + committed edit).

## 6. Validation (local, private DB `openlinear_outbox_test` on 127.0.0.1:54330, recreated from scratch before the final runs)

| Command | Result |
|---|---|
| `DATABASE_URL=…/openlinear_outbox_test prisma migrate deploy` (fresh DB) | all 20 migrations applied |
| `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` | No difference detected |
| CI migration-safety logic (bash) on the new migration | FAIL=0 |
| `pnpm exec turbo run typecheck --force` | 11/11 successful, 0 cached |
| `pnpm lint` | 51 files, no findings (5 new test files added to the root list) |
| `TEST_DATABASE_URL=… pnpm --filter @openlinear/api test` | **36 files, 357 passed, 2 skipped** (baseline 286 + 71 new) — final green run; see flakes below |
| `pnpm --filter @openlinear/sidecar test` | 38 files, 661 passed |
| `TEST_DATABASE_URL=… pnpm --filter @openlinear/sidecar test:integration` | 26 passed |
| `git diff --check` | clean |

Flakes (decided pre-existing/environmental, not regressions): across 12 full runs with these changes on this shared machine (4 fully green), intermittent `socket hang up` in `route-inventory.test.ts` (6 runs) (supertest opens one ephemeral server per request; TIME_WAIT reached ~7 800 of 16 383 ports) and three isolated spurious 401s on session-JWT requests (`events.access`, `workspaces.members`, `idempotency` "authorizes before replaying"); every one passes when rerun alone. Evidence: the **base tree** (`git archive 0a41ea8b`, same DB) shows the same symptoms — route-inventory failed 2 of 12 isolated runs (`expected [Array(1)] to deeply equal []`, as on mine) and its full suite failed 1 of 3 runs with `socket hang up` in `idempotency.test.ts` and `route-inventory.test.ts`; the failing route-inventory probes are rejected by the auth middleware before any changed code runs; a temporary diagnostic in the fail-closed session lookup (reverted byte-identically) logged no DB errors in two full runs.

Note: one scratch database (`openlinear_outbox_scratch_test`) was created for ~1 minute to confirm Prisma 7.4 runs `CREATE INDEX CONCURRENTLY` migrations, then dropped. No other database was touched.

## 7. Left, and why

1. Remaining post-commit emission sites (§1.3 table) — next round; mechanical with `transactionWithEvents` + `targets.ts`.
2. `sse.ts` should delegate to `events/targets.ts` (single binding implementation) — authz-owned file.
3. Route-level: hold live events during replay; emit `id:` cursor checkpoints after filtered pages; send a resync signal when `isReplayTruncated` — `routes/events.ts`/`hub.ts` are authz-owned; storage support is in place.
4. Execute/cancel idempotency (needs W05 operation record); `api-client`/MCP sending keys (W04a remainder 4).
5. Contract migration dropping `idempotency_keys` + `pruneIdempotencyKeys` after one release.
6. `agent_run_events` immutability (upsert overwrites payload) — `routes/agent-runs.ts` not owned; fix: `createMany({ skipDuplicates })` + 409 on a differing payload, plus a trigger like `domain_events_immutable`.
7. Register outbox prune/relay health in pg-boss once the single-scheduler fix lands; metrics/alerts on `readOutboxHealth` (pending age, unpublished, dead letters).
8. If dead letters accumulate, add `(published_at, dead_lettered_at, id)` index CONCURRENTLY (claim scan currently filters them).

## 8. Merge hazards

- `apps/api/src/routes/events.ts` (authz-owned): import line (`replaySince` → `replayEvents`, `liveStreamPosition`), `const liveBoundary = liveStreamPosition();` right after `registerClient(client)`, and the replay block (`for await … replayEvents(…, { upTo: liveBoundary })`). If the authz engineer rewrote the replay loop, keep their loop but feed it `readReplayPage`/`replayEvents` with `upTo` captured synchronously at registration.
- `replaySince` semantics changed (pages past filtered rows, no `publishedAt` filter); `PersistedDomainEvent` gained optional `sourceId`; `EventBus.publish` now returns `Promise<void>` and throws; `MemoryBus.publish` dispatches to subscribers.
- Services edited heavily: `services/{tasks,projects,teams,workspaces,members,idempotency}.ts`, `routes/{projects,teams,workspaces,comments}.ts`, `lib/http.ts` (legacy helpers removed). Anyone touching these functions should keep appends inside the transaction.
- `packages/db/prisma/schema.prisma` (DomainEvent fields, two models, IdempotencyKey comment) and the new migration folder `20261026020000_w04b_durable_outbox`.
- Root `package.json` lint list (5 test files appended at the end of the line).
- `events/targets.ts` duplicates `sse.ts` binding logic; a parity test fails if they diverge.
- Process wiring for `index.ts`/`worker.ts` is described in §4.2, not edited.
