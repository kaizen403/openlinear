# OpenLinear Pre-Launch Fix Plan

**Status:** 🔴 NO-GO until complete  
**Target:** Launch-ready codebase  
**Estimated Time:** 14-20 hours of focused work  
**Last Updated:** 2026-05-16  

---

## Phase 1: Stop the Bleeding (CI/CD & Deploy Safety)
**Priority:** CRITICAL  
**Time:** ~1 hour  
**Goal:** Prevent broken code from shipping to production

### 1.1 Fix CI Silent Failures
**File:** `.github/workflows/deploy.yml`  
**Problem:** `continue-on-error: true` on every quality gate means broken builds deploy silently  
**Fix:** Remove all `continue-on-error: true` from typecheck, build, and test steps  
**Validation:** Push a test branch, verify CI fails on broken code

### 1.2 Restrict Deploy Trigger to `main` Only
**File:** `.github/workflows/deploy.yml:5`  
**Problem:** Deploy runs on both `main` and `dev` branches  
**Fix:** Change `on.push.branches` from `[main, dev]` to `[main]`  
**Validation:** Verify `dev` branch pushes no longer trigger deploy

### 1.3 Remove Build Error Suppression
**File:** `scripts/deploy.sh:103-108`  
**Problem:** `NEXT_IGNORE_BUILD_ERRORS=1` suppresses Next.js build failures  
**Fix:** Remove the `NEXT_IGNORE_BUILD_ERRORS=1` line  
**Validation:** Run `pnpm --filter @openlinear/desktop-ui build` and confirm it passes without the flag

### 1.4 Add DB-Aware Health Check
**File:** `apps/api/src/app.ts:154-160`  
**Problem:** `/health` returns 200 even if Postgres is disconnected  
**Fix:** Add `await prisma.$queryRaw`SELECT 1`` to health check, return 503 on failure  
**Validation:** Stop Postgres locally, verify `/health` returns 503

---

## Phase 2: Fix Authentication Holes
**Priority:** CRITICAL  
**Time:** ~1.5 hours  
**Goal:** Close unauthenticated endpoints that expose data or allow state changes

### 2.1 Add Auth to Team Endpoints
**File:** `apps/api/src/routes/teams.ts:206,229`  
**Problem:** `GET /api/teams/:id` and `GET /api/teams/:id/members` have no auth  
**Fix:** Add `requireAuth` middleware and verify caller is team member via `assertTeamRole`  
**Validation:** Test with curl — no-auth request should return 401

### 2.2 Add Auth to Public Repo Routes
**File:** `apps/api/src/routes/repos.ts:40,51,63`  
**Problem:** `POST /api/repos/:id/activate/public` and related public routes are unauthenticated  
**Fix:** Add `requireAuth` to all public repo routes, or remove `/public` flavor entirely  
**Validation:** Test with curl — no-auth request should return 401

### 2.3 Add Rate Limiter to OAuth Endpoints
**File:** `apps/api/src/app.ts`  
**Problem:** `/api/auth/github*` has no per-IP rate limiting  
**Fix:** Mount a looser rate limiter (30/min per IP) on `/api/auth/github*`  
**Validation:** Rapid-fire requests from same IP should hit 429

### 2.4 Add Startup Env Validation
**File:** `apps/api/src/index.ts:11`  
**Problem:** Missing `JWT_SECRET` or `GITHUB_CLIENT_ID` doesn't fail until first request  
**Fix:** Add fail-fast validation at boot — check all required env vars, throw if missing in production  
**Validation:** Unset `JWT_SECRET`, verify server exits immediately on startup

---

## Phase 3: Fix Schema Drift
**Priority:** CRITICAL  
**Time:** ~1 hour  
**Goal:** Prevent runtime crashes from missing database columns

### 3.1 Fix Settings Migration
**File:** `packages/db/prisma/schema.prisma:159`  
**Problem:** `Settings.userId` declared in schema but not in any migration  
**Fix:** Create migration `add_settings_user_id` to add the column  
**Commands:**
```bash
pnpm --filter @openlinear/db prisma migrate dev --name add_settings_user_id
```
**Validation:** Run `prisma migrate status`, verify no pending migrations. Query `Settings` table via Prisma

