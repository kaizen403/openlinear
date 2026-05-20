# OpenLinear Architecture Refactor Plan

> **Goal**: Introduce a true `Workspace → Project → Team → Issue` hierarchy with workspace-scoped membership, per-project access control, team-scoped issues, and cross-team issue links — **without breaking existing functionality**.
>
> **Strategy**: Additive, backwards-compatible migrations. Every existing Team/Project/Task continues to work throughout the refactor. Old endpoints stay live until cutover.
>
> **Scope**: Backend, schema, API, and sidecar only. Frontend is documented as a separate final phase to be executed by a different model.

---

## 1. The Vision (User's Original Brief)

Verbatim from the conversation:

1. The product will have a **Workspace** at the top. A workspace represents a company or a community.
2. A workspace contains **multiple projects**. Projects can be entirely independent of each other (different products, different repos, no shared issues).
3. A project contains **multiple teams** (e.g. Frontend, Backend, Testing/QA).
4. A workspace has **multiple members**. Members can be granted or denied access to any project inside the workspace.
5. Projects support **cross-linking issues**, while individual issues remain owned by a single team inside the project.

This refactor implements that vision while preserving every feature that currently exists.

---

## 2. Target Architecture

### 2.1 Hierarchy

```
Workspace                  (company / community)
  ├── Members              (workspace-level identities)
  ├── Projects[]           (independent products inside the workspace)
  │     ├── Project ACL    (per-user, per-project: full | view | deny)
  │     ├── Teams[]        (frontend, backend, qa, etc.)
  │     │     └── Team members (subset of project members)
  │     └── Issues[]
  │           ├── primary team (owner)
  │           └── cross-links (blocks / blocked_by / relates_to / duplicates)
```

### 2.2 Core Principles

| Principle | Why |
|---|---|
| One workspace per company/community | Clean billing, branding, and member boundary |
| Projects are siblings, not nested | Different products do not share teams or issues |
| Teams live inside a project | Frontend in Product A ≠ Frontend in Product B |
| Issues belong to one team (or to the project) | Clear ownership; team can be `null` for project-level epics |
| Cross-links via an explicit join table | Typed relationships, audit-friendly, future-proof |
| Workspace role is the default; per-project ACL overrides | Simple by default, fine-grained when needed |
| Identifiers are deterministic and stable | `PROJ-TEAM-N` or fallback `PROJ-N` |

---

## 3. Final Data Model

### 3.1 Workspace

```prisma
model Workspace {
  id          String   @id @default(cuid())
  name        String
  slug        String   @unique
  plan        String   @default("free")
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  members     WorkspaceMember[]
  projects    Project[]
}

model WorkspaceMember {
  id           String   @id @default(cuid())
  workspaceId  String
  userId       String
  role         WorkspaceRole @default(MEMBER)
  invitedAt    DateTime @default(now())
  joinedAt     DateTime?

  workspace    Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  user         User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([workspaceId, userId])
  @@index([userId])
}

enum WorkspaceRole {
  OWNER
  ADMIN
  MEMBER
  VIEWER
}
```

### 3.2 Project (modified)

```prisma
model Project {
  id           String   @id @default(cuid())
  workspaceId  String                              // NEW (nullable during migration, NOT NULL after backfill)
  name         String
  key          String                              // NEW: short uppercase code (e.g. "OL")
  description  String?
  status       ProjectStatus @default(PLANNED)
  color        String?
  targetDate   DateTime?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  workspace    Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  teams        Team[]
  issues       Task[]                              // Task model retained, displayed as "Issue"
  access       ProjectAccess[]

  @@unique([workspaceId, key])
  @@index([workspaceId])
}

model ProjectAccess {
  id           String   @id @default(cuid())
  projectId    String
  userId       String
  permission   ProjectPermission @default(FULL)
  grantedAt    DateTime @default(now())

  project      Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  user         User    @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([projectId, userId])
  @@index([userId])
}

enum ProjectPermission {
  FULL    // can edit project, teams, issues
  VIEW    // read-only
  DENY    // explicitly hidden (overrides workspace role)
}
```

> **Migration note**: the existing `ProjectTeam` join table is dropped after teams are reparented to a single project (see Phase 4).

### 3.3 Team (modified)

