# OpenLinear execution engine audit — 2026-10-15

> Source evidence includes the pre-fix audit. Read [consolidated validation](validation.md) for final repairs, tests and remaining scope. Audit line references may precede the local edits.
Scope: backend source at the checked-out `dev` tree; single tasks, parallel/queue/combined batches, runner prototypes, repository ownership, persistence, recovery, cancellation, completion, and performance gates. Read `AGENTS.md`, the Phase 2 and latest October 15 entries in `ISSUES.md`, Phase 2 Execution Engine v2, and A2 Execution Engine Architecture. No production, cloud, credential, or deployment state was tested. Source findings below are verified from implementation, not work-log completion labels. Line numbers refer to the pre-fix tree. Root agent will record the session in `ISSUES.md`.

## 1. Actual call graph

```text
index.start
  -> persistence-mode guard
  -> createSidecarApp
     -> /api/tasks      legacy executionRouter
     -> /api/batches    legacy batchesRouter
     -> /api/opencode   provider / server management
     -> /api/transcribe
     -> /api/events     separate local SSE registry
  -> new RunJournal(defaultPath) [no API client; not retained in runtime]
  -> recoverInFlightExecutions({journal}) [no runner]
  -> recoverActiveBatches [empty result]
  -> initOpenCode

POST /api/tasks/:id/execute
  -> API requireAuth + assertTaskOwned [Prisma-backed]
  -> lifecycle.executeTask
     -> pendingExecutions in-memory guard
     -> getExecutionSettings + getSidecarStore task/SCM-token reads
     -> ensureModelConfigured [OpenCode preflight]
     -> getClientForUser(computed checkout path) || setupRepository
        -> remote: cloneRepository -> acquireLocalWorktree
                   [acquired path dropped] -> createBranch(computed path)
        -> local: createBranch(project.localPath) [shared user's checkout]
     -> direct OpenCode session.create
     -> resolveAgentId [only records label, does not select runner]
     -> createAgentRun [direct Prisma]
     -> in-memory ExecutionState + 30-minute absolute timer
     -> subscribeToSessionEvents [one GLOBAL event subscription per task]
     -> direct OpenCode promptAsync
     -> event-stream-processor.processEvent -> legacy action executor
        -> usage memory snapshots -> Prisma at finalization
        -> idle -> commitAndPush -> GitHub PR -> task.done
        -> error/timeout -> failure or auto-salvage into ordinary completion
        -> persistLogs [whole JSON array, only at terminal state]
        -> cleanupExecution [timers/buffers only, no workspace release]

POST /api/batches
  -> API requireAuth + ownership check per task
  -> direct Prisma credential lookup
  -> createBatch: choose arbitrary first selected task's repository
     -> legacy ensureMainRepo [mutex only here]
     -> in-memory activeBatches + task.batchId updates
  -> startBatch
     parallel: launch ALL task indexes immediately
     queue: launch first; advanceQueue/approve launches later tasks
     combined: one shared worktree/session/prompt
  -> legacy createWorktree/createBatchWorktree
  -> direct OpenCode session/create/promptAsync
  -> services/session-manager.ts [second global-event consumer]
  -> completion.handleTaskComplete / handleCombinedBatchComplete
     -> stage allowlist -> RAW git commit
     -> mark task.done BEFORE batch publish
     -> merge branches -> push -> create PR
     -> push failure swallowed -> batch.completed -> delete worktrees

Prototype, NOT used by either execute route:
  engine.RunCoordinator -> runners.OpenCodeRunner/CodexRunner
    -> engine.SessionManager -> execution-core.processAgentEvent -> journal
```

Entry wiring is `apps/sidecar/src/app.ts:135`; single execution is `routes/execution.ts:39`, `services/execution/lifecycle.ts:324`; batch wiring is `routes/batches.ts:31`, `services/batch/orchestrator.ts:147`. `rg` finds no production construction of `RunCoordinator`, no `pickRunner` execution caller, and no caller of `setDefaultApiClient`. There are three event/lifecycle implementations, not one coordinator.

