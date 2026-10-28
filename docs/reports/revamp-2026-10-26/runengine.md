# W05a/W06a — one durable run service for single-task execution (engineer: runengine)

Date: 2026-10-26 (round 3). Base: `922dbd7` + `round3-base.patch` (tree `a7c4d7e8…`).
Owner constraint honoured: local work only — no deployment, no cloud operation, no paid inference (FakeRunner-style runtime and a stub OpenCode server only). Nothing committed.

## 1. Outcome

| Priority | Status |
|---|---|
| 1. Contract (state machine, journal + effect ledger, recovery policy) | **Done** — `packages/execution-core/src/run-contract.ts` (pure, 16 tests) and §2–§4 below |
| 2. Run service (sidecar) | **Done** — `apps/sidecar/src/run/service.ts` over the SQLite journal `apps/sidecar/src/journal/durable.ts` |
| 3. Recovery (reattach / reconcile / fence, capability renewal) | **Done** — reattach to the surviving runtime with the journaled endpoint, never re-prompting; publication effects reconciled; renewal both sides |
| 4. Control-plane sweeper | **Done** — `apps/api/src/services/execution-sweeper.ts`, job `execution-lease-sweep` under `OPENLINEAR_JOBS_RUNNER` |
| 5. Wiring behind `OPENLINEAR_RUN_ENGINE=v2` (default legacy) + `SANDBOX_UNAVAILABLE` → 503 | **Done** |
| 6. Acceptance tests (a)–(d) | **Done** — real API + real sidecar child process SIGKILLed at 3 kill points + sweeper fence (`run-engine.e2e.test.ts`, 5 tests), plus 35 service-level tests incl. fault injection at every await point |

PRD gates touched: W05 (exhaustive actions, durable acceptance, pending counted, queue cancellation + fair refill, no reservation leak after every injected await failure, one terminal transition), W06 (SQLite atomicity, persisted acknowledged cursor, outage retry without new events, ≤ 50 per ingest batch, bounded backlog, SIGKILL restart replays every unacked event, redacted payloads), W12 core (cancel in every state, SIGKILL recovery attaches without prompt duplication, dead sidecar handled honestly). W05a/W06a are accepted as **one joint slice** per the PRD review unit 6; real native adapters (W07a) and the W11 verification pipeline are not part of it.

## 2. Contract — run/attempt state machine

```
queued ─► preparing ─► running ⇄ awaiting_approval
   │          │          │   ⇄ compacting
   │          │          ▼
   │          │       finishing ─► succeeded
   ▼          ▼          ▼            
 cancelled / failed / abandoned (any live state) · recovery_required (running…finishing)
```

| State | Meaning | Control-plane attempt (W03a enum) |
|---|---|---|
| `queued` | authorized + capability issued, waiting for a local slot; heartbeats keep the lease | `preparing` |
| `preparing` | credential, workspace, runtime session, claim; task row untouched until the claim | `preparing` (→ `running` at claim) |
| `running` / `awaiting_approval` / `compacting` | the agent turn; prompt possibly submitted from the transition into `running` on | `running` |
| `finishing` | publication: commit → push → PR | `running` (→ `finishing` once the terminal is written) |
| `succeeded` | PR confirmed and the `done` projection written | `finishing` → `closed` |
| `failed` | setup failure, agent error, stream EOF without result, no changes, publication failure, watchdog/budget | any → `closed`/`released` |
| `cancelled` | stopped on request **with a positive provider stop receipt** | → `closed`/`released` |
| `recovery_required` | after a restart the agent's fate is unknown (runtime gone); work retained, never auto-published | → `closed` |
| `abandoned` | this sidecar lost authority (capability revoked/expired, attempt closed by the sweeper); fenced, writes nothing | already `closed`/`released` |

Rules (enforced by `DurableRunJournal.transition`, compare-and-set on `state_version`): terminal states have no outgoing edge; `succeeded` is reachable only from `finishing`; a terminal transition must carry exactly one terminal decision (`terminal_json`); no state re-enters setup after the agent ran. `LEGACY_PROGRESS_STATUS` maps every state to the progress status the current UI understands (`queued`, `cloning`, `executing`, `committing`, `done`, `error`, `cancelled`).

