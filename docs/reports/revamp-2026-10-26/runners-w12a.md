# FE-02 runner selection + W12a run hardening

Date: 2026-10-27. Coordinator, working alone. Status: **implemented and
locally validated; not committed, not deployed.**

## 1. FE-02 — choose the runner, with real availability

Before: Claude Code and Codex ran on the v2 engine (W07a) but nothing in the
desktop app could select them; the API stored any string as `task.agent` /
`project.defaultAgent` (a typo surfaced later as a failed run), and the
runner catalogue (W07) had no route.

| Piece | Behaviour |
|---|---|
| API `schemas/runner.ts` | `task.agent` (create **and** update) and `project.defaultAgent` accept only `opencode` / `claude-code` / `codex`; the aliases the sidecar always accepted (`claude`, `openai`, `openai-codex`, any case) are stored canonical; anything else is a 400 at write time. |
| Sidecar `GET /api/runners` | Per runner: available (installed + signed in for the sandbox mode), **executable** (the current engine can run it — the legacy engine runs OpenCode only), the reason when not ("Not signed in to Claude Code on this device", "Signed in, but the sandbox can't reach the … login", not installed…), version, auth state, features (resume / approvals / interrupt / model discovery); sandbox summary. Health checks are cached 30 s; `?refresh=1` at most every 5 s. Engine = `runEngineActive()` (v2 only with API persistence). |
| Desktop `RunnerSelect` | Task sidebar **Agent** (inherits "Project default (X)") and project settings **Default agent**. Unrunnable runners are disabled with the reason; a stored choice that became unrunnable stays visible with a warning ("Runs of this task will fail until…"); without a reachable sidecar (web) every runner is offered and availability says "unknown". |

## 2. W12a — run hardening