## 2. Ranked verified defects

### Shipping blockers and data integrity

1. **P0 — every fresh remote single-task setup uses the wrong checkout path.** `lifecycle.ts:106` constructs `REPOS_DIR/<repoName>/<task-prefix>`; `git.ts:111` acquires `<appData>/repos/worktrees/<task-prefix>` but its `Promise<void>` drops the handle and only logs the difference (`git.ts:119`). `lifecycle.ts:133` then runs checkout against the original path. Trigger: normal execution on a repository without the old computed path already on disk. Impact: `git -C` fails before session starts; an orphan checkout remains. Existing lifecycle mocks return void and existing real-git tests cover only the provider, so the broken composition is untested. **This is the first safe repair.**

2. **P0 — API-only sidecar remains structurally unusable.** `persistence/store.ts:93` throws without an injected/default client; no production caller initializes it. Entry guards forbid the old production DB mode (`persistence/boot.ts:20`), yet route authentication, ownership, agent-run creation/finalization, task updates, logs, completion, and the entire batch path still import Prisma/API internals (`routes/execution.ts:2`, `routes/batches.ts:2`, `state.ts:443`, `agent-run.ts:16`, `batch/orchestrator.ts:3`). A successful `health` response proves none of these work. Do not cure this with a process-global user bearer token: stores, credentials, and authorization must be bound to each authenticated request/run.

3. **P0 security — cloud run replay has no task/run authorization.** `apps/api/src/routes/events.ts:137-153` fetches all `agentRunEvent` rows for caller-provided `run:<uuid>:<seq>` after authenticating only the connecting user. Trigger: authenticated user learns another run UUID. Impact: another tenant's agent events/tool output can be replayed. Apply current task view policy before querying, and scope the query itself. Normal event audiences also need current project-deny semantics, not workspace/team membership alone.

4. **P1 — batch publication failure becomes success and removes the checkout.** `batch/completion.ts:92` marks tasks done after their local commit. `finalizeBatch` catches push errors (`:391`) and unconditionally marks the batch completed (`:395`) then cleans up (`:416`). Combined does the same at `:503`, `:508`, `:528`. Trigger: network/auth/lease failure. Impact: users see completed work without a remote branch/PR, and useful inspection worktrees are removed. On merge conflict, in-memory task status becomes failed/skipped (`:312`, `:318`) but task DB status stays done. Completion needs durable publish stages and retained artifacts on failure.

5. **P1 — batch may execute tasks in the wrong repository.** `batch/orchestrator.ts:83-110` selects one arbitrary matching task, never validates every selected task's project/repository or existence, and all runs use its repository (`:213`, `:330`). Duplicate IDs are allowed by `routes/batches.ts:24`. Trigger: selection spans projects or repeats IDs. Impact: code changes, branches, and PRs in the wrong repo, stale-worktree deletion for duplicate task branches. Reject unsupported mixtures before any filesystem mutation; optionally partition into an explicit multi-repository plan later.

6. **P1 — cancellation is neither durable nor safe across preparation/completion.** Batch cancellation changes only in-memory states (`batch/orchestrator.ts:408-497`), does not persist cancelled task status or elapsed usage, and cancelling one queued/running task never advances queue. A task in setup has `running` but no session; cancelBatch's `:423` guard misses it, then setup can continue and prompt after cancellation while cleanup deletes directories. Cancelling one issue in combined mode cancels all issues (`:475`), while that route verifies only the named issue (`routes/batches.ts:156-161`), unlike whole-batch authorization. A batch completion already past its guard can race cancel and mark done again. Single tasks cannot cancel cloning/preflight because `isTaskRunning` sees only active execution state. Completion has already claimed finalization, so single cancellation then returns 'already finalizing' and cannot stop push/fetch (`lifecycle.ts:415`).