### 3.2 Add Missing FK Constraints to Notifications
**File:** `packages/db/prisma/schema.prisma:328-329`  
**Problem:** `Notification.taskId` and `commentId` lack foreign keys  
**Fix:** Add `onDelete: Cascade` relations to Task and Comment models  
**Validation:** Create migration, verify it generates proper `FOREIGN KEY` constraints

---

## Phase 4: Fix Sidecar Security
**Priority:** CRITICAL  
**Time:** ~2 hours  
**Goal:** Prevent RCE and path traversal vulnerabilities

### 4.1 Replace exec() with execFile() for Git Commands
**File:** `apps/sidecar/src/services/batch.ts:411-415`  
**Problem:** `execAsync(\`git commit -m "${commitMsg}"\`)` — shell injection via user-controlled task title  
**Fix:** Switch all `exec()` and `execAsync()` git calls to `execFile()` with array args  
**Files to Audit:**
- `apps/sidecar/src/services/batch.ts`
- `apps/sidecar/src/services/execution/git.ts`
- `apps/sidecar/src/services/worktree.ts`
**Validation:** Create task with title containing backticks `$()`, verify safe handling

### 4.2 Add Path Traversal Guards
**File:** `apps/sidecar/src/services/execution/state.ts:23`, `apps/sidecar/src/services/worktree.ts:27-28`  
**Problem:** `path.join(REPOS_DIR, project.name, ...)` — `project.name` can contain `..`  
**Fix:** Add validation — `path.resolve(target).startsWith(path.resolve(REPOS_DIR) + path.sep)`  
**Validation:** Attempt to create project named `../../../etc/passwd`, verify it throws

### 4.3 Hide Git Token from Process Environment
**File:** `apps/sidecar/src/services/worktree.ts:30-32`  
**Problem:** `GH_TOKEN` passed via `env` — visible in `ps` and `/proc`  
**Fix:** Switch to `git credential` helper via stdin or use temporary `.git-credentials` file  
**Validation:** Run `ps e`, verify no `GH_TOKEN` in process environment

---

## Phase 5: Fix Data Integrity
**Priority:** HIGH  
**Time:** ~2 hours  
**Goal:** Prevent orphaned records and race conditions

### 5.1 Wrap Project Delete in Transaction
**File:** `apps/api/src/routes/projects.ts:281-286`  
**Problem:** Two writes (delete project, nullify tasks) not in transaction — partial failure orphans tasks  
**Fix:** Wrap in `prisma.$transaction()`  
**Validation:** Simulate failure mid-delete, verify no orphaned tasks

### 5.2 Fix Team Delete Policy
**File:** `apps/api/src/routes/teams.ts:194`  
**Problem:** Team delete sets `task.teamId = null` — tasks become orphans  
**Fix:** Either cascade delete team's tasks, or block deletion if team has tasks  
**Validation:** Try to delete team with tasks, verify proper error or cascade

### 5.3 Fix Execution State Reset Logic
**File:** `apps/api/src/routes/tasks.ts:348-351`  
**Problem:** State reset triggers when entering `in_progress`, but should clear on terminal states  
**Fix:** Invert condition — reset execution state when transitioning to `done`/`cancelled`/`todo`  
**Validation:** Re-run a completed task, verify old state is cleared

### 5.4 Fix Batch Task Completion Race Condition
**File:** `apps/sidecar/src/services/batch.ts:392-471`  
**Problem:** `handleTaskComplete()` can fire from both event stream AND timeout  
**Fix:** Add atomic completion flag per task, skip if already completed  
**Validation:** Simulate timeout during event completion, verify no duplicate PRs

### 5.5 Fix Fire-and-Forget Batch Promises
**File:** `apps/sidecar/src/services/batch.ts:147,150,484,486`  
**Problem:** `startTask()` called without `await` — errors swallowed, tasks hang  
**Fix:** Wrap in `Promise.allSettled()` or proper async queue with error handling  
**Validation:** Inject error in task start, verify it's caught and broadcast

---

## Phase 6: Fix Frontend Stability
**Priority:** HIGH  
**Time:** ~1.5 hours  
**Goal:** Prevent white screens, memory leaks, and silent failures

### 6.1 Add Root Error Boundary
**File:** `apps/desktop-ui/app/error.tsx` (create)  
**Problem:** No root-level error boundary — layout crash = white screen  
**Fix:** Create `app/error.tsx` with retry UI  
**Validation:** Throw error in root layout, verify error boundary catches it

