# W17b / FE-09 — reviewable plans (immutable revisions, explicit approval)

Date: 2026-10-27. Engineer id: `plans` (coordinator, working alone).
Status: **implemented and locally validated; not committed, not deployed.**

## 1. Problem

`openlinear_bulk_create_plan` turns an AI's plan straight into issues. Nobody
reviews it first, a second version can't be compared with the first, and
re-planning duplicates or overwrites work. PRD W17 asks for a schema-valid
plan with acceptance checks, estimates, dependencies; cycle/conflict
detection; idempotent creation; explicit approve/revise/supersede; and no
implicit executable authority from planning text. FE-09 is its review UI.

## 2. Model (migration `20261027150000_w17b_plan_revisions`)

| Table | Notes |
|---|---|
| `plans` | One per plan in a project: `title`, `status` (`draft` → `approved`, or `archived`; CHECK), `latestRevision`, `approvedRevision` (CHECK ≤ latest). |
| `plan_revisions` | Immutable `spec` (JSONB) + `specHash` (sha256 of canonical JSON; CHECK hex), `note`, author; only `approvedAt`/`approvedById` are written later (CHECK both or neither). Unique `(planId, number)`. |
| `plan_tasks` | Plan key → the task an approval created (`taskId` unique: one plan per task); FK cascade both ways. |

Spec (`schemas/plans.ts`): `summary?`, 1–100 `tasks` of `{ key, title,
description?, priority?, acceptance?: string[] (≤20), estimate?: xs|s|m|l|xl,
blockedBy?: key[] }`.

## 3. Checks

