# GitHub Auth — Wire Up & Polish

## TL;DR

> **Quick Summary**: Wire up the existing GitHub OAuth implementation by adding environment variables, moving the sign-in entry point from the header into the sidebar bottom, and adding auth-related tests.
> 
> **Deliverables**:
> - Root `.env.example` updated with all GitHub OAuth variables
> - Root `.env` updated with GitHub OAuth placeholder variables
> - Sidebar bottom: sign-in button (unauthenticated) / user avatar + sign-out (authenticated)
> - Header: UserMenu removed from `page.tsx`
> - Auth-related vitest tests
> 
> **Estimated Effort**: Short
> **Parallel Execution**: YES - 2 waves
> **Critical Path**: Task 1 (env) → Task 3 (sidebar) → Task 4 (header cleanup) → Task 5 (tests)

---

## Context

### Original Request
Wire up the existing GitHub OAuth flow: add missing env vars, add a visible sign-in entry point to the sidebar, remove UserMenu from header, and implement tests.

### Interview Summary
**Key Discussions**:
- All OAuth backend + frontend code is already fully built and functional
- Security audit found 7 issues (JWT in URL, CSRF, etc.) but user chose **Wire Up Only** — no backend changes
- User wants **tests after implementation** using existing vitest infrastructure
- Sidebar should show auth controls at the bottom (below Settings)

**Research Findings**:
- `apps/api/.env.example` already documents all OAuth vars — root `.env.example` only has `DATABASE_URL`
- Root `.env` only has `DATABASE_URL` — needs GitHub vars added
- Sidebar bottom has Settings link at lines 202-215
- UserMenu in header at `page.tsx:50` — renders sign-in/sign-out
- App uses Tailwind CSS, lucide-react, shadcn/ui, Linear dark theme
- AuthProvider wraps entire app via `layout.tsx`

### Metis Review
Metis returned no output. Self-review conducted instead (see gaps addressed below).

**Self-identified Gaps (addressed)**:
- Gap: Should sidebar auth section go above or below Settings? → **Below** (per user spec: "bottom of the sidebar")
- Gap: What happens to the `UserMenu` component file itself? → **Keep file, just stop rendering in header** — sidebar will inline similar logic
- Gap: Should `RepoConnector` in header be affected? → **No** — it already conditionally renders only when `!isAuthenticated`
- Gap: `.env` contains a real Neon DB URL — shouldn't overwrite → **Append** GitHub vars, preserve existing DATABASE_URL

---

## Work Objectives

### Core Objective
Make the existing GitHub OAuth flow usable by adding environment configuration and moving the sign-in UI from the header to the sidebar bottom.

### Concrete Deliverables
- Updated `/.env.example` with all env vars (database + GitHub OAuth)
- Updated `/.env` with GitHub OAuth placeholder vars appended
- Modified `sidebar.tsx` with auth controls at bottom
- Modified `page.tsx` without UserMenu in header
- New test file `apps/api/src/__tests__/auth.test.ts`

### Definition of Done
- [ ] Starting API server with `pnpm --filter @openlinear/api dev` succeeds with new env vars
- [ ] Starting frontend with `pnpm --filter @openlinear/desktop-ui dev` succeeds
- [ ] Sidebar shows "Sign in with GitHub" when not authenticated
- [ ] Sidebar shows user avatar + name + sign-out when authenticated
- [ ] Header no longer contains UserMenu component
- [ ] All vitest tests pass: `pnpm --filter @openlinear/api test`

### Must Have
- GitHub OAuth env vars in root `.env.example` and `.env`
- Sidebar sign-in button visible at sidebar bottom
- UserMenu removed from header
- Auth tests passing

### Must NOT Have (Guardrails)
- **DO NOT** modify OAuth backend code (routes/auth.ts, services/github.ts, middleware/auth.ts)
- **DO NOT** change the OAuth flow (JWT delivery, state handling, token storage)
- **DO NOT** delete the `user-menu.tsx` file — only stop rendering it in page.tsx
- **DO NOT** touch ProjectSelector placement (stays in sidebar top, conditional on auth)
- **DO NOT** modify the Prisma schema or database
- **DO NOT** add new npm dependencies
- **DO NOT** change the RepoConnector component
- **DO NOT** overwrite the existing DATABASE_URL in `.env`

---

## Verification Strategy (MANDATORY)

