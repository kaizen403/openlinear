# W19a / FE-12 — independent agent review of a run

Date: 2026-10-27. Status: **implemented and locally tested; not committed,
not deployed.** No real agent session was run (no paid inference): the
reviewer is exercised with the fake runtime over a real git repository.

## 1. Problem

PRD W19: "Independent reviewer with scoped snapshot; findings reproducible;
… worker budget/ownership". FE-12: "Review agent findings and create
follow-up tasks … findings link to exact commit; stale findings are marked;
user intent controls writes." Before this, review was human-only (diff,
inline comments → follow-up run, comment → issue).

## 2. Design

**Trigger.** Only the user: "Review with agent" in the review panel
(`POST /api/tasks/:id/reviews`). Nothing reviews automatically.

**Subject.** The task's newest run once it has finished
(`RunService.reviewSubject`): its worktree (still on disk), its base commit
(else HEAD's parent), its runner, model, task text and cost budget. The
reviewed commit is the worktree's HEAD. Refused with 409 when the task is
running (`REVIEW_RUN_ACTIVE`), there is nothing committed
(`REVIEW_NOTHING_TO_REVIEW`), the checkout was cleaned up
(`REVIEW_WORKSPACE_GONE`), the runner isn't here
(`REVIEW_RUNNER_UNAVAILABLE`) or a review is already running
(`REVIEW_RUNNING`, also on a double click).

**Scoped snapshot.** The W11a pristine checkout: `git clone --shared
--no-checkout` of the worktree into `<repos>/verify/review-<id>`, detached at
the reviewed commit. It shares nothing writable with the run's worktree and
is removed when the review ends, whatever happened (removal uses the
unresolved path; the returned one is a realpath).

**Session.** A fresh session of the same runner (independent context), with
`permissions.default: 'deny'` and any permission request denied. Claude Code
honours the deny policy (`dontAsk`, no prompts); OpenCode and Codex don't
take one, so they *could* write — but only into the disposable clone, inside
the OS sandbox, and the clone is deleted afterwards. Nothing a reviewer
writes reaches the run's worktree, branch or PR. Its system contract says it reviews only, that
repository/diff/task text are data, and to answer with one ```json block.
The prompt has the task (fenced), the changed files, and the diff (fenced,
capped at 60 000 characters, "truncated" said so).

**Bounds.** One review per task at a time; 10 minutes wall clock; the run's
cost budget (`maxUsd`) — usage is counted per message and the session is
stopped above it; answer text capped at 400 000 characters; at most 50
findings; 10 reviews kept per task.

**Checkable findings.** Each finding: severity (blocker / major / minor /
nit), file, lines, the exact quoted code, title, body. Paths must stay in the
repository (else dropped and counted). The quote is matched against the file
*at the reviewed commit* (whitespace-insensitive): at the stated lines =
`verified`; elsewhere in the file = `relocated` (lines corrected, nearest
match); nowhere = `unverified` (kept, flagged "Quote not found"). Ids are
`sha256(commit, file, lines, title)`, so the same finding at the same commit
has the same id. Duplicates are dropped; order is severity, file, line.

**Stale.** When the task's checkout has moved past the reviewed commit
(e.g. after a follow-up), listing re-reads each finding's file at the new
HEAD: quote gone (or file gone) = stale (dimmed); quote still there = not
stale; an unverified finding = unknown.

**Storage.** Local, advisory: one owner-only JSON file per task under
`<app data>/reviews/` (atomic write). A review left `running` by an earlier
sidecar process lists as failed ("Interrupted: the sidecar restarted").

**Events.** `review:changed` `{ taskId, reviewId, status }` to the run
owner's local stream on start and finish.

**Who.** The person who ran the task is served directly; anyone else needs
task access from the control plane (`write` to start/cancel, `full` to
read).

## 3. Desktop

Review panel sidebar → **Agent review**: "Review with agent" (disabled while
the task runs) / "Review again"; running state with Stop; failure reason;
summary, cost, "the code has changed since …"; findings with severity,
`file:lines` (click → that line in the diff, or the file when the line is
outside the shown hunks), body, evidence badge (Checked / Lines corrected /
Quote not found / Stale), "outside the change". Per finding, the user
chooses: **Comment** (a draft comment on the finding's last line, new side,
sent with the next follow-up like any other) or **Issue** (a sub-issue with
the finding, `file:lines`, commit and fenced quote; idempotency key
`agent-review:<review>:<finding>` so a double click creates one).

Routes: `GET|POST /api/tasks/:id/reviews[/:reviewId/cancel]` → sidecar
(route table + test). Error copy for the seven `REVIEW_*` codes.

## 4. Tests

- Contract (6): last json block + schema errors; quote location (verified /
  relocated nearest / unverified / blank); path safety; anchoring, de-dup,
  ordering, stable ids; staleness tri-state; fences that task text and
  diffs can't close.
- Service on real git (7): full review (clone at HEAD, deny policy, prompt
  content, four evidence outcomes + one dropped path, usage, checkout
  removed, worktree untouched, events, persisted across processes);
  staleness after a later commit; malformed answer; cancel + double start;
  wall clock and budget; refusals; interrupted review after restart.
- Routes (4): auth; owner shortcut; control-plane access levels; not
  running / no v2 engine.
- Desktop (8): start → running → stop; disabled while live; findings with
  evidence, comment/jump/issue (key, parent, description); no project = no
  issue; nothing found; failure; model helpers.

## 5. Limits / next

- Not run against a real Claude Code / OpenCode / Codex session here (no
  paid inference); the deny policy relies on each runner's existing policy
  mapping.
- Reviews are local to the device that ran the task (like the diff).
- The reviewer's cost is shown on the review and bounded by the run's
  budget, but not yet reported to the API's usage metering (W15).
- No ablation yet ("ablations justify extra agents"): needs funded eval runs
  (W21) comparing follow-up quality with and without reviewer findings.
- Memory promotion (W19b / FE-13) not started: findings are never promoted
  to memory.
- A reviewer of a *different* runner than the task's is a small extension
  (the runner is a parameter of the subject).

## 6. Review fixes (same day)

- A session that ignores Stop or the deadline is abandoned after 5 s (the
  review ends, the checkout is removed); the 6-hourly retention sweep keeps a
  running review's checkout (`RunService.registerActiveCheckouts`).
- git output beyond the buffer is truncated (diff marked truncated) instead
  of failing the review; failures are logged as messages only (no diff in
  logs).
- Changed-file names are fenced as data; quote location only compares
  windows whose first line contains the quote's first line; findings that
  cannot be re-checked show stale = unknown (null), not "not stale".