```prisma
model Team {
  id          String   @id @default(cuid())
  projectId   String                               // NEW (replaces M:M with project)
  name        String
  key         String                               // existing — 2-4 chars, used in identifier
  color       String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  project     Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  members     TeamMember[]
  issues      Task[]
  labels      Label[]

  @@unique([projectId, key])                       // key now unique per project, not globally
  @@index([projectId])
}

model TeamMember {
  // unchanged structure; just continues to reference Team and User
  id      String @id @default(cuid())
  teamId  String
  userId  String
  role    TeamRole @default(MEMBER)

  team    Team @relation(fields: [teamId], references: [id], onDelete: Cascade)
  user    User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([teamId, userId])
}

enum TeamRole {
  LEAD
  MEMBER
}
```

### 3.4 Task (the "Issue") — modified

```prisma
model Task {
  id           String   @id @default(cuid())
  projectId    String                              // NEW: required after backfill
  teamId       String?                             // existing, still nullable for project-level issues
  identifier   String                              // existing — format below
  // ... all existing fields preserved: title, description, status,
  //     priority, assigneeId, labels[], dueDate, createdAt, etc.

  project      Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  team         Team?   @relation(fields: [teamId], references: [id], onDelete: SetNull)

  linksFrom    IssueLink[] @relation("LinkSource")
  linksTo      IssueLink[] @relation("LinkTarget")

  @@unique([projectId, identifier])                // identifier unique per project
  @@index([projectId, teamId])
}

model IssueLink {
  id            String   @id @default(cuid())
  sourceId      String
  targetId      String
  linkType      IssueLinkType
  createdAt     DateTime @default(now())
  createdById   String?

  source        Task @relation("LinkSource", fields: [sourceId], references: [id], onDelete: Cascade)
  target        Task @relation("LinkTarget", fields: [targetId], references: [id], onDelete: Cascade)

  @@unique([sourceId, targetId, linkType])
  @@index([targetId])
}

enum IssueLinkType {
  BLOCKS
  BLOCKED_BY
  RELATES_TO
  DUPLICATES
  DUPLICATED_BY
}
```

### 3.5 Identifier Format

| Case | Format | Example |
|---|---|---|
| Issue has a team | `{PROJECT_KEY}-{TEAM_KEY}-{seq}` | `OL-FE-42` |
| Issue is project-level (no team) | `{PROJECT_KEY}-{seq}` | `OL-101` |

`seq` is monotonic per **project** (a single counter per project, regardless of team) so identifiers never collide on import/move.

---

## 4. Permission Resolution

Resolution order when checking access to a project:

1. Is the user a `WorkspaceMember`? If **no** → deny.
2. Look up `ProjectAccess(projectId, userId)`.
   - `DENY` → deny (overrides everything).
   - `VIEW` → read-only.
   - `FULL` → full edit.
3. No `ProjectAccess` row → fall back to workspace role:
   - `OWNER` / `ADMIN` → full.
   - `MEMBER` → full (default).
   - `VIEWER` → read-only.

Team membership is **separate** from access. Anyone with project access can read team issues; team membership only affects assignment filters, notifications, and "my team" views.

---

## 5. Migration Strategy (Zero-Breakage)

Every database change is **additive first, destructive last**. At no point do we drop a column that current code still reads.

### Phase ordering rules

- Each phase ships as its own deploy (or its own commit block on `dev`).
- After each phase, the app continues to boot, all existing endpoints respond, and existing data is intact.
- Destructive cleanup (dropping `ProjectTeam`, making `workspaceId` NOT NULL, etc.) only happens after the corresponding write path has been migrated and a backfill has been verified.

---

## 6. Backend Refactor Phases

### Phase 0 — Audit & Lock (no code changes)

1. Snapshot current row counts for `Team`, `Project`, `ProjectTeam`, `Task`, `User`.
2. Document every place `teamId` and `projectId` are read in API, sidecar, and shared packages.
3. Confirm no production data exists outside the dev DB (this is pre-launch).

**Exit criteria**: written audit list of affected files and route handlers.

---

### Phase 1 — Introduce `Workspace` (additive only)

**Schema**

- Add `Workspace`, `WorkspaceMember`, `WorkspaceRole`.
- Add nullable `Project.workspaceId` (no FK enforcement issues; existing projects unaffected).

