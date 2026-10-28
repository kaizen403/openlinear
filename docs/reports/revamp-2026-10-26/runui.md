# runui — the run UI on the v2 contract (FE-01, FE-06; FE-02/FE-04 partial)

Date: 2026-10-26. Engineer id: `runui` (the worktree agent stopped before
changing anything; done by the coordinator alone). Status: **implemented and
locally validated; not committed, not deployed.** No screenshots were taken
(needs a running desktop app with a live v2 run).

## 1. Problem

The v2 run engine (default since round 9) reports every state of its machine
on `execution:progress` as `{ status, message, runState, runId, runSeq }`.
The UI decoder only knew the legacy shape and the `{runId, seq, type,
payload}` journal shape, so it dropped `runState`/`runSeq`:

- `verifying` showed as "Committing"; `awaiting_approval`/`compacting` as
  "Running"; `recovery_required`/`abandoned` as "Failed" — FE-01 requires
  them separately and "a model saying done cannot appear as verified success";
- replays and the second delivery path (local SSE + control-plane relay)
  were de-duplicated only by content for logs and not at all for beats;
- after a reload, the drawer guessed the state from the task row and the
  last log line instead of the journal;
- a v2 `queued` beat put `status: 'queued'` in the board store and **crashed
  the task card** (`progressConfig['queued']` was undefined);
- a queued run could not be stopped, a second click on Execute while queued
  sent another start, and the v2/W10a/W11a error codes had no copy.

## 2. What changed

| Area | Change |
|---|---|
| Sidecar relay | Relayed progress carries `runId` (with `runSeq`), so the cloud path de-duplicates like the local one. |
| Run model phases | `compacting`, `recovery_required`, `abandoned` are real phases (labels, descriptions, tones, icons; the last two terminal). `RUN_STATE_PHASE` / `phaseForRunState`: `finishing` is shown as committing/publishing from the beat's status. |
| Decoder | v2 beats keep `runId`, `runSeq`, `runState` (validated); `queued` accepted. |
| Folding | De-dup by `(runId, runSeq)` — the same key as journal events. A new `runId` opens attempt N+1 behind a divider; late beats of an earlier run are ignored; a lower `runSeq` never rewinds the phase; within a run only `runState` moves the phase (a status-only beat can't knock "Awaiting approval" back to "Running"), except publication steps inside `finishing`. |
| Reload / reconnect | `useRunModel` fetches the sidecar's durable run state (`GET /api/tasks/:id/run`) on mount and after every reconnect and folds it as a `run-state` input (state as of `lastSeq`, runner). A reload mid-verification shows "Verifying"; a run that hit an unprovable restart while offline shows "Recovery required". Legacy tasks (404) are unaffected. |
| Board store / card | `ExecutionProgress` gains `queued` and the v2 fields; one `isActiveProgressStatus` helper (includes `queued`) replaces four hard-coded lists — no double start while queued; the card shows "Queued" with a clock (the crash is fixed). |
| Stop (FE-06) | Stop is offered for a run waiting in the engine queue (`phaseSource: journal`), not for a start request still in flight; available in verifying/compacting/awaiting approval. |
| Recovery actions (FE-06) | `RunRecoveryActions` for `recovery_required` / `abandoned`: what happened, then **Inspect the work** (opens the Review tab) and **Run again** — never a silent retry. Wired in the task detail view. |
| Runner (FE-02, partial) | The header names the runner the attempt actually uses (from the run state): OpenCode / Claude Code / Codex. |
| Review gate | `compacting` is live (no override while the agent works); `recovery_required` / `abandoned` block with their own reason. |
| Error copy | `RUN_ACTIVE`, `RUN_ENGINE_STOPPED`, `RUN_JOURNAL_LOCKED`, `PARALLEL_LIMIT_REACHED`, `CLAIM_FAILED`, `RUN_NOT_FOUND`, `RUNTIME_NOT_REATTACHABLE`, `FOLLOW_UP_UNSUPPORTED` (workspace expired), `TASK_FENCE_REJECTED`, `CLOUD_API_UNREACHABLE`, `GITHUB_APP_REQUIRED` (install link or ask an admin), `GITHUB_APP_UNAVAILABLE`, `GITHUB_APP_TOKEN_REJECTED`, `GIT_CREDENTIAL_UNUSABLE` (git ≥ 2.31), `VERIFICATION_REQUIRED`, `VERIFICATION_CONFLICT`; the INVALID_RUNNER hint names all three runners. |

## 3. Evidence

| Gate | Result |
|---|---|
| `lib/run-model/model.test.mjs` | +6 — every state in order from recorded-shape v2 fixtures (`v2VerifiedRun`); recovery/abandoned distinct; replay + relayed copy fold nothing (version unchanged); older seq never rewinds; new run → attempt 2, late beats ignored; queued from the engine; defensive decoding |
| `components/execution/use-run-model.test.mjs` | +3 — reload mid-verification shows Verifying + Claude Code, older replay ignored, next live beat advances; reconnect re-reads run state (→ Recovery required); never-run task doesn't ask |
| `components/execution/run-kit.test.mjs` | +3 — queued stop (engine vs request; verifying/compacting/approval), recovery actions order + callbacks, abandoned copy; runner display name |
| `components/review/model/checks.test.mjs` | +1 (v2 phases in the gate) |
| `lib/api/errors.test.mjs` | +1 and 11 codes added to the required set |
| desktop-ui full | 1037 passed + 9 skipped (was 1022) |
| sidecar full / API run-engine e2e | 1083 + 3 / 14 + 1 (relay `runId` change) |
| typecheck 11/11, `pnpm lint` 330 | clean |

## 4. Not done / owed

- **FE-04 approval inbox**: blocked on the backend — the v2 engine decides
  permissions by policy (logged "Permission granted by policy") and there is
  no approval-intent API (user, attempt, policy version, operation digest,
  deadline). The `awaiting_approval` phase is shown; cards come with the API.
- **FE-02 runner catalogue**: the header shows the actual runner; a picker
  with health/version/availability needs a sidecar catalogue endpoint.
- FE-06 "interrupt vs cancel" distinction and "salvage": the engine has one
  cancel; resume = follow-up turn (shipped in W07a).
- Per-check live progress in the drawer (verification beats appear as log
  lines and the phase; a checks list lives in the Review tab).
- Screenshots of the new states.
- `components/board/execution-monitor.tsx` is unused (dead code) — candidate
  for removal.
