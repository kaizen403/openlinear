# FE-04 — approvals: permission requests that wait for you

Date: 2026-10-27. Engineer id: `approvals` (coordinator).
Status: **done locally** (uncommitted, not deployed) — setting, broker,
engine hook (Claude Code + OpenCode), sidecar routes, desktop.

## 1. Problem

Runners that support it (Claude Code, OpenCode) ask before using a tool.
The run engine answered every such request immediately by a fixed policy
(`permissionPolicy`, default allow), so a person could never say "not that
command". FE-04 asks for an approval inbox with deadlines, operation
previews and once-scoped answers; expired, replayed or changed-operation
approvals must fail, and a deny/cancel must reach every view.

## 2. Design

- **Setting** (`settings.approvalMode`, `auto` | `ask`, default `auto`;
  migration `20261027180000_fe04_approval_mode`, CHECK). Sealed into each
  attempt's execution settings at start (`loadExecutionSettings`), so a run
  keeps the mode it started with. Desktop: Settings → AI Execution →
  **Approvals** switch ("Ask me before the agent acts").
- **Broker** (`apps/sidecar/src/run/approvals.ts`): a request is bound to its
  run, its owner (the user who started the run) and a digest
  `sha256([runId, runner request id, tool, detail])`. It settles exactly
  once: by the owner quoting the digest (`APPROVAL_CHANGED` 409 if it
  differs; `APPROVAL_NOT_FOUND` 404 if decided, expired or unknown — a replay
  approves nothing; `APPROVAL_FORBIDDEN` 403 for anyone else), at its
  deadline (deny, `timeout`, default 15 min), or when the run ends or is
  cancelled (deny, `cancel`). In memory by design: a pending runner request
  does not survive a sidecar restart either.
- **Desktop**: the task view shows each pending request (tool, detail,
  "expires in N min", Allow once / Deny) while the task runs; the Inbox
  lists every request waiting on you across tasks. Both refresh on the
  `approval:changed` event and every 15 s, and a stale decision refreshes
  instead of applying. Error copy for the three codes.

## 3. Engine (apps/sidecar/src/run/service.ts)

- **Sealed mode.** `snapshotFromTask` copies `approvalMode: 'ask'` from the
  attempt's execution settings into the run snapshot (journaled), so a
  recovered or long run keeps the mode it started with.
- **Which runners ask.** `RunRuntime.approvals` (`interactive` |
  `policy-only`): Claude Code and OpenCode are interactive, Codex is
  policy-only. `permissionsFor(run, runtime)` starts sessions (and follow-up
  resumes / seeded sessions) with `permissions.default: 'ask'` only when the
  sealed mode is `ask` *and* the runner is interactive; otherwise the
  service policy (`allow`) applies and the run log says "codex cannot pause
  for your approval; it runs under the sandbox policy instead".
  - Claude Code: `--permission-prompt-tool stdio` (control requests →
    `permission.requested`).
  - OpenCode: the per-attempt sandboxed server is started with
    `permission: { edit, bash, webfetch: 'ask' }` (`AttemptServerManager
    .setApprovalMode`, set by the OpenCode runtime before each start /
    resume). An *idle* server of the other mode is replaced on the next
    route; a busy one is kept. The shared trusted-host server (env grant or
    FE-03 project grant, no sandbox) cannot be reconfigured per run: the run
    log says its actions are not held for review.