**Backfill migration**

- Create exactly one workspace per existing user with no shared workspace yet: `name = "{user.name}'s Workspace"`, `slug` derived from username.
- Insert a `WorkspaceMember` row (`role = OWNER`) for each user in their own workspace.
- For every existing `Project`, set `workspaceId` to the workspace of its creator (`Project.createdById` if present; otherwise the workspace of the first user with `ProjectAccess` after Phase 2, or a default fallback workspace).

**API**

- New routes (read-only at first):
  - `GET /api/workspaces` (returns workspaces the caller belongs to)
  - `GET /api/workspaces/:id`
  - `GET /api/workspaces/:id/members`
- No existing route changes.

**Exit criteria**

- Every `Project` row has a non-null `workspaceId`.
- Existing app behaves identically.
- Workspace endpoints return data.

---

### Phase 2 — `ProjectAccess` + Permission Middleware

**Schema**

- Add `ProjectAccess`, `ProjectPermission`.

**Backfill**

- For every existing project, insert `ProjectAccess(projectId, userId, FULL)` for every workspace member of that project's workspace. This guarantees the post-cutover behaviour matches today's behaviour (everyone in a workspace sees everything by default).

**Middleware**

- Introduce `requireProjectAccess(req, projectId, minPermission)` helper.
- Apply it to existing project and task endpoints in a **non-breaking** way: log denials as warnings for one cycle, then enforce.

**API**

- `POST /api/projects/:id/access` — grant/update access.
- `DELETE /api/projects/:id/access/:userId` — revoke (which inserts a `DENY` row or removes the explicit grant).
- `GET /api/projects/:id/access` — list grants.

**Exit criteria**

- All existing project/task reads and writes still succeed for every existing user.
- New ACL endpoints functional.

---

### Phase 3 — Add `Project.key`, `Task.projectId`, and Project-Scoped Identifiers

**Schema**

- Add `Project.key` (nullable for now).
- Add `Task.projectId` (nullable for now).
- Add new unique index `(projectId, identifier)` but keep the existing team-scoped unique index in place.

**Backfill**

- Generate a `Project.key` for every project:
  - Derive from first 2-4 alphanum chars of `name`, uppercased.
  - Collision resolver appends a numeric suffix.
- For every `Task`:
  - If the task has a team: set `projectId` = that team's primary project (via existing `ProjectTeam` row; if multiple, pick the oldest).
  - If the task has no team: assign to a per-workspace "Inbox" project created by the migration (one per workspace).
- Recompute `identifier` to the new format **in shadow** (write to a new column `identifierV2`) so existing UI keeps working.

**API**

- All existing endpoints continue to read the old `identifier` field.
- New endpoints (or new query param `?format=v2`) return `identifierV2`.

**Exit criteria**

- Every task has a non-null `projectId` and a populated `identifierV2`.
- Old identifier still served by default.

---

### Phase 4 — Reparent Teams to a Single Project; Retire `ProjectTeam`

**Schema**

- Add `Team.projectId` (nullable for one deploy).

**Backfill**

- For each team, choose its primary project:
  - If exactly one row in `ProjectTeam`, use that.
  - If multiple, pick the project with the most tasks owned by this team. Tie-break by oldest `ProjectTeam.createdAt`.
  - If zero, attach to the workspace's "Inbox" project.
- Set `Team.projectId` accordingly.
- Verify: every team has a project.

**API**

- `GET /api/teams?projectId=X` becomes the canonical list endpoint.
- `GET /api/teams` (no filter) returns teams across all projects the caller can access (backwards compatible).
- Writes to `ProjectTeam` blocked; deletes still allowed during deprecation.

**Destructive step (separate commit)**

- Drop `ProjectTeam` join table.
- Make `Team.projectId` NOT NULL.

**Exit criteria**

- Every team belongs to exactly one project.
- `ProjectTeam` table is gone.
- All existing list endpoints behave equivalently.

---

### Phase 5 — Cross-Linking Issues (`IssueLink`)

**Schema**

- Add `IssueLink`, `IssueLinkType`.

**API**