Refused before storing (400 `PLAN_INVALID`, `details.issues`):
`DUPLICATE_KEY`, `SELF_BLOCK`, `UNKNOWN_BLOCKER`, `CYCLE`. Shown as review
warnings: `NO_ACCEPTANCE` ("done" can't be verified), `NO_ESTIMATE`. Every
read returns `order` (blockers first) and `diff` against the previous
revision (`added`, `removed`, `changed` with field names).

## 4. API

| Route | Notes |
|---|---|
| `GET /api/projects/:id/plans` | Summaries with progress (`taskCount`, `createdTaskCount`, `doneTaskCount`). View access. |
| `POST /api/projects/:id/plans` | Draft + revision 1. Full access. `Idempotency-Key` (operation `plans.create`). Creates no tasks. |
| `GET /api/plans/:planId[?revision=n]` | Plan, revision history, one revision with checks/diff, created tasks by key. |
| `POST /api/plans/:planId/revisions` | `{ baseRevision, spec, title?, note? }` under a row lock; `baseRevision` must be the latest (409 `PLAN_REVISION_CONFLICT`); an identical spec adds nothing (200 `unchanged`). |
| `POST /api/plans/:planId/approve` | `{ revision }`, latest only (409 `PLAN_REVISION_STALE`). See §5. |
| `POST /api/plans/:planId/archive` | Read-only afterwards (409 `PLAN_ARCHIVED`). |

Registry rows: `tasks:read` / `tasks:write`, enforcement `project`, new
resource param `plan` (route-inventory probes a foreign plan). Events:
`plan:created|revised|approved|archived` (project audience), plus
`tasks:bulk-created` / `task:updated` from approval.

## 5. Approval semantics

One transaction under the project dependency lock (the same advisory lock
W17a edits take) and the plan row lock:

- **New keys** → issues (consecutive numbers via the shared
  `insertProjectTasks`), description = text + `## Acceptance criteria`
  checklist (so the agent sees the checks), status `todo`.
- **Existing keys** → **three-way**: only fields the plan changed since the
  last approved revision are written (title, description/acceptance,
  priority). Edits made on the issue itself survive (tested).
- **Keys approved before whose issue was deleted** → `skipped: deleted`, not
  recreated. Issues moved to another project → `skipped: moved`.
- **Keys dropped** → reported in `removed`; their issues are kept.
- **Dependencies** between plan issues: add what the spec wants, drop what
  the previous approval added and this one no longer wants; hand-made edges
  are left alone. An edge that would close a loop with hand-made ones →
  409 `PLAN_CONFLICT` and **nothing** is written (tested).
- Approving the same revision again → `alreadyApproved`, no writes.
- Nothing runs: approval creates/updates issues only. Running them is the
  normal Execute / batch / "Run with blockers" flow.

## 6. MCP (24 tools)

`openlinear_propose_plan` (keyed, retry-safe), `openlinear_get_plan`,
`openlinear_revise_plan`, `openlinear_approve_plan` ("only when the user asked
for it"). Server instructions describe the review flow;
`openlinear_bulk_create_plan` stays for direct creation. Catalogue
regenerated.

## 7. Desktop (FE-09)

Sidebar → project → **Plans**: list with progress and "revision N to review"
when a newer revision waits; plan view with revision picker, problems (block
approval), warnings, diff line ("Against revision 1: 1 added, 1 changed, 0
removed" + kept issues of removed keys), tasks in blocker order with
acceptance checklist, estimate, "after <keys>", new/changed badges and the
created issue's identifier + status, and **Approve and create issues** /
**Approve revision N** (latest only). Realtime via `plan:*` events.

## 8. Validation (local, 2026-10-27)

| Suite | Result |
|---|---|
| API | 799 + 3 (76 files) — `plans.test.ts` (8): checks, idempotent create, lifecycle (revise conflict/no-op, stale approval, approval once, three-way update keeps board edit, deleted task not recreated, edges added/removed), loop with hand-made edge refused atomically, access/archive, list progress |
| Sidecar | 1125 + 3 |
| Integration | 26 |
| desktop-ui | 1080 + 9 (exit 0) — `plan-review.test.mjs` (5) |
| MCP | 110 |
| typecheck / lint | 11/11 / 354 files |
| fresh-DB drift | 0 |

Also fixed: an order-dependent assertion in `task-dependencies.test.ts`
(the concurrent-edge race decided whether task E had a second blocker).

## 9. Home Chat: `propose_plan`

The in-app assistant gets a `propose_plan` tool (effect `write`; it stores a
draft and creates no issues — approval stays with people under Plans). The
tool card links "Review the plan — nothing is created until you approve it".
Chat tool count 34 → 35 (shape guard, effect and exposure tests updated);
chat suites 115/115; API 800 + 3; desktop-ui 1081 + 9. The Brainstorm panel
(`components/quick-capture/brainstorm-panel.tsx`) turned out not to be
mounted anywhere, so Home Chat is the in-app planning entry point.

## 10. FE-10: Run plan

An approved plan's review page offers **Run plan** (two-step confirm, since
it starts agents). It takes the plan's unfinished issues — not done,
archived or held by a running execution (`tasks[].running`, new on the plan
view) — in blocker-first order, at most 20 (one v2 batch). A prefix of that
order is closed under "blocked by", so a long plan runs correctly in parts
("N more next time"). It checks the model setup first, starts one parallel
batch (the W17a coordinator runs blockers first and starts an issue only
after everything it waits on succeeded — with a require-pass project that
means verified), and offers "Open board". Tests: API plan view `running`;
desktop `planRunSelection` + run flow (8 in `plan-review.test.mjs`).
Validation: API 800 + 3; desktop-ui 1084 + 9; typecheck 11/11; lint 354.

Follow-up (self-review): the sidecar caps a batch at the user's
`maxBatchSize` (Settings → AI Execution; API default **3**, max 10), so a
20-task run would have been refused with 400 `INVALID_BATCH`. Run plan and
Run with blockers now size runs by `maxBatchSizeOf(settings)` (default 3,
engine cap 20) and say how to raise it. desktop-ui 1086 + 9.

## 11. In-app plan editing

The latest revision has **Edit**: summary, task titles, estimates,
acceptance checks (one per line), blockers (keys, comma-separated), add and
remove tasks (keys of existing tasks stay fixed, new ones get a free
`task-N`), and a revision note. **Save as revision N+1** posts the full spec
based on the latest revision; problems the server finds (unknown blockers,
loops, duplicate keys) are listed in the editor instead of saving; an
identical spec says "Nothing changed". Approve is hidden while editing.
Tests: `plan-editor.test.mjs` (4) + review toggle. desktop-ui 1094 + 9.

## 12. Plan membership on issues

`GET /api/tasks/:id` returns `plan: { id, key, title, status,
approvedRevision } | null` (one raw statement; perf budget 15 → 16). The task
sidebar shows **Plan: <title> · <key>** linking to the plan review; MCP
`openlinear_get_issue` returns `plan`. API 802 + 3; desktop-ui 1101 + 9;
MCP 111.

## 13. Home Chat: list / read / revise plans

Chat tools `list_plans`, `get_plan` (read) and `revise_plan` (write; the
whole task list based on the latest revision — `PLAN_REVISION_CONFLICT`
otherwise; nothing on the board changes until people approve). The task
item schema is shared with `propose_plan`. Chat tools 38 (16 read, 15 write,
7 destructive). MCP gained `openlinear_list_plans` (26 tools). Chat suites
115/115.

## 14. Risk

Plan tasks take an optional `risk` (low / medium / high): stored in the
spec, part of the revision diff, accepted by MCP and Home Chat, shown in
review as a "medium risk" / "high risk" badge and editable in the plan
form. No cost estimate: a number derived from sizes would look more precise
than it is (left for the W15 usage ledger).

## 15. Export

The project export (FE-16) now carries `dependencies` (edges among the
exported tasks, `{ taskId, blockedByTaskId }`) and `plans` (every revision
with its spec, note and approval time, plus the key → task map). Free text
in specs (summary, titles, descriptions, checks) and notes is redacted like
task text; keys, estimates, risk, priority and blockers are kept. Format
version stays 1 (additive). Export test extended (3/3).

## 16. Open / next

- Done since: **New plan** on the Plans page (same form as Edit plus a plan
  title; keyed create, so a retry returns the same draft). desktop-ui
  1095 + 9.
- Phases (labels) are not part of the spec; `bulk_create_plan` keeps them.
- Owner: confirm that agents may approve when the user asks (tool exists,
  annotated, described as user-requested only).
