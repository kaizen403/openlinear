# Work Plan: Dual Auth + Project-Repo Connection

## TL;DR

Add email/password authentication alongside GitHub OAuth, enable connecting repos or local folders to projects, and migrate existing issues into a project with a seeded user account.

**Deliverables:**
- Login page with GitHub OAuth + email/password tabs
- Backend auth routes for register/login with bcrypt
- Updated project creation form with repo URL / local folder selector
- Modified execution engine to use project's repo/folder instead of active repository
- Database seed for user "kaz" (password: "kaz"), team, project, and migrated issues

**Estimated Effort:** Large (~2-3 hours)
**Parallel Execution:** NO (sequential, many dependencies)
**Critical Path:** Schema verification → Auth backend → Project API updates → Execution engine refactor → Frontend login → Migration seed

---

## Context

### Current State
- **Auth:** GitHub OAuth only, JWT tokens stored in localStorage
- **User Model:** Already has `passwordHash` field (nullable), `githubId` now optional
- **Project Model:** Has `repositoryId`, `localPath`, `repoUrl` fields (recently added)
- **Execution:** Uses `prisma.repository.findFirst({ where: { userId, isActive: true } })` to get active repo
- **Issues:** Tasks exist but aren't linked to projects (all `projectId` are null)

### Target State
1. **Auth:** Both GitHub OAuth and email/password work
2. **Projects:** When creating, choose either:
   - GitHub repo URL (clones to REPOS_DIR, creates Repository record)
   - Local folder path (absolute path, no clone, uses existing files)
3. **Execution:** Tasks use their project's repo/folder, not global active repository
4. **Migration:** All existing tasks linked to a default project
5. **Seed:** User "kaz" exists with password "kaz", has team + project + issues

---

## Work Objectives

### Core Objective
Enable flexible authentication and project-repo binding so users can work with either GitHub repos or local folders, with proper data migration.

### Concrete Deliverables
1. Email/password auth backend (POST /auth/register, POST /auth/login)
2. Login page with tabbed UI (GitHub OAuth button + email/password form)
3. Project creation supports repo URL or local folder path
4. Execution engine refactored to use `task.project.repository` or `task.project.localPath`
5. Database seed creates "kaz" user, migrates existing issues to a project

### Definition of Done
- [x] Can register with email/password and get JWT token
- [x] Can login with email/password
- [x] Can still login with GitHub OAuth
- [x] Creating project with repo URL clones and links it
- [x] Creating project with local path stores path (no clone)
- [x] Executing task uses project's repo/folder (not global active repo)
- [x] Existing issues are in a project linked to "kaz" user
- [x] Can login as "kaz"/"kaz" and see all issues

### Must NOT Have (Guardrails)
- Don't remove existing GitHub OAuth flow
- Don't break existing execution for public repos (userId: null)
- Don't delete existing issues during migration
- Don't require re-authentication for existing users

---

## Verification Strategy

### Agent-Executed QA Scenarios

**Scenario 1: Email/Password Registration**
```
Tool: Bash (curl)
Steps:
  1. POST /api/auth/register {"username":"testuser","password":"testpass","email":"test@test.com"}
  2. Assert: status 201, response has token
  3. POST /api/auth/login {"username":"testuser","password":"testpass"}
  4. Assert: status 200, response has token
  5. GET /api/auth/me with Bearer token
  6. Assert: status 200, username is "testuser"
Expected Result: User registered and can login
```

**Scenario 2: Project with Repo URL**
```
Tool: Bash (curl)
Preconditions: User "kaz" exists with auth token
Steps:
  1. POST /api/projects {"name":"Test Project","teamIds":["team-id"],"repoUrl":"https://github.com/owner/repo"}
  2. Assert: status 201, response has repository object
  3. Check Repository table: new entry with cloneUrl
  4. Check filesystem: repo cloned to REPOS_DIR/{repo-id}/.main
Expected Result: Project created with linked repo, files cloned
```

**Scenario 3: Project with Local Path**
```
Tool: Bash (curl)
Preconditions: User "kaz" exists, folder /tmp/test-project exists
Steps:
  1. POST /api/projects {"name":"Local Project","teamIds":["team-id"],"localPath":"/tmp/test-project"}
  2. Assert: status 201, response has localPath="/tmp/test-project"
  3. Assert: no Repository entry created
  4. Check filesystem: no clone happened
Expected Result: Project created with local path only
```

**Scenario 4: Task Execution Uses Project Repo**
```
Tool: Bash (curl) + File checks
Preconditions: Project with repo exists, task linked to project
Steps:
  1. POST /api/tasks/{taskId}/execute
  2. Check execution logs: verify clone happened in REPOS_DIR/{project-repo-id}/
  3. Verify worktree created at REPOS_DIR/{project-repo-id}/batch-*/task-*
  4. Assert: NOT using old global active repository path
Expected Result: Task uses project's specific repo
```