### 6.2 Fix Sidebar EventSource Lifecycle
**File:** `apps/desktop-ui/components/layout/sidebar.tsx:195-208`  
**Problem:** EventSource opened with `[]` deps — never reconnects on re-login, never closes  
**Fix:** Add `token` to deps, close old connection before opening new one  
**Validation:** Login, logout, login again — verify single SSE connection

### 6.3 Fix Dynamic Tailwind Classes
**File:** `apps/desktop-ui/components/layout/sidebar.tsx`, `app/(app)/teams/manage/page.tsx`  
**Problem:** Runtime class strings like `bg-yellow-500/10` get purged  
**Fix:** Replace with design token classes from `lib/design-tokens.ts`  
**Validation:** Build production bundle, verify classes exist

### 6.4 Fix Auth Loading State
**File:** `apps/desktop-ui/app/(app)/page.tsx:65-67`  
**Problem:** Returns `null` while loading — blank flash + hydration mismatch  
**Fix:** Render skeleton loader instead of null  
**Validation:** Refresh page, verify skeleton appears during auth check

---

## Phase 7: Fix Event Streaming
**Priority:** HIGH  
**Time:** ~1 hour  
**Goal:** Prevent hanging tasks and memory leaks

### 7.1 Fix Event Stream Timeout
**File:** `apps/sidecar/src/services/execution/events.ts:332-349`  
**Problem:** Event subscription hangs forever if OpenCode stalls  
**Fix:** Add 30-second timeout with cleanup on timeout  
**Validation:** Block OpenCode port, verify task times out and cleans up

### 7.2 Fix Delta-Buffer Memory Leak
**File:** `apps/sidecar/src/services/delta-buffer.ts`  
**Problem:** Per-task buffers never freed on SSE disconnect  
**Fix:** Hook buffer cleanup into execution lifecycle (complete/cancel/timeout)  
**Validation:** Run many tasks, verify memory doesn't grow unbounded

### 7.3 Fix SSE Broadcast Failures
**File:** `apps/sidecar/src/services/execution/state.ts:83-86`  
**Problem:** `void broadcastToTaskById(...)` — failures silently lost  
**Fix:** Log failures, add retry queue for critical events  
**Validation:** Disconnect SSE client mid-execution, verify events are queued

---

## Phase 8: Fix Deployment Pipeline
**Priority:** HIGH  
**Time:** ~1 hour  
**Goal:** Safe, reliable deployments

### 8.1 Fix Docker Preview Entrypoint
**File:** `scripts/docker/entrypoint.sh`  
**Problem:** Runs `apps/sidecar/dist/index.js` under name `api` — wrong binary, executes shell commands  
**Fix:** Run `apps/api/dist/index.js` instead  
**Validation:** Build Docker image, verify correct process starts

### 8.2 Fix Docker Postgres Exposure
**File:** `docker-compose.preview.yml`, `scripts/docker/init-db.sh`  
**Problem:** Postgres bound to `0.0.0.0/0` with `trust` auth, port 5432 exposed  
**Fix:** Bind to `127.0.0.1`, use password auth, remove 5432 from compose ports  
**Validation:** Run `nmap` from another container, verify 5432 is not accessible

### 8.3 Add Deploy Rollback Script
**File:** `scripts/deploy.sh` or new `scripts/rollback.sh`  
**Problem:** No rollback mechanism — bad deploy requires manual intervention  
**Fix:** Tag previous good commit, create one-command rollback  
**Validation:** Simulate failed deploy, verify rollback restores previous version

---

## Phase 9: Testing & Validation
**Priority:** HIGH  
**Time:** ~2 hours  
**Goal:** Verify everything works end-to-end

### 9.1 Fix Test Database Setup
**File:** `apps/api/vitest.config.ts`  
**Problem:** 48/57 tests skipped due to missing `DATABASE_URL` in test env  
**Fix:** Add `dotenv/config` to vitest setup, wire `openlinear_test` DB  
**Validation:** Run `pnpm --filter @openlinear/api test`, verify all 57 tests pass

### 9.2 Add Smoke Test Script
**File:** `scripts/smoke-test.sh` (create)  
**Goal:** Automated end-to-end validation  
**Script Steps:**
1. Start API + sidecar + Postgres
2. Create user via OAuth mock
3. Connect GitHub repo
4. Create task
5. Execute task
6. Verify branch created, PR opened
7. Cancel task
8. Clean up