7. **P1 — recovery is a decision counter, not execution recovery.** Boot constructs journal without runner/client before OpenCode init (`index.ts:146-148`, `:190`). Production legacy paths never start journal runs. Coordinator journals externalSessionId null (`engine/run-coordinator.ts:68`) and never updates it. RESUME branch only increments counters (`recovery.ts:76`); SALVAGE and COMPLETE_IDEMPOTENT only update statuses (`:81-86`), no event reattachment or commit/push/PR. Probe creates a resume wrapper using empty cwd and assumes busy without checking session status (`:35-39`). FAIL status writes can be swallowed (`:109`). `recoverActiveBatches` is an empty result (`:114`). Process-kill survival acceptance is not implemented.

### Resource control, runner correctness, and observability

8. **P1 — configured concurrency is bypassed.** `maxConcurrent` is copied from settings (`batch/orchestrator.ts:77`) but never used; `execution-core/batch/modes.ts:22-28` launches every selected task. No global batch/worktree cap. Single admission checks only active count before asynchronous setup (`lifecycle.ts:65`), so many distinct pending requests can all pass and exceed the cap; a thrown gather step before the outer try can leave task pending forever (`:325`, `:353`). Duplicate request returns error and deletes the shared pending entry, permitting a third request to bypass the original reservation (`:326-328`). Queue approval can launch the next issue while an earlier issue is running (`orchestrator.ts:517-522`).

9. **P1 — shared mirror operations are not serialized throughout.** `services/worktree.ts:23` locks only initial clone/fetch. Later create/fetch/remove/branch/merge/update-ref have no lock (`:109`, `:171`, `:327`, `:410`), exposing same repo across concurrent batches. New provider's coalesced fetch sits *inside* the mutex (`workspace/local-worktree.ts:69-89`), so waiters usually enter after the previous fetch finished and refetch. Bare-clone local branches can stay stale without explicit fetch refspec; provider tests must advance origin and verify the next checkout's base SHA. Merge temp path uses sanitized taskBranch (`worktree.ts:333`), not batch/run identity, so repeated tasks collide.

10. **P1 — runner selection is cosmetic.** Single path records resolved `Task.agent`/`Project.defaultAgent` (`lifecycle.ts:379`) after directly creating OpenCode session (`:359`). Batch selects only model, never agent (`batch/orchestrator.ts:254`). Requested Codex/Claude Code can therefore run OpenCode while telemetry names the requested runner. Fail unsupported selections clearly until route/coordinator migration is proven.

11. **P1 latent — new normalized event manager silently drops critical actions.** `engine/session-manager.ts:60-73` applies only setPromptSent, suspend/resume, handleSessionComplete, failExecution. Reducer errors are `sessionError` (`execution-core/process-agent-event.ts:137`), ignored; permission reply, usage, text/log/progress, file/tool counters and watchdogs also ignored. A runner stream ending without terminal event leaves journal running and admission held forever. Callback rejection can cause `onComplete` twice (`:66`, `:78`); channel-map entries are retained. `RunCoordinator.start` awaits consumption until end (`:89`), preventing prompt route acknowledgement; startup throws leak reservations (`:58-93`); dequeue ignores admission limits (`:115-116`); cancelling queued starts does not remove them (`:103`); batch Set deletion loses accounting when the first task of a still-active batch finishes (`:112`). These must be fixed before wiring.

12. **P1 latent — OpenCodeRunner does not isolate sessions.** New `extractSessionId` reads only top-level properties (`runners/opencode/index.ts:45`), missing `info.sessionID`/`part.sessionID`. Filter skips only other-session turn.finished; emits their errors/tool/text/usage (`:181-187`). An unrelated error can terminate this run. Resume re-sends an empty user turn/system contract (`:271`, `:166`) rather than attaching. 'v2' is only fallback after a system-user client failure (`:284-295`), feature methods optional/no-op, no real children reconciliation. Contract still embedded in user text (`:156`).