- **Waiting.** `onPermission` hands the request to the broker (owner = the
  run's user, digest over run, runner request id, tool, detail), logs
  "Waiting for your approval: <tool>" (critical, journaled + relayed), moves
  the run to `awaiting_approval`, and the pump waits there with its
  watchdogs suspended (the old 10-minute policy deadline is not armed in ask
  mode; the broker's 15-minute deadline denies instead, and the run carries
  on). The answer is logged ("Approved: bash", "Denied: bash", "Denied (no
  answer in time): bash", "Denied (run stopping): bash") with the request id
  and the digest prefix, then sent to the runner once (`replyPermission(id,
  decision, 'once')`).
- **Stop.** `cancel()`, `stop()`, any pump exit and any pump interrupt
  (abandon, authority lost, wall clock) deny the run's pending requests;
  after a cancel nothing is sent to the runner (it is being stopped).
- **Events.** Every request and decision publishes `approval:changed`
  (`{ taskId, runId, approvalId, state: pending|allowed|denied, by }`) to the
  run owner's local SSE stream only.
- Requests are handled one at a time per run (the pump is sequential): a
  second parallel request appears after the first is answered.

## 4. Sidecar routes (apps/sidecar/src/routes/approvals.ts, mounted on `/api` before the task routers)

| Route | Answer |
|---|---|
| `GET /api/approvals` | the caller's pending requests across tasks, oldest first, with `taskTitle` |
| `GET /api/tasks/:id/approvals` | the task's requests the caller owns (others: `[]`) |
| `POST /api/tasks/:id/approvals/:approvalId` `{ decision: allow\|deny, digest }` (strict) | `{ decision, by }`; 400 VALIDATION_ERROR, 403 APPROVAL_FORBIDDEN, 404 APPROVAL_NOT_FOUND (decided, expired, unknown, other task, no engine), 409 APPROVAL_CHANGED |

Every route authenticates like the other sidecar routes (per-route
middleware). Desktop route table: `GET /api/approvals`, `GET|POST
/api/tasks/:id/approvals[/:approvalId]` → sidecar.

## 4a. "Allow for this run" (follow-up, same day)

A decision may carry `scope: 'run'` (allow only; a deny is always once).
The runner is answered once (a runner-side session grant — OpenCode
`always` — would outlive the run into a follow-up on the same session), and
the run service remembers the tool: later requests for it in the same run are allowed
without asking ("Allowed (you allowed bash for this run)"); other tools are
still asked. The decision log says "Approved for the rest of this run:
bash". Desktop: "Allow for this run" next to Allow once / Deny on the task
card and in the Inbox. Engine test: run scope → `once` replies, the second
bash request allowed without asking, a different tool still asked.

## 5. Limits

- In memory: a sidecar restart drops pending requests (the reattached
  runner session re-asks or the run recovers as before).
- Claude Code in ask mode asks for every edit and command (its default
  permission mode with the stdio prompt tool) — that is what "Ask me before
  the agent acts" means; "Allow for this run" stops repeat questions per
  tool, but there is no saved per-project allow list.
- Real Claude Code / OpenCode sessions in ask mode were not run end to end
  here (no paid inference); the runner side is covered by the existing
  Claude control-request tests and the OpenCode server-config test.

## 6. Tests

- Broker 3 (decide once + replay; changed / other user / other task /
  expired; timeout + cancel).
- Engine 7 (`run/approvals.service.test.ts`): ask → owner allow reaches the
  runner (others can't see/answer, changed digest 409, replay 404, events,
  logs); deny carries on; timeout denies; cancel while waiting denies and
  stops without replying; auto/unsealed answer by policy; policy-only runner
  logs it; snapshot sealing.
- Routes 3 (`routes/approvals.test.ts`, real run service + fakes over HTTP):
  auth on every route; no engine; list/answer end to end with 400/403/404/409.
- OpenCode: attempt server config + idle replacement
  (`sandbox.unit.test.ts`), runtime sets the mode before start/resume
  (`opencode-runtime.test.ts`).
- Desktop 7 (cards, inbox, setting switch) + route table cases.

## 7. Review fixes (same day)

- OpenCode 1.x: the bundled server emits `permission.asked` (decoded now:
  permission, patterns, metadata) and is answered through
  `POST /session/:id/permissions/:permissionID`; before this, ask-mode
  OpenCode runs hung (no card, silent reply no-op).
- Claude Code may withdraw a request (`control_cancel_request`): the
  pending approval is withdrawn (no reply, the run goes on, log "Withdrawn by
  the agent"); a late reply is a no-op.
- The detail (and so the digest) is the full tool input, cut only above
  64K characters, visibly.
- An attempt server with a live session is never restarted for a mode
  change; an "ask" session on a policy server fails closed
  (`APPROVAL_MODE_UNAVAILABLE`) before any prompt.