## 3. Journal (W06a) — `apps/sidecar/src/journal/durable.ts`

File `<app data>/journal/runs-v2.sqlite` (the legacy prototype journal keeps `runs.sqlite`), mode 0600 in a 0700 directory inside the app-data root the W09a sandbox denies to agents. `node:sqlite`, WAL, `synchronous=FULL`, every write a `BEGIN IMMEDIATE` transaction → a returned call survives SIGKILL (proved by a test that SIGKILLs a writer process and reopens).

| Table | Content |
|---|---|
| `run_attempts` | run id, task/user, control-plane attempt id **+ capability token + expiry**, runner/model, state + version, task snapshot (no secrets), workspace (worktree, branch, owned handle), runtime endpoint (base URL, directory, per-attempt server authorization, sandbox mode), provider session id, cancel request, terminal decision, `last_seq`, **`relay_ack_seq`** (control plane's acknowledged cursor), usage (per-message totals), counters, owning boot id |
| `run_attempt_events` | `(run_id, seq)` gap-free, append-only (an UPDATE trigger aborts), kind ∈ `run.accepted · run.state · agent · log · progress · effect · recovery`, `relay` flag |
| `run_effects` | the effect ledger: `(run_id, key)`, kind, `pending → confirmed / failed`, intent, receipt, dispatch count |
| `journal_meta` | schema version; **single owner** `{pid, bootId}` — a second live sidecar process on the same app data gets `503 RUN_JOURNAL_LOCKED`, a dead owner is replaced |

JSON columns are zod-validated on read (`JournalCorruptError` instead of driving an effect from a corrupt row). Bounds: 20 000 events per run (beyond: only critical events — state, effects, errors, terminal — are kept; drops counted), 32 KB per payload (truncated to valid JSON), agent output redacted with the sidecar's secret patterns before it is journaled or relayed, text deltas coalesced (≤ 4 KB) into log entries. Retention: finished runs with nothing pending are pruned after 14 days at boot.

## 4. Effect ledger

Every effect is journaled (`pending`) in the same transaction as the state it belongs to, **before** dispatch, and settled with its receipt after. `pending` means "possibly dispatched".

| Effect | Key | Journaled | Receipt | Recovery of a `pending` effect (`EFFECT_RECOVERY`) |
|---|---|---|---|---|
| `attempt.claim` | `<run>:attempt.claim` | before `POST …/claim` | `{agentRunId}` | heartbeat status: `running` = claimed. Setup is not resumed: the run fails; a possibly-landed claim is projected (a refused projection is harmless, a missing one would leave the task stuck) |
| `prompt.submit` | `<run>:prompt.submit` | **in the `preparing → running` transaction**, before the event stream (which submits) is pulled | first runtime event after `session.started` | **never resubmitted**: runtime probe busy → reattach, idle → finish, idle-error → fail, gone/unreachable → `recovery_required` |
| `git.commit` | `<run>:git.commit` | before staging/commit | `{sha}` or `{no_changes}` | the commit message carries `OpenLinear-Effect: <key>`; HEAD with the trailer is the receipt, else commit once |
| `git.push` | `<run>:git.push:<sha>` | before `ls-remote`/push | `{sha}` | `ls-remote` shows the branch at the sha → confirmed; absent → push again (absent-target lease; same commit is a no-op); moved by someone else → definitive failure, never clobbered |
| `pr.create` | `<run>:pr.create:<branch>` | before lookup/POST | `{url}` | open PR for the branch → reused; else the W01 POST-then-reconcile path (a POST is never blindly retried) |
| `cancel.ack` | `<run>:cancel.ack` | with the `cancelled` decision | — | idempotent resend |
| `task.terminal` | `<run>:task.terminal:<done\|cancelled>` | with the terminal decision | `{repeated}` | idempotent resend; `TASK_FENCE_REJECTED` / `ATTEMPT_TERMINAL_CONFLICT` are definitive |
| `run.finalize` | `<run>:run.finalize:<status>` | with the terminal decision | `{finalized}` | idempotent (`updateMany where running`) |
| `attempt.close` | `<run>:attempt.close` | with the terminal decision | `{status, closeReason}` | idempotent; relay is flushed and the log snapshot persisted first |

The terminal decision and its control-plane projection effects commit together; projection retries with backoff while the API is unreachable (the local slot is already released); authority loss settles the remaining projections as failed (fenced). Local effects still pending at a terminal decision are settled `failed {unreconciled: true}` (the outcome says the work is retained).

## 5. Run service — `apps/sidecar/src/run/`

| File | Role |
|---|---|
| `service.ts` | admission, drive, pump, exhaustive reducer interpreter, publication, terminal decision + projection, relay, heartbeat/renewal, cancellation, recovery |
| `control-plane.ts` | the W03a `/api/executions` surface the service needs; capability-only channels re-creatable from the journal; error classification (`isAuthorityLost`, `isTransientControlError`) |
| `runtime.ts`, `opencode-runtime.ts` | `RunRuntime` = `AgentRunner.start` + `inspect` / `attach` (stream only, no prompt) / `abort` (positive receipt) / `release`. OpenCode: the existing `OpenCodeRunner` for start (W09a routing), journaled endpoint captured from the SDK client (`describeOpenCodeClient`, runtime-checked), `decodeOpenCodeEvent` reused for attach |
| `publication.ts`, `workspace.ts` | split git/GitHub effects; owned worktree `<repos>/worktrees/<runId>` on `openlinear/<runId>` (deterministic → recoverable) |
| `faults.ts` | named await points; test-only crash points (`OPENLINEAR_RUN_ENGINE_CRASH_AT`, honoured only with `NODE_ENV=test`) |
| `engine-mode.ts`, `index.ts` | flag, lazy production wiring, single-owner journal claim, boot recovery |
| `test-support.ts` | in-memory control plane with W03a fences + sweeper, out-of-process runtime host, fake publication/workspace |

Drive of a fresh run: `submit` reserves the task synchronously → `POST /attempts` (authorization; 401/403/404/409/503 pass through) → runner check → admission (`admitRunRequest`: pending work counts; a newcomer never overtakes the queue; bounded queue of 10 → `400 PARALLEL_LIMIT_REACHED`) → **`journal.createRun` (durable acceptance)** → heartbeat → `preparing`: model preflight, clone credential, workspace (journaled), runtime start (endpoint + session journaled), claim effect → `running` + prompt intent → execute answers `200 {runId, attemptId, state}` (or `202` queued) → pump → `finishing` → publication effects → terminal decision → projection → slot released and queue refilled.

- **Events.** Each runner event is journaled (seq) before interpretation; derived log/progress events are journaled, then delivered to local SSE (`execution:log` / `execution:progress` with `runId` + `runSeq`), then relayed. The relay sends unacknowledged journal events in order (≤ 50 per request, one in flight per run, backoff on outage, no new events created by retries), using the journal sequence as the W03a `(attempt, seq)` key, and persists the acknowledged cursor. After a restart it continues from `relay_ack_seq`.
- **Reducer actions** — all 20 `AgentAction` types handled in one `switch` with a `never` check (`ignore, log, broadcastProgress, flushDeltaBuffer, appendTextDelta, appendReasoningDelta, markThinking, setPromptSent, incrementFilesChanged, noteToolCompleted, resetEventStreamTimeout, handleSessionComplete, failExecution, sessionError, replyPermission, suspendWatchdog, resumeWatchdog, recordUsage, checkpointThenStop, touchHeartbeat`). Permission requests → `awaiting_approval`, answered by policy (default allow, the legacy OpenCode config's behaviour), approval deadline 10 min; compaction → `compacting`.
- **Watchdogs** — transport / no-progress / wall-clock / token / USD budgets from `engine/watchdogs.ts`, suspended during approval and compaction; a trip stops the agent (interrupt → grace → abort) and fails the run with the work retained. End of stream without a result is a failure.
- **Exactly one terminal / no leak** — all decisions go through `decide()` (journal CAS); the slot and reservation are released in the drive's `finally`; a drive that somehow ends undecided is failed defensively.
- **Cancellation** — queued: dequeued, attempt released, task untouched. preparing: controller aborted, setup stops at the next checkpoint, attempt released (or, if the claim landed, the cancelled projection). running/approval/compacting: interrupt → grace → abort with a **positive receipt**; without it the run stays reserved and the caller gets `Cancellation could not be confirmed; execution remains reserved` (W01 semantics). finishing: no new publication effect is dispatched; one already dispatched is reported in the outcome (`branch already pushed` / `pull request already created: …`), never rolled back, and the run is `cancelled`, never quietly `succeeded`. A cancellation requested through the control plane (heartbeat/relay `cancelRequested`) runs the same path.
- **Capability renewal** — heartbeat reports `capabilityExpiresAt`; < 30 min left → `POST …/renew`; the new token is journaled **before** it is used. Authority loss (401, attempt closed/released) at any time → `abandoned`, the agent is stopped, nothing is written.

### Fault injection (W05 "every injected await failure")

`service.test.ts` first records every `before:`/`after:` await point a happy run passes (30+: control start, accepted, preparation steps, each effect's dispatch/receipt, pump pulls, prompt confirmation, publication credential, projection dispatch/receipt, relay sends), then for **each** point runs a fresh scenario that throws there once and asserts: no reservation or slot held, exactly one terminal `run.state` event, gap-free sequence, the control-plane task not left `in_progress`, attempt `closed`/`released`, and `done` only if the run really succeeded. A failure *after* `control:start` (lost response) holds nothing locally and leaves an unclaimed attempt the sweeper releases.

## 6. Recovery matrix (`decideRunRecovery`, after the control-plane heartbeat and, when needed, a runtime probe)

| Journaled state | Control plane | Prompt effect | Runtime probe | Decision | Action |
|---|---|---|---|---|---|
| terminal | any | — | — | terminalize | re-drive pending projections; flush unrelayed events |
| live | unreachable | — | — | wait | keep reservation, retry with backoff (≤ 60 s), decide nothing |
| live | lost (401 / closed / released) | — | — | abandon | abort the orphan session (best effort), terminal `abandoned`, no writes |
| live | active, cancel requested (local or cloud) | — | — | cancel | abort with receipt → `cancelled` (+ ack); no receipt → `recovery_required` |
| `queued` / `preparing` | active | — | — | fail | abort session if any; release (or project, if claimed) |
| `running`… | active | absent | — | fail | the prompt never went out; project the failure |
| `running`… | active | pending/confirmed | busy | **reattach** | subscribe to the session's event stream with the journaled endpoint — no prompt; re-probe after subscribing in case the turn ended in between |
| `running`… | active | pending/confirmed | idle | finish | publication |
| `running`… | active | pending/confirmed | idle-error | fail | |
| `running`… | active | pending/confirmed | missing / unreachable | recovery_required | task released (`cancelled`, outcome "Agent state unknown after a sidecar restart …; work retained on <branch> at <path>"), run `failed` |
| `finishing` | active | — | — | resume-finishing | each publication effect reconciled first (trailer / remote ref / PR lookup), then the rest dispatched |

Recovery starts in the background from the existing boot hook (`recoverInFlightExecutions` → `startRunEngineRecoveryInBackground`), before OpenCode is initialized (reattach uses the journaled endpoint, not a new server). The legacy prototype recovery now passes the worktree path to its runner probe (W09a leftover).

**Sandbox note.** In `enforce` mode the per-attempt server's egress proxy lives in the sidecar process (and bubblewrap uses `--die-with-parent`), so after a sidecar crash the orphan server is either gone (Linux) or cannot reach its model (macOS): recovery then lands in `recovery_required` (or `failed` if the turn errored), honestly. Full live reattach is proven with the trusted-host shared server (which survives with its own network). Persisting/adopting attempt servers across restarts is a W09/W12 item.

## 7. Control plane (apps/api)

- **Migration `20261026080000_runengine_attempt_leases`** (additive): `execution_attempts.recoveryState` (CHECK `recovery_required|abandoned`), `sweptAt`, `renewedAt`, `renewals` (CHECK ≥ 0); constraints added `NOT VALID` then validated; `lock_timeout 5s`; no index (the sweeper uses `(status, heartbeatAt)`), no destructive DDL. `schema.prisma` in sync: `prisma migrate diff --from-migrations … --to-schema … --exit-code` with a shadow DB → *No difference detected*; migration-safety patterns: no match.
- **`POST /api/executions/attempts/:attemptId/renew`** (capability `execution:status`, never PAT-callable; registry row via `attemptCallback`): active attempt, lease fresh (`OPENLINEAR_ATTEMPT_LEASE_MS`, default 5 min), lifetime ≤ `OPENLINEAR_ATTEMPT_MAX_LIFETIME_MS` (default 24 h), initiator re-authorized; mints a new capability (TTL 2 h, capped by the lifetime) and shortens the presented one to a 5-min grace (a lost response can be retried); `409 ATTEMPT_LEASE_EXPIRED` / `ATTEMPT_LIFETIME_EXCEEDED`, `403 EXECUTION_ACCESS_REVOKED`.
- **Sweeper** `sweepLostExecutionAttempts({leaseMs, now, limit})`, one row lock per attempt, heartbeat re-checked under the lock (a heartbeat that lands first wins), events appended in the same transaction (W04b):

| Attempt | Sweeper action | Task |
|---|---|---|
| `preparing` | `released`, `sidecar_lost`, recoveryState `abandoned`, capabilities revoked | untouched |
| `running`, task still bound (W01 fence: in_progress + session + project/team/creator) | `closed`, `sidecar_lost`, recoveryState `recovery_required`, terminalStatus `cancelled`, AgentRun `failed`, capabilities revoked; `task:updated` + `execution:progress {status:error, reason:sidecar_lost, runState:recovery_required}` | → `cancelled`, `sessionId null`, outcome "Execution lost: the local agent runner stopped responding … run the task again to retry" |
| `running`, task owned by a replacement | `closed`, recoveryState `abandoned` | untouched |
| `finishing` | `closed`, `sidecar_lost_after_terminal`, AgentRun finalized from the recorded projection | untouched |

  A sidecar that comes back is triple-fenced: revoked capability (401 on every callback), attempt `closed` (state conflicts), task `sessionId` cleared (W01 terminal fence).
- **Job**: `JOB_NAMES.executionLeaseSweep = 'execution-lease-sweep'` — pg-boss cron `* * * * *`, or a 60 s timer in the interval loop; runs only in the process `OPENLINEAR_JOBS_RUNNER` selects.

## 8. Flag and wiring

`OPENLINEAR_RUN_ENGINE`: unset/`legacy` (default) → unchanged W01/W03a path; `v2` → run service, **only in API persistence mode** (otherwise logged fallback to legacy). Sidecar routes (`routes/execution.ts`):

| Route | v2 behaviour |
|---|---|
| `POST /api/tasks/:id/execute` | `200 {message:'Task execution started', runId, attemptId, state}` once claimed and the prompt is journaled; `202 {message:'Task execution queued', …, state:'queued'}`; setup errors keep their status (`503 SANDBOX_UNAVAILABLE`, `400 MODEL_NOT_CONFIGURED`, `400 RUNNER_NOT_SUPPORTED`, control-plane 401/403/404/409/503) |
| `GET /:id/running`, `GET /:id/logs`, `POST /:id/cancel` | consult the run service (owner shortcut, else control-plane authorization as before); cancel `200` / `400` / `202 Cancellation is still in progress` |
| `GET /:id/run` (new, sidecar-local) | run-state contract (below); `404 RUN_NOT_FOUND` |

Legacy execute now maps `SANDBOX_UNAVAILABLE` and `SANDBOX_START_FAILED` to **503** (was 400).

## 9. Acceptance evidence

**End to end** (`apps/api/src/__tests__/run-engine.e2e.test.ts`, 5 tests, all green; real API app + test DB, sidecar child via `tsx src/index.ts` with `OPENLINEAR_RUN_ENGINE=v2` and no DB/secrets, stub OpenCode `fixtures/opencode-stub-durable.mjs` spawned detached by the sidecar so it **outlives** the SIGKILL, loopback GitHub stub tracking PRs per branch, local bare origin, explicit trusted-host grant). Five sidecar processes in sequence on one app-data dir:

| # | Kill point | Proven |
|---|---|---|
| (a) | — | start → events → done: journal effects all confirmed; task `done` + PR; attempt closed, run succeeded, capabilities revoked; prompt count 1; journal seq gap-free; one terminal; `relay_ack_seq` = control plane `lastEventSeq` = last relayable seq; **#domain events for the task = #relayable journal events** |
| (b1) | **external SIGKILL after prompt dispatch** (agent busy, some events already relayed) | restart → recovery decision `reattach` → new stream on the surviving runtime → release → `done`; **prompt count still 1**, 0 aborts, sequence continuity and exact event delivery as in (a), one terminal |
| (b2) | **crash point after the commit receipt, before the push**; then on restart **crash point after the push dispatch, before its receipt** | 2nd process resumes publication with the journaled commit and dies after pushing; 3rd process reconciles the push from the remote ref (`receipt.reconciled`, dispatches 1) → PR → `done`; exactly **one commit** (with the effect trailer) on the branch, **one PR POST**, one terminal, prompt count 1 |
| (c) | **external SIGKILL, sidecar not restarted in time** | lease aged → `sweepLostExecutionAttempts` → task `cancelled`/released, attempt `closed`/`recovery_required`; restarted sidecar → heartbeat 401 → run `abandoned`, task row **byte-for-byte untouched** (same `updatedAt`), orphan session aborted, user can start a new attempt immediately |
| (d) | — | cancel of a running v2 run → `cancelled`, stop receipt (`cancelAcknowledgedAt`), AgentRun `cancelled` |

**Service level** (`apps/sidecar/src/run/service.test.ts`, 35 tests): happy path; local double-execute refused; every reducer action incl. approval/compaction transitions and redaction; agent error and EOF failures; no-changes failure; sandbox-unavailable 503 with workspace released; unsupported runner; **fault injection at every await point**; cancel in queued / preparing / running (+ unconfirmed stop keeps the reservation) / finishing (+ PR-after-cancel reported) / via control plane; in-process crash + restart at: after prompt dispatch, after commit receipt, after commit dispatch (trailer receipt), after push dispatch (remote-ref receipt), after PR dispatch (PR reused), after terminal dispatch (projected once), turn finished while down, runtime gone (`recovery_required`), swept while down (`abandoned`, orphan aborted), control plane unreachable at restart (wait, then reattach), cancel recorded while recovery waits and applied once the control plane is back, crash during setup, cancel requested while down; capability renewal journaled before use; live fencing by the sweeper; 120 events journaled offline then relayed with no duplicates/loss; no-progress watchdog.

**Journal** (`durable.test.ts`, 14): atomic rollback, CAS, one terminal, immutable/gap-free events, settle-once receipts, monotonic persisted cursor, **SIGKILLed writer process** (all 202 events, cursor 120, pending effect present after reopen; 81 unacked events replayed), bounds, truncation, retention, corruption detection, single owner. **Control plane** (`executions.sweeper.test.ts`, 12): every sweeper row above, returning-sidecar fence on 7 callbacks, fresh heartbeat untouched, replacement attempt untouched, concurrent sweeps fence once, heartbeat-before-lock wins, renewal rotation/grace/close, lapsed lease, lifetime, revoked PAT, capability-only. Plus runtime (7, loopback OpenCode stand-in), control-plane client + fault hooks (6), real-git publication (2), route wiring (6), contract (16).

## 10. Validation (this worktree; private DBs `openlinear_runengine_test`, `openlinear_runengine_int_test`, `openlinear_runengine_shadow_test` on 127.0.0.1:54330)

| Check | Result |
|---|---|
| `pnpm typecheck --force` (root) | 10/10 tasks, 0 cached |
| `pnpm lint` | 185 files, clean (9 paths added to the list) |
| `pnpm --filter @openlinear/api test` (migrated `openlinear_runengine_test`) | 56 files, **618 passed + 2 skipped** (baseline 601 + 2; +12 sweeper/renewal, +5 e2e) |
| `pnpm --filter @openlinear/sidecar test` | 53 files, **833 passed + 1 skipped** (baseline 763 + 1; +70) |
| `pnpm --filter @openlinear/sidecar test:integration` (`openlinear_runengine_int_test`) | 26 passed |
| `pnpm --filter @openlinear/execution-core test` | 44 passed (baseline 28; +16) |
| `prisma migrate deploy` (both private DBs) + `migrate diff --from-migrations --to-schema --exit-code` (shadow DB) | applied; *No difference detected* |
| migration-safety patterns on the new migration | no destructive DDL, no CREATE INDEX |
| `node esbuild.config.js --packaged` (sidecar) | 330 inputs, no Prisma, no `@openlinear/api` |
| W03a e2e stability | the legacy e2e failed once in one full run (`executionLogs` empty on the first row seen as `done`: the legacy path persists logs *after* the terminal write and the test reads the first `done` row — a pre-existing race), then 3/3 green on rerun and green in the final full run |

Baseline on this base before my changes: API 600 passed / 1 failed / 2 skipped (load flakes: `idempotency` 20 s timeout, W03a e2e `afterAll` 60 s hook timeout), sidecar 761 passed / 2 failed / 1 skipped (load flakes: two real-git timeouts) — all four pass on re-run and are timing, not regressions.

## 11. What is still legacy

- Default execution is still the legacy lifecycle/events path (flag off). Under v2, only **single-task** execution in **API mode** with the **OpenCode** runner runs on the new service; batches (501 in API mode), Prisma/`--with-cloud-api` mode, and Codex/Claude Code (`RUNNER_NOT_SUPPORTED` until a `RunRuntime` with inspect/attach/abort exists for them) are not migrated.
- `engine/run-coordinator.ts` and `engine/session-manager.ts` (the old unwired prototypes) are untouched and unused by v2; the v2 service supersedes them (remove after the batch migration, W13).
- Publication is the W01 publication (commit/push/PR) split into effects — not yet the W11 broker-owned candidate commit + independent verification.

## 12. Run-state contract for the UI (run timeline engineer)

- Local SSE (`/api/events` on the sidecar): unchanged event names. v2 adds to `execution:progress` / `execution:log` payloads: `runId`, `runSeq` (journal sequence — stable across sidecar restarts, unlike the SSE `id:` which is per boot), and on state changes `runState` (one of the 11 states). De-duplicate by `(runId, runSeq)`; after `replay-gap` (sidecar restarted) refetch `GET /api/tasks/:id/run` and logs.
- Cloud SSE: relayed `execution:progress` carries `runState`, `runSeq` (and `runId` on locally delivered frames); logs are `execution:log {entry}` (the API schema forbids extra keys on logs). The sweeper emits `execution:progress {status:'error', reason:'sidecar_lost', runState:'recovery_required', attemptId}` + `task:updated`.
- `GET /api/tasks/:id/run` (sidecar) → `{ run: { runId, state, attemptId, lastSeq, relayAckSeq, terminal: { state, reason, outcome, prUrl, claimed } | null, effects: [{ key, kind, status }] } }` — `lastSeq − relayAckSeq` = events not yet at the cloud; effects show publication progress (`git.commit` → `git.push` → `pr.create`).
- Execute: `202 state:'queued'` means accepted but waiting for a slot (show "Queued", allow cancel). Task status projection stays legacy (`in_progress` → `done` | `cancelled` + `outcome`); show `recovery_required`/`abandoned` from `runState` or the sweeper outcome text, and offer "Run again".

## 13. Client-visible changes (manual test list)

- Legacy: sandbox unavailable/start failure on execute → **503** (was 400), body unchanged (`{error, code}`).
- With `OPENLINEAR_RUN_ENGINE=v2`: execute returns `runId/attemptId/state` and may return `202` (queued) instead of `400 Parallel limit reached` (a full queue still answers `400 PARALLEL_LIMIT_REACHED`); cancel can answer `202`; new `GET /api/tasks/:id/run`; a second sidecar process on the same app data → `503 RUN_JOURNAL_LOCKED`; a task whose sidecar died is released to `cancelled` with the "Execution lost" outcome after ≤ lease + 1 min (default ≈ 6 min).
- API: new capability route `POST /api/executions/attempts/:id/renew`; new attempt columns; new job `execution-lease-sweep` (every minute in the jobs process).
- Legacy sidecar crash behaviour is unchanged except that the sweeper now also releases legacy attempts whose heartbeat stopped (they heartbeat the same way) — **this is a behaviour change for the legacy path too**: previously such tasks stayed `in_progress` forever.

## 14. Decisions

- **Capability in the journal.** A restarted sidecar needs the attempt's authority to finish or project anything; the run-scoped capability (and a per-attempt server password) is stored in the private journal file, denied to agents by the sandbox policy. It dies at close, sweep or expiry. Alternative (a user token at restart) does not exist: user tokens arrive per request.
- **Endpoint capture.** `AgentRunner.resume` re-sends a turn on OpenCode, so it cannot be used for recovery; the run service journals the runtime endpoint and attaches with its own stream-only session. The SDK keeps base URL/headers in a protected client; `describeOpenCodeClient` reads them via `getConfig()` with runtime checks and a test that fails if the SDK shape changes. No edits to `runners/**` or `sandbox/**`.
- **Execute waits until "started"** (claim + prompt journaled, bounded 60 s) so setup failures keep their HTTP status; acceptance is still durable before any answer. Model output is not awaited.
- **Queue instead of reject** at the parallel limit (bounded 10), FIFO; queued runs heartbeat their unclaimed attempt. Queued/preparing runs are failed (not resumed) after a restart.
- **Sweeper projection = `cancelled`** with an explanatory outcome (the legacy failure projection), recoveryState on the attempt; default lease 5 min to tolerate sleeping laptops.
- **Pending claim treated as claimed** when deciding a terminal outcome.
- **Graceful shutdown** does not stop agents or checkpoint: journal writes are synchronous; recovery handles it like a crash (shared OpenCode killed by shutdown → `recovery_required`).

## 15. Leftovers

1. `OpenCodeSession.abort()` (runners/opencode, not mine) resolves even when OpenCode answers `false`; v2 uses its own receipt-checking abort, but the runner contract should require a positive receipt — runners engineer.
2. Codex / Claude Code `RunRuntime`s (inspect/attach/abort) once the runners land; until then v2 refuses them.
3. Enforce-mode attempt servers cannot be adopted after a sidecar crash (in-process egress proxy, no persisted adopt handle, no orphan reaping on macOS) → `recovery_required`. Needs the sandbox to persist `{url, auth, pid, nonce}` in its records and an adopt/reap API (W09/W12).
4. `gcLocalWorktrees` at boot deletes worktrees older than 24 h without consulting the run journal (a run recovering after > 24 h could lose its worktree) — W08.
5. Batch execution on the run service (W13), local-path projects in isolated checkouts (W08), approval UI (`ask` policy), W11 verification/publication broker, journal retention of per-run events beyond 20 000 (compaction/snapshots).
6. `SandboxRunMetadata` is not yet journaled (only the sandbox mode is part of the endpoint).
7. Sweeper outcome text is English-only; UI may want a code (`sidecar_lost` is in the progress event and `closeReason`).
8. Interactive-session revocation is still not re-checked for running attempts (renewal re-authorizes PAT attempts only through `reauthorizeInitiator`, unchanged W03a semantics).

## 16. Merge hazards

| File | Hazard |
|---|---|
| `packages/execution-core/src/index.ts` | one added export line (`run-contract`); runners engineer may also export from here |
| `packages/api-client/src/executions.ts` | additive `ExecutionCapabilityRenewal` + `ExecutionAttemptClient.renew()` (not in my listed ownership; only consumer is the sidecar) |
| `apps/api/src/services/execution-control.ts` | `lockAttempt`, `revokeCapabilities`, `boundTaskWhere`, `taskEventAudience` now exported; renewal section + lease/lifetime env helpers appended |
| `apps/api/src/routes/executions.ts`, `apps/api/src/registry.ts` | one route + one `attemptCallback` row |
| `apps/api/src/jobs/index.ts`, `apps/api/src/__tests__/jobs.pgboss.test.ts` | new queue `execution-lease-sweep` + interval timer; the pg-boss test's queue list gained it (stale assertion updated) |
| `packages/db/prisma/schema.prisma` + migration `20261026080000_*` | 4 columns on `ExecutionAttempt` |
| `apps/sidecar/src/routes/execution.ts` | v2 branches in execute/running/logs/cancel, new `GET /:id/run`, 503 mapping |
| `apps/sidecar/src/services/execution/recovery.ts` | background v2 recovery hook (`skipRunEngine` dep), worktree path in the legacy probe |
| `apps/sidecar/src/services/execution/state.ts` | new export `redactSecrets` |
| root `package.json` | 9 paths appended to the `lint` list |
| `apps/api/src/__tests__/fixtures/opencode-stub-durable.mjs` | new fixture (the W03a stub is untouched) |