13. **P1 — time/budget expectations differ from runtime.** Real single tasks hit absolute 30-minute cancel (`state.ts:22`, `lifecycle.ts:145`) even through compaction/permission and despite advertised six-hour budgets. New budget watchdog and approval-deadline helpers have zero runtime callers. Legacy permission reply failure can suspend watchdogs permanently; batches then have no absolute timer (`services/session-manager.ts:132`, `:149-154`). On no-progress/transport failure with any diff, single path automatically commits/pushes a normal success PR (`events.ts:115-135`), conflating salvage with requested work being complete. Need checkpoint/salvaged terminal outcome and review-required artifact.

14. **P1 — cancellation token stops at prototypes.** `engine/cancel.ts:17` aborts first, contrary to its interrupt/grace contract; SDK interrupt can hang without timeout. Single legacy cancel supplies no controller or pgid (`lifecycle.ts:450`); git and GitHub operations receive no run signal/deadline. Batch simply aborts OpenCode. There is no sandbox group to reap. Shutdown kills OpenCode separately but doesn't drain journal/API mirrors or reconcile every active execution (`index.ts:98-129`).

15. **P1 — journal mirroring isn't a durable outbox.** `journal/sqlite.ts:116-148` holds mirror backlog only in memory; loses it on crash/close (`:111`). Failed flush requeues but doesn't schedule retry until another event, can grow without limit during API outage, and a requeued list can exceed API max 50 (`agent-runs.ts:79`). No saved API ack/high-water cursor. No WAL/database retention, foreign key/index lifecycle, or checkpoint snapshots. Events include full tool input/output and bypass legacy redaction. New local SSE delivery has no producer; replay is an empty branch (`sse/local.ts:83`). Legacy broadcasts reach imported API hub, not local route's separate clients.

16. **P1 — cloud progress journal is mutable and has split cursor semantics.** `/progress` requires only task view after PAT write scope (`api/routes/agent-runs.ts:203`), not full/run producer rights; upsert overwrites old event payload (`:220`). It persists and fans out each event sequentially, then creates a second outbox event for only the final item (`:210-255`). Replica receiving POST gets run:seq frames; other replicas receive only last item's numeric domain cursor. Mixed last-event IDs lose intervening streams/events; 500-row replay lacks pagination or replay/live barrier. Use immutable event insert, conflict verification, one durable envelope per event/batch and one public cursor model.

17. **P2 — worktree lifecycle/usage is incomplete.** New acquire removes directory with rmSync, leaves Git registration/branch (`workspace/local-worktree.ts:94`) and next `-b` fails for same run ID (`:106`); single path never calls release. GC ignores maxBytes and blindly deletes old paths without checking live journal lease (`:131-148`), runs concurrently before recovery (`index.ts:143`), and uses macOS path default on Linux instead of existing cross-platform repo-storage helper. Single logs capped, but messageUsage snapshots grow and are re-summed O(messages) each update (`agent-run.ts:74-95`); batch has no AgentRun or message.updated capture at all. Batch logs don't use single secret redaction (`batch/shared.ts:96`).

18. **Security cross-cut — raw commit and non-NUL staging parser bypass intended hardening.** `batch/completion.ts:68` and `:180` invoke raw git, allowing repo config/hooks/fsmonitor unlike `execGit`. Staging parser uses quoted porcelain lines, not `-z` (`staging-allowlist.ts:46-50`), and checks root package.json only. Execution policy, not filenames alone, must cover nested package scripts, Makefiles, config files and indexed/renamed paths. Ownership remains sidecar-only trusted host execution for localPath; simultaneous local tasks checkout and stage in the user's same working directory (`lifecycle.ts:123-133`). Sandbox workstream should own this.

## 3. Migration toward one durable coordinator

