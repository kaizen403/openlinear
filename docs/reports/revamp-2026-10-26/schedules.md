# W20 / FE-14 — recurring issues (schedules)

Date: 2026-10-27. Engineer id: `schedules` (background agent).
Status: **implemented and locally validated; not committed, not deployed.**

## 1. Problem

PRD W20 asks for "schedules idempotent/cancellable with quotas and
approvals"; the frontend backlog has FE-14 (schedules). Nothing in OpenLinear
could create work on a cadence. This slice is **issue creation on a schedule**
(like Linear recurring issues): every day, every weekday, every week or every
month, a template becomes an issue in a project.

Out of scope, on purpose: **running** the created issue. Execution happens in
the user's local desktop sidecar and needs an approval policy the owner has
not decided (who approves an unattended run, with which budget, on which
machine). Schedules only create issues; a person runs them as usual (board
Execute, batches, "Run with blockers"). Follow-up: "run on create" behind
FE-04 approvals and W15 budgets, once the owner picks the policy.

## 2. Model (migration `20261027210000_w20_issue_schedules`)

| Table | Notes |
|---|---|
| `issue_schedules` | Project (FK cascade), template (`title` 1-200, `description` ≤ 10 000, `priority`, `labelIds` ≤ 20, `assigneeId?`), rule (`cadence` daily/weekdays/weekly/monthly, `weekday` 0-6 only for weekly, `dayOfMonth` 1-28 only for monthly, `hour`, `minute`, IANA `timezone` ≤ 64), `nextRunAt`, `lastRunAt`, `pausedAt`, `pauseReason` (only when paused), `ownerId`, `createdById`. All rules are CHECK constraints. |
| `issue_schedule_occurrences` | One row per handled slot: **unique `(scheduleId, slotAt)`**, `slotAt` a whole minute (CHECK), `kind` scheduled/manual, `outcome` created/skipped (created ⇒ no reason; skipped ⇒ reason and no task), `skippedSlots` ≥ 0, `taskId` unique (FK SET NULL: deleting the issue keeps the history), cascade with the schedule. |

The team that numbers the issues is the project's team at run time (same
rule as task create and plan approval), not stored: a team moved out of the
project can't receive issues. Labels deleted since are left out; an assignee
who left the team is dropped (issue unassigned). Additive migration; drift
against the schema: 0.

## 3. API

| Route | Notes |
|---|---|
| `GET /api/projects/:id/schedules` | `{ items, limits }`. View access. |
| `POST /api/projects/:id/schedules` | Full access + team member. `Idempotency-Key` (operation `schedules.create`). Labels must be the project's, the assignee a team member, the zone known (canonical spelling stored: `europe/berlin` → `Europe/Berlin`; offsets refused). Creates no issue. |
| `GET /api/schedules/:scheduleId` | Schedule + 20 most recent occurrences (with their issue). |
| `PATCH /api/schedules/:scheduleId` | Any subset; a new rule recomputes `nextRunAt` from now; a cadence change drops the day it no longer uses. The caller becomes the owner. |
| `DELETE /api/schedules/:scheduleId` | Immediate; created issues stay (204). |
| `POST /api/schedules/:scheduleId/pause` · `/resume` | Pause is immediate (paused = never due). Resume starts from now — slots missed while paused are not created — counts toward the quota, and makes the caller the owner. |
| `POST /api/schedules/:scheduleId/run-now` | One issue now, created by the caller (also when paused); 201, or 200 `created: false` with the same occurrence when this minute already has one. Does not move `nextRunAt`. |

Registry rows: `tasks:read` / `tasks:write`, enforcement `project`, new
resource param `schedule` (route inventory probes a foreign schedule for
GET/DELETE, bound PATs, outsiders; the "left in place" check covers it).
Events (outbox, project audience): `schedule:created|updated|deleted`
(`{ scheduleId, projectId }`), and the normal `task:created` (task DTO, task
audience) for every issue a schedule creates. Activity `task_created` with
`source: 'schedule'`; the assignee gets the usual assignment notification.

Error codes: `SCHEDULE_NOT_FOUND` (404), `SCHEDULE_QUOTA_EXCEEDED` (409,
`details: { kind: 'active' | 'total', limit }`), `VALIDATION_ERROR` with
`details.field` for rule/zone problems.

## 4. Creating issues: claiming and idempotency

Job `schedule-run` (every minute), registered in both runners of
`jobs/index.ts` — the interval loop and the pg-boss cron table — which stay
mutually exclusive per process (`startBackgroundJobs`; the pg-boss wiring
test now lists the queue).

1. Scan due schedules (`pausedAt IS NULL AND nextRunAt <= now`, oldest
   first, ≤ 100 per run).
2. Per schedule: read whether the owner may still create issues (outside the
   transaction), then in **one transaction**:
   - `SELECT … FOR UPDATE SKIP LOCKED` on the row — a second worker skips it
     instead of waiting — and re-read it after the lock (paused? owner or
     project changed? still due?). Due-ness is compared in JS: raw timestamp
     parameters would be compared in the session time zone (the local
     cluster runs `Asia/Kolkata`).
   - Compute the slot (§6). If an occurrence for that minute exists ("run
     now" took it), just advance.
   - Otherwise create the issue (`insertProjectTasks`: atomic team
     numbering), the occurrence, the `task:created` and `schedule:updated`
     events, and advance `nextRunAt` / `lastRunAt`.
3. A schedule that throws is logged and retried next minute; the others go on.

So a slot creates at most one issue however many workers, retries or "run
now" clicks race: row lock first, unique `(scheduleId, slotAt)` as the
backstop. "Run now" takes the same row lock (waiting) and checks the minute's
occurrence first.

**Owner access.** Issues are created as the owner with the owner's current
rights (full project access + team member). If that no longer holds, the
slot is recorded `skipped` (`owner_lost_access`; `project_has_no_team` for a
project without a team) and the schedule **pauses itself** with that reason.
Whoever resumes it (and may create issues) becomes the owner. A background
job never acts with rights its owner lost.

## 5. Daylight saving and time zones

Slot math is pure (`services/schedule-slots.ts`), `Intl.DateTimeFormat`
only, no new dependency. Wall-clock rules = Temporal's `compatible`:

- a time that doesn't exist that day (spring forward: 02:30 when clocks jump
  02:00 → 03:00) fires once, shifted by the gap (03:30);
