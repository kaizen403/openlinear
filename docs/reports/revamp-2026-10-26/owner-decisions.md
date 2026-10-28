# Owner decisions — what is blocked on you (2026-10-27)

Everything below is implemented up to the decision; each item says what
happens today, the options, a recommendation, and the work left once you
decide. None of it needs a deploy to decide.

## 1. Do cancelled blockers still block?

- **Today:** only `done` resolves a "blocked by" edge; a cancelled blocker
  keeps its dependents blocked (they can still run with "Run anyway").
- **Options:** (a) keep; (b) cancelled also resolves; (c) per-project setting.
- **Recommendation:** (a) keep. A cancelled prerequisite usually means the
  plan changed; silently unblocking dependents runs agents on a broken
  premise. People remove the edge or use "Run anyway".
- **Work if (b)/(c):** ~1 h (`isResolvedTaskStatus`, unblocked notifications,
  board filters, tests).

## 2. May agents approve plans when the user asks?

- **Today:** `openlinear_approve_plan` (MCP) and the API allow it with a PAT;
  the tool says "only when the user asks". Home Chat cannot approve.
- **Options:** (a) keep; (b) people only (like project knowledge: PATs get
  403); (c) allow but require a confirmation code like destructive chat tools.
- **Recommendation:** (b), matching knowledge — approval creates issues that
  agents then execute, so it is the same trust step.
- **Work:** ~1 h (session check in `approvePlan`, MCP tool removed or turned
  into "request approval", docs, tests).

## 3. Batch pull requests: one per task, or one per batch (W13b)?

- **Today:** a batch runs its tasks as ordinary runs, each with its own branch
  and PR, in blocker order.
- **Options:** (a) keep per-task PRs; (b) combined mode: one session/worktree,
  one PR for the batch; (c) per-task PRs plus an optional stacked/combined PR.
- **Recommendation:** (a) now; (c) later if reviewers ask. Per-task PRs keep
  verification, review and revert per task.
- **Work if (b):** large (2–3 days): batch worktree ownership, sequential
  sessions in one checkout, combined verification and publication.

## 4. Create the real GitHub App; rotate leaked secrets

- **Today:** per-effect GitHub App tokens are implemented (W10); without a
  real App the system falls back as documented. Secrets that were in the
  repo history must be rotated.
- **Action (you):** follow `docs/runbooks/github-app.md` (create the App,
  set its env vars), then rotate the listed secrets.
- **Unlocks:** PR-comment follow-ups ("@openlinear fix this" on a review),
  issue sync, checks — not built yet; ~1–2 days each once the App exists.

## 5. Deletion and retention (FE-16, W20)

- **Today:** project export works (tenant-scoped, redacted). Deleting a
  project cascades its data; there is no account/workspace deletion request
  flow, no retention windows beyond the existing job prunes.
- **Needed from you:** retention periods (run logs, transcripts, audit
  metadata, exports), who can request deletion (user / workspace owner), and
  what audit metadata is kept after deletion (legal basis).
- **Recommendation:** 30-day soft delete for workspaces/projects, audit
  metadata kept 1 year, transcripts 90 days, immediate hard delete on request
  after the grace period.
- **Work after decision:** ~1–2 days (request + grace + job + UI + export
  before delete).

## 6. Running scheduled issues unattended

- **Today:** recurring issues (W20) only *create* issues; a person runs them.
- **Needed from you:** may a schedule start a run automatically, on which
  device (runs are local), with which approval mode and budget?
- **Recommendation:** allow "run on create" only when the schedule owner's
  device is online, with approval mode forced to "ask" for commands and a
  per-schedule cost cap; otherwise queue the issue as today.
- **Work:** ~1 day (device presence, sidecar pickup of queued runs, caps).

## 7. Funded evaluation runs (W21) and ablations

- **Today:** the offline harness, sealed holdout and smoke manifest exist;
  W16b's retrieval ablation is offline; the reviewer (W19a) and knowledge
  (W19b) have no outcome measurements.
- **Ready now:** three paired ablations (repository context, project
  knowledge, reviewer pass) run offline with fakes (`pnpm eval:cli ablation
  smoke all`); funded runs are one `run … --confirm-spend` away
  (`evals.md` §12).
- **Cost (worst case, $10/task cap, 5 repeats):** sample holdout (4 tasks)
  $440 / $440 / $880; a 40-task holdout $4,400 / $4,400 / $8,800. Real spend
  is usually far below the cap.
- **Needed from you:** a model budget, which runners/models to compare, and
  (for knowledge) a fixture written for the private holdout.
- **Work:** running the harness is mechanical once funded; analysis ~1 day.