### 9.3 Manual Launch Checklist
- [ ] OAuth flow works (GitHub login → redirect → JWT stored)
- [ ] Repo connection works (list repos, activate, verify clone)
- [ ] Task creation works (kanban board, form, labels)
- [ ] Task execution works (click execute → clone → branch → agent → PR)
- [ ] Batch execution works (select 3 tasks → parallel mode → single PR)
- [ ] Real-time updates work (SSE events, progress bar, logs)
- [ ] Cancel works (mid-execution → clean state)
- [ ] Settings page works (load, save, no 500 errors)
- [ ] Teams page works (create, join, manage members)
- [ ] Deploy pipeline works (push to main → CI green → deploy → health check)

---

## Phase 10: Security Hardening (Post-Launch Critical)
**Priority:** HIGH  
**Time:** ~2 hours  
**Goal:** Encrypt tokens, prevent abuse

### 10.1 Encrypt GitHub Access Tokens
**File:** `apps/api/src/services/github.ts:209-228`  
**Problem:** `user.accessToken` stored in plaintext  
**Fix:** Encrypt with `aes-256-gcm` using `TOKEN_ENCRYPTION_KEY` env var  
**Migration Script:** One-shot encrypt all existing tokens  
**Validation:** Read token from DB, verify it's ciphertext

### 10.2 Add Brainstorm Abuse Limits
**File:** `apps/sidecar/src/routes/brainstorm.ts`  
**Problem:** Unbounded prompt length, no per-user rate limit  
**Fix:** Max prompt 2000 chars, max 5 brainstorms/hour per user  
**Validation:** Submit 10kb prompt, verify rejected. Submit 6th brainstorm in hour, verify 429

### 10.3 Add HSTS Header
**File:** `apps/api/src/app.ts`  
**Problem:** No HSTS header on API responses  
**Fix:** Add `Strict-Transport-Security: max-age=31536000; includeSubDomains` via Helmet  
**Validation:** `curl -I https://openlinear.tech/health`, verify HSTS header present

---

## Execution Order

**Today (8-10 hours):**
1. Phase 1 (CI/CD) — 1h
2. Phase 2 (Auth) — 1.5h
3. Phase 3 (Schema) — 1h
4. Phase 4 (Sidecar Security) — 2h
5. Phase 5 (Data Integrity) — 2h

**Tomorrow AM (4-6 hours):**
6. Phase 6 (Frontend Stability) — 1.5h
7. Phase 7 (Event Streaming) — 1h
8. Phase 8 (Deploy Pipeline) — 1h
9. Phase 9 (Testing) — 2h

**Post-Launch (Week 1):**
10. Phase 10 (Security Hardening) — 2h

---

## Definition of Done

- [ ] All CRITICAL issues fixed and verified
- [ ] All HIGH issues fixed and verified
- [ ] CI passes without `continue-on-error`
- [ ] All 57 tests pass
- [ ] Smoke test script passes end-to-end
- [ ] Manual launch checklist complete
- [ ] No console.log in production builds
- [ ] Health check verifies DB connectivity
- [ ] Deploy to staging, verify no 500s
- [ ] Tag release candidate

---

## Risk Mitigation

**If we can't finish all CRITICAL + HIGH in 2 days:**
1. **Must fix:** B1 (CI), B2 (Settings schema), B3 (Auth holes), B5 (Shell injection)
2. **Can delay:** B10 (Token encryption), H7 (Delta-buffer leak), H12 (Sidebar reconnect)
3. **Fallback:** Disable batch execution temporarily if race conditions can't be fixed

**If staging deploy fails:**
1. Run smoke test locally first
2. Check `pm2 logs` on droplet
3. Verify `.env` has all required vars
4. Run `prisma migrate status` to check migrations

---

## Notes

- **Do not skip Phase 1.** CI is the safety net. Without it, every subsequent fix could be reverted by a bad deploy.
- **Phase 4 (Sidecar Security) is non-negotiable.** RCE on a user's machine is a company-ending bug.
- **Test after every Phase.** Don't batch all changes and test at the end. Test incrementally.
- **Document every change.** The audit trail will be useful for post-mortem and compliance.