Do not flip the route imports directly to the existing coordinator; findings 11/12 show that is unsafe. Preserve useful pure reducer/types, allowlisted subprocess helpers, API client, and real-git tests, but establish one production service with explicit ownership.

1. **Run identity and ownership.** Allocate a full UUID per attempt, separate Task ID from Run ID, idempotency key for execute request, authenticated principal + task/project/repository snapshot. API acquires one active-run lease per task via transaction/unique constraint; sidecar creates durable local request record before accepting. Never use task-prefix directories as attempt ownership. Batch record persists plan, order, mode, approval state, selected runner/model, member runs, and completion state. Combined mode is one run with N owned task links, not N fictitious sessions.
2. **Explicit contracts.** Runner `prepare/start` resolves actual session ID and subscription-ready before `submit`; `resume` only inspects/reattaches (no implicit prompt). `inspect(externalId)` returns exists/status/cursor. Credentials/principal, model provider/id, signal, environment, permission policy and sandbox handle are required inputs. Capabilities match actual pinned runtime features. A terminal Result distinguishes succeeded/cancelled/failed/interrupted/budget_exhausted/salvaged. End-of-stream without Result is an error. Backend demux is bound to credential-set/backend-generation and session/root-child relationships.
3. **Durable state machine.** `queued -> preparing -> running <-> awaiting_approval/compacting -> completing -> succeeded`; failure/cancellation/salvage terminal alternatives. Record transition + event + snapshot in SQLite transaction before external side effects. Append-only event sequence; persist external ID immediately, current counters/usage and completion stage. Lease prevents two processes completing same run; recover cancellation and queue entries too. Reducer is pure; a complete, exhaustive effect interpreter owns all actions.
4. **Admission.** Durable FIFO/fair queue; run, distinct-batch and worktree reservations acquired atomically before repository setup; include pending allocations. Ref-count batch membership. Bounded queue/backpressure, cancellable queued requests, per-user/project/global limits, disk budget. Queue mode enforces at most one active member even during approval; parallel caps refill on terminal member transition; combined one reservation.
5. **Workspace/sandbox.** One provider returning actual owned handle used by every git/runner/completion stage. Canonical remote+credential-set identity, full run UUID paths, all mirror mutations locked, coalesced refresh outside lock where safe, explicit ref refresh, isolated dissociated checkout where required. Active lease excluded from GC; retain failures for inspection. Do not mutate project.localPath directly—acquire an isolated checkout from it. Sandbox provider launch/reap is a dependency, and trusted-host mode is explicit policy rather than silent fallback.
6. **Durable mirror/outbox.** SQLite event/snapshot write also tracks API acknowledged cursor; replay unacked ranges from disk, batches of <=50, one in-flight flush per run, bounded retry/backoff. Flush/close lifecycle. API writes immutable event rows with attempt authorization, bulk insert and postcommit outbox. Define public replay cursor once; authorize replay and stream audiences dynamically. Keep local SSE and cloud relay consistent.
7. **Completion as resumable stages.** Capture diff/base/head -> validate allowlist+approval -> staged -> commit SHA -> fetched expected remote SHA -> push confirmation -> find/create PR by unique branch -> persisted terminal run/task outcome -> release. Re-enter each stage idempotently; task.done only after configured success artifact requirement. Preserve committed local artifacts if push fails; lease rejection is not treated as missing ref. Offload summary generation. No timeout-generated diff becomes succeeded automatically.
8. **Watchdogs/cancel.** One controller per attempt propagated into git, fetch, runner, sandbox; bounded interrupt then bounded grace/hard abort/reap. Separate transport, task progress, budget; pause appropriate clocks on approval/compaction with deadline; checkpoint before budget stop. Retry only safe/idempotent operations, honor provider retry-after; attempts and fallback recorded. Shutdown stop admission, checkpoint/mark reconnect state, drain durable mirrors, close streams, reap or keep resumable runner according to policy.
9. **Migrate incrementally.** First route single-task execution into coordinator behind one backend flag after black-box parity tests, then independent batch plan schedulers that invoke the same run service, then combined membership. Every enabled route uses same usage/cancel/completion/recovery. Remove legacy consumers only after coverage demonstrates parity; do not retain two live finalizers.