**Scenario 5: Login as Kaz**
```
Tool: Bash (curl)
Steps:
  1. POST /api/auth/login {"username":"kaz","password":"kaz"}
  2. Assert: status 200, token returned
  3. GET /api/auth/me with token
  4. Assert: username is "kaz"
  5. GET /api/tasks with token
  6. Assert: returns all migrated issues
Expected Result: Can login as kaz and see issues
```

---

## Execution Strategy

### Sequential Dependencies
```
1. Verify schema + LSP clean
   ↓
2. Backend auth routes (register/login)
   ↓
3. Update execution engine to use project repo/folder
   ↓
4. Frontend login page
   ↓
5. Update project creation form
   ↓
6. Create seed script (kaz user, migrate issues)
   ↓
7. Run seed + verify
```

### No Parallelization
This work has tight dependencies — each step builds on the previous. Execute sequentially.

---

## TODOs

- [x] **1. Verify schema and regenerate Prisma client**

  **What to do:**
  - Confirm `User` has: `githubId?`, `username` (unique), `passwordHash?`, `email?`
  - Confirm `Project` has: `repositoryId?`, `repository`, `localPath?`, `repoUrl?`
  - Run `pnpm db:generate` to ensure Prisma client has all fields
  - Verify all API files have no LSP errors

  **Must NOT do:**
  - Don't modify schema further
  - Don't run db:push (will do after all code changes)

  **Acceptance Criteria:**
  - [x] `lsp_diagnostics` on auth.ts, projects.ts, execution.ts, batch.ts = clean
  - [x] Prisma client has `localPath` and `repoUrl` on Project model

  **Commit:** NO (part of feature commit)

- [x] **2. Backend: Email/Password Auth Routes**

  **What to do:**
  - In `apps/api/src/routes/auth.ts`:
    - POST `/auth/register` - Validate username/password, hash with bcrypt, create user, return JWT
    - POST `/auth/login` - Find by username, compare password, return JWT
  - Username validation: alphanumeric + hyphens/underscores only
  - Password: min 3 chars (for dev convenience)

  **Must NOT do:**
  - Don't remove GitHub OAuth routes
  - Don't make email required (allow null)

  **Acceptance Criteria:**
  - [x] POST /api/auth/register returns 201 with token
  - [x] POST /api/auth/login returns 200 with token for valid creds
  - [x] POST /api/auth/login returns 401 for invalid creds
  - [x] Token works with existing /api/auth/me endpoint

  **Commit:** YES
  - Message: `feat(auth): add email/password register and login endpoints`

- [x] **3. Backend: Update Execution Engine for Project-Linked Repos**

  **What to do:**
  - Modify `apps/api/src/services/execution.ts`:
    - In `executeTask()` function (~line 579)
    - Instead of `prisma.repository.findFirst({ where: { userId, isActive: true } })`
    - Get task with project: `prisma.task.findUnique({ where: { id: taskId }, include: { project: { include: { repository: true } } } })`
    - If `task.project.localPath` exists, use that (no clone needed)
    - If `task.project.repository` exists, use that repo (clone if needed)
    - If neither, fall back to old behavior (for backward compat)
  - Modify `apps/api/src/services/batch.ts`:
    - Similar change in `executeBatch()` function
    - Get batch tasks with their projects
    - Group by project to handle different repos

  **Must NOT do:**
  - Don't break public repo execution (userId: null case)
  - Don't remove isActive repository logic entirely (fallback only)

  **Acceptance Criteria:**
  - [x] Task with `project.localPath` executes in that folder
  - [x] Task with `project.repository` uses that repo for clone/worktree
  - [x] Task without project falls back to active repository
  - [x] LSP clean on both files

  **Commit:** YES
  - Message: `feat(execution): use project's repo or local path for task execution`

- [x] **4. Frontend: Login Page with Email/Password + GitHub**

  **What to do:**
  - Create new route `/login` in `apps/desktop-ui/app/login/page.tsx`
  - Tabbed interface:
    - Tab 1: "Email / Password" - Form with username, password inputs
    - Tab 2: "GitHub" - Big "Sign in with GitHub" button
  - On email login success: store token in localStorage, redirect to /
  - On GitHub button click: redirect to `/api/auth/github`
  - Update `useAuth.tsx` to handle token from URL query param (already does this)
  - Style to match Linear.app aesthetic (dark mode, clean inputs)

  **Must NOT do:**
  - Don't remove existing sidebar auth section
  - Don't break existing GitHub OAuth callback handling

  **Acceptance Criteria:**
  - [x] Login page at /login
  - [x] Can switch between Email and GitHub tabs
  - [x] Email form validates and submits to /api/auth/login
  - [x] GitHub button redirects to OAuth flow
  - [x] Successful login redirects to dashboard
  - [x] Shows error message on failed login

  **Commit:** YES
  - Message: `feat(auth): add login page with email/password and GitHub tabs`