- `POST /api/issues/:id/links` — body `{ targetId, linkType }`.
- `DELETE /api/issues/:id/links/:linkId`.
- `GET /api/issues/:id/links` — returns both directions, normalised (`BLOCKS` ↔ `BLOCKED_BY` are treated as one row with derived inverse).
- Symmetric pairs (`BLOCKS`/`BLOCKED_BY`, `DUPLICATES`/`DUPLICATED_BY`) are stored once and projected in responses.

**Validation**

- Cannot link an issue to itself.
- Source and target must belong to projects the caller has access to.
- Cross-workspace links are rejected.

**Exit criteria**

- Issues can be linked, unlinked, and listed.
- No existing behaviour regresses.

---

### Phase 6 — Cutover: Switch Default Identifier and Enforce Project Scoping

**Schema**

- Drop the legacy team-scoped unique index on `Task.identifier`.
- Rename `identifierV2` → `identifier` (or drop the old column after one deploy).

**API**

- All endpoints now return the new identifier format by default.
- `Task.projectId` becomes NOT NULL.
- `Project.workspaceId` becomes NOT NULL.
- `Project.key` becomes NOT NULL.

**Exit criteria**

- Schema is in its final shape.
- Every read/write goes through the new model.
- Audit log empty of legacy access patterns.

---

### Phase 7 — Sidecar, Background Jobs, and Integrations

Code paths to audit and update (do this after Phase 6 cutover):

- **Sidecar `apps/sidecar`**: any place it fabricates tasks (e.g. brainstorm import, opencode batch creation) must pass `projectId`. Today it relies on `activeProject` from the client.
- **Brainstorm**: must persist the project context with the brainstorm result.
- **Onboarding**: must create a workspace + default project + default team in one transaction; today it creates orphan tasks.
- **GitHub integration**: pull-request links must travel through `IssueLink` (type `RELATES_TO`) when a PR references another project's issue.
- **Webhook receivers**: validate the workspace boundary before fanning out events.
- **Rate limiter keys**: include `workspaceId` so noisy workspaces don't starve others.

**Exit criteria**

- All background writers populate the full hierarchy.
- No code path can create a "floating" task or team again.

---

### Phase 8 — Hardening

- Add DB-level CHECK constraints where Prisma cannot (e.g. `IssueLink.sourceId != targetId`).
- Add structured logs for permission denials.
- Add an admin endpoint to dump a workspace's hierarchy as JSON (for support).
- Add integration tests covering: workspace create, project create + ACL, team create, issue create + link, permission inheritance.

---

## 7. Compatibility Matrix (what still works during each phase)

| Phase | Old project list works | Old task list works | Old identifier format | New workspace UI possible |
|---|---|---|---|---|
| 0 | ✅ | ✅ | ✅ | ❌ |
| 1 | ✅ | ✅ | ✅ | partial (read-only) |
| 2 | ✅ (with implicit FULL grants) | ✅ | ✅ | partial |
| 3 | ✅ | ✅ | ✅ (old served by default) | ✅ |
| 4 | ✅ (single project per team) | ✅ | ✅ | ✅ |
| 5 | ✅ | ✅ | ✅ | ✅ + links |
| 6 (cutover) | ✅ (new format) | ✅ (new format) | new only | ✅ |
| 7 | ✅ | ✅ | new only | ✅ (consistent) |
| 8 | ✅ | ✅ | new only | ✅ |

The application is shippable at every phase boundary.

---

## 8. API Surface — Final

```
# Workspaces
GET    /api/workspaces
POST   /api/workspaces
GET    /api/workspaces/:id
PATCH  /api/workspaces/:id
DELETE /api/workspaces/:id
GET    /api/workspaces/:id/members
POST   /api/workspaces/:id/members/invite
PATCH  /api/workspaces/:id/members/:userId
DELETE /api/workspaces/:id/members/:userId

# Projects (scoped by workspace)
GET    /api/projects?workspaceId=X
POST   /api/projects
GET    /api/projects/:id
PATCH  /api/projects/:id
DELETE /api/projects/:id
GET    /api/projects/:id/access
POST   /api/projects/:id/access
DELETE /api/projects/:id/access/:userId

# Teams (scoped by project)
GET    /api/teams?projectId=X
POST   /api/teams
GET    /api/teams/:id
PATCH  /api/teams/:id
DELETE /api/teams/:id
GET    /api/teams/:id/members
POST   /api/teams/:id/members
DELETE /api/teams/:id/members/:userId

# Issues
GET    /api/issues?projectId=X&teamId=Y&status=Z
POST   /api/issues
GET    /api/issues/:id
PATCH  /api/issues/:id
DELETE /api/issues/:id
GET    /api/issues/:id/links
POST   /api/issues/:id/links
DELETE /api/issues/:id/links/:linkId
```