> **UNIVERSAL RULE: ZERO HUMAN INTERVENTION**
> ALL tasks are verified by the agent using tools. No human action required.

### Test Decision
- **Infrastructure exists**: YES (vitest, `apps/api/vitest.config.ts`, existing test files)
- **Automated tests**: Tests-after
- **Framework**: vitest

### Agent-Executed QA Scenarios (MANDATORY — ALL tasks)

> QA scenarios complement unit tests at integration/E2E level.
> These describe how the executing agent DIRECTLY verifies each deliverable.

**Verification Tool by Deliverable Type:**

| Type | Tool | How Agent Verifies |
|------|------|-------------------|
| **Env files** | Bash (cat, grep) | Check file contents, verify vars present |
| **Frontend/UI** | Playwright (playwright skill) | Navigate, interact, assert DOM, screenshot |
| **API/Backend** | Bash (curl) | Send requests, parse responses, assert fields |
| **Tests** | Bash (pnpm test) | Run test suite, verify all pass |

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately):
├── Task 1: Environment setup (env files)
└── Task 2: Sidebar auth controls

Wave 2 (After Wave 1):
├── Task 3: Header cleanup (depends: Task 2 — sidebar must have auth before removing from header)
└── Task 4: Auth tests (depends: Tasks 1-3 — tests verify the whole thing)
```

### Dependency Matrix

| Task | Depends On | Blocks | Can Parallelize With |
|------|------------|--------|---------------------|
| 1 | None | 4 | 2 |
| 2 | None | 3 | 1 |
| 3 | 2 | 4 | None |
| 4 | 1, 2, 3 | None | None (final) |

### Agent Dispatch Summary

| Wave | Tasks | Recommended Agents |
|------|-------|-------------------|
| 1 | 1, 2 | task(category="quick") + task(category="visual-engineering") |
| 2 | 3, 4 | task(category="quick") + task(category="unspecified-low") |

---

## TODOs

- [ ] 1. Environment Setup — Add GitHub OAuth vars to root env files

  **What to do**:
  - Update `/.env.example` to include all env vars: DATABASE_URL (existing) + GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_REDIRECT_URI, GITHUB_TOKEN, JWT_SECRET, FRONTEND_URL, CORS_ORIGIN, PORT
  - Update `/.env` to **append** (NOT overwrite existing DATABASE_URL) the GitHub OAuth placeholder vars with empty values for GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, and sensible defaults for the rest
  - Use `apps/api/.env.example` as the reference for what vars exist and their default values
  - Add inline comments explaining each variable and linking to GitHub OAuth App setup

  **Must NOT do**:
  - DO NOT overwrite or modify the existing DATABASE_URL line in `.env`
  - DO NOT add actual credentials — only placeholders
  - DO NOT create a separate `.env` for the API workspace (it inherits from root)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Simple file edits to two files, no complex logic
  - **Skills**: []
    - No special skills needed — straightforward text file editing

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 2)
  - **Blocks**: Task 4 (tests need env vars)
  - **Blocked By**: None

  **References**:

  **Pattern References** (existing code to follow):
  - `apps/api/.env.example:1-25` — Complete reference for all env vars with comments. Copy the structure and variable names exactly.
  - `apps/api/src/services/github.ts:3-5` — Where GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_REDIRECT_URI are consumed. Defaults shown here.
  - `apps/api/src/routes/auth.ts:13-14` — Where JWT_SECRET and FRONTEND_URL are consumed with their defaults.
  - `apps/api/src/app.ts:14-16` — Where CORS_ORIGIN is consumed.

  **Documentation References**:
  - `/.env.example:1-3` — Current root env.example with only DATABASE_URL
  - `/.env:1-4` — Current root env with actual DATABASE_URL (Neon DB) — MUST PRESERVE these lines
  - `/.gitignore:7` — `.env` is gitignored, so it's safe to put placeholders

  **Acceptance Criteria**:

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: Root .env.example contains all required variables
    Tool: Bash (grep)
    Preconditions: None
    Steps:
      1. Read /.env.example
      2. Assert: contains "DATABASE_URL"
      3. Assert: contains "GITHUB_CLIENT_ID"
      4. Assert: contains "GITHUB_CLIENT_SECRET"
      5. Assert: contains "GITHUB_REDIRECT_URI"
      6. Assert: contains "JWT_SECRET"
      7. Assert: contains "FRONTEND_URL"
    Expected Result: All 6 key variables present with comments
    Evidence: File content captured

  Scenario: Root .env preserves existing DATABASE_URL and adds GitHub vars
    Tool: Bash (grep)
    Preconditions: None
    Steps:
      1. Read /.env
      2. Assert: contains existing Neon DATABASE_URL (not overwritten)
      3. Assert: contains "GITHUB_CLIENT_ID="
      4. Assert: contains "GITHUB_CLIENT_SECRET="
      5. Assert: contains "JWT_SECRET="
    Expected Result: Original DATABASE_URL untouched, GitHub vars appended
    Evidence: File content captured
  ```

  **Commit**: YES
  - Message: `chore(auth): add GitHub OAuth env vars to root .env.example and .env`
  - Files: `.env.example`, `.env`
  - Pre-commit: `grep GITHUB_CLIENT_ID .env.example`