## 4. Safe implementation tranche

Tranche A (this session): repair remote workspace acquisition return value, propagate actual path through branch/client/session/state, and release owned acquisition when setup fails; cover with real temp-origin composition regression and mocked SDK boundary, plus existing lifecycle regression suite. Avoid new runner/coordinator wiring or production calls. Separate user-owned localPath cleanup from owned remote cleanup. Keep changes narrow enough to review.

Tranche B: completion truthful terminal semantics and artifact retention; batch mixed-repository/duplicate validation and consistent cancel persistence/queue advancement; atomic pending admission. Fix replay authorization and staging/parser/raw-commit hardening with security workstream. Add failure-injection and interleaving tests before changes.

Tranche C: authenticated sidecar bootstrap and request-bound API persistence/auth; remove Prisma imports and local JWT-secret reliance. End-to-end sidecar boot with no DATABASE_URL and fake API verifies execute/status/logs/cancel. Never expose broker secret to agent.

Tranche D: coordinator/reducer full effects, runner contracts, durable journal/outbox/leases; route migration single -> batch -> combined, then real recovery and resource gates. These are multiple reviewed slices, not one giant import replacement.

## 5. Meaningful validation and performance evidence

- Real temp bare origin + actual lifecycle: fresh remote execution uses existing acquired checkout for git and session.cwd; repeat attempt uses unique identity; setup/session failure releases registration; default branch advance appears in next warm run; no original path assumed. Mock only agent/cloud boundary, not git/workspace path.
- Scheduler property/interleaving tests: 20 concurrent execute requests, duplicate race, 8 concurrent batches, per-repo contention, cancel during every acquisition await, single cancellation isolates other sessions, manual approve can't exceed queue/concurrency, mixed repositories/duplicates rejected before acquire, combined ownership verified.
- Completion fault injection after every stage: filesystem error, credential denial, lost response after accepted push, lease conflict, PR 422 existing, cloud write lost then retry, cancellation before publish, process crash after commit/push/PR. Assert exactly one run terminal transition/artifact and retain all incomplete outcomes.
- Fake SDK event contract: actual nested session shapes, unrelated errors/idle/message, child root idle, permission denied/no reply deadline, compaction begin/end, clean/truncated stream EOF, API errors carried in resolved result, repeated cumulative usage snapshots, Codex multiple item IDs/command exit codes/errors/model option. Pin SDK+CLI and nightly exercise local fixture through real runner without a cloud deployment.
- Crash recovery process test: fork test sidecar, persist run/event/ack, SIGKILL during runner and each completion stage, restart, assert reattach/no duplicate prompt, salvage artifact, all queues/batch metadata restored, zero orphan child groups and bounded journal. Pure recovery-decision tests are insufficient.
- Replay/auth: revoked identity, other workspace, project deny, run UUID guessed, API reconnect cursor at >500 rows, simultaneous live events during replay, cross-replica distribution, >50 failed mirror backlog, idle failed mirror flush retry, restart ack recovery. Assert ordered immutable once-dedupable sequence.
- Genuine latency harness: seed actual 300 MiB git repo with reproducible blob layout and bare origin; cold/warm cache variants, 1/4/8 runs; HTTP execute click time to observed first normalized message event, plus spans for API auth, snapshot, queue wait, mirror refresh, worktree checkout, runner session/subscription, prompt acceptance, TTFT. At least 30 repetitions; emit p50/p95/max and failing threshold (warm p95 <=2.7s or agreed CI 3s). Separate provider/network TTFT from engine overhead; do not claim target from file size metadata.
- Genuine soak: accelerated fake-runner 2M-token/6-hour logical clock in CI and scheduled wall-clock soak; periodic tools with 10-minute no output but heartbeat, compaction, approval, retry, API outage and cancellation. Track RSS slope, event-loop delay, journal bytes/WAL growth, queue/backlog, worktree bytes/count, per-stage duration, usage reconciliation. Retention/compaction must bound storage without destroying replay window.
- Current `scripts/latency-bench.mjs`, `latency-300mb.mjs`, `soak.mjs` only `console.log` fixture descriptions; no seeded data, execution, measurement, assertion or CI threshold. Current sidecar coverage thresholds don't prove orchestration: legacy batch flows have no dedicated integration test file. Test counts and recorded green September runs should not be described as present acceptance evidence.