- [x] **5. Frontend: Update Project Creation Form**

  **What to do:**
  - Modify `apps/desktop-ui/app/projects/page.tsx`
  - In create project dialog, add:
    - Radio buttons: "GitHub Repository" vs "Local Folder"
    - If "GitHub Repository" selected: show text input for URL
    - If "Local Folder" selected: show text input for absolute path
  - Send `repoUrl` or `localPath` to POST /api/projects
  - Show validation errors

  **Must NOT do:**
  - Don't remove team selector (still required)
  - Don't make repo/folder required (optional for now)

  **Acceptance Criteria:**
  - [x] Radio buttons toggle between repo URL and local path inputs
  - [x] repoUrl sent when "GitHub Repository" selected
  - [x] localPath sent when "Local Folder" selected
  - [x] Project created successfully with either option

  **Commit:** YES
  - Message: `feat(projects): add repo URL and local folder options to project creation`

- [x] **6. Backend: Create Seed Script for Migration**

  **What to do:**
  - Modify `packages/db/prisma/seed.ts`:
    - Create user "kaz" with password hash for "kaz"
    - Create a team "Default" with key "DEF"
    - Create a project "OpenLinear" linked to the team
    - If existing Repository with isActive=true, link it to the project
    - Update all existing tasks (where projectId is null) to link to this project
    - Create a TeamMember entry for kaz in the team

  **Password hash for "kaz":**
  ```typescript
  import bcrypt from 'bcryptjs';
  const passwordHash = await bcrypt.hash('kaz', 10);
  ```

  **Must NOT do:**
  - Don't delete existing tasks
  - Don't fail if seed runs multiple times (use upsert)

  **Acceptance Criteria:**
  - [x] User "kaz" created with password hash
  - [x] Team "Default" created
  - [x] Project "OpenLinear" created with team
  - [x] All existing tasks linked to project
  - [x] Can login as kaz/kaz after seed

  **Commit:** YES
  - Message: `feat(db): add seed script with kaz user and project migration`

- [x] **7. Run Seed and Verify**

  **What to do:**
  - Run `pnpm db:seed` (or `prisma db seed`)
  - Verify in database:
    - User "kaz" exists with passwordHash
    - Project exists with team
    - Tasks have projectId set
  - Test login: POST /api/auth/login with kaz/kaz
  - Test dashboard: Login and verify issues visible

  **Acceptance Criteria:**
  - [x] Seed runs without errors
  - [x] Can login as kaz/kaz via API
  - [x] Can login as kaz/kaz via UI
  - [x] Dashboard shows migrated issues
  - [x] All LSP checks pass

  **Commit:** NO (seed already committed, this is verification)

---

## Commit Strategy

| After Task | Message | Files |
|------------|---------|-------|
| 2 | `feat(auth): add email/password register and login endpoints` | auth.ts |
| 3 | `feat(execution): use project's repo or local path for task execution` | execution.ts, batch.ts |
| 4 | `feat(auth): add login page with email/password and GitHub tabs` | login/page.tsx, useAuth.tsx updates |
| 5 | `feat(projects): add repo URL and local folder options to project creation` | projects/page.tsx |
| 6 | `feat(db): add seed script with kaz user and project migration` | seed.ts |

---

## Success Criteria

### Verification Commands
```bash
# 1. Test auth
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"kaz","password":"kaz"}'
# Expected: {"token":"...","user":{...}}

# 2. Test project creation with repo
curl -X POST http://localhost:3001/api/projects \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"Test","teamIds":["..."],"repoUrl":"https://github.com/vercel/next.js"}'
# Expected: Project with repository object

# 3. Verify seed
curl http://localhost:3001/api/tasks \
  -H "Authorization: Bearer $KAZ_TOKEN"
# Expected: All existing issues returned
```

### Final Checklist
- [x] GitHub OAuth still works
- [x] Email/password register works
- [x] Email/password login works
- [x] Project creation with repo URL works
- [x] Project creation with local path works
- [x] Task execution uses project's repo/folder
- [x] All existing issues linked to project
- [x] Can login as kaz/kaz
- [x] All LSP clean
- [x] No breaking changes to existing flows

---

## Notes

### Password Hash for "kaz"
```typescript
// bcrypt hash of "kaz" with 10 rounds
const KAZ_PASSWORD_HASH = '$2a$10$yourhashhere...';
```

### Execution Engine Changes Location
The key function to modify is `executeTask()` in `apps/api/src/services/execution.ts` around line 579. Currently it does:
```typescript
project = await prisma.repository.findFirst({
  where: { userId, isActive: true },
});
```

Should become:
```typescript
const taskWithProject = await prisma.task.findUnique({
  where: { id: taskId },
  include: { project: { include: { repository: true } } },
});

if (taskWithProject?.project?.localPath) {
  // Use local path
} else if (taskWithProject?.project?.repository) {
  // Use project's repository
} else {
  // Fallback: old behavior
}
```

### Local Folder Path Handling
For local paths, the execution engine should:
1. NOT clone anything
2. Use the local path directly as the working directory
3. Still create a git worktree if it's a git repo, OR just work in the folder if not

Consider whether to require the local path to be a git repo. For MVP, assume it is.

---

**Plan created by Prometheus**
**Date:** 2026-02-12
**Status:** Ready for execution
**Next Step:** Run `/start-work` to begin implementation