| Gap (ledger leftover) | Change |
|---|---|
| Interactive-session revocation never reached running executions (runengine #8) | The attempt records the session that started it (`credentialId` for `authSource: session`). Every re-authorization (claim, git credential, renewal, publication) checks it: signed out / revoked / expired → 403 `EXECUTION_ACCESS_REVOKED`. A session the **refresh flow rotated** stays valid while its family has a live successor (the user is still signed in); a family revoked by refresh-token reuse or "sign out everywhere" stops the run. Pre-W12a attempts and sessionless test tokens are not session-checked. |
| `turn.finished{max_turns}` counted as success (v2native #6) | Reducer: a turn that hit its limit is **not** published as success — the run fails with "The agent stopped at its turn limit before finishing", the worktree and commits are kept, and a follow-up continues it (tested end to end). *Behaviour change; reversible in `process-agent-event.ts` if the owner prefers publishing partial work.* |
| A failed follow-up projected `cancelled` on a task that already had a PR (v2native #5) | A follow-up turn that fails or is cancelled leaves the task **done with its pull request**; the outcome says so truthfully ("Follow-up failed: …; the pull request is unchanged", or "…includes the commits this turn pushed" when the turn had pushed before stopping). The run itself is still recorded failed/cancelled. Not under a sealed `require-pass` policy (the `done` gate needs this attempt's own passing evidence) — there the turn projects `cancelled` as before. |

## 3. Evidence

| Gate | Result |
|---|---|
| API `runner-selection.test.ts` (new) | 3/3 — alias normalization on create/update, null clears, unknown refused on task and project |
| API `execution-session-revocation.test.ts` (new) | 3/3 — session recorded; signed out → git-credential and renewal 403; refresh-rotated with live successor → allowed, family revoked → 403; expired → 403 |
| Sidecar `routes/runners.test.ts` (new) | 3/3 — availability + reasons + features, legacy engine restriction, cache/refresh throttling |
| Sidecar `run/follow-up.test.ts` | +3 — turn limit fails/keeps work then follow-up publishes; failed follow-up keeps task done + PR (run failed, attempt terminal done); cancelled follow-up keeps it |
| execution-core `agent.test.ts` | +1 (max_turns) |
| desktop-ui `runner-select.test.mjs` (new) | 5/5 |
| Full suites | API 773 + 3 skipped; sidecar 1103 + 3; integration 26; execution-core 69; desktop-ui 1048 + 9; typecheck 11/11; lint 341 |

## 4. Still open (W12)

- Graceful interrupt vs forced cancel as two distinct commands, with grace/kill deadlines surfaced to the UI.
- Adopting an enforce-mode sandboxed OpenCode server after a sidecar crash (persisted adopt handle + orphan reaping) — today `recovery_required`.
- Claude Code / Codex reattach after a sidecar crash (needs a supervisor process that survives the sidecar).
- Per-run provider keys for Claude/Codex (Keychain logins need a trusted-host grant or a credential broker — W10 inference broker).

## 5. W08a — isolated checkouts for local-folder projects (same day)

Before: a local-folder project's run created and **checked out** a branch in
the user's own repository, the agent edited the user's working tree, and the
commit was made there. A run therefore switched the user's branch, mixed
with their uncommitted work, and could leave their checkout on
`openlinear/<id>`.

Now (`workspace/local-worktree.ts` `acquireLocalFolderCheckout`, wired in
`run/workspace.ts`): the run works in its own clone at
`<repos>/worktrees/<runId>` on `openlinear/<runId>`, started from the
folder's HEAD — the same layout as remote runs, so retention, follow-ups,
review diff and verification apply unchanged.

- The user's checked-out branch, working tree, index, branch list and
  worktree metadata are never modified.
- A local clone hard-links objects (copies across filesystems): no alternates
  into the user's object store, so the agent sandbox (which reads only its
  own checkout) can run `git status`/`diff`, and `git gc` in the folder can't
  break a run.
- The clone's `origin` is the folder's `origin` (push and PR as before); a
  folder without a remote gives a clone without one.
- Uncommitted changes in the folder are **not** part of the run (behaviour
  change); the run log says so ("commit them first to include them").
- Refused: relative paths, a sub-folder of a repository, folders inside
  OpenLinear storage.

Evidence: `workspace/local-folder.realgit.test.ts` 4/4 (folder untouched
byte-for-byte after an agent commit; no alternates; origin mirrored; no
remote case; refusals; workspace port owned + release); sidecar 1107 + 3;
API run-engine e2e 14 + 1; lint 342; typecheck 11/11.

## 6. W08 — mirrors in the disk budget (same day)

The 20 GiB budget used to count only worktrees; bare mirrors
(`<repos>/<owner>/<name>.git`) grew without bound and were never removed.
Now the retention sweep (`workspace/retention.ts`) also:

- removes a mirror that **no existing worktree uses** (checked through git's
  own `worktrees/<id>/gitdir` pointers, so journaled, legacy and in-flight
  worktrees all count) once it has been unused for `retainMs` — reason
  `unused_cache`, receipted like every removal;
- counts every mirror toward `maxBytes`, and removes unused mirrors (least
  recently used) **before** any worktree when over budget;
- takes the mirror's clone lock (`withRepoLock`) and re-checks its use inside
  it, so a run being set up can't lose its mirror mid-clone; an admin entry
  it can't read keeps the mirror (never remove on doubt).

Evidence: `workspace/retention.test.ts` +3 (11/11); sidecar 1110 + 3; lint
342; typecheck 11/11.

## 7. W15a — per-run budgets (same day)

Before: the run watchdog could enforce `maxUsd` / `maxTokens`, and usage
already reached it, but no limit was ever set — only the 6 h wall clock and
the no-progress timeout stopped a runaway agent.

| Piece | Behaviour |
|---|---|
| Settings | `settings.maxRunCostUsd` (0 < x ≤ 10 000) and `settings.maxRunTokens` (1 000 – 1 000 000 000), null = no limit; API validation + DB CHECKs; migration `20261027090000_w15a_run_budgets` (nullable columns, catalog-only). |
| Sealing | `loadExecutionSettings` puts both in the attempt snapshot; the sidecar copies them into the run snapshot (`budgets`), which is journaled — a recovered run keeps its budget; changing settings affects only runs started later. |
| Enforcement | The watchdog checks the run's own budgets on top of the service limits; on a trip the agent is interrupted → aborted, the run fails with the work kept: "it reached this run's cost budget ($0.75 of $0.50); its work was kept — raise the budget in Settings → Execution or send a follow-up" (tokens: input + output). Cost counts only what providers report. |
| UI | Settings → AI Execution → **Run budgets** card (self-contained: reads the shared settings query, saves only its two fields; local validation mirrors the API). |

Evidence: sidecar `run/budgets.test.ts` 4/4 (cost trip, token trip, no
budget no trip, snapshot sealing); API `run-budgets.test.ts` 3/3
(validation, DB constraint, snapshot); desktop-ui `run-budgets-card.test.mjs`
5/5; sidecar 1114 + 3; desktop-ui 1053 + 9; lint 344; typecheck 11/11;
fresh-DB migrate + drift: no difference.

## 8. W12a — no surviving sandboxed OpenCode servers after a crash (same day)

Before (runengine leftover #3): an enforce-mode OpenCode attempt server is a
sandboxed child of the sidecar. After a sidecar crash the new process's
manager doesn't know it, so `release` was a no-op and the server (with any
tool processes in its group) kept running.

Now: the manager records each server's launch window
(`processFor(directory)` → `{ pid, launchedAt, spawnedBy }`; the server is a
process-group leader), the OpenCode runtime journals it with the endpoint in
enforce mode, and `release` — called when a recovered run settles — closes
its own server as before or, for a server this process doesn't own, stops it
through `stopOrphanProcess`: SIGTERM → SIGKILL to the group, only when `ps`
confirms the same process (pgid + start time inside the window; a recycled
pid is never signalled, an unreadable start time is left alone).

Adopting the server (continuing the run instead of stopping it) is still not
possible — its egress proxy lived in the dead sidecar — so such runs remain
`recovery_required`, now without a leftover process.

Evidence: `run/opencode-runtime.test.ts` +2 (identity journaled only in
enforce mode; own vs foreign vs trusted-host vs identity-less release),
`sandbox/sandbox.unit.test.ts` +1 (manager identity; release ownership);
sidecar 1117 + 3; integration 26; lint 344; typecheck 11/11. The
identity check itself is the W07a `stopOrphanProcess` (already tested for
the Claude Code / Codex process runtimes).

## 9. FE-15 agent health + FE-08 budget usage (same day)

- **Settings → Agents** (`components/settings/agents-section.tsx`): each
  runner on this device with version, sign-in state, whether it can run
  tasks and why not, and what it supports in plain words; the sandbox state
  (verified provider / unavailable with the blocker / trusted-host /
  misconfigured — never shown as safe when it isn't); the engine; "Check
  again" re-runs the local health checks (`GET /api/runners?refresh=1`).
  No credentials or paths are shown.
- **Run header budget usage**: the sidecar run view carries the run's sealed
  budgets; the run model keeps them per run (reset on a new run until its
  run state arrives); the header shows "$0.42 of $2.00" / "42k of 200k
  tokens" (input + output, as enforced), and "budget $2.00 (cost unknown)"
  rather than inventing a spend.
- De-flaked `runners/claude-code/index.test.ts` "declines host requests…":
  it read the fake CLI's stdin log before the asynchronous write landed
  (passes alone, failed ~1 in 3 full runs); now waits up to 2 s for it.

Evidence: agents-section 4/4, run-kit +1, run-model +1, budgets +1 assert;
desktop-ui 1059 + 9; sidecar 1117 + 3 (two consecutive clean full runs);
lint 344; typecheck 11/11.

## 10. FE-16 / W20 slice — project export (same day)

`GET /api/projects/:id/export` (view access; registry `project:read`,
binding enforced): one versioned JSON document (`openlinear.project-export`
v1) with the project, teams, labels and every task — comments, run metadata
(status, model, tokens, cost + basis, PR, error) and verification evidence
(status, policy, checks without log tails). Excluded and listed under
`omitted`: credentials and encrypted fields, execution logs/transcripts,
audit logs, other projects. Free text (titles, descriptions, outcomes,
comments, run errors) passes through `lib/redact-text.ts` (GitHub / OpenLinear
/ provider / Slack / AWS / Google tokens, JWTs, PEM keys, Authorization
headers, `secret=…` pairs, URL credentials). Bounded to 5 000 tasks with
`truncated`. Project settings → **Export** downloads it (blob link;
server-chosen file name, never a path).

Not done: deletion/retention requests (owner decisions on retained audit
metadata), workspace-wide export, background export jobs for very large
projects. The desktop shell's handling of blob downloads should be checked
by hand (no Tauri runtime in this environment).

Evidence: API `project-export.test.ts` 3/3 (redaction corpus; export scope,
headers, redaction, logs/oauth excluded, other project excluded; access
refused), route inventory + authz matrix green; desktop-ui
`project-export.test.mjs` 3/3; API 779 + 3; desktop-ui 1062 + 9; lint 347;
typecheck 11/11.

**Security review fixes (2026-10-27).**
- A PAT with only `projects:read` (or `projects:write`) could read every issue, comment and run through the export. The route now requires `tasks:read` and `projects:read`.
- The export is bounded across the project: on top of 5,000 tasks, it keeps the newest 20,000 comments, 20,000 runs, 20,000 verifications, 5,000 knowledge versions and 2,000 plan revisions. These now come from flat capped queries instead of unbounded nested includes. `truncated` is true when anything was cut, and `truncation` says what.
- The route is limited to 2 exports per minute per person (429 `RATE_LIMITED`, scope `project-export`).
- Tests: `project-export.test.ts`, +1 PAT scope test plus the `truncation` shape.

## 11. W12: stop and redirect (steer a running agent)

- `RunService.redirect({ credential, taskId, request })`: when a turn is
  running, cancel it (reason "redirected by user"; its work is retained on
  the branch, as on any cancel) and wait for it to settle, then start a
  follow-up turn with the instruction on the same worktree/branch (resumed
  session when the runner supports it, else seeded with the diff). Nothing
  running: a plain follow-up. A turn that doesn't stop within the wait →
  409 `REDIRECT_PENDING` (the cancel stays requested; nothing new starts).
- Sidecar `POST /api/tasks/:id/redirect` (`{ message, comments? }`, same
  validation as follow-up; write access; v2 only — a legacy run answers
  `FOLLOW_UP_UNSUPPORTED`). 202 `{ runId, attemptId, state }`.
- Desktop: **Redirect** next to Stop in the task header once the agent is
  working (not while queued/preparing): a short instruction box, "Stop and
  redirect"; the activity shows the new turn as queued until it reports.
  `REDIRECT_PENDING` has its own copy. Desktop route table updated.
- Tests: run service (stop → continue on the same worktree with the
  instruction in the prompt; plain follow-up when idle; REDIRECT_PENDING
  starts nothing), route (202, validation, pending, legacy), component (send,
  pending copy), desktop routing case. Sidecar 1128 + 3; desktop-ui 1099 + 9.

