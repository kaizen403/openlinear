# W13a — batches on the v2 run service (parallel + queue)

Date: 2026-10-26. Engineer id: `batches` (coordinator, working alone).
Status: **implemented and locally validated; not committed, not deployed.**

## 1. Problem

With API persistence — the desktop default — every `/api/batches` route
answered 501 `BATCH_REQUIRES_API_PERSISTENCE`: batches only worked on the
legacy engine with direct Prisma access (tests, `--with-cloud-api`). The v2
run engine (default since round 9) had no batch support, so "run these five
tasks" was unavailable to real users.

## 2. Design decision (owner to confirm)

A v2 batch is a **coordinated set of ordinary v2 runs**, one per task. Every
member gets exactly what a single run gets — its own control-plane attempt,
lease and heartbeat, sandbox, sealed W11a verification, cancel, crash
recovery — and **publishes its own verified pull request**.

This changes one legacy behaviour: the legacy engine merged every member
branch into one batch branch and opened **one** PR. Per-member PRs keep each
change independently reviewable and verified (one failing member no longer
blocks or pollutes the others), which is how Conductor/Capy-style parallel
agents work. A single combined PR remains a separate mode (below).

| Mode | v2 behaviour |
|---|---|
| `parallel` | All members submitted at once; the run service's parallel limit (the user's execution setting, from the attempt snapshot) bounds how many run — the rest wait in its queue (`queued` → `preparing` "slot available"). |
| `queue` | One member at a time, in order. Next member starts when the previous settles: automatically with **queue auto-approve**, otherwise on `POST /:id/approve` (the approver's credential starts it). **Stop on failure** skips the rest after a member that did not succeed. |
| `combined` | **Refused** on v2 (501 `BATCH_MODE_UNAVAILABLE`, nothing started). One agent session and one PR for many tasks needs a multi-task attempt that authorizes every member — W13b. |

Batch status: `completed` when every member completed; `cancelled` when the
batch was cancelled; otherwise `failed` (some member failed, was skipped or
refused). Each member's status comes from its run; members that never ran
are recorded as `skipped` / `cancelled` / `failed` (refused at submit, e.g.
`TASK_NOT_FOUND`, `TASK_ALREADY_RUNNING`).

## 3. What changed

| Piece | File | Behaviour |
|---|---|---|
| Run-settled hook | `run/service.ts` | `onRunSettled(listener)` after a run's terminal projection; `runRecord(runId)`. |
| Journal schema 3 | `journal/durable.ts` | `run_batches` + `run_batch_members` (additive tables, CHECKed enums); member `final_status` frozen when the batch finishes; `batchMemberForRun`, `finishBatch` (exactly once). |
| Coordinator | `run/batch.ts` | Create / view / active / approveNext / cancel / cancelTask / recover; per-batch serialization; batch events (`batch:created`, `started`, `task:started|completed|failed|skipped|cancelled`, `completed|failed|cancelled`) to the creator only. The creator's credential is kept **in memory only** (queue auto-advance); after a restart a queue whose next member never started waits for `approve`. |
| Routes | `routes/batches-v2.ts`, `routes/batches.ts` | API mode + v2 engine → coordinator; never reaches Prisma (catch-all 404). Same request/response contracts as legacy, plus per-member `prUrl`, `runId` and `engine: 'v2'`. Only the creator can see/act on a batch (others: 404). Every member authorized before anything starts; the user's max batch size enforced; queue settings read from `GET /api/settings` with safe defaults when the token can't read them. Legacy engine in API mode still fails closed (501). |
| UI copy | `desktop-ui/lib/api/errors.ts` | `BATCH_MODE_UNAVAILABLE`; `BATCH_REQUIRES_API_PERSISTENCE` now explains the engine switch. The existing batch panel already handles every event and a null batch `prUrl`; each card shows its own PR. |

## 4. Evidence

| Gate | Result |
|---|---|
| `run/batch.test.ts` (new) | 8/8 — parallel within limit 2 (third run queued then "slot available"), three distinct PRs, three attempts, events to the creator only, status response shape; refused member fails alone; combined refused with no attempt; queue waits for approve (approve while running → BATCH_NOT_READY; after finish → BATCH_NOT_RUNNING); auto-approve + stop-on-failure → completed/failed/skipped (skipped event, no attempt); cancel → running member and waiting member cancelled; restart: finished batch survives; restart with an unstarted queue member → waits, approve continues |
| `routes/batches-v2.test.ts` (new) | 6/6 — create with settings after per-member authorization; refusals before start (403 member, max batch size, duplicates); default settings fallback; creator-only (4 routes 404 for another user); cancel/member cancel/approve/list wiring; legacy engine in API mode → 501, Prisma never loaded |
| `api-only-mode.test.ts` | pinned to `OPENLINEAR_RUN_ENGINE=legacy` (the fail-closed case it covers) |
| Sidecar full / integration | 1097 + 3 skipped / 26 |
| desktop-ui full | 1043 + 9 skipped |
| typecheck 11/11, `pnpm lint` 334 | clean |

## 5. Not done / owed

- **W13b combined mode** on v2 (one session, one branch, one PR; a
  multi-task attempt that authorizes all members; a single resumable batch
  finalizer).
- Board grouping: v2 batch members are not linked by `task.batchId` (the
  control plane's claim clears it); the batch panel tracks them.
- Dependency ordering beyond queue order, and per-repository locks between
  concurrent batches (the run service's per-task reservation already
  prevents the same task running twice).
- Owner decision: confirm per-member PRs for parallel/queue (vs the legacy
  single batch PR).