Runtime validation is delegated to the implementation tranche after dependencies install. This report itself is a static audit, with deterministic source-level triggers stated explicitly.

## 6. First implementation tranche completed

- `services/execution/git.ts` now returns the actual WorkspaceHandle, with a fresh UUID per remote attempt; GitService.clone forwards that handle.
- `services/execution/lifecycle.ts` adopts acquired path and branch before checkout; directory-bound OpenCode client/session and ExecutionState use that acquired path. Missing session ID enters the same error cleanup. Setup failures release owned remote checkouts; errors after this attempt's active state was registered first use the shared finalizer. A user-owned localPath is never released. Completion workspace lifecycle remains the subsequent coordinator/provider tranche.
- Existing unit fixtures deliberately use different computed and acquired paths; obsolete GitService adapter references to nonexistent mocks.execFileAsync now use execGit.
- Added `services/execution/lifecycle-worktree.test.ts`: real temp bare origin/git/worktree acquisition, with only persistence/agent boundaries mocked. Four integration scenarios verify acquired cwd and branch, rejected session setup releasing registration and unique retries, missing session ID cleanup, and local checkout preservation.
- Focused execution tests: **57 passed**, three files (22 git helper, 31 lifecycle, 4 real-git integration). After concurrent runner/provider fixes finished, **sidecar typecheck passed** and the full sidecar suite passed **409 tests across 29 files**, with no unhandled rejections. `git diff --check` passed. No deployment, production request, cloud action, or commit.

These changes repair finding 1 and the associated pre-agent setup lifecycle only. They do not claim the unfinished durable coordinator, API-only boot, real runner route selection, batch publication integrity, or recovery is complete.

## 7. Independent review of shared provider repairs

Root provider patch now refreshes remote heads into a separate origin namespace, resolves base commit SHA, validates owned paths, refuses duplicate workspaces, and checks Git common-directory identity before release. Its updated real-git tests plus lifecycle integration passed **13/13** (eight-way contention, warm freshness preserving earlier attempt, duplicate retention, deleted base rejection, symlink/traversal rejection, fetch failure release, forged release retention, dissociated release, lifecycle acquired cwd and failure cleanup). The stale-session test failure was an incorrect fixture: it left active state registered and expected a matching busy event to be ignored. Test-only correction now gates the event until after real cleanup, deliberately restores stale mapping, and verifies no state/DB/finalization effects plus iterator closure; focused event suite **37/37** passed.

Independent scratch real-git review additionally verified two ref-freshness cases needing root correction: explicit remote tag deletion still resolved the stale copied local tag because only heads are refreshed; deleting default branch `main` while a tag `main` exists silently falls back to that tag. Also repository-name validation initially rejected legitimate dot/underscore-prefixed names such as `.github` and `_repo` and harmless repeated dots. Review findings delivered to root for narrow provider correction.

Private HTTPS partial-clone materialization is **not runtime-tested**. Root added credential-scoped checkout/reset to cover Git's lazy blob fetch after temporary clone credentials are removed. The real-git fixture uses file origins; it demonstrates composition and ref safety, not private server credential authentication. Fetch coalescing, cross-process run leases, active-run-aware size GC, sandbox isolation, and full completion cleanup remain explicitly deferred.
