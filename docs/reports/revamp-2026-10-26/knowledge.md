# W19b / FE-13 — project knowledge (provenance-bearing memory)

Date: 2026-10-27. Status: **implemented and locally tested; not committed,
not deployed.** No agent was run against it (no paid inference); the run
engine is exercised with the fake runtime.

## 1. Problem

PRD W19: "only evidence-backed memory promotion with expiry/retraction;
sealed tasks cannot enter memory". FE-13: "Workspace memory and procedures
browser with edit/delete/history … provenance-bearing memory, explicit
promotion, retention/delete APIs and versioned skills … untrusted
repository/tool content cannot silently become trusted policy or memory."
Before this, every run started from the task text alone: what a team learned
(conventions, procedures, pitfalls) had to be repeated in each task.

## 2. Model

`KnowledgeEntry` (`knowledge_entries`) per project: kind (convention /
procedure / note), title (≤ 120), body (≤ 4 000), status (proposed / active /
retracted), source (user / agent / review_finding) + `sourceRef` (task, run,
review, finding, commit, chat session), latest revision number, optional
expiry, who created / last changed / approved / retracted it and why.
`KnowledgeVersion` (`knowledge_versions`): one row per change (created,
edited, approved, retracted, restored) with the content and status as of that
change. Migration `20261027250000_w19b_project_knowledge` (CHECKs on kind,
status, source, lengths, approval and retraction pairing). Project delete
cascades; project export includes entries and their full history (text
redacted).

## 3. Trust rules

| Who | Can |
|---|---|
| Signed-in person (session) with full project access | create (active at once), edit (new revision; vouches for it), approve proposals, retract / reject (with a reason), restore |
| Personal access token (MCP worker, scripts, agents) | create **proposals** only, edit its proposals while still proposed; approve / retract / restore / edit active entries → 403 `KNOWLEDGE_PEOPLE_ONLY` |
| Viewer | read entries and history |

- **Provenance:** a `sourceRef.taskId` must be a task of the same project
  (`KNOWLEDGE_SOURCE_INVALID`); a task labelled `sealed` or `eval:sealed`
  cannot be a source (`KNOWLEDGE_SEALED_SOURCE`) — evaluation tasks never
  leak into memory.
- **Revisions:** edits and approvals name the revision they are based on;
  anything else is 409 `KNOWLEDGE_VERSION_CONFLICT` (`details.latest`), so a
  person never approves text they did not see.
- **Quota:** 200 entries that are not retracted per project, under an
  advisory lock (`KNOWLEDGE_QUOTA_EXCEEDED`).
- Retraction keeps the entry and its history; a retracted entry is never
  given to runs and must be restored before it can be edited.

## 4. What runs get

At attempt start the control plane seals `knowledge` into the execution
snapshot: active, unexpired entries, conventions then procedures then notes,
newest first, at most 20 entries and 8 000 characters (`promptKnowledge`).
The sidecar journals it with the run (`RunSnapshot.knowledge`), so a
recovered or long run keeps the revisions it started with, and appends a
"## Project knowledge" section to the **first** prompt (before the W16b
repository context): written or approved by the team, follow it unless the
task says otherwise. The run log names what was given ("Project knowledge: 2
entries given to the agent" — `Use pnpm (v3), Before a PR (v1)`), which is
the provenance link from a run back to the exact revisions.

## 5. Desktop

Project → **Knowledge**: Active / Proposed / Retracted tabs with counts;
each entry shows kind, title, text, where it came from, revision, expiry;
Approve (proposals), Edit (new revision; conflicts reload), Retract / Reject
with a reason, Restore, History (every revision). New entry form: kind,
title, text (counter), expiry (never / 30 / 90 / 365 days; keep on edit).
Agent review findings get **Remember**: the form prefilled from the finding
(edit it into a general rule), saved with the review, finding, commit and
task as its source. SSE `knowledge:changed` refreshes the list.

## 6. Tests

- API (7, real Postgres): person active / agent proposal / approval of the
  latest revision only / agent can't approve, retract or change active
  entries; revisions, conflict, retract → edit refused → restore, history
  order; access (viewer reads, can't write; stranger refused); provenance
  (finding source, sealed task refused, other project refused, unknown keys
  refused); prompt selection (status, expiry, kind order, character
  budget); sealed into the execution snapshot at start; quota. Full API
  suite 80 files 836 + 3 on a fresh DB; no schema drift.
- Sidecar: prompt section order and the revisions log line (with repository
  context present).
- Desktop: form (create keyed with kind/expiry/provenance, edit with
  baseVersion, conflict copy, expiry mapping), list (approve, retract with a
  reason, history, restore, provenance, empty tabs), Remember prefill.

## 7. Limits / next

- Home Chat has `list_knowledge` and `propose_knowledge` (the assistant only
  proposes, with the chat session as source; the tool card links to the
  Knowledge page). MCP has `openlinear_list_knowledge` and
  `openlinear_propose_knowledge` (a PAT, so always a proposal; keyed, retry-
  safe); docs page `/tools/knowledge`. MCP 113 tests, 30 tools.
- Project-scoped only; no workspace-wide knowledge.
- No automatic promotion of anything: every active entry was written,
  edited or approved by a person.
- Whether knowledge improves runs is not measured (needs funded evals, W21).

## 8. Review fixes (same day)

- An agent (PAT / chat) may edit only its own user's agent proposals.
- Restoring a rejected proposal brings it back as a proposal (approval
  stays a separate, revision-bound step); a retracted approved entry comes
  back active.
- At most 50 open agent proposals per project (`KNOWLEDGE_PROPOSALS_FULL`),
  so agents cannot use up the quota people need.