- a time that happens twice (fall back: 01:30) fires once, the first time;
- the local time is kept across the change (09:00 EST → 09:00 EDT).

Tested: New York spring/fall, Berlin fall back, Sydney (southern hemisphere),
Santiago (transition at midnight), Lord Howe (30-minute shift), weekdays
across a weekend, weekly, monthly in February, `{date}` in the zone (the
title token becomes the slot's local `YYYY-MM-DD`). Zones are validated
against the runtime's ICU data and stored canonically.

## 6. Missed slots (downtime)

`nextRunAt` is always the first unhandled slot. When the job finds several
slots passed (API down for days), it creates **one** issue for the most
recent due slot and records how many earlier ones it skipped
(`skippedSlots` on that occurrence): never a flood. Example: daily 09:00,
down from Friday to Tuesday 10:00 → one issue for Tuesday 09:00,
`skippedSlots: 4`. The count saturates at 10 000 (27 years of daily slots).
Paused periods are never caught up.

## 7. Quotas and limits

- ≤ 25 **active** schedules per project, ≤ 50 in total (paused included);
  checked on create and resume under a per-project advisory lock (three
  concurrent creates at 24 → exactly one succeeds; tested).
- Finest cadence is daily, so a project gets at most 25 scheduled issues a
  day, plus "run now" at most once per schedule per minute (the general
  per-principal rate limit applies too).
- The job handles ≤ 100 due schedules per minute per worker; more wait a
  minute (SKIP LOCKED lets several workers share the load).
- Project delete removes its schedules (FK cascade; tested); their issues
  stay with the project-less tasks as before.

## 8. Desktop (FE-14)

Project → **Recurring issues** (`/projects/schedules?id=…&name=…`): list with
cadence in words (zone shown only when it isn't the device's), next run in
the device's local time (or "Paused" + the automatic-pause reason), last
issue; **Run now** (toast names the created issue), **Pause/Resume**,
**Edit**, **Delete** (confirm: "issues it already created are kept"); a form
for create/edit (title with `{date}` hint, description, repeats / weekday /
day of month, time, time zone defaulting to the device's, priority, assignee
from the project's team, project labels). Creates are keyed with an
`IdempotencyIntent` (same body → same key). Error copy for the two new codes.
Query keys live in `lib/api/schedules.ts` (`scheduleKeys`) until they move to
`lib/query/keys.ts`; the sidebar link and SSE wiring are listed for the
coordinator (files they own).

## 9. MCP (28 tools)

`openlinear_list_schedules` (read-only) and `openlinear_create_schedule`
(keyed, retry-safe; `time` as `HH:MM`, cadence + weekday/dayOfMonth, IANA
zone). Server instructions mention them; fake API and contract test added;
tool catalogue regenerated; docs site has a "Recurring issues" group, nav
entry and page. Pause/resume/delete stay in the app for now.

## 10. Validation (local, 2026-10-27, DB `openlinear_sched_test`)

| Suite | Result |
|---|---|
| API | 829 + 3 skipped (79 files; baseline 806 + 3 / 77) — `schedule-slots.test.ts` (11, pure), `schedules.test.ts` (12): create (canonical zone, next slot, keyed replay, events), validation, viewer/stranger permissions, job creates from the template once and keeps 09:00 across DST, four concurrent workers → one issue, catch-up `skippedSlots: 4`, pause immediate / resume without catch-up, run-now idempotent per minute + concurrent + paused + no duplicate with the job, owner loses access → skipped + self-pause → resume transfers ownership, PATCH semantics, delete keeps issues, project delete removes schedules, quotas incl. concurrent creates. Route inventory, PAT policy, authorization matrix, export (schedules included, description redacted), pg-boss wiring updated. |
| desktop-ui | 1190 + 9 skipped (exit 0) — `components/schedules/schedules.test.mjs` (6), `errors.test.mjs` (+1), `routes.test.mjs` (schedule functions land on the cloud API) |
| MCP | 112 (+1 contract test) |
| typecheck | api, desktop-ui, mcp, mcp-docs: 0 |
| biome | new/changed API + MCP files: clean |
| migration safety / drift | opt-in comment (indexes on new tables); `prisma migrate diff` exit 0 |

## 11. Open / next

- Owner: an approval policy for **running** scheduled issues (FE-04 approval
  mode, W15 budget, which device) — then "run on create" can be added.
- MCP pause/resume/delete tools if agents need them.
- Task detail could link back to its schedule (occurrence → schedule).
- Deploy order when shipped: migration → API (job starts with it) → MCP worker.

## Review fixes (same day)

- A schedule whose issue keeps failing backs off (1, 2, 4 … 60 min; left
  out of the sweep meanwhile, per process) and pauses itself after 5
  failures in a row (`pauseReason = creation_failed`, explained in the app).
- PATCH and resume merge into the row locked inside the transaction, so a
  concurrent template edit can no longer write back an old rule.
- The schedule detail shows a created issue only while it is still in the
  schedule's project.