---

- [ ] 2. Sidebar Auth Controls — Sign-in button + user info at sidebar bottom

  **What to do**:
  - Modify `apps/desktop-ui/components/layout/sidebar.tsx`
  - Add an auth section **below** the Settings link in the sidebar bottom `<div>` (lines 202-215)
  - **When not authenticated** (`!isAuthenticated`): Show a "Sign in with GitHub" button
    - Use `Github` icon from lucide-react (already imported in user-menu.tsx)
    - Link to `getLoginUrl()` from `@/lib/api`
    - Style: match existing sidebar patterns — use `bg-linear-accent` for the sign-in CTA
  - **When authenticated**: Show user avatar + username + sign-out button
    - Avatar: `user.avatarUrl` as circular `<img>` (24-28px)
    - Username: `user.username` in small text, truncated
    - Sign-out: `LogOut` icon button from lucide-react
    - Style: subtle, match sidebar aesthetic — no bright backgrounds
  - Use `useAuth()` hook (already imported in sidebar.tsx) for `user`, `isAuthenticated`, `isLoading`, `logout`
  - Import `getLoginUrl` from `@/lib/api`
  - Import `Github`, `LogOut` from `lucide-react`
  - Show a subtle loading skeleton (matching UserMenu pattern) during `isLoading`

  **Must NOT do**:
  - DO NOT move or modify the ProjectSelector placement (stays in sidebar top area)
  - DO NOT change any existing nav items or section headers
  - DO NOT remove Settings link — add auth section below it
  - DO NOT add new npm dependencies
  - DO NOT modify the `useAuth` hook
  - DO NOT create a new component file — inline in sidebar.tsx (keeps it simple)

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: UI component work requiring visual design sense for the auth section
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: Needed for crafting the sidebar auth section with proper Linear-inspired styling

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 1)
  - **Blocks**: Task 3 (header cleanup depends on sidebar having auth)
  - **Blocked By**: None

  **References**:

  **Pattern References** (existing code to follow):
  - `apps/desktop-ui/components/layout/sidebar.tsx:202-215` — Current sidebar bottom section with Settings link. The auth section goes directly below this, still inside the sidebar's flex-col layout.
  - `apps/desktop-ui/components/layout/sidebar.tsx:32-34` — Destructures `isAuthenticated` and `activeProject` from `useAuth()`. Need to also destructure `user`, `isLoading`, `logout`.
  - `apps/desktop-ui/components/layout/sidebar.tsx:14-20` — `navItemClass` styling utility function. Use similar patterns for consistency.
  - `apps/desktop-ui/components/auth/user-menu.tsx:7-49` — **Reference implementation** for the sign-in / signed-in states. Reuse the same conditional rendering pattern. Note the exact `getLoginUrl()` call, avatar rendering, and logout button.
  - `apps/desktop-ui/components/auth/user-menu.tsx:10-14` — Loading skeleton pattern (rounded pulse div).
  - `apps/desktop-ui/components/layout/sidebar.tsx:6-9` — Current lucide-react imports. Add `Github`, `LogOut` to this import.

  **API/Type References** (contracts to implement against):
  - `apps/desktop-ui/hooks/use-auth.tsx:6-14` — AuthContextType interface. `user`, `isAuthenticated`, `isLoading`, `logout` are available.
  - `apps/desktop-ui/lib/api.ts:3-10` — User type definition. `user.avatarUrl` (nullable), `user.username`.
  - `apps/desktop-ui/lib/api.ts:108-110` — `getLoginUrl()` returns the GitHub OAuth URL string.
  - `apps/desktop-ui/lib/api.ts:112-115` — `logout()` function clears localStorage and redirects.

  **Acceptance Criteria**:

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: Sidebar shows sign-in button when not authenticated
    Tool: Playwright (playwright skill)
    Preconditions: Dev server running on localhost:3000, no token in localStorage
    Steps:
      1. Navigate to: http://localhost:3000
      2. Wait for: aside (sidebar) visible (timeout: 5s)
      3. Assert: sidebar bottom area contains text "Sign in with GitHub" or similar CTA
      4. Assert: a link/button with href containing "/api/auth/github" exists in sidebar
      5. Assert: NO user avatar visible in sidebar bottom
      6. Screenshot: .sisyphus/evidence/task-2-sidebar-unauthenticated.png
    Expected Result: Sign-in CTA visible at sidebar bottom, no user info shown
    Evidence: .sisyphus/evidence/task-2-sidebar-unauthenticated.png

  Scenario: Sidebar shows user info when authenticated
    Tool: Playwright (playwright skill)
    Preconditions: Dev server running, valid JWT token set in localStorage
    Steps:
      1. Set localStorage 'token' to a valid JWT (use the test user's token)
      2. Navigate to: http://localhost:3000
      3. Wait for: aside (sidebar) visible (timeout: 5s)
      4. Wait for: img in sidebar bottom (avatar, timeout: 5s)
      5. Assert: user avatar image visible (img tag with rounded class)
      6. Assert: username text visible near avatar
      7. Assert: sign-out button/icon visible
      8. Assert: NO "Sign in with GitHub" text visible
      9. Screenshot: .sisyphus/evidence/task-2-sidebar-authenticated.png
    Expected Result: Avatar, username, and sign-out button visible at sidebar bottom
    Evidence: .sisyphus/evidence/task-2-sidebar-authenticated.png

  Scenario: Sign-out button works from sidebar
    Tool: Playwright (playwright skill)
    Preconditions: Dev server running, authenticated with valid token
    Steps:
      1. Navigate to: http://localhost:3000 with valid token in localStorage
      2. Wait for: sidebar visible with user info
      3. Click: sign-out button in sidebar bottom
      4. Wait for: page navigation or state change (timeout: 5s)
      5. Assert: localStorage 'token' is null
      6. Assert: sidebar now shows "Sign in with GitHub" instead of user info
      7. Screenshot: .sisyphus/evidence/task-2-sidebar-signout.png
    Expected Result: Token cleared, sidebar reverts to sign-in state
    Evidence: .sisyphus/evidence/task-2-sidebar-signout.png

  Scenario: Settings link still visible above auth section
    Tool: Playwright (playwright skill)
    Preconditions: Dev server running on localhost:3000
    Steps:
      1. Navigate to: http://localhost:3000
      2. Wait for: sidebar visible
      3. Assert: Settings link visible in sidebar
      4. Assert: Settings link appears ABOVE the auth section (sign-in button or user info)
      5. Assert: Settings link href is "/settings"
    Expected Result: Settings link preserved, positioned above auth controls
    Evidence: Visual inspection in screenshots from other scenarios
  ```

  **Commit**: YES (groups with Task 3)
  - Message: `feat(auth): add sign-in/user controls to sidebar bottom`
  - Files: `apps/desktop-ui/components/layout/sidebar.tsx`
  - Pre-commit: `pnpm --filter @openlinear/desktop-ui build`

---

- [ ] 3. Header Cleanup — Remove UserMenu from page header

  **What to do**:
  - Modify `apps/desktop-ui/app/page.tsx`
  - Remove the `<UserMenu />` rendering at line 50
  - Remove the `import { UserMenu } from "@/components/auth/user-menu"` at line 8
  - Remove `import { useAuth } from "@/hooks/use-auth"` at line 10 ONLY IF `isAuthenticated` and `activeProject` are no longer used — CHECK FIRST (they ARE used at line 15 and line 26-28)
  - Keep the `useAuth` import and the `isAuthenticated`/`activeProject` destructuring since they're used elsewhere in the component (header title, RepoConnector conditional)
  - **DO NOT** delete `components/auth/user-menu.tsx` — it may be useful later or for other pages

  **Must NOT do**:
  - DO NOT delete the `user-menu.tsx` component file
  - DO NOT remove `useAuth` import or destructuring (it's used for `activeProject` and `isAuthenticated`)
  - DO NOT change the header layout or other header elements (search, Create Task button)
  - DO NOT touch RepoConnector

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Two-line deletion (import + JSX render). Trivial change.
  - **Skills**: []
    - No special skills needed

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (sequential after Task 2)
  - **Blocks**: Task 4 (tests verify final state)
  - **Blocked By**: Task 2 (sidebar must have auth controls before removing from header)

  **References**:

  **Pattern References** (existing code to follow):
  - `apps/desktop-ui/app/page.tsx:8` — `import { UserMenu } from "@/components/auth/user-menu"` — REMOVE this line
  - `apps/desktop-ui/app/page.tsx:50` — `<UserMenu />` — REMOVE this element
  - `apps/desktop-ui/app/page.tsx:10` — `import { useAuth } from "@/hooks/use-auth"` — KEEP this (used at line 15)
  - `apps/desktop-ui/app/page.tsx:15` — `const { isAuthenticated, activeProject } = useAuth()` — KEEP this (used at lines 26, 28)
  - `apps/desktop-ui/app/page.tsx:28` — `{!isAuthenticated && <RepoConnector />}` — KEEP this unchanged

  **Acceptance Criteria**:

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: Header no longer contains UserMenu
    Tool: Playwright (playwright skill)
    Preconditions: Dev server running on localhost:3000
    Steps:
      1. Navigate to: http://localhost:3000
      2. Wait for: header element visible (timeout: 5s)
      3. Assert: header does NOT contain "Sign in with GitHub" text
      4. Assert: header does NOT contain user avatar or logout button
      5. Assert: header STILL contains search input
      6. Assert: header STILL contains "Create Task" button
      7. Screenshot: .sisyphus/evidence/task-3-header-no-usermenu.png
    Expected Result: Header clean — only search + Create Task, no auth UI
    Evidence: .sisyphus/evidence/task-3-header-no-usermenu.png

  Scenario: page.tsx builds without errors
    Tool: Bash
    Preconditions: None
    Steps:
      1. Run: pnpm --filter @openlinear/desktop-ui build
      2. Assert: exit code 0
      3. Assert: no TypeScript errors related to UserMenu or unused imports
    Expected Result: Clean build with no warnings about removed imports
    Evidence: Build output captured
  ```

  **Commit**: YES (groups with Task 2)
  - Message: `refactor(auth): remove UserMenu from header, auth now in sidebar`
  - Files: `apps/desktop-ui/app/page.tsx`
  - Pre-commit: `pnpm --filter @openlinear/desktop-ui build`

---

- [ ] 4. Auth Tests — Add vitest tests for auth endpoints

  **What to do**:
  - Create `apps/api/src/__tests__/auth.test.ts`
  - Test the auth route handlers using the existing vitest setup
  - Follow the pattern established in `health.test.ts` and `tasks.test.ts`
  - Test cases to cover:
    1. `GET /api/auth/github` — returns 302 redirect to GitHub OAuth URL
    2. `GET /api/auth/github` — redirect URL contains correct client_id and scopes
    3. `GET /api/auth/github/callback` — with missing code param returns redirect with error
    4. `GET /api/auth/github/callback` — with error param returns redirect with error
    5. `GET /api/auth/me` — without auth header returns 401
    6. `GET /api/auth/me` — with invalid token returns 401
    7. `POST /api/auth/logout` — returns success response
  - Use supertest (check if already installed, otherwise use native fetch against the Express app)
  - Mock the GitHub API calls in services/github.ts (token exchange, user fetch) to avoid real OAuth calls

  **Must NOT do**:
  - DO NOT modify existing test files (health.test.ts, tasks.test.ts)
  - DO NOT make real API calls to GitHub
  - DO NOT modify the auth route handlers to make them "more testable"
  - DO NOT add unnecessary test dependencies — use what's already installed

  **Recommended Agent Profile**:
  - **Category**: `unspecified-low`
    - Reason: Straightforward test writing following existing patterns
  - **Skills**: []
    - No special skills needed — standard vitest tests

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (runs after Tasks 1-3)
  - **Blocks**: None (final task)
  - **Blocked By**: Tasks 1, 2, 3

  **References**:

  **Pattern References** (existing tests to follow):
  - `apps/api/src/__tests__/health.test.ts` — Follow this test structure: imports, describe blocks, test assertions
  - `apps/api/src/__tests__/tasks.test.ts` — Follow this for more complex test patterns with request bodies
  - `apps/api/vitest.config.ts` — Vitest configuration — understand the test runner setup

  **API/Type References** (contracts to test against):
  - `apps/api/src/routes/auth.ts:20-24` — GET /github route handler (redirect)
  - `apps/api/src/routes/auth.ts:26-56` — GET /github/callback route handler (code exchange)
  - `apps/api/src/routes/auth.ts:58-82` — GET /me route handler (auth check)
  - `apps/api/src/routes/auth.ts:84-86` — POST /logout route handler
  - `apps/api/src/app.ts:11-68` — createApp() function for setting up the Express app in tests
  - `apps/api/src/services/github.ts:118-126` — getAuthorizationUrl() — generates the OAuth URL

  **Documentation References**:
  - `apps/api/src/middleware/auth.ts:4` — JWT_SECRET default value for test assertions

  **Acceptance Criteria**:

  - [ ] Test file created: `apps/api/src/__tests__/auth.test.ts`
  - [ ] Tests cover: /github redirect, /github/callback error cases, /me unauthorized, /logout
  - [ ] `pnpm --filter @openlinear/api test` → PASS (all tests including new auth tests)

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: Auth tests pass
    Tool: Bash
    Preconditions: All dependencies installed
    Steps:
      1. Run: pnpm --filter @openlinear/api test
      2. Assert: exit code 0
      3. Assert: output contains "auth" test suite
      4. Assert: no test failures
    Expected Result: All auth tests pass alongside existing tests
    Evidence: Test output captured

  Scenario: Auth tests cover key endpoints
    Tool: Bash (grep)
    Preconditions: Test file exists
    Steps:
      1. Read: apps/api/src/__tests__/auth.test.ts
      2. Assert: contains test for "/api/auth/github"
      3. Assert: contains test for "/api/auth/me"
      4. Assert: contains test for "401" status code assertion
      5. Assert: contains test for "/api/auth/logout"
    Expected Result: All critical auth endpoints have test coverage
    Evidence: File content captured
  ```

  **Commit**: YES
  - Message: `test(auth): add vitest tests for auth route handlers`
  - Files: `apps/api/src/__tests__/auth.test.ts`
  - Pre-commit: `pnpm --filter @openlinear/api test`

---

## Commit Strategy

| After Task | Message | Files | Verification |
|------------|---------|-------|--------------|
| 1 | `chore(auth): add GitHub OAuth env vars to root .env.example and .env` | `.env.example`, `.env` | `grep GITHUB_CLIENT_ID .env.example` |
| 2+3 | `feat(auth): move sign-in controls from header to sidebar bottom` | `sidebar.tsx`, `page.tsx` | `pnpm --filter @openlinear/desktop-ui build` |
| 4 | `test(auth): add vitest tests for auth route handlers` | `auth.test.ts` | `pnpm --filter @openlinear/api test` |

---

## Success Criteria

### Verification Commands
```bash
# Env vars present
grep GITHUB_CLIENT_ID .env.example    # Expected: GITHUB_CLIENT_ID=
grep GITHUB_CLIENT_ID .env            # Expected: GITHUB_CLIENT_ID=

# Frontend builds
pnpm --filter @openlinear/desktop-ui build  # Expected: exit 0

# Tests pass
pnpm --filter @openlinear/api test    # Expected: all tests pass
```

### Final Checklist
- [ ] Root `.env.example` has all env vars documented
- [ ] Root `.env` has GitHub placeholder vars (DATABASE_URL untouched)
- [ ] Sidebar bottom shows sign-in button (unauthenticated) or user info (authenticated)
- [ ] Settings link still visible above auth section in sidebar
- [ ] Header no longer contains UserMenu
- [ ] Search and Create Task still in header
- [ ] RepoConnector still shows when not authenticated
- [ ] Frontend builds without TypeScript errors
- [ ] All vitest tests pass (including new auth tests)
- [ ] No new npm dependencies added
- [ ] No OAuth backend code modified