Legacy aliases (`/api/tasks`, `/api/projects` without workspace filter) stay live and proxy to the new handlers for the duration of the migration.

---

## 9. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Identifier collisions during backfill | Generate `identifierV2` in shadow; only swap after verification query confirms uniqueness per project |
| Lost team-to-project mapping | Phase 4 backfill chooses primary project deterministically; manual override endpoint provided |
| Permission regressions | Phase 2 ships in "log-only" mode for one cycle before enforcement |
| Orphan tasks from onboarding | Phase 3 backfill puts them in a per-workspace Inbox project; Phase 7 fixes the writer |
| Sidecar continuing to write old shape | Phase 7 is gated by a feature flag; legacy writers throw in non-prod once flag is on |
| Cross-workspace links by mistake | Server-side validation in Phase 5 rejects them with `400` |

---

## 10. Out of Scope (for this refactor)

- Multi-workspace switching UI (single implicit workspace is enough for launch).
- SSO / SCIM provisioning of workspace members.
- Per-team billing.
- Custom roles beyond `OWNER/ADMIN/MEMBER/VIEWER` + `FULL/VIEW/DENY`.

These are easy follow-ups once the hierarchy is in place.

---

## 11. Frontend Phase (separate execution, different model)

> The frontend will be refactored in a single dedicated phase after the backend is fully cut over (i.e. after Phase 6). A different model will execute it. The plan below is informational only — do not interleave it with the backend phases.

**FE-1. Workspace bootstrap**
- Add `WorkspaceProvider` analogous to the existing `ProjectProvider`.
- Persist active workspace to `localStorage` (`openlinear:activeWorkspaceId`).
- Auto-select the only workspace until multi-workspace UX is needed.

**FE-2. Project context restructure**
- `ProjectProvider` becomes workspace-aware: only fetches projects inside the active workspace.
- Sidebar `ProjectDropdown` already exists — point it at the workspace-scoped endpoint.

**FE-3. Team selector inside a project**
- Sidebar gets a `TeamSection` under the project dropdown, listing the teams of the active project with active-state highlighting.
- Each team links to a team-scoped issues view (`/teams/issues?projectId=X&teamId=Y`).

**FE-4. Issue creation flow**
- Task form: project comes from `useProject()` (already wired), team becomes an in-form dropdown defaulted to the user's primary team in that project.
- Project-level issues (team = none) are explicitly selectable for epics.

**FE-5. Cross-link UI**
- Issue detail view gains a "Linked issues" panel.
- Add link: search-as-you-type across all accessible projects, choose link type (`Blocks / Blocked by / Relates to / Duplicates`).
- Inverse links rendered automatically on the other side.

**FE-6. Permission UX**
- Project settings page exposes the `ProjectAccess` table.
- Workspace settings page exposes member roles.
- Denied projects are hidden from sidebar entirely; viewer projects render with edit controls disabled.

**FE-7. Onboarding overhaul**
- First-run flow: create workspace → create first project → create first team → optional invite.
- Existing onboarding wizard is the template; expand it by two steps.

**FE-8. Identifier rendering**
- Update everywhere identifiers are shown (`task-card`, `task-detail-view`, breadcrumbs, search results) to handle both `PROJ-N` and `PROJ-TEAM-N`.

**FE-9. Migration UX**
- One-time banner explaining the new hierarchy.
- "Move issue" action that targets a different team within the same project.

---

## 12. Done Criteria for the Whole Refactor

- Every row in `Task`, `Team`, `Project` has a non-null parent up to a `Workspace`.
- No code path can create an entity outside the hierarchy.
- All existing user flows (create task, kanban, brainstorm, opencode batch, GitHub PR link) work without regression.
- ACL endpoints exist and are enforced.
- `IssueLink` is functional with bidirectional projection.
- Schema is in its final shape (Phase 6 + 7 complete).
- Integration tests cover the matrix in §7.
- Frontend phase plan is handed off to the other model.
