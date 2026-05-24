# OpenLinear: 50/60% → 80% Push

## TL;DR

> **Quick Summary**: Comprehensive stability + polish + feature push: fix 250+ identified bugs (critical: shell injection, multi-tenant auth gaps, broken kanban search, no error handling), complete the OpenLinear visual identity (logo, favicon, fonts, copy), and ship 10 high-impact SaaS features (Cmd+K, comments, markdown, assignee, cost tracking, theme, AlertDialog, hotkeys, inline create + bulk, search).
>
> **Deliverables**:
> - All POST/PATCH/DELETE routes auth-protected with team-scope checks; SSE filtered per user
> - Shell-injection RCE class eliminated across git.ts/worktree.ts (~17 lines hardened)
> - Schema migrated: `assigneeId`, `creatorId`, `Comment`, `AgentRun`, `Notification`, `ActivityLog` models + indexes + uniques
> - Single `apiFetch()` wrapper with 401 redirect + lazy URL resolution + uniform error envelope
> - Cmd+K command palette + global search backend + UI
> - Comments + @mentions + markdown editor + Inbox notifications backed by real model
> - Per-user `AgentRun` records with cost/token capture from OpenCode SDK + analytics page
> - Working theme switcher (dark/system; deferred light), AlertDialog primitive replacing 4 native confirms, `?` hotkeys overlay
> - Inline task creation in board columns + multi-select bulk actions
> - Complete OpenLinear visual identity: SVG logomark, full favicon set, Tauri icon set, OG/Twitter cards, unified palette across desktop+landing, font cleanup
> - Landing page copy purged of placeholder/template content (Zep/Mem0, fake "1.2k", broken footer links, false integrations)
> - Personal handle `kaizen403` → `openlinear` org migration across 14 sites
> - Domain unified to `openlinear.tech` (5 `.dev` references fixed)
> - Reduced-motion support, focus-visible restored, App Router error boundaries (loading.tsx/error.tsx/not-found.tsx)
> - Pino request logging, Helmet, rate limiting, global error middleware, graceful shutdown
> - Per-task `parentId` (subtasks), Activity log feed
>
> **Estimated Effort**: XL
> **Parallel Execution**: YES — 6 waves
> **Critical Path**: Wave 1 foundation → Wave 2-5 parallel → Wave 6 final review

---

## Context

### Original Request
"There are many bugs. I see a few friends and bugs when I'm creating the issue. The last thing is the UI has some bugs. Fix the friend and fix whatever you see is broken. The API is failing many times, and even as a whole app, any features are missing. I want to do complete research and complete planning about this... I feel it's like 50-60 complete; I want you to push it to 80. Feel free to make any changes you like. This is a SAS platform. I want you to remove the KS Code logo and put Open Linear in a very nice way. It should be very simple and clean, and the UI bugs, the animations, I wanted to fix. Like, everything. I can't explain each and everything; just index the whole codebase and do the best you can do."

### Interview Decisions
- **Priority**: Parallel everything (most aggressive) — bugs + rebrand + features interleaved
- **Scope**: Feature-heavy — fix critical bugs + rebrand + 6-10 SaaS features
- **Trust**: User explicitly said "feel free to make any changes you like"
- **Test Strategy**: No formal test infrastructure exists — rely on agent-executed QA via Playwright (UI), curl (API), tmux (CLI). Each task includes happy + failure scenarios.

### Research Summary (6 parallel explore agents, ~250 findings)
- **Branding (bg_3f8a29fa)**: 95% rebrand-complete; remaining: 14 `kaizen403` refs, 5 `.dev` vs `.tech` inconsistencies, no SVG logo, no proper favicon/Tauri icon set, fonts unused (Geist, Caveat), placeholder landing copy
- **Design system (bg_d5d360c0)**: shadcn-based with nice `linear.*` palette + runtime accent themability; missing primitives (AlertDialog, cmdk, DropdownMenu, Tabs, Tooltip, Avatar, Skeleton, Sheet); raw hex literals duplicate tokens in 10+ files
- **Missing features (bg_f5780c3f)**: Cmd+K, search, comments+@mentions, markdown, assignee/creator, cost tracking, theme switcher, AlertDialog, hotkeys, inline create+bulk
- **UI bugs (bg_2530bdf1)**: 66 across 22 files — header search wired to nothing; project name renders literal "OpenLinear"; focus outline removed globally; ZERO prefers-reduced-motion; module cache leaks across users; silent error handling everywhere
- **API bugs (bg_f4c71c16)**: 75 — SHELL INJECTION in git.ts/worktree.ts (RCE class), AUTH GAPS on POST/PATCH/DELETE tasks, labels/settings global no auth, SSE cross-tenant leak, OpenCode shared auth across users, schema confusion, no indexes, no error middleware, no rate limiting
- **State/data flow (bg_f36ae619)**: 28 — no 401 handling anywhere, module-level URL captures stale, 3 protected endpoints without auth headers, no loading.tsx/error.tsx, dual SSE double-broadcasts

### Self-Metis Gap Analysis
- **Security MUST land in Wave 1** even in "parallel everything" mode — features depending on auth routes can't ship before auth works
- **Schema migration is a hard blocker** for #3 comments, #5 assignee, #6 cost tracking — Wave 1
- **`apiFetch()` wrapper blocks ~20 silent-error fixes** — Wave 1
- **Merge conflict hot zones**: `app/globals.css`, `use-kanban-board.ts`, `task-detail-view.tsx` — bundled into single tasks where possible
- **Deferred (out of scope)**: file attachments, full notifications (push/email), 2FA implementation, real session management, light theme, cycles/roadmap/templates, OpenCode binary bundling, Tauri Rust changes, Apple cert/notarization

---

## Work Objectives

### Core Objective
Push OpenLinear from a half-finished prototype with critical security holes and silent-failure UX to a polished, secure, feature-complete SaaS that feels like a real product — with a complete OpenLinear visual identity replacing the placeholder PNG logo.

### Concrete Deliverables
- Hardened API: every mutating route auth + ownership checked, no shell injection, structured errors, request logging, rate limiting
- New schema: `assigneeId`, `creatorId`, `parentId` on Task; new `Comment`, `AgentRun`, `Notification`, `ActivityLog` models with indexes and uniques
- New API routes: `/api/comments`, `/api/agent-runs`, `/api/search`, `/api/notifications`, `/api/activity-log`
- Single `apiFetch()` client wrapper handling 401, lazy URL resolution, uniform error envelope
- 10 SaaS features shipped (Cmd+K palette, search, comments+mentions, markdown, assignee, cost analytics, theme, AlertDialog, hotkeys, inline+bulk)
- Complete OpenLinear identity: SVG logomark + wordmark + favicon set + Tauri icon set + OG/Twitter cards
- Unified design tokens; raw hex literals removed; semantic status color tokens; reduced-motion + focus-visible respected
- Landing page truthful and polished (no Zep/Mem0, no fake stats, no broken footer links, real claims only)

### Definition of Done
- [x] Final-wave 4 review agents (oracle plan-compliance, code-quality, manual QA, scope-fidelity) ALL approve
- [ ] User explicitly approves consolidated review summary
- [x] All evidence files exist in `.sisyphus/evidence/`

### Must Have
- ALL POST/PATCH/DELETE on `/api/tasks` require auth + team-scope ownership
- Shell injection eliminated from `git.ts` and `worktree.ts` (use `execFile`/argv arrays — zero `exec` with interpolation)
- Single `apiFetch()` wrapper used by ALL UI fetches; zero hand-rolled `localStorage.getItem('token')` outside it
- 401 from any API call clears token + redirects to `/login` via auth context emit
- `Comment` + `Notification` + `AgentRun` + `ActivityLog` models exist, migrated, queryable
- `assigneeId` and `creatorId` on Task; `my-issues` filters to current user's tasks
- Cmd+K command palette with global search results
- Markdown rendering on task descriptions and comments
- Theme switcher functional (dark/system; light deferred)
- `prefers-reduced-motion` respected everywhere framer-motion is used
- `focus-visible` shows visible 2px accent ring on all form fields
- SVG logomark + wordmark + complete favicon set + Tauri icon set
- Domain unified to `openlinear.tech` (zero `.dev` references in landing copy)
- `kaizen403` handle replaced everywhere user-visible
- Landing copy: zero references to Zep/Mem0; zero fake stats; footer links resolve; integrations claims match reality
- App Router error boundaries: `loading.tsx`, `error.tsx`, `not-found.tsx` at root + per-section
- `prisma.$transaction` callbacks pass under sustained load (>10 concurrent task creates)
- Final container builds and runs; smoke test: GitHub login → create task → execute → see cost → comment → @mention → notification appears → archive

### Must NOT Have (Guardrails)
- No new files for trivial helpers — extend existing modules
- No `as any` / `@ts-ignore` introduced
- No `console.log` in production code (use `pino`)
- No `window.confirm()` / `window.alert()` / `window.prompt()` anywhere — use AlertDialog
- No raw `localStorage.getItem('token')` outside `apiFetch()`
- No new direct `fetch()` calls in pages — must go through `apiFetch()` or `lib/api/*`
- No new raw hex color literals — must use design tokens
- No new `exec()` with shell interpolation — `execFile`/`spawn` with arrays only
- No new endpoints without auth + ownership checks
- No new Prisma queries without index coverage on `where` filters
- No new module-level `getApiUrl()` / `getSidecarApiUrl()` captures — call inside functions
- No deferring of security tasks (#W1.5, #W1.6, #W2.1, #W2.2 cannot slip)
- No light theme (deferred — too much surface)
- No file attachments (deferred — needs storage backend)
- No cycles/roadmap/templates (deferred)
- No Tauri Rust changes (no toolchain available)
- No OpenCode binary bundling in this plan (separate effort)
- No "fix everything in one mega-task" — every task is bounded

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: NO formal test framework configured
- **Automated tests**: NO unit/integration tests (will rely on Agent QA scenarios)
- **Framework**: N/A
- **Strategy**: Every task includes mandatory agent-executed QA scenarios with happy + failure paths

### QA Policy
Every task MUST include agent-executed QA scenarios. Evidence saved to `.sisyphus/evidence/task-{N}-{slug}.{ext}`.

- **Frontend/UI**: Playwright skill — navigate via desktop-ui at http://localhost:3000, interact, assert DOM, screenshot
- **API/Backend**: Bash + curl — issue requests, assert status code + JSON response shape, log raw response
- **CLI/Build**: interactive_bash (tmux) — run pnpm scripts, capture stdout/stderr, assert exit code
- **Schema**: Bash + `psql` or `prisma studio` introspect — verify columns/indexes/constraints exist

---

## Execution Strategy

### Parallel Execution Waves

> 6 waves. Wave 1 is the bottleneck (foundation); Waves 2-5 fan out maximally; Wave 6 is final review.

```
Wave 1 (Foundation — start IMMEDIATELY, blocks everything else):
├── T1.  Schema migration: assigneeId/creatorId/parentId/Comment/AgentRun/Notification/ActivityLog + indexes + uniques [unspecified-high]
├── T2.  Design tokens consolidation + AlertDialog/Sheet/Tooltip/Avatar/Skeleton/Tabs/DropdownMenu/Command primitives [visual-engineering]
├── T3.  apiFetch() wrapper: lazy URL resolve + 401 handler + uniform error envelope + remove all module-level URL captures [unspecified-high]
├── T4.  API hardening: pino logging + helmet + global error middleware + rate limiting + graceful shutdown + remove OPENLINEAR_TRUST_PROXY_AUTH guard [unspecified-high]
├── T5.  Brand assets: SVG logomark + wordmark + full favicon set + Tauri icon set + OG/Twitter cards [visual-engineering]
├── T6.  SECURITY: shell injection elimination across git.ts + worktree.ts (execFile/argv arrays everywhere) [deep]
└── T7.  SECURITY: AUTH on all task/label/settings routes + team-scope ownership helper [deep]

Wave 2 (Backend correctness — depends on T1, T3, T4, T7):
├── T8.  SSE per-user filtering + auth on /api/events + reconnect with jitter [unspecified-high]
├── T9.  Validation pass: zod schemas on all routes + correct status codes (201 on create) + Prisma error code matching [unspecified-high]
├── T10. Comments API: routes + ownership + @mention parsing → Notification creation [unspecified-high]
├── T11. AgentRun capture in execution lifecycle: persist cost/tokens/duration/status/prUrl per run [deep]
├── T12. Search API: GET /api/search?q= with ILIKE on tasks/projects/teams scoped to user's teams [quick]
├── T13. Notifications + ActivityLog API: routes + integrate into mutation handlers [unspecified-high]
├── T14. Execution state recovery on sidecar restart: rehydrate from DB rows with status=in_progress [deep]
└── T15. OpenCode per-user isolation OR documented single-tenant constraint [deep]

Wave 3 (UI bug sweep — depends on T2, T3):
├── T16. Wire header search to KanbanBoard filter (currently does nothing) [quick]
├── T17. Convert TaskDetailView to Radix Sheet + fix project name placeholder [quick]
├── T18. Optimistic update rollback for use-kanban-board (snapshot/restore pattern) [unspecified-high]
├── T19. Replace 4 native window.confirm() with AlertDialog [quick]
├── T20. Replace 8 hand-rolled localStorage.getItem('token') in use-kanban-board with apiFetch [quick]
├── T21. globals.css: restore focus-visible 2px ring + add prefers-reduced-motion overrides [quick]
├── T22. Form error pipeline: surface errors with toast + inline (projects, teams, task-form, label-picker, inbox) [unspecified-high]
├── T23. Sidebar: remove module-level cachedTeams; per-user via context + clear on logout [quick]
└── T24. Animation polish: useReducedMotion in framer-motion call sites; stop infinite brain pulse; coordinate sidebar/content transitions [visual-engineering]

Wave 4 (Features — depends on T1, T2, T3, T10, T12):
├── T25. Cmd+K command palette: cmdk + navigate/quick-actions + search results from T12 [visual-engineering]
├── T26. Markdown rendering: @uiw/react-md-editor or Tiptap on task description + comments [visual-engineering]
├── T27. Comments UI: composer + thread under task description, @mention autocomplete [visual-engineering]
├── T28. Inbox real notifications: list from T13 with grouping + mark-read + filter [visual-engineering]
├── T29. Working theme switcher: next-themes wired to settings + Toaster + meta theme-color [quick]
├── T30. Keyboard shortcuts: react-hotkeys-hook + ? overlay sheet listing all shortcuts [quick]
├── T31. Inline task creation in board columns + bulk-select + bulk actions toolbar [unspecified-high]
├── T32. Assignee/creator UI: assignee picker in task detail + my-issues filters by current user [unspecified-high]
└── T33. Cost analytics page: /usage with per-task + aggregate cost/tokens from AgentRun [visual-engineering]

Wave 5 (Rebrand + landing polish — depends on T2, T5):
├── T34. Replace logo.png usages with SVG logomark + wordmark across desktop-ui + landing [visual-engineering]
├── T35. Tauri icon regeneration via tauri icon master.svg → icns/ico/multi-size pngs [quick]
├── T36. Font cleanup: delete Geist .otf/.woff2 + npm pkg + Caveat link; settle on Space Grotesk + DM Sans + DM Mono (drop EB Garamond if unused) [quick]
├── T37. Unify desktop + landing palette: pick canonical OpenLinear accent, sync globals.css both apps [visual-engineering]
├── T38. Remove raw hex literals: replace bg-[#1a1a1a] etc with linear-* tokens; extract status colors to lib/design-tokens.ts [quick]
├── T39. Landing copy purge: remove Zep/Mem0 references, fake "X 1.2k" stat, false integration claims; rewrite hero/performance/integrations sections truthfully [writing]
├── T40. Landing footer + nav: wire all href="#" to real pages or remove; unify domain to openlinear.tech [quick]
├── T41. kaizen403 → openlinear org rename: 14 sites (README, AUR, CLI postinstall, CI/CD docs, landing components, contact page, package.json) + npm pkg @kaizen403/openlinear-cli → @openlinear/cli [quick]
└── T42. Seed user kaz → demo + remove personal traces from packages/db/prisma/seed.ts [quick]

Wave 6 (Polish + boundaries — depends on T1-T5):
├── T43. App Router error boundaries: root + per-section loading.tsx, error.tsx, not-found.tsx [quick]
├── T44. Empty states + skeletons: reusable EmptyState component; replace ad-hoc "No X yet" strings [visual-engineering]
├── T45. Sidebar polish: fix handleClose calling minimize bug; nested button HTML fix; user dropdown menu [quick]
├── T46. Dead code removal: hooks/use-sse.ts; defensive headerLabel.replace in app/page.tsx; unused fonts [quick]
├── T47. Settings tab cleanup: hide non-functional 2FA + sessions list (don't ship fake mocks); add real Profile tab [unspecified-high]
└── T48. Pagination on tasks list + inbox + archived endpoints [quick]

Wave FINAL (4 parallel reviews → user okay):
├── F1. Plan compliance audit (oracle)
├── F2. Code quality review (unspecified-high)
├── F3. Real manual QA — full smoke test (unspecified-high + playwright)
└── F4. Scope fidelity check (deep)
→ Present consolidated results → Wait for explicit user okay

Critical Path: T1 → T7 → T10 → T27 → F1-F4 → user okay
Parallel Speedup: ~75% faster than sequential
Max Concurrent: 9 tasks (Wave 4)
```

### Dependency Matrix (abbreviated — shown for key bottlenecks)

- **T1 (schema)**: blocks T10, T11, T13, T14, T27, T28, T31, T32, T33
- **T2 (primitives)**: blocks T17, T19, T25, T26, T27, T28, T44
- **T3 (apiFetch)**: blocks T16, T18, T20, T22, T23, T28
- **T4 (api hardening)**: blocks T8, T9, T13
- **T5 (brand assets)**: blocks T34, T35
- **T6 (shell injection)**: blocks T11 (execution writes touch git)
- **T7 (auth)**: blocks T8, T10, T13, T31, T32

### Agent Dispatch Summary

- **Wave 1**: 7 — T1/T3/T4/T7 → unspecified-high+deep, T2/T5 → visual-engineering, T6 → deep
- **Wave 2**: 8 — T8/T9/T10/T13 → unspecified-high, T11/T14/T15 → deep, T12 → quick
- **Wave 3**: 9 — T16/T19/T20/T21/T23 → quick, T17 → quick, T18/T22 → unspecified-high, T24 → visual-engineering
- **Wave 4**: 9 — T25/T26/T27/T28/T33 → visual-engineering, T29/T30 → quick, T31/T32 → unspecified-high
- **Wave 5**: 9 — T34/T37/T44 → visual-engineering, T39 → writing, others → quick
- **Wave 6**: 6 — T43-T46/T48 → quick, T47 → unspecified-high
- **FINAL**: 4 — F1 → oracle, F2 → unspecified-high, F3 → unspecified-high+playwright, F4 → deep

---

## TODOs

> Implementation + Test = ONE Task. Never separate.
> EVERY task MUST have: Recommended Agent Profile + Parallelization info + QA Scenarios.

### WAVE 1 — FOUNDATION

- [x] 1. **Schema migration: add Comment, AgentRun, Notification, ActivityLog + assigneeId/creatorId/parentId on Task + indexes + uniques**

  **What to do**:
  - Edit `packages/db/prisma/schema.prisma`:
    - Add to `Task`: `assigneeId String?`, `creatorId String?`, `parentId String?`, FK relations to `User` (opposite side: `assignedTasks`, `createdTasks`), FK to self for `parentId` (relation name `Subtasks`)
    - Add `@@index([teamId, archived])`, `@@index([projectId])`, `@@index([status])`, `@@index([assigneeId])`, `@@index([creatorId])`, `@@unique([teamId, number])`
    - Add new model `Comment { id, taskId (FK Task cascade), userId (FK User), body String, mentions String[], createdAt, updatedAt; @@index([taskId, createdAt]) }`
    - Add new model `AgentRun { id, taskId (FK Task cascade), userId (FK User?), agent String, model String, startedAt, endedAt DateTime?, costUsd Decimal? @db.Decimal(12,6), inputTokens Int?, outputTokens Int?, status enum AgentRunStatus, prUrl String?, errorMessage String?; @@index([taskId, startedAt]), @@index([userId, startedAt]) }`
    - Add new model `Notification { id, userId (FK User cascade), type enum NotificationType (mention/assignment/status_change/comment), taskId String?, commentId String?, actorUserId String?, body String, readAt DateTime?, createdAt; @@index([userId, readAt, createdAt]) }`
    - Add new model `ActivityLog { id, taskId String? (FK Task), projectId String? (FK Project), teamId String? (FK Team), userId (FK User), action enum ActivityAction, payload Json, createdAt; @@index([taskId, createdAt]), @@index([projectId, createdAt]) }`
    - Add `@unique` to `User.email`
    - Rename `Repository @@map("projects")` → `@@map("repositories")` (BREAKING — coordinated with migration)
  - Run `pnpm db:migrate --name 80_percent_foundation` (creates `prisma/migrations/`)
  - Update `prisma/seed.ts`: rename `seed-user-kaz` → `seed-user-demo`, `username: "kaz"` → `"demo"`
  - Bump prisma client + run `pnpm prisma generate`

  **Must NOT do**:
  - Don't drop existing data; migration must be additive (use `db:migrate` not `db:push --accept-data-loss`)
  - Don't add fields without indexes if they'll be queried
  - Don't rename `Project @@map("linear_projects")` (breaks too much; just document the historical quirk)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` — schema design + migration generation + Prisma + understanding existing FK graph
  - **Skills**: `prisma-expert` (Prisma 7.4 schema + migrations + indexes), `database-schema-designer` (FK design, normalization, index strategy)
  - **Skills Evaluated but Omitted**: `postgresql-table-design` (overkill — Prisma generates correct DDL); `sql-optimization-patterns` (no query tuning yet)

  **Parallelization**:
  - **Can Run In Parallel**: NO — Wave 1 blocker
  - **Parallel Group**: Wave 1 with T2-T7 (different surfaces)
  - **Blocks**: T10, T11, T13, T14, T27, T28, T31, T32, T33
  - **Blocked By**: None

  **References**:
  - `packages/db/prisma/schema.prisma` — current 9-model schema; Task, User, Project, Team, TeamMember, ProjectTeam, Label, TaskLabel, Repository, Settings
  - `packages/db/prisma/seed.ts:81,84,85,116,126` — `kaz` references to rename
  - `packages/db/src/client.ts` — singleton Proxy (don't touch)
  - `apps/api/src/routes/teams.ts:301` — `prisma.user.findFirst({ where: { email } })` will benefit from `@unique`
  - `apps/sidecar/src/services/execution/state.ts:62` — `activeExecutions` map needs DB recovery (T14)
  - Prisma 7.4 driver-adapter mode — `@prisma/adapter-pg` already configured
  - Schema quirk to preserve: `Project @@map("linear_projects")` MUST stay

  **WHY References Matter**:
  - schema.prisma is the source of truth — every other model relation must remain valid
  - seed.ts gets rewritten with new fields (creatorId/assigneeId on demo task)
  - T14 will need `select * from tasks where status='in_progress'` so `@@index([status])` is critical
  - `email @unique` lets us drop the brittle `findFirst` and gives Prisma `findUnique` codepath

  **Acceptance Criteria**:
  - [ ] `pnpm prisma generate` succeeds with 0 errors
  - [ ] `pnpm db:migrate --name 80_percent_foundation` creates `prisma/migrations/<timestamp>_80_percent_foundation/migration.sql`
  - [ ] Migration SQL contains `ADD COLUMN "assigneeId"`, `ADD COLUMN "creatorId"`, `ADD COLUMN "parentId"`, `CREATE TABLE "Comment"`, `CREATE TABLE "AgentRun"`, `CREATE TABLE "Notification"`, `CREATE TABLE "ActivityLog"`, all `CREATE INDEX` statements

  **QA Scenarios**:

  ```
  Scenario: Migration applies cleanly to existing DB
    Tool: Bash
    Preconditions: Postgres running with existing schema, container `openlinear` healthy
    Steps:
      1. Backup: `docker exec openlinear pg_dump -U openlinear openlinear > /tmp/pre-migration.sql`
      2. Run: `docker exec openlinear sh -c "cd /app && pnpm db:migrate deploy"`
      3. Inspect: `docker exec openlinear psql -U openlinear -d openlinear -c "\d Task"` — verify columns assigneeId, creatorId, parentId exist
      4. Inspect: `docker exec openlinear psql -U openlinear -d openlinear -c "\dt"` — verify Comment, AgentRun, Notification, ActivityLog tables exist
      5. Inspect indexes: `docker exec openlinear psql -U openlinear -d openlinear -c "\di"` — verify Task_teamId_archived_idx, Task_status_idx, etc. exist
    Expected Result: All tables, columns, indexes present; existing rows untouched
    Failure Indicators: Migration error, missing columns, dropped data
    Evidence: .sisyphus/evidence/task-1-migration-success.txt (psql output)

  Scenario: User.email uniqueness enforced
    Tool: Bash
    Preconditions: Migration applied
    Steps:
      1. Insert duplicate: `docker exec openlinear psql -U openlinear -d openlinear -c "INSERT INTO users (id, email, username, name) VALUES ('test1', 'dup@test.com', 'a', 'A'), ('test2', 'dup@test.com', 'b', 'B');"`
    Expected Result: ERROR: duplicate key value violates unique constraint "users_email_key"
    Evidence: .sisyphus/evidence/task-1-email-unique-error.txt
  ```

  **Commit**: YES (groups alone)
  - Message: `feat(db): add Comment/AgentRun/Notification/ActivityLog models + assignee/creator/parent on Task with indexes`
  - Files: `packages/db/prisma/schema.prisma`, `packages/db/prisma/migrations/<ts>_80_percent_foundation/`, `packages/db/prisma/seed.ts`
  - Pre-commit: `pnpm prisma generate && pnpm typecheck --filter=@openlinear/db`

---

- [x] 2. **shadcn primitives + design tokens consolidation**

  **What to do**:
  - Add shadcn primitives via CLI or manual: `apps/desktop-ui/components/ui/{alert-dialog,sheet,tooltip,avatar,skeleton,tabs,dropdown-menu,command,scroll-area,context-menu}.tsx`
  - Install deps: `cmdk`, `@radix-ui/react-{alert-dialog,tooltip,avatar,tabs,dropdown-menu,scroll-area,context-menu}` (Sheet uses dialog primitive)
  - Create `apps/desktop-ui/lib/design-tokens.ts` exporting:
    - Status color map (todo/in_progress/done/cancelled/error/cloning/executing/committing/creating_pr) with bg + text + border classes
    - Priority color map (low/medium/high/urgent)
    - Semantic shadow tokens (`shadow-card`, `shadow-overlay`, `shadow-elevation`)
    - Reusable empty-state palette
  - Update `apps/desktop-ui/tailwind.config.ts`: extend with semantic shadow tokens
  - Don't touch `globals.css` (T21 owns it)

  **Must NOT do**:
  - Don't change `linear-*` namespace (preserve runtime accent)
  - Don't introduce raw hex literals (T38 will remove existing ones)
  - Don't ship light-mode tokens (deferred)

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering` — shadcn/ui primitive integration + Radix + Tailwind tokens
  - **Skills**: `shadcn-ui` (component installation, theming, Radix wrapping patterns), `frontend-design` (token system structure)
  - **Skills Evaluated but Omitted**: `figma-implement-design` (no Figma source provided)

  **Parallelization**:
  - **Can Run In Parallel**: YES with T1, T3, T4, T5, T6, T7
  - **Parallel Group**: Wave 1
  - **Blocks**: T17, T19, T25, T26, T27, T28, T44
  - **Blocked By**: None

  **References**:
  - `apps/desktop-ui/components/ui/` — existing 13 primitives (button, input, dialog, etc.)
  - `apps/desktop-ui/components.json` — shadcn config (style: default, baseColor: neutral, cssVariables: true)
  - `apps/desktop-ui/tailwind.config.ts` — `linear.*` namespace + container + plugins
  - `apps/desktop-ui/app/globals.css:37-38` — `--linear-accent` runtime variable (DO NOT touch — owned by T21/T37)
  - shadcn docs: https://ui.shadcn.com/docs/components/alert-dialog (canonical patterns)
  - cmdk docs: https://github.com/pacocoursey/cmdk (Command palette base)

  **WHY References Matter**:
  - components.json must remain valid; new primitives use same baseColor neutral
  - linear-accent will be themable so primitives must use `bg-primary` not literals
  - design-tokens.ts becomes the single import for status colors (T38 deletes scattered literals)

  **Acceptance Criteria**:
  - [ ] All 10 new primitive files exist in `apps/desktop-ui/components/ui/`
  - [ ] `pnpm --filter @openlinear/desktop-ui build` succeeds
  - [ ] `apps/desktop-ui/lib/design-tokens.ts` exports `STATUS_COLORS`, `PRIORITY_COLORS`, `SHADOWS` typed constants

  **QA Scenarios**:

  ```
  Scenario: AlertDialog renders and trigger works
    Tool: Bash + Playwright
    Preconditions: New primitives created; minimal test page added at apps/desktop-ui/app/_dev/primitives/page.tsx (DELETE after QA)
    Steps:
      1. Add test page rendering <AlertDialog><AlertDialogTrigger>Open</AlertDialogTrigger>...</AlertDialog>
      2. Boot UI: scripts/openlinear.sh up
      3. Playwright: navigate http://localhost:3000/_dev/primitives, click "Open" button
      4. Assert: AlertDialog appears with backdrop, ESC closes, click outside closes
      5. Screenshot
      6. Delete _dev/primitives/page.tsx
    Expected Result: AlertDialog opens/closes correctly; screenshot shows themed dialog
    Evidence: .sisyphus/evidence/task-2-alertdialog.png

  Scenario: design-tokens.ts is type-safe and imports
    Tool: Bash
    Steps:
      1. Run: `pnpm --filter @openlinear/desktop-ui exec tsc --noEmit`
    Expected Result: Exit 0; no TS errors
    Evidence: .sisyphus/evidence/task-2-typecheck.txt
  ```

  **Commit**: YES
  - Message: `feat(ui): add AlertDialog, Sheet, Tooltip, Avatar, Skeleton, Tabs, DropdownMenu, Command primitives + design tokens`
  - Files: `apps/desktop-ui/components/ui/*.tsx` (10 new), `apps/desktop-ui/lib/design-tokens.ts`, `apps/desktop-ui/tailwind.config.ts`, `apps/desktop-ui/package.json`, `pnpm-lock.yaml`
  - Pre-commit: `pnpm --filter @openlinear/desktop-ui build`

---

- [x] 3. **Single apiFetch() wrapper with 401 handler + lazy URL resolution**

  **What to do**:
  - Create `apps/desktop-ui/lib/api/fetch.ts` exporting `apiFetch<T>(path: string, init?: RequestInit & { sidecar?: boolean }): Promise<T>` that:
    - Resolves `getApiUrl()` or `getSidecarApiUrl()` INSIDE the function (never module-level)
    - Auto-attaches `getAuthHeader()` (Authorization + x-openlinear-client)
    - On 401: clears localStorage token, dispatches `window.dispatchEvent(new CustomEvent('auth:expired'))`, throws `AuthExpiredError`
    - On non-2xx: parses `{ error, code, details }` envelope; throws typed `ApiError` carrying server message
    - On network error: throws `NetworkError` with retry-after hint
  - Add `auth:expired` listener in `apps/desktop-ui/hooks/use-auth.tsx`: setUser(null), router.push('/login'), toast.error("Session expired")
  - Migrate all `lib/api/*.ts` files to use `apiFetch` (replace hand-rolled fetch + try/catch + JSON.parse)
  - Migrate `apps/desktop-ui/components/board/use-kanban-board.ts` 8 hand-rolled `localStorage.getItem('token')` sites to apiFetch
  - Remove module-level captures: `app/archived/page.tsx:17`, `components/task-form.tsx:57`, `components/label-picker.tsx:30`, `components/desktop/api-loading-screen.tsx:14`, `use-kanban-board.ts:31-32`
  - Migrate the 3 endpoints calling without auth header: `app/archived/page.tsx:39`, `app/teams/manage/page.tsx:113`, `app/settings/page.tsx:166+270`

  **Must NOT do**:
  - Don't keep parallel old fetch helpers
  - Don't add module-level URL captures anywhere new
  - Don't suppress errors silently — every catch must `toast.error` or rethrow

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` — touches many files, contract-design + careful migration
  - **Skills**: `nodejs-backend-patterns` (HTTP client patterns, error envelopes), `architecture-patterns` (single seam for cross-cutting concerns)
  - **Skills Evaluated but Omitted**: `api-design-principles` (this is client wrapper not API design)

  **Parallelization**:
  - **Can Run In Parallel**: YES with T1, T2, T4, T5, T6, T7
  - **Parallel Group**: Wave 1
  - **Blocks**: T16, T18, T20, T22, T23, T28
  - **Blocked By**: None

  **References**:
  - `apps/desktop-ui/lib/api/client.ts:20-90` — getAuthHeader, getApiUrl, getSidecarApiUrl, ensureSidecarListener
  - `apps/desktop-ui/lib/api/auth.ts` — fetchCurrentUser pattern; only file with structured error class to follow
  - `apps/desktop-ui/lib/api/opencode.ts:OpenCodeUnavailableError` — typed error pattern to mirror
  - `apps/desktop-ui/components/board/use-kanban-board.ts:191,216,575,671,693,707,745,760` — 8 hand-rolled token sites
  - `apps/desktop-ui/hooks/use-auth.tsx:46-58` — token-from-URL flow; ensure auth:expired listener doesn't conflict
  - SWR not installed; React Query not installed — staying with plain fetch

  **WHY References Matter**:
  - client.ts is the ONLY current source for getApiUrl — preserve its lazy sidecar URL resolution
  - opencode.ts shows the typed-error pattern to copy
  - 8 sites in use-kanban-board are the most-touched migration targets

  **Acceptance Criteria**:
  - [ ] `apps/desktop-ui/lib/api/fetch.ts` exists with `apiFetch`, `ApiError`, `AuthExpiredError`, `NetworkError`
  - [ ] `grep -rn "localStorage.getItem('token')" apps/desktop-ui/components/ apps/desktop-ui/app/` returns 0 matches (only `lib/api/fetch.ts`)
  - [ ] `grep -rn "const API_BASE_URL = getApiUrl" apps/desktop-ui/` returns 0 matches
  - [ ] `pnpm --filter @openlinear/desktop-ui build` passes

  **QA Scenarios**:

  ```
  Scenario: 401 from API redirects to /login
    Tool: Playwright + Bash
    Preconditions: Container running, user logged in, valid token in localStorage
    Steps:
      1. Browser: navigate http://localhost:3000 (board view)
      2. Browser DevTools: localStorage.setItem('token', 'invalid-jwt'); location.reload()
      3. Wait for kanban fetch to fire
    Expected Result: Toast "Session expired" appears, browser redirects to /login, localStorage token cleared
    Evidence: .sisyphus/evidence/task-3-401-redirect.png + screencast

  Scenario: Sidecar URL resolves lazily (Tauri runtime)
    Tool: Bash
    Steps:
      1. Run: `grep -rn "= getApiUrl()\|= getSidecarApiUrl()" apps/desktop-ui/components/ apps/desktop-ui/app/`
    Expected Result: Zero matches at module top-level (only inside functions)
    Evidence: .sisyphus/evidence/task-3-no-module-capture.txt

  Scenario: Network error surfaces typed message
    Tool: Playwright
    Preconditions: API stopped (container down or sidecar killed)
    Steps:
      1. Browser: navigate /projects, click "New Project", fill, Submit
    Expected Result: Toast appears with NetworkError message ("Could not reach OpenLinear server"), form remains open with values intact
    Evidence: .sisyphus/evidence/task-3-network-error.png
  ```

  **Commit**: YES
  - Message: `refactor(ui): single apiFetch wrapper with 401 redirect and lazy URL resolution`
  - Files: `apps/desktop-ui/lib/api/fetch.ts` (new), `apps/desktop-ui/lib/api/{client,auth,tasks,projects,teams,repos,brainstorm,opencode}.ts`, `apps/desktop-ui/hooks/use-auth.tsx`, `apps/desktop-ui/components/board/use-kanban-board.ts`, `apps/desktop-ui/app/{archived,teams/manage,settings}/page.tsx`, `apps/desktop-ui/components/{task-form,label-picker}.tsx`, `apps/desktop-ui/components/desktop/api-loading-screen.tsx`
  - Pre-commit: `pnpm --filter @openlinear/desktop-ui typecheck`

---

- [x] 4. **API hardening: pino logging + helmet + global error middleware + rate limiting + graceful shutdown**

  **What to do**:
  - Install `pino`, `pino-http`, `helmet`, `express-rate-limit` in `apps/api`
  - Edit `apps/api/src/app.ts`:
    - Mount `helmet({ contentSecurityPolicy: false })` (CSP managed in Tauri)
    - Mount `pino-http` with `genReqId` and `redact: ['req.headers.authorization', 'req.headers.cookie']`
    - Replace `express.json()` with `express.json({ limit: '256kb' })`
    - Mount `express-rate-limit` on `/api/auth/*` (5/min), `/api/repos/url` (10/min), `/api/transcribe` (10/min), default cap `100/min`
    - Add global error middleware (LAST): logs via req.log, returns `{ error: 'internal_error', requestId }` with 500 (or actual code)
    - Fix CORS: `callback(null, false)` instead of throw
  - Edit `apps/api/src/index.ts`:
    - SIGTERM/SIGINT handler: `server.close(() => prisma.$disconnect())` with 10s force-exit timer
  - Edit `apps/api/src/middleware/auth.ts:15-26`: refuse `OPENLINEAR_TRUST_PROXY_AUTH=1` if `NODE_ENV==='production'`; log loud warning every request
  - Same for `apps/sidecar/src/app.ts` (helmet, pino, error middleware, rate limit on `/api/transcribe`, `/api/brainstorm`); SIGTERM in `apps/sidecar/src/index.ts`

  **Must NOT do**:
  - Don't enable CSP in helmet (Tauri owns CSP)
  - Don't apply rate limit to SSE endpoint
  - Don't strip auth header from logs incorrectly
  - Don't make the migration block sidecar boot if pino fails to write

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` — Express middleware stack + production observability
  - **Skills**: `nodejs-backend-patterns` (Express middleware order, error handling), `appinsights-instrumentation` (logging conventions)
  - **Skills Evaluated but Omitted**: `cicd-expert` (no pipeline changes)

  **Parallelization**:
  - **Can Run In Parallel**: YES with T1, T2, T3, T5, T6, T7
  - **Parallel Group**: Wave 1
  - **Blocks**: T8, T9, T13
  - **Blocked By**: None

  **References**:
  - `apps/api/src/app.ts` — current 3-middleware stack (cors, json, routes)
  - `apps/api/src/app.ts:14-32` — buildCorsOrigin throws into callback (bug)
  - `apps/api/src/index.ts` — bootstrap; no SIGTERM
  - `apps/api/src/middleware/auth.ts:15-26` — OPENLINEAR_TRUST_PROXY_AUTH dangerous flag
  - `apps/sidecar/src/app.ts` — same patterns needed
  - `apps/sidecar/src/routes/transcribe.ts:7-10` — 10MB raw upload no rate limit
  - pino docs: https://getpino.io/#/docs/api?id=options-object
  - express-rate-limit: https://express-rate-limit.mintlify.app/

  **WHY References Matter**:
  - app.ts middleware ordering is critical — error middleware must be LAST after routes
  - buildCorsOrigin throw bug needs the same patch as helmet integration
  - sidecar duplicates the pattern — touch both

  **Acceptance Criteria**:
  - [ ] Boot API: every request emits structured pino log line with `reqId`, method, url, statusCode, responseTime
  - [ ] Auth header REDACTED in logs (verify with curl + log inspection)
  - [ ] curl `/api/auth/github/start` 6 times → 6th returns 429
  - [ ] kill -15 process → graceful shutdown completes < 10s, prisma disconnects, no orphan connections in pg_stat_activity
  - [ ] `OPENLINEAR_TRUST_PROXY_AUTH=1 NODE_ENV=production node apps/api/dist/index.js` → process logs FATAL and refuses to start

  **QA Scenarios**:

  ```
  Scenario: Rate limit kicks in
    Tool: Bash
    Preconditions: API running on :3001
    Steps:
      1. Loop: `for i in $(seq 1 7); do curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/api/auth/github/start; done`
    Expected Result: First 5 return 200/302, 6th and 7th return 429
    Evidence: .sisyphus/evidence/task-4-rate-limit.txt

  Scenario: Graceful shutdown
    Tool: Bash
    Preconditions: API running standalone (not in container)
    Steps:
      1. Get PID: `pgrep -f "apps/api/dist/index.js"`
      2. Send: `kill -15 <pid>`
      3. Tail log
    Expected Result: Log shows "SIGTERM received, draining...", "prisma disconnected", process exits 0 within 10s
    Evidence: .sisyphus/evidence/task-4-graceful-shutdown.txt

  Scenario: Error middleware catches uncaught
    Tool: Bash
    Steps:
      1. Add temp test route that throws synchronously
      2. curl GET /api/_test/throw
    Expected Result: 500 with JSON `{error:"internal_error", requestId:"<uuid>"}`; log shows full stack with reqId; NO Express default HTML
    Evidence: .sisyphus/evidence/task-4-error-middleware.txt
  ```

  **Commit**: YES
  - Message: `feat(api): pino logging, helmet, rate limiting, global error middleware, graceful shutdown`
  - Files: `apps/api/src/app.ts`, `apps/api/src/index.ts`, `apps/api/src/middleware/auth.ts`, `apps/sidecar/src/app.ts`, `apps/sidecar/src/index.ts`, both `package.json`s, `pnpm-lock.yaml`
  - Pre-commit: `pnpm --filter @openlinear/api typecheck && pnpm --filter @openlinear/sidecar typecheck`

---

- [x] 5. **Brand assets: SVG logomark + wordmark + favicon set + Tauri icon set + OG/Twitter cards**

  **What to do**:
  - Design SVG logomark + wordmark (clean geometric, tech-forward, monochrome with single accent fill that respects `currentColor`):
    - `apps/desktop-ui/public/brand/logomark.svg` — 64x64 viewBox, single-color stroke or fill, suitable for sidebar at 16px
    - `apps/desktop-ui/public/brand/wordmark.svg` — horizontal lockup ("OpenLinear")
    - `apps/desktop-ui/public/brand/logomark-dark.svg` and `wordmark-dark.svg` — for light surfaces (deferred light theme but still useful for OG)
  - Generate full favicon set from logomark:
    - `apps/desktop-ui/public/favicon.ico` (16+32+48 multi-res)
    - `apps/desktop-ui/public/icon-192.png`, `icon-512.png` (PWA manifest sizes)
    - `apps/desktop-ui/public/apple-touch-icon.png` (180x180)
  - Generate OG card: `apps/desktop-ui/public/og-image.png` (1200x630), `apps/landing/public/og-image.png`
  - Generate Twitter card: `apps/desktop-ui/public/twitter-card.png` (1200x600)
  - Same set for `apps/landing/public/` (favicon, apple-touch, og)
  - Generate Tauri icon set via `pnpm --filter @openlinear/desktop tauri icon apps/desktop-ui/public/brand/logomark.svg` → produces `apps/desktop/src-tauri/icons/{32x32.png,128x128.png,128x128@2x.png,icon.icns,icon.ico,icon.png}`
  - Update `apps/desktop-ui/app/layout.tsx`: replace `<link rel="icon" href="/logo.png">` with proper multi-link favicon block + `<meta property="og:image">`, `<meta name="twitter:card">`, `<meta name="twitter:image">`
  - Same metadata block in `apps/landing/app/layout.tsx`

  **Must NOT do**:
  - Don't replace `/public/logo.png` yet (T34 owns the migration to ensure no broken refs)
  - Don't ship complex multi-color logo (must work as `currentColor`)
  - Don't ship JPG (only SVG/PNG)

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering` — design + asset generation + Next.js metadata
  - **Skills**: `frontend-design` (logo design principles, SVG optimization, OG card composition)
  - **Skills Evaluated but Omitted**: `figma-implement-design`, `figma-use` (no Figma source)

  **Parallelization**:
  - **Can Run In Parallel**: YES with T1, T2, T3, T4, T6, T7
  - **Parallel Group**: Wave 1
  - **Blocks**: T34, T35
  - **Blocked By**: None

  **References**:
  - `apps/desktop-ui/public/logo.png` — current 4MB placeholder (don't delete yet)
  - `apps/desktop/src-tauri/icons/icon.png` — current 2.4KB placeholder (will be regenerated)
  - `apps/desktop-ui/app/layout.tsx:59` — `<link rel="icon">` to replace
  - `apps/landing/app/layout.tsx` — landing layout (no favicon currently)
  - Tauri icon docs: `pnpm tauri icon --help` (CLI generates full set from one master)
  - Inspiration (don't copy): Linear, Vercel, Raycast — clean geometric, single accent, works at 16px

  **WHY References Matter**:
  - logomark SVG must work at 16px (sidebar target — verify via screenshot)
  - tauri icon CLI requires single 1024px PNG OR SVG master
  - OG image must include legible "OpenLinear" wordmark + tagline at 1200x630

  **Acceptance Criteria**:
  - [ ] All 7 SVG/PNG/ICO files exist under `apps/desktop-ui/public/brand/` and `apps/desktop-ui/public/`
  - [ ] `file apps/desktop/src-tauri/icons/icon.icns` reports valid icns
  - [ ] Layout.tsx metadata includes openGraph + twitter blocks

  **QA Scenarios**:

  ```
  Scenario: Logomark renders cleanly at 16px
    Tool: Playwright
    Preconditions: Brand assets in place; T34 not yet run (still uses logo.png in sidebar) — so render isolated test
    Steps:
      1. Add temp page apps/desktop-ui/app/_dev/brand/page.tsx rendering <img src="/brand/logomark.svg" width="16" height="16">, <img width="32">, <img width="64">, wordmark
      2. Boot UI, screenshot at /dev/brand
    Expected Result: Logomark legible at 16px, no clipping, no antialiasing artifacts
    Evidence: .sisyphus/evidence/task-5-logomark-sizes.png

  Scenario: Tauri icon set complete
    Tool: Bash
    Steps:
      1. ls apps/desktop/src-tauri/icons/
    Expected Result: Contains 32x32.png, 128x128.png, 128x128@2x.png, icon.icns, icon.ico, icon.png
    Evidence: .sisyphus/evidence/task-5-tauri-icons.txt
  ```

  **Commit**: YES
  - Message: `feat(brand): SVG logomark + wordmark + full favicon + Tauri icon + OG/Twitter cards`
  - Files: `apps/desktop-ui/public/brand/*.svg`, `apps/desktop-ui/public/{favicon.ico,icon-192.png,icon-512.png,apple-touch-icon.png,og-image.png,twitter-card.png}`, `apps/landing/public/{favicon.ico,apple-touch-icon.png,og-image.png}`, `apps/desktop/src-tauri/icons/*`, `apps/desktop-ui/app/layout.tsx`, `apps/landing/app/layout.tsx`
  - Pre-commit: `file apps/desktop/src-tauri/icons/icon.icns | grep -q icns`

---

- [x] 6. **SECURITY: Eliminate shell injection in git.ts and worktree.ts**

  **What to do**:
  - Edit `apps/sidecar/src/services/execution/git.ts`:
    - Lines 54-55: `git clone` with `execFile('git', ['clone', '--depth', '1', cloneUrl, repoPath])`
    - Line 86: `git commit -m message` → `execFile('git', ['-C', repoPath, 'commit', '-m', commitMessage])`
    - Line 90: `git push --force` → `execFile('git', ['-C', repoPath, 'push', '--force-with-lease', '-u', 'origin', branchName])` (also upgrades --force to --force-with-lease per finding #56)
    - Line 55: `chmod -R a+rwX` → `execFile('chmod', ['-R', 'a+rwX', repoPath])`
    - Replace token-in-URL with credential helper: `git -c credential.helper='!f() { echo "username=oauth2"; echo "password=$GH_TOKEN"; }; f' clone ...`
  - Edit `apps/sidecar/src/services/worktree.ts` — convert ALL 13 lines (25, 34, 63, 86, 93, 119, 141, 206, 210, 219, 223, 257, 271) to `execFile('git', ['-C', mainRepoPath, ...args])`
  - Move helper to `apps/sidecar/src/services/execution/exec.ts` exporting `execFileAsync(file, args, options)` returning `{stdout, stderr}`; replace all imports
  - Add unit-style smoke check at boot: assert no callsite uses raw `execAsync` with template literal (lint via `ast-grep` rule in CI doc)

  **Must NOT do**:
  - Don't use `shell-quote` library (still risky)
  - Don't keep ANY `exec(\`...\`)` or `execAsync(\`...\`)` with template literal in those files
  - Don't break the existing happy path — branch names + paths still flow through
  - Don't lose the GH_TOKEN auth mechanism for private repos

  **Recommended Agent Profile**:
  - **Category**: `deep` — security-critical refactor; must understand each callsite's intent + control flow + error semantics
  - **Skills**: `nodejs-backend-patterns` (child_process, execFile vs exec, error handling)
  - **Skills Evaluated but Omitted**: `golang-pro`, `rust-async-patterns`

  **Parallelization**:
  - **Can Run In Parallel**: YES with T1-T5, T7
  - **Parallel Group**: Wave 1
  - **Blocks**: T11 (execution lifecycle writes touch git)
  - **Blocked By**: None

  **References**:
  - `apps/sidecar/src/services/execution/git.ts:50,54,55,86,90` — primary attack surface
  - `apps/sidecar/src/services/worktree.ts:18,25,34,63,86,93,119,141,206,210,219,223,257,271` — 13 lines + token leak
  - Node docs: https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback
  - `util.promisify(execFile)` to get async/await
  - Pattern reference: `find apps/ -name "*.ts" | xargs grep -l "execFile"` (any existing safe usage to mirror)

  **WHY References Matter**:
  - execFile arg arrays are the ONLY safe way; shell escape libs have edge cases
  - --force-with-lease prevents clobbering other users' branches (finding #56 fix bundled here)
  - credential helper avoids embedding token in `.git/config` (finding #55 fix)

  **Acceptance Criteria**:
  - [ ] `grep -nE 'execAsync\(`|exec\(`' apps/sidecar/src/services/execution/git.ts apps/sidecar/src/services/worktree.ts` returns 0 matches
  - [ ] Existing task execution end-to-end still succeeds (no regression in happy path)
  - [ ] Git remote URL after clone does NOT contain token (`grep "oauth2:" .git/config` empty)
  - [ ] Force-push uses `--force-with-lease`

  **QA Scenarios**:

  ```
  Scenario: Malicious branch name does not execute shell
    Tool: Bash
    Preconditions: Sidecar built with new code; test via direct unit invocation OR end-to-end with crafted task
    Steps:
      1. Create unit harness: write a minimal `apps/sidecar/test-injection.mjs` that imports the helpers and calls `execFileAsync('git', ['-C', '/tmp/test', 'checkout', '-b', 'feature; rm /tmp/SHOULD_NOT_EXIST'])`
      2. Pre-create marker: `touch /tmp/SHOULD_NOT_EXIST`
      3. Run: `node apps/sidecar/test-injection.mjs`
      4. Verify marker still exists: `ls /tmp/SHOULD_NOT_EXIST`
      5. Delete harness file
    Expected Result: marker file still exists; git rejects branch name with semicolon (or accepts it as literal); shell command does NOT run
    Evidence: .sisyphus/evidence/task-6-injection-blocked.txt

  Scenario: Happy-path clone + commit + push still works
    Tool: Bash
    Preconditions: Test repo accessible; container has GH_TOKEN
    Steps:
      1. Trigger task execution via `curl -X POST http://localhost:3001/api/tasks/<id>/execute` (with valid auth)
      2. Wait for execution complete via SSE or poll
      3. Verify PR URL appears in task
    Expected Result: Execution completes; PR created; no error
    Evidence: .sisyphus/evidence/task-6-happy-path.txt

  Scenario: Token not in .git/config
    Tool: Bash
    Preconditions: Test repo cloned via new code path
    Steps:
      1. cat /tmp/openlinear-worktrees/<task>/.git/config
    Expected Result: No `oauth2:<token>` substring
    Evidence: .sisyphus/evidence/task-6-no-token-leak.txt
  ```

  **Commit**: YES
  - Message: `fix(security): eliminate shell injection in git/worktree services + use --force-with-lease + credential helper`
  - Files: `apps/sidecar/src/services/execution/git.ts`, `apps/sidecar/src/services/worktree.ts`, `apps/sidecar/src/services/execution/exec.ts` (new)
  - Pre-commit: `pnpm --filter @openlinear/sidecar build`

---

- [x] 7. **SECURITY: AUTH on all task/label/settings/team/inbox routes + ownership helper**

  **What to do**:
  - Create `apps/api/src/services/ownership.ts` exporting:
    - `assertTaskOwned(taskId, userId): Promise<Task>` — fetches, checks `task.teamId ∈ getUserTeamIds(userId)`, throws `403`
    - `assertProjectOwned(projectId, userId)` — checks via projectTeams ∈ user's teams
    - `assertTeamRole(teamId, userId, roles[])` — checks `TeamMember.role ∈ roles`, throws `403`
    - `assertCommentOwned(commentId, userId)` — for T10
  - Edit `apps/api/src/routes/tasks.ts`:
    - POST `/`: add `requireAuth` + `assertProjectOwned(projectId)` OR `assertTeamRole(teamId, ['owner','admin','member'])`
    - PATCH `/:id`: add `requireAuth` + `assertTaskOwned(id, req.userId)`
    - DELETE `/:id`: same
    - DELETE `/archived`: `requireAuth`, scope `deleteMany` by `where: { teamId: { in: userTeamIds }, archived: true }`
    - DELETE `/archived/:id`: `requireAuth` + `assertTaskOwned`
    - GET `/:id`: `requireAuth` + `assertTaskOwned`
  - Edit `apps/api/src/routes/labels.ts`: add `requireAuth` to all 5 routes; add `teamId` query param to scope; add `Label.teamId` if T1 didn't (verify schema)
  - Edit `apps/api/src/routes/settings.ts`: deprecate singleton; per-user settings keyed by `req.userId` (Settings model needs `userId @unique`)
  - Edit `apps/api/src/routes/teams.ts:168,209,329`: switch `optionalAuth` → `requireAuth`; PATCH/DELETE require `assertTeamRole(['owner','admin'])`; remove member requires `owner`
  - Edit `apps/api/src/routes/inbox.ts:73,87`: add `requireAuth`
  - Edit `apps/api/src/routes/projects.ts:151`: add `optionalAuth` + ownership; `:248` DELETE require `assertTeamRole(['owner','admin'])`
  - Edit `apps/sidecar/src/routes/execution.ts:133,143,165` and `apps/sidecar/src/routes/batches.ts:71,89,142,153,165`: add `optionalAuth` + ownership
  - All ownership errors return `{ error:'forbidden', code:'OWNERSHIP_REQUIRED', resourceType, resourceId }` with 403

  **Must NOT do**:
  - Don't break existing legitimate flows (verify via QA happy path)
  - Don't introduce N+1 queries (use existing `getUserTeamIds` cache from T4 hardening)
  - Don't change response shapes of existing successful responses

  **Recommended Agent Profile**:
  - **Category**: `deep` — security-critical, touches 7 route files, must reason about every callsite
  - **Skills**: `nodejs-backend-patterns` (Express middleware patterns, auth flows), `architecture-patterns` (single ownership seam)
  - **Skills Evaluated but Omitted**: `better-auth-best-practices` (different auth lib), `better-auth-security-best-practices` (same)

  **Parallelization**:
  - **Can Run In Parallel**: YES with T1-T6
  - **Parallel Group**: Wave 1
  - **Blocks**: T8, T10, T13, T31, T32
  - **Blocked By**: None

  **References**:
  - `apps/api/src/middleware/auth.ts:requireAuth,optionalAuth` — existing helpers to combine with new ownership
  - `apps/api/src/services/team-scope.ts:getUserTeamIds` — existing scope helper
  - `apps/api/src/routes/tasks.ts:188,295,369,129,139,274` — six unprotected callsites
  - `apps/api/src/routes/labels.ts:24,36,60,90,110` — five unprotected
  - `apps/api/src/routes/settings.ts:16,35` — singleton anti-pattern
  - `apps/api/src/routes/teams.ts:168,209,329` — optionalAuth bug
  - `apps/api/src/routes/inbox.ts:73` — unprotected PATCH
  - `apps/api/src/routes/projects.ts:151,248` — leak + missing role check
  - `apps/sidecar/src/routes/execution.ts:133,143,165` — log/cancel leak
  - `apps/sidecar/src/routes/batches.ts:71,89,142,153,165` — batch leak

  **WHY References Matter**:
  - getUserTeamIds is the canonical scope source; ownership helpers must reuse it
  - The 30+ call sites need consistent auth pattern — one helper file becomes the seam

  **Acceptance Criteria**:
  - [ ] curl `POST /api/tasks` without `Authorization` header → 401
  - [ ] curl `POST /api/tasks` with valid token but `teamId` of OTHER user's team → 403 with `code:'OWNERSHIP_REQUIRED'`
  - [ ] curl `DELETE /api/tasks/archived` without auth → 401 (NOT a system-wide wipe)
  - [ ] curl `PATCH /api/teams/:id` as non-owner member → 403
  - [ ] All existing logged-in flows still pass smoke test (happy path)

  **QA Scenarios**:

  ```
  Scenario: Unauthenticated POST /api/tasks rejected
    Tool: Bash
    Preconditions: API running
    Steps:
      1. `curl -i -X POST http://localhost:3001/api/tasks -H "Content-Type: application/json" -d '{"title":"hack"}'`
    Expected Result: HTTP/1.1 401 ; body `{"error":"unauthorized"}`
    Evidence: .sisyphus/evidence/task-7-unauth-rejected.txt

  Scenario: Cross-tenant access rejected
    Tool: Bash
    Preconditions: Two test users exist, each with own team; tokens stored in $TOKEN_A, $TOKEN_B; teamId of A in $TEAM_A
    Steps:
      1. As B: `curl -i -X POST http://localhost:3001/api/tasks -H "Authorization: Bearer $TOKEN_B" -H "Content-Type: application/json" -d "{\"title\":\"x\",\"teamId\":\"$TEAM_A\"}"`
    Expected Result: 403 with `code:"OWNERSHIP_REQUIRED"`
    Evidence: .sisyphus/evidence/task-7-cross-tenant-rejected.txt

  Scenario: Archived delete now scoped, not system-wide
    Tool: Bash
    Preconditions: Two users with archived tasks
    Steps:
      1. Count B's archived: `curl -H "Authorization: Bearer $TOKEN_B" http://localhost:3001/api/tasks/archived | jq length`
      2. As A: `curl -X DELETE -H "Authorization: Bearer $TOKEN_A" http://localhost:3001/api/tasks/archived`
      3. Recount B's: `curl -H "Authorization: Bearer $TOKEN_B" http://localhost:3001/api/tasks/archived | jq length`
    Expected Result: B's archived count UNCHANGED after A's delete
    Evidence: .sisyphus/evidence/task-7-archived-scoped.txt

  Scenario: Happy path — own team CRUD still works
    Tool: Bash
    Preconditions: As user A with token $TOKEN_A and own team $TEAM_A
    Steps:
      1. Create: `curl -X POST -H "Authorization: Bearer $TOKEN_A" -d "{\"title\":\"happy\",\"teamId\":\"$TEAM_A\"}" http://localhost:3001/api/tasks`
      2. Capture id from response
      3. Patch: `curl -X PATCH -H "Authorization: Bearer $TOKEN_A" -d '{"title":"updated"}' http://localhost:3001/api/tasks/$id`
      4. Delete: `curl -X DELETE -H "Authorization: Bearer $TOKEN_A" http://localhost:3001/api/tasks/$id`
    Expected Result: 201, 200, 204 respectively; no errors
    Evidence: .sisyphus/evidence/task-7-happy-crud.txt
  ```

  **Commit**: YES
  - Message: `fix(security): require auth + ownership checks on all task/label/settings/team/inbox/execution routes`
  - Files: `apps/api/src/services/ownership.ts` (new), `apps/api/src/routes/{tasks,labels,settings,teams,inbox,projects}.ts`, `apps/sidecar/src/routes/{execution,batches}.ts`
  - Pre-commit: `pnpm --filter @openlinear/api typecheck && pnpm --filter @openlinear/sidecar typecheck`

---

### WAVE 2 — BACKEND CORRECTNESS

- [x] 8. **SSE per-user filtering + auth on /api/events + reconnect with jitter**

  **What to do**:
  - Edit `apps/api/src/sse.ts`: change `SSEClient` to `{ res, userId, teamIds }`; add `broadcastToUser(userId, event, data)`, `broadcastToTeam(teamId, ...)`, `broadcastToAll(...)`; update existing `broadcast()` callers to use targeted variants
  - Edit `apps/api/src/app.ts:61` `/api/events`: require auth (token via query `?token=` since EventSource can't set headers), parse JWT, store userId + teamIds on client; ignore client-supplied `clientId` — generate server-side UUID
  - Edit all `broadcast()` call sites (tasks.ts, projects.ts, teams.ts, inbox.ts, sidecar/execution, sidecar/batch) to use `broadcastToUser` or `broadcastToTeam` based on resource ownership
  - Edit `apps/desktop-ui/providers/sse-provider.tsx:115-128`: replace linear backoff with exponential + jitter (`min(30s, 1s * 2^attempt + random*1000)`); keep retrying forever (no max-retries cap), surface "reconnecting..." badge in UI

  **Must NOT do**:
  - Don't broadcast cross-tenant events
  - Don't keep `client.res.write` outside try/catch
  - Don't allow client-supplied clientId to overwrite map entries

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` — touches SSE infra + ~10 broadcast call sites
  - **Skills**: `nodejs-backend-patterns` (SSE patterns, EventSource quirks)

  **Parallelization**: YES with T9-T15. **Blocked By**: T7 (auth), T4 (logging).

  **References**:
  - `apps/api/src/sse.ts` — current broadcast helper
  - `apps/api/src/app.ts:61-95` — SSE handler
  - `apps/desktop-ui/providers/sse-provider.tsx:115-143` — client retry logic
  - `apps/api/src/services/team-scope.ts:getUserTeamIds`

  **Acceptance Criteria**:
  - [ ] User A's task:created NOT received by User B's EventSource (verify via two parallel curl streams)
  - [ ] EventSource reconnects with exponential backoff after server kill+restart
  - [ ] Server-side UUIDs in clients map (no collision risk)

  **QA Scenarios**:
  ```
  Scenario: Cross-tenant SSE leak prevented
    Tool: Bash
    Preconditions: Two users A, B with valid tokens
    Steps:
      1. Stream A: `curl -N "http://localhost:3001/api/events?token=$TOKEN_A" > /tmp/sse-a.log &`
      2. Stream B: `curl -N "http://localhost:3001/api/events?token=$TOKEN_B" > /tmp/sse-b.log &`
      3. As A, create a task: `curl -X POST -H "Authorization: Bearer $TOKEN_A" -d '...' http://localhost:3001/api/tasks`
      4. Wait 2s, kill both streams
      5. grep "task:created" /tmp/sse-a.log /tmp/sse-b.log
    Expected Result: sse-a.log has 1 match, sse-b.log has 0 matches
    Evidence: .sisyphus/evidence/task-8-sse-isolation.txt
  ```

  **Commit**: `fix(sse): per-user filtering + auth on /api/events + jittered reconnect`

---

- [x] 9. **Validation pass: zod schemas on all routes + correct status codes + Prisma error code matching**

  **What to do**:
  - Create `apps/api/src/schemas/` directory; one zod schema file per route domain (tasks.ts, projects.ts, teams.ts, labels.ts, repos.ts, inbox.ts, settings.ts)
  - Add `validateBody(schema)` middleware: `app.use(...)` per route with parsed body in `req.validBody`
  - Replace string-matched Prisma errors with `error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'` (unique violation), `'P2025'` (record not found), `'P2003'` (FK violation)
  - Fix status codes: 201 on POST creates (`tasks:188`, `projects:create`, `teams:create`, `labels:create`, `repos:122`)
  - Reject `routes/tasks.ts:248` orphan task path (require team OR project)
  - Standardize error envelope: `{ error: string, code: string, details?: any }`

  **Must NOT do**: Don't change response shapes of successful responses; don't break frontend contract on error shape (frontend will adapt in T22).

  **Agent**: `unspecified-high` — broad route refactor. **Skills**: `nodejs-backend-patterns`, `prisma-expert`.

  **Parallelization**: YES with T8, T10-T15. **Blocked By**: T4 (error middleware), T7 (auth).

  **References**: `apps/api/src/routes/*.ts` — every file; `apps/api/src/routes/teams.ts:104,196,200,320,342` (string-match pattern); `apps/api/src/routes/labels.ts:51,77,81,101,141,164` (same).

  **Acceptance Criteria**:
  - [ ] POST /api/tasks with `{}` (empty body) → 400 with `code:'VALIDATION_ERROR'` and `details` from zod
  - [ ] POST /api/tasks with valid body → 201 (was 200)
  - [ ] Duplicate label create → 409 with `code:'P2002'` (was 500 string-match brittle)

  **QA Scenarios**:
  ```
  Scenario: Validation error shape
    Tool: Bash
    Steps: `curl -i -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}' http://localhost:3001/api/tasks`
    Expected Result: 400; body contains `"error":"validation_error"`, `"code":"VALIDATION_ERROR"`, `"details"` array with field paths
    Evidence: .sisyphus/evidence/task-9-validation.txt

  Scenario: Create returns 201
    Tool: Bash
    Steps: `curl -i -X POST -H "Authorization: Bearer $TOKEN" -d '{"title":"test","teamId":"$TEAM"}' http://localhost:3001/api/tasks`
    Expected Result: HTTP/1.1 201 Created
    Evidence: .sisyphus/evidence/task-9-201.txt
  ```

  **Commit**: `feat(api): zod validation + correct status codes + Prisma error code matching`

---

- [x] 10. **Comments API: routes + ownership + @mention parsing → Notification creation**

  **What to do**:
  - Create `apps/api/src/routes/comments.ts`:
    - `GET /api/tasks/:taskId/comments` — list scoped via `assertTaskOwned`
    - `POST /api/tasks/:taskId/comments` — create with body, parse `@username` mentions (regex), look up users via `User.findMany({ where:{ username: { in: mentionedNames } } })`, create Notification rows for each mention via `prisma.notification.create`, broadcast `comment:created` and `notification:created` via SSE
    - `PATCH /api/comments/:id` — only author can edit
    - `DELETE /api/comments/:id` — author or team owner
  - Mount in `apps/api/src/app.ts` after auth middleware
  - Reuse `assertCommentOwned` from T7

  **Must NOT do**:
  - Don't allow editing other users' comments
  - Don't store `mentions` if user not found (silent skip with log warning)
  - Don't double-notify if same user mentioned twice in same comment

  **Agent**: `unspecified-high`. **Skills**: `nodejs-backend-patterns`, `prisma-expert`.

  **Parallelization**: YES with T8/T9/T11-T15. **Blocked By**: T1 (Comment model), T7 (ownership), T4 (error middleware).

  **References**: schema models from T1 (Comment, Notification, ActivityLog), `apps/api/src/services/ownership.ts` from T7, `apps/api/src/sse.ts` from T8.

  **Acceptance Criteria**:
  - [ ] POST comment with `@demo` body → 201; Notification row exists for demo user with `type:'mention'`; SSE event `notification:created` received by demo user

  **QA Scenarios**:
  ```
  Scenario: Comment with mention creates notification
    Tool: Bash
    Steps:
      1. As A, on B's task: `curl -X POST -H "Authorization: Bearer $TOKEN_A" -d '{"body":"hey @demo what do you think"}' http://localhost:3001/api/tasks/$TASK_ID/comments`
      2. As demo: `curl -H "Authorization: Bearer $TOKEN_DEMO" http://localhost:3001/api/notifications | jq '.[] | select(.type=="mention")'`
    Expected Result: Notification with `type:"mention"`, `actorUserId:A`, `commentId:<created>`, `body:<comment>`
    Evidence: .sisyphus/evidence/task-10-mention.txt

  Scenario: Cross-task comment access denied
    Tool: Bash
    Steps: As A, comment on B's task (A not in B's team): `curl -i -X POST -H "Authorization: Bearer $TOKEN_A" -d '...' http://localhost:3001/api/tasks/$B_TASK/comments`
    Expected Result: 403
    Evidence: .sisyphus/evidence/task-10-cross-tenant.txt
  ```

  **Commit**: `feat(api): comments routes with @mention parsing + notification fan-out`

---

- [x] 11. **AgentRun capture: persist cost/tokens/duration/status/prUrl per execution**

  **What to do**:
  - Edit `apps/sidecar/src/services/execution/lifecycle.ts`:
    - On execution start: `prisma.agentRun.create({ data: { taskId, userId, agent, model, startedAt: new Date(), status: 'running' } })`; capture returned `id` in execution state
    - On stream message with `cost`/`tokens` from OpenCode SDK: accumulate in execution state
    - On execution complete: `prisma.agentRun.update({ where: { id }, data: { endedAt, costUsd, inputTokens, outputTokens, status: 'completed', prUrl } })`
    - On error/cancel: same with `status: 'failed'|'cancelled'`, `errorMessage`
  - Edit `apps/sidecar/src/services/execution/state.ts:62`: include `agentRunId` in `ExecutionState`
  - Add `GET /api/agent-runs?taskId=` and `GET /api/agent-runs?userId=` to `apps/api/src/routes/agent-runs.ts` (new file); scope by ownership

  **Must NOT do**: Don't store cost/tokens if SDK doesn't provide them (NULL in DB); don't double-count if execution restarts (T14 handles recovery).

  **Agent**: `deep` — must understand OpenCode SDK stream semantics. **Skills**: `nodejs-backend-patterns`, `prisma-expert`.

  **Parallelization**: YES with T8-T10, T12-T15. **Blocked By**: T1 (AgentRun model), T6 (git fixes), T7 (auth).

  **References**: `apps/desktop-ui/lib/api/opencode.ts:98` (cost type), `apps/sidecar/src/services/execution/lifecycle.ts:204-226` (prompt call), `apps/sidecar/src/services/execution/state.ts`, schema from T1.

  **Acceptance Criteria**:
  - [ ] After one task execution: `select count(*) from agent_runs` increases by 1; row has `costUsd`, `inputTokens`, `outputTokens` populated (assuming SDK provided them)

  **QA Scenarios**:
  ```
  Scenario: AgentRun row captured after execution
    Tool: Bash
    Preconditions: Real OpenCode-enabled environment (or mock); valid task
    Steps:
      1. Pre-count: `psql ... -c "select count(*) from agent_runs"`
      2. Execute task: `curl -X POST -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/tasks/$ID/execute`
      3. Wait for completion via SSE
      4. Post-count: same query
      5. Inspect: `psql ... -c "select * from agent_runs order by started_at desc limit 1"`
    Expected Result: Count +1; row has non-null endedAt, status='completed', costUsd > 0 (if SDK provides)
    Evidence: .sisyphus/evidence/task-11-agentrun.txt
  ```

  **Commit**: `feat(execution): persist AgentRun rows with cost/token capture`

---

- [x] 12. **Search API: GET /api/search?q= scoped to user's teams**

  **What to do**:
  - Create `apps/api/src/routes/search.ts`:
    - `GET /api/search?q=&types=tasks,projects,teams&limit=20`
    - Validate q ≥ 2 chars; default `types=all`; max limit 50
    - Tasks: `WHERE teamId IN (userTeamIds) AND (title ILIKE %q% OR description ILIKE %q% OR identifier ILIKE %q%)` LIMIT
    - Projects: scoped via projectTeams
    - Teams: scoped via TeamMember
    - Return `{ tasks: [...], projects: [...], teams: [...] }` with abbreviated fields (id, title/name, type, score)
  - Add `requireAuth`; rate-limit 30/min per user

  **Must NOT do**: Don't full-text-index now (defer to pg_trgm later); ILIKE is fine for current scale.

  **Agent**: `quick`. **Skills**: `prisma-expert`, `sql-optimization-patterns`.

  **Parallelization**: YES with T8-T11, T13-T15. **Blocked By**: T7 (auth).

  **References**: `apps/api/src/services/team-scope.ts:getUserTeamIds`, `apps/api/src/routes/tasks.ts:175` (existing list query for include patterns).

  **Acceptance Criteria**:
  - [ ] `GET /api/search?q=login` returns `{ tasks: [...], projects: [...], teams: [...] }` with results matching `login` substring
  - [ ] Other tenant's matching tasks NOT in results

  **QA Scenarios**:
  ```
  Scenario: Search returns scoped results
    Tool: Bash
    Steps:
      1. `curl -H "Authorization: Bearer $TOKEN_A" "http://localhost:3001/api/search?q=test"`
    Expected Result: 200, JSON with arrays containing only A's resources
    Evidence: .sisyphus/evidence/task-12-search.txt
  ```

  **Commit**: `feat(api): GET /api/search scoped to user's teams`

---

- [x] 13. **Notifications + ActivityLog API + integration into mutation handlers**

  **What to do**:
  - Create `apps/api/src/routes/notifications.ts`: `GET /` (paginated, scoped by userId), `PATCH /:id/read`, `POST /read-all`, SSE `notification:created`
  - Create `apps/api/src/routes/activity-log.ts`: `GET /api/activity?taskId=|projectId=|teamId=` scoped + paginated
  - Create `apps/api/src/services/activity.ts:logActivity({taskId?, projectId?, teamId?, userId, action, payload})` helper
  - Wire `logActivity()` into mutation handlers: task create/update/delete/status-change, comment create, project update, team member add/remove, AgentRun start/complete
  - Wire Notification creation: assignment change → notify new assignee; @mention (T10); status change on task you created → notify creator

  **Must NOT do**: Don't notify the actor about their own action.

  **Agent**: `unspecified-high`. **Skills**: `nodejs-backend-patterns`, `prisma-expert`.

  **Parallelization**: YES with T8-T12, T14-T15. **Blocked By**: T1 (models), T7 (auth), T8 (SSE), T10 (Comment integration).

  **References**: schema from T1 (Notification, ActivityLog enums); existing routes for mutation hooks.

  **Acceptance Criteria**:
  - [ ] Assigning task to user X → X has new Notification with `type:'assignment'`
  - [ ] Task status change emits ActivityLog row + SSE event
  - [ ] Notification list paginated, sorted by createdAt desc

  **QA Scenarios**:
  ```
  Scenario: Assignment creates notification
    Tool: Bash
    Steps:
      1. As A: `curl -X PATCH -H "Authorization: Bearer $TOKEN_A" -d '{"assigneeId":"<userB>"}' http://localhost:3001/api/tasks/$ID`
      2. As B: `curl -H "Authorization: Bearer $TOKEN_B" http://localhost:3001/api/notifications | jq '.[0]'`
    Expected Result: First notification is `type:"assignment"`, actorUserId=A, taskId=$ID
    Evidence: .sisyphus/evidence/task-13-assignment.txt
  ```

  **Commit**: `feat(api): notifications + activity log + mutation integration`

---

- [x] 14. **Execution state recovery on sidecar restart**

  **What to do**:
  - Edit `apps/sidecar/src/services/execution/state.ts`: keep in-memory map but on boot rehydrate from DB
  - Add `apps/sidecar/src/services/execution/recovery.ts:recoverInFlightExecutions()`:
    - Query `prisma.task.findMany({ where: { status: 'in_progress' }, include: { agentRuns: { orderBy: { startedAt: 'desc' }, take: 1 } } })`
    - For each: if last AgentRun has `endedAt` IS NULL and started > 1h ago, mark as failed (`status: 'failed'`, agentRun.status='failed', errorMessage='sidecar_restart_orphan')
    - Otherwise: best-effort reconnect to OpenCode session OR mark stuck
  - Call `recoverInFlightExecutions()` once during sidecar boot in `apps/sidecar/src/index.ts`
  - Same pattern for batches: `apps/sidecar/src/services/batch.ts:15` `activeBatches`

  **Must NOT do**: Don't auto-restart task execution from scratch (could cause duplicate PRs); just clean up orphans.

  **Agent**: `deep` — concurrency + recovery semantics. **Skills**: `nodejs-backend-patterns`, `prisma-expert`.

  **Parallelization**: YES with T8-T13, T15. **Blocked By**: T1 (AgentRun), T11 (AgentRun population).

  **References**: `apps/sidecar/src/services/execution/state.ts:62`, `apps/sidecar/src/services/batch.ts:15`, `apps/sidecar/src/index.ts` (boot).

  **Acceptance Criteria**:
  - [ ] Kill sidecar mid-execution; restart; orphan task moves from `in_progress` → `failed` with error message
  - [ ] No phantom in-memory execution registered

  **QA Scenarios**:
  ```
  Scenario: Orphan recovery after restart
    Tool: Bash
    Preconditions: Task status manually set to in_progress with stale agentRun
    Steps:
      1. `psql ... -c "INSERT INTO agent_runs (id, task_id, agent, model, started_at, status) VALUES ('test-orphan', '$TASK_ID', 'claude', 'opus', now() - interval '2 hours', 'running')"`
      2. `psql ... -c "UPDATE tasks SET status='in_progress' WHERE id='$TASK_ID'"`
      3. Restart sidecar: `docker exec openlinear sh -c "kill -15 $(pgrep -f sidecar)"`
      4. Wait 5s for restart
      5. Check: `psql ... -c "SELECT status FROM tasks WHERE id='$TASK_ID'"`
    Expected Result: status='failed', agent_runs.status='failed', errorMessage contains 'orphan'
    Evidence: .sisyphus/evidence/task-14-recovery.txt
  ```

  **Commit**: `feat(sidecar): recover orphan in-flight executions on boot`

---

- [x] 15. **OpenCode per-user isolation OR document constraint**

  **What to do**:
  - Investigate OpenCode SDK: does spawning per-user server work? (read SDK docs + test)
  - **Path A (preferred)**: Per-user OpenCode server map in `apps/sidecar/src/services/opencode.ts` keyed by userId; spawn lazily on first request; idle-shutdown after 10min
  - **Path B (fallback)**: Document the single-tenant limitation in `docs/limitations.md` + add startup banner; restrict OpenCode features to single-user mode (refuse to start if multiple users exist)
  - Either way: rename `_userId` parameter (no underscore — actively used)

  **Must NOT do**: Don't ship Path B without explicit notice; prefer A.

  **Agent**: `deep`. **Skills**: `nodejs-backend-patterns`. Also explore OpenCode SDK (call librarian if needed).

  **Parallelization**: YES with T8-T14. **Blocked By**: None (independent investigation).

  **References**: `apps/sidecar/src/services/opencode.ts:22-23,165-188,190` (`_userId` ignored), https://github.com/sst/opencode (SDK source).

  **Acceptance Criteria**:
  - [ ] Either: per-user spawn proven via QA scenario showing User A's provider auth NOT inherited by User B; OR limitation documented + enforced

  **QA Scenarios**:
  ```
  Scenario A (per-user): Auth isolation
    Tool: Bash
    Steps:
      1. As A: configure OpenAI provider with key K_A
      2. As B: list providers
    Expected Result: B sees no providers configured (auth state isolated)
    Evidence: .sisyphus/evidence/task-15-isolation.txt

  Scenario B (single-tenant docs): Banner shown
    Tool: Bash
    Steps: Boot sidecar; check stdout
    Expected Result: Stdout contains "OpenCode runs in single-tenant mode" banner
    Evidence: .sisyphus/evidence/task-15-banner.txt
  ```

  **Commit**: `feat(opencode): per-user server isolation` OR `docs(opencode): document single-tenant constraint with enforcement`

---

### WAVE 3 — UI BUG SWEEP

- [x] 16. **Wire header search to KanbanBoard filter (currently does nothing)**

  **What to do**: Edit `apps/desktop-ui/app/page.tsx`: pass `searchQuery` state into `<KanbanBoard searchQuery=... />`. Edit `apps/desktop-ui/components/board/kanban-board.tsx` + `use-kanban-board.ts:filteredTasks`: filter tasks by case-insensitive substring match on title + identifier when `searchQuery.length >= 1`. Add debounce 200ms via `useDeferredValue`.

  **Must NOT**: Don't fetch a new search-aware list (keep client-side filter for now); don't break grouping by status.

  **Agent**: `quick`. **Skills**: none.

  **Parallelization**: YES with all of Wave 3. **Blocked By**: T3.

  **References**: `apps/desktop-ui/app/page.tsx:194-200`, `apps/desktop-ui/components/board/kanban-board.tsx`, `apps/desktop-ui/components/board/use-kanban-board.ts`.

  **Acceptance**: [ ] Type "bug" in header search → board immediately filters to tasks containing "bug"; clear → all tasks return.

  **QA**:
  ```
  Scenario: Header search filters board
    Tool: Playwright
    Steps: navigate /, type "bug" in header search
    Expected: Board cards visible reduce to only those with "bug" in title/identifier
    Evidence: .sisyphus/evidence/task-16-search.png (before+after)
  ```

  **Commit**: `fix(ui): wire header search input to kanban board filter`

---

- [x] 17. **Convert TaskDetailView to Radix Sheet + fix project name placeholder**

  **What to do**: Refactor `apps/desktop-ui/components/task-detail-view.tsx` to wrap in `<Sheet>` from T2; remove custom `Escape` handler (Sheet handles); fix line 467 hardcoded `"OpenLinear"` to render `{project?.name}` (pass project as prop OR look up via task.projectId in caller); fix double-save on blur+enter (track `saved` flag).

  **Must NOT**: Don't change the column layout or fields; don't break inline-edit.

  **Agent**: `quick`. **Skills**: `shadcn-ui`.

  **Parallelization**: YES Wave 3. **Blocked By**: T2 (Sheet primitive).

  **References**: `apps/desktop-ui/components/task-detail-view.tsx:90-108,128-143,153,467`.

  **Acceptance**: [ ] Sheet has backdrop + focus trap + ESC close; project name shows actual project; ⌘+Enter saves description; no duplicate save.

  **QA**:
  ```
  Scenario: Project name shows real value
    Tool: Playwright
    Steps: open any task in sheet
    Expected: Sidebar "Project" field shows the task's actual project name (e.g., "OpenLinear" only if that IS the project name; otherwise the real one)
    Evidence: .sisyphus/evidence/task-17-project-name.png
  ```

  **Commit**: `fix(ui): TaskDetailView as Sheet + real project name + no double-save`

---

- [x] 18. **Optimistic update rollback for use-kanban-board**

  **What to do**: Edit `apps/desktop-ui/components/board/use-kanban-board.ts`: in `updateTaskStatus`, `handleDelete`, `handleBatchExecute`, snapshot `tasks` BEFORE optimistic mutation; on error, restore snapshot + show toast.error with server message; restore `selectedTaskId` on failed delete; remove the 3s safety timeout hack (line 547-571) — fix root cause.

  **Must NOT**: Don't introduce new state; reuse existing `tasks` setter.

  **Agent**: `unspecified-high` — touches large hook file. **Skills**: `nodejs-backend-patterns`.

  **Parallelization**: YES Wave 3. **Blocked By**: T3 (apiFetch + ApiError).

  **References**: `apps/desktop-ui/components/board/use-kanban-board.ts:547-592,705-718,740-756`.

  **Acceptance**: [ ] Force API failure on PATCH /tasks/:id (e.g., toggle invalid status) → card visibly snaps then snaps back to original column; toast shows server error.

  **QA**:
  ```
  Scenario: Failed status update rolls back
    Tool: Playwright + Bash
    Preconditions: API blocked (kill api temporarily) or middleware injecting 500
    Steps: drag a card from "Todo" to "Done" while API down
    Expected: Card briefly in "Done", returns to "Todo", toast appears
    Evidence: .sisyphus/evidence/task-18-rollback.gif
  ```

  **Commit**: `fix(ui): optimistic update rollback in kanban hook`

---

- [x] 19. **Replace 4 native window.confirm() with AlertDialog**

  **What to do**: Replace `window.confirm()` at `apps/desktop-ui/components/layout/sidebar.tsx:184`, `apps/desktop-ui/app/teams/page.tsx:164`, `apps/desktop-ui/app/teams/manage/page.tsx:188+213` with `<AlertDialog>` from T2. Wrap each confirm flow in a controlled-open dialog with destructive variant button.

  **Must NOT**: Don't introduce a callback-based confirm helper (use declarative dialogs); don't keep `window.confirm()` anywhere.

  **Agent**: `quick`. **Skills**: `shadcn-ui`.

  **Parallelization**: YES Wave 3. **Blocked By**: T2.

  **References**: those 4 lines.

  **Acceptance**: [ ] `grep -rn 'window\.confirm' apps/desktop-ui/` returns 0 matches.

  **QA**:
  ```
  Scenario: Delete team uses themed dialog
    Tool: Playwright
    Steps: navigate /teams, click delete on a team
    Expected: Themed AlertDialog appears (not browser native); Cancel + Delete buttons; Delete is red destructive variant
    Evidence: .sisyphus/evidence/task-19-alertdialog.png
  ```

  **Commit**: `fix(ui): replace window.confirm with AlertDialog`

---

- [x] 20. **Replace 8 hand-rolled localStorage.getItem('token') in use-kanban-board**

  **What to do**: Replace lines 191, 216, 575, 671, 693, 707, 745, 760 in `apps/desktop-ui/components/board/use-kanban-board.ts` with `apiFetch()` from T3. Removes need for hand-rolled headers.

  **Must NOT**: Don't keep any direct fetch in this file post-migration.

  **Agent**: `quick`. **Skills**: none.

  **Parallelization**: YES Wave 3. **Blocked By**: T3.

  **References**: those 8 lines.

  **Acceptance**: [ ] `grep "localStorage.getItem('token')" apps/desktop-ui/components/board/use-kanban-board.ts` returns 0 matches.

  **QA**:
  ```
  Scenario: Kanban CRUD still works
    Tool: Playwright
    Steps: full kanban flow (create, drag, archive)
    Expected: All operations succeed; no console errors
    Evidence: .sisyphus/evidence/task-20-kanban-flow.gif
  ```

  **Commit**: `refactor(ui): use apiFetch in use-kanban-board`

---

- [x] 21. **globals.css: focus-visible 2px ring + prefers-reduced-motion overrides**

  **What to do**: Edit `apps/desktop-ui/app/globals.css`:
  - Replace lines 140-143 `outline: none` with `outline: 2px solid var(--linear-accent); outline-offset: 1px` on `:focus-visible` (NOT `:focus`)
  - Add `@media (prefers-reduced-motion: reduce) { *,*::before,*::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; scroll-behavior: auto !important; } }`
  - Add the same to `apps/landing/app/globals.css`
  - Wrap framer-motion call sites with `useReducedMotion()` returning conditional `transition: { duration: 0 }` (T24 owns the JS side)

  **Must NOT**: Don't remove the `linear-accent` ring color; don't disable focus styles.

  **Agent**: `quick`. **Skills**: none.

  **Parallelization**: YES Wave 3. **Blocked By**: None.

  **References**: `apps/desktop-ui/app/globals.css:140-143`, `apps/landing/app/globals.css`.

  **Acceptance**: [ ] Tab through any form → blue ring visible on each field; OS-level "Reduce motion" enabled → animations near-instant.

  **QA**:
  ```
  Scenario: Focus visible
    Tool: Playwright
    Steps: navigate /projects, tab to Name input
    Expected: Visible 2px accent-color ring on input
    Evidence: .sisyphus/evidence/task-21-focus.png

  Scenario: Reduced motion
    Tool: Playwright (with reduced-motion emulation)
    Steps: open dialog with reduced motion
    Expected: Dialog appears near-instantly without zoom animation
    Evidence: .sisyphus/evidence/task-21-reduced-motion.png
  ```

  **Commit**: `fix(a11y): restore focus-visible + add prefers-reduced-motion`

---

- [x] 22. **Form error pipeline: surface errors with toast + inline**

  **What to do**: Replace `console.error` swallows in:
  - `apps/desktop-ui/app/projects/page.tsx:374-378,381-395,397-425` (3 handlers)
  - `apps/desktop-ui/app/teams/page.tsx:99-119` (handleCreateTeam)
  - `apps/desktop-ui/components/task-form.tsx` mutations
  - `apps/desktop-ui/components/label-picker.tsx:41-57` (add auth header + retry button)
  - `apps/desktop-ui/app/inbox/page.tsx:208-213` (loadData error state)
  - `apps/desktop-ui/components/global-quick-capture.tsx:371-397` (Promise.allSettled + per-task feedback)

  Pattern: `try { await apiFetch(...) } catch (err) { if (err instanceof ApiError) { toast.error(err.message); setFormErrors({_root: err.message}) } else { toast.error('Network error') } }`

  **Must NOT**: Don't swallow errors silently anywhere; don't show stack traces to users.

  **Agent**: `unspecified-high` — touches many files. **Skills**: `nodejs-backend-patterns`.

  **Parallelization**: YES Wave 3. **Blocked By**: T3 (ApiError).

  **References**: lines listed above.

  **Acceptance**: [ ] Force API error on project create → toast appears + inline error under form; spinner stops.

  **QA**:
  ```
  Scenario: Project create error visible
    Tool: Playwright
    Preconditions: API rate-limit reached or temporarily blocked
    Steps: navigate /projects, fill, Submit
    Expected: Toast appears with server error; submit button no longer spinning; form remains open with values
    Evidence: .sisyphus/evidence/task-22-form-error.png
  ```

  **Commit**: `fix(ui): surface mutation errors via toast + inline form errors`

---

- [x] 23. **Sidebar: remove module-level cachedTeams; per-user via context + clear on logout**

  **What to do**: Edit `apps/desktop-ui/components/layout/sidebar.tsx:18-19`: delete `let cachedTeams`; move teams state to a small `TeamsProvider` context OR derive from `useAuth().user.teams` if auth context loads them; clear on logout via `auth:expired` listener (T3). Also fix sidebar bugs from research: line 198 `handleClose` calls `minimize()` (rename to handleMinimize OR add real close); fix nested `<button>` in TeamSection (line 75-82) by restructuring as flex siblings.

  **Must NOT**: Don't break the sidebar resize / collapse behavior.

  **Agent**: `quick`. **Skills**: none.

  **Parallelization**: YES Wave 3. **Blocked By**: T3.

  **References**: `apps/desktop-ui/components/layout/sidebar.tsx:18-19,75-82,198`.

  **Acceptance**: [ ] Logout user A → login as B → sidebar shows ONLY B's teams immediately (no flash of A's).

  **QA**:
  ```
  Scenario: Team list isolated per user
    Tool: Playwright
    Steps: login as A (with team "Foo"); logout; login as B (with team "Bar")
    Expected: B's sidebar shows "Bar" only, never "Foo"
    Evidence: .sisyphus/evidence/task-23-isolation.gif
  ```

  **Commit**: `fix(ui): per-user sidebar teams + nested button HTML + close button bug`

---

- [x] 24. **Animation polish: useReducedMotion + stop infinite brain pulse + coordinate sidebar transitions**

  **What to do**:
  - Add `useReducedMotion()` hook check in `apps/desktop-ui/components/global-quick-capture.tsx`, `god-mode-overlay.tsx`, `onboarding-wizard.tsx` — gate `transition` and `animate` props
  - Stop infinite brain pulse: edit `apps/desktop-ui/components/god-mode-overlay.tsx:132-153` — only animate when `state==='pill'`, stop on overlay open
  - Replace `width` animation in `apps/desktop-ui/components/layout/sidebar.tsx:223-226` with `transform: translateX` of an absolute child (avoids layout thrash)
  - Coordinate sidebar+content transitions in `apps/desktop-ui/components/layout/app-shell.tsx:115-120` via shared CSS variable `--sidebar-width`
  - Replace `boxShadow` + `borderColor` `whileHover` in `apps/desktop-ui/components/global-quick-capture.tsx:99-114` with CSS hover (transform + opacity only)
  - Disable backdrop-blur during drag in `apps/desktop-ui/components/board/task-card.tsx:111-120`

  **Must NOT**: Don't remove all motion (just gate by reduced-motion); don't break the polished brainstorm animation.

  **Agent**: `visual-engineering`. **Skills**: `frontend-design`.

  **Parallelization**: YES Wave 3. **Blocked By**: T21 (CSS reduced-motion).

  **References**: lines listed above.

  **Acceptance**: [ ] Brain button stops pulsing when overlay open; sidebar resize smooth (no jank); drag retains 60fps (no paint storm).

  **QA**:
  ```
  Scenario: Brain pulse stops
    Tool: Playwright
    Steps: open Cmd+K overlay
    Expected: Brain button no longer pulsing
    Evidence: .sisyphus/evidence/task-24-brain.gif
  ```

  **Commit**: `fix(ui): animation polish — reduced-motion + stop brain pulse + smooth sidebar`

---

### WAVE 4 — FEATURES

- [x] 25. **Cmd+K command palette: cmdk + navigate/quick-actions + search results**

  **What to do**: Create `apps/desktop-ui/components/command-palette.tsx` using `<Command>` primitive from T2:
  - Mount at root (in `apps/desktop-ui/app/layout.tsx`); open via `cmd+k` (mac) / `ctrl+k` (windows) global hotkey
  - Sections: **Navigate** (Inbox, My Issues, Projects, Teams, Archived, Settings), **Quick Actions** (New Task, New Project, New Team, Toggle Theme), **Search** (live results from T12 `/api/search`)
  - Use `useDeferredValue` for query; debounce search 200ms
  - Results group by type (Tasks/Projects/Teams); enter selects + navigates

  **Must NOT**: Don't reuse the brainstorm right-edge ghost (T46 will cull dead UI).

  **Agent**: `visual-engineering`. **Skills**: `shadcn-ui`, `frontend-design`.

  **Parallelization**: YES Wave 4. **Blocked By**: T2, T12.

  **References**: cmdk docs, `apps/desktop-ui/components/global-quick-capture.tsx` (existing right-edge brainstorm — separate, keep), `apps/desktop-ui/components/god-mode-overlay.tsx` (existing Cmd+K-bound — likely deprecate or merge).

  **Acceptance**: [ ] cmd+k anywhere → palette opens; type → live results; enter → navigates.

  **QA**:
  ```
  Scenario: Palette opens and navigates
    Tool: Playwright
    Steps: navigate /, press Cmd+K, type "settings", press Enter
    Expected: Palette opens; Settings appears in Navigate section; Enter navigates to /settings
    Evidence: .sisyphus/evidence/task-25-palette.gif

  Scenario: Search results from API
    Tool: Playwright
    Steps: Cmd+K, type a known task title substring
    Expected: Task appears in Search section; Enter opens task detail Sheet
    Evidence: .sisyphus/evidence/task-25-search.gif
  ```

  **Commit**: `feat(ui): Cmd+K command palette with navigate, actions, and live search`

---

- [x] 26. **Markdown rendering: descriptions + comments**

  **What to do**: Install `react-markdown` + `remark-gfm` (GFM tables/strikethrough/task lists). Replace plain `<textarea>`+`whitespace-pre-wrap` in `apps/desktop-ui/components/task-detail-view.tsx` with split: edit mode = `<textarea>`, view mode = `<ReactMarkdown>`. Same for comment thread (T27). Custom styling via `prose` Tailwind plugin OR custom component map.

  **Must NOT**: Don't ship raw HTML rendering (XSS); use ReactMarkdown's safe defaults.

  **Agent**: `visual-engineering`. **Skills**: `frontend-design`.

  **Parallelization**: YES Wave 4. **Blocked By**: T2, T17 (Sheet conversion).

  **References**: `apps/desktop-ui/components/task-detail-view.tsx:307-318` (current textarea), https://github.com/remarkjs/react-markdown.

  **Acceptance**: [ ] Description with `**bold**` + `- list` + ```` ```code``` ```` renders correctly in view mode; edit returns to plain textarea.

  **QA**:
  ```
  Scenario: Markdown renders
    Tool: Playwright
    Steps: open task, edit description with `# Title\n\n- item 1\n\n**bold**`, save, view
    Expected: Heading, bullet, bold all rendered; click description → re-enters edit mode with raw markdown
    Evidence: .sisyphus/evidence/task-26-markdown.png
  ```

  **Commit**: `feat(ui): markdown rendering for task descriptions and comments`

---

- [x] 27. **Comments UI: composer + thread + @mention autocomplete**

  **What to do**: Add `<CommentsThread>` component under task description in `task-detail-view.tsx`:
  - List existing comments via T10 GET; group with avatar + relative time
  - Composer: textarea with `@` triggering autocomplete dropdown of team members (fetch users via existing endpoint or new GET `/api/teams/:id/members`)
  - On submit: POST via T10; SSE `comment:created` updates thread for other users
  - Markdown rendering via T26
  - Edit/delete own comments inline

  **Must NOT**: Don't autocomplete users from outside the task's team; don't auto-mention.

  **Agent**: `visual-engineering`. **Skills**: `shadcn-ui`, `frontend-design`.

  **Parallelization**: YES Wave 4. **Blocked By**: T2, T10, T17, T26.

  **References**: `apps/desktop-ui/components/task-detail-view.tsx`, T10 routes, T26 markdown.

  **Acceptance**: [ ] Type `@` → autocomplete shows team members; pick one → mention inserted; submit → comment appears in thread + other user receives SSE notification.

  **QA**:
  ```
  Scenario: Mention round-trip
    Tool: Playwright (two browser contexts)
    Steps:
      1. Context A: open task, type comment with `@demo`, submit
      2. Context B (logged in as demo): wait for /inbox auto-update
    Expected: B's inbox shows new mention notification within 2s; A's thread shows the comment immediately
    Evidence: .sisyphus/evidence/task-27-mention.gif
  ```

  **Commit**: `feat(ui): comments thread with composer and @mention autocomplete`

---

- [x] 28. **Inbox real notifications: list from T13 with grouping + mark-read**

  **What to do**: Refactor `apps/desktop-ui/app/inbox/page.tsx`:
  - Replace task-based inbox with notifications from T13 GET `/api/notifications`
  - Group by today/this-week/older
  - Filter chips: all / @mentions / assignments / status changes
  - Click → navigate to source task with comment scrolled into view
  - Mark-read on click; bulk mark-all-read
  - SSE `notification:created` prepends new ones live
  - Sidebar badge: count of unread from T13

  **Must NOT**: Don't keep the old `Task.inboxRead` flag-based logic (deprecate Task.inboxRead in T1 if not done; otherwise leave inert).

  **Agent**: `visual-engineering`. **Skills**: `shadcn-ui`, `frontend-design`.

  **Parallelization**: YES Wave 4. **Blocked By**: T2, T3, T13.

  **References**: `apps/desktop-ui/app/inbox/page.tsx`, T13 routes.

  **Acceptance**: [ ] Real notifications shown; SSE live update works; click navigates correctly.

  **QA**:
  ```
  Scenario: Inbox shows real notifications
    Tool: Playwright
    Preconditions: T27 mention round-trip executed
    Steps: navigate /inbox
    Expected: Notification list shows the mention; grouped by today; click navigates to task with comment thread visible
    Evidence: .sisyphus/evidence/task-28-inbox.png
  ```

  **Commit**: `feat(ui): inbox backed by real notifications + grouping + filters`

---

- [x] 29. **Working theme switcher: next-themes wired to settings + Toaster + meta**

  **What to do**: Install `next-themes`. Wrap `apps/desktop-ui/app/layout.tsx` body in `<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>`. Wire `apps/desktop-ui/app/settings/page.tsx:691-720` `setTheme` to `useTheme().setTheme()`. Update `<Toaster theme={theme}>` (currently hardcoded "dark"). Update meta `theme-color` reactively. Limit options to **Dark / System** for now (light explicitly deferred — show "Light theme coming soon" disabled).

  **Must NOT**: Don't ship light theme (would require massive token rework).

  **Agent**: `quick`. **Skills**: `frontend-design`.

  **Parallelization**: YES Wave 4. **Blocked By**: T2.

  **References**: `apps/desktop-ui/app/settings/page.tsx:691-720`, `apps/desktop-ui/app/layout.tsx:65-76`.

  **Acceptance**: [ ] Settings → toggle to "System" → theme follows OS; toaster updates; meta theme-color updates.

  **QA**:
  ```
  Scenario: System theme follows OS
    Tool: Playwright (with prefers-color-scheme emulation)
    Steps: settings → System; toggle OS dark↔light
    Expected: theme follows; persists on reload
    Evidence: .sisyphus/evidence/task-29-theme.png
  ```

  **Commit**: `feat(ui): functional theme switcher (dark/system; light deferred)`

---

- [x] 30. **Keyboard shortcuts: react-hotkeys-hook + ? overlay**

  **What to do**: Install `react-hotkeys-hook`. Create `apps/desktop-ui/components/shortcuts-overlay.tsx`: opens via `?` key, shows grouped list (Navigation: g i / g m / g p / g t; Actions: c=create task, /=search, ?=help, esc=close; Editing: cmd+enter=save). Add `useHotkeys` calls at root for global bindings; per-page for contextual.

  **Must NOT**: Don't conflict with browser shortcuts; don't bind in input/textarea fields.

  **Agent**: `quick`. **Skills**: `frontend-design`.

  **Parallelization**: YES Wave 4. **Blocked By**: T2.

  **References**: react-hotkeys-hook docs.

  **Acceptance**: [ ] `?` opens overlay; `g i` navigates to inbox; `c` opens new-task dialog; works from any page.

  **QA**:
  ```
  Scenario: Hotkeys work
    Tool: Playwright
    Steps: navigate /, press ?, then esc, press g i
    Expected: ? opens overlay; esc closes; g i navigates /inbox
    Evidence: .sisyphus/evidence/task-30-hotkeys.gif
  ```

  **Commit**: `feat(ui): global keyboard shortcuts + ? overlay`

---

- [x] 31. **Inline task creation in board columns + bulk-select + bulk actions**

  **What to do**:
  - Edit `apps/desktop-ui/components/board/column.tsx`: add "+ Add task" row at bottom; click → inline input; Enter creates via apiFetch + optimistic update; Esc cancels
  - Add bulk-select to kanban: shift-click range, cmd-click toggle, cmd+a select all visible; show floating toolbar with Archive / Delete / Change Status / Assign actions
  - Wire to existing `handleBatchExecute` pattern + new bulk handlers in use-kanban-board

  **Must NOT**: Don't break drag-and-drop while in select mode (disable DnD when selection active).

  **Agent**: `unspecified-high`. **Skills**: `frontend-design`.

  **Parallelization**: YES Wave 4. **Blocked By**: T2, T3, T18.

  **References**: `apps/desktop-ui/components/board/column.tsx`, `apps/desktop-ui/components/board/kanban-board.tsx`, `use-kanban-board.ts`.

  **Acceptance**: [ ] Inline create works in each column; shift-click selects range; floating toolbar performs bulk archive.

  **QA**:
  ```
  Scenario: Inline create
    Tool: Playwright
    Steps: navigate /, click "+ Add task" in Todo column, type "test", Enter
    Expected: New task appears at top of column without modal
    Evidence: .sisyphus/evidence/task-31-inline.gif

  Scenario: Bulk archive
    Tool: Playwright
    Steps: shift-click 3 cards, click Archive in toolbar
    Expected: All 3 disappear from board; appear in /archived
    Evidence: .sisyphus/evidence/task-31-bulk.gif
  ```

  **Commit**: `feat(ui): inline task creation in columns + bulk-select with toolbar`

---

- [x] 32. **Assignee/creator UI: picker in task detail + my-issues filters by current user**

  **What to do**:
  - Add assignee picker in `task-detail-view.tsx` sidebar (Avatar + dropdown listing team members); writes via PATCH /tasks/:id `{assigneeId}` (auto-creates assignment notification via T13)
  - Display creator avatar + "created by X" line
  - Edit `apps/desktop-ui/app/my-issues/page.tsx`: query `WHERE assigneeId=req.userId OR creatorId=req.userId` (push filter to backend `/api/tasks?assignee=me`); add filter chips (Assigned to me / Created by me / All)
  - Update `apps/desktop-ui/app/page.tsx` (board) to support `?assignee=me` filter chip

  **Must NOT**: Don't expose users from outside the task's team in the picker.

  **Agent**: `unspecified-high`. **Skills**: `shadcn-ui`, `frontend-design`.

  **Parallelization**: YES Wave 4. **Blocked By**: T1 (assigneeId/creatorId), T2 (Avatar/Dropdown), T17.

  **References**: `apps/desktop-ui/components/task-detail-view.tsx`, `apps/desktop-ui/app/my-issues/page.tsx`.

  **Acceptance**: [ ] Pick assignee → notification fires → my-issues shows the task for assignee.

  **QA**:
  ```
  Scenario: Assignment flows
    Tool: Playwright (two contexts)
    Steps:
      1. Context A: open task, click assignee, pick "demo"
      2. Context demo: navigate /my-issues
    Expected: Task appears in demo's my-issues "Assigned to me" filter
    Evidence: .sisyphus/evidence/task-32-assign.gif
  ```

  **Commit**: `feat(ui): assignee/creator picker + my-issues real filters`

---

- [x] 33. **Cost analytics page: /usage with per-task + aggregate from AgentRun**

  **What to do**: Create `apps/desktop-ui/app/usage/page.tsx`:
  - Header: total cost this month, total tokens, total runs, avg cost/run
  - Chart: cost over last 30 days (bar/line via recharts or visx)
  - Table: per-task breakdown with cost, tokens, model, run count; sortable; filter by team/project
  - Add backend `GET /api/usage/summary` and `GET /api/usage/by-task` to new `apps/api/src/routes/usage.ts` (or extend agent-runs.ts)
  - Add navigation link in sidebar

  **Must NOT**: Don't expose other tenants' usage; scope by user's teams.

  **Agent**: `visual-engineering`. **Skills**: `frontend-design`.

  **Parallelization**: YES Wave 4. **Blocked By**: T1 (AgentRun), T11 (population), T12 ownership pattern.

  **References**: `apps/desktop-ui/lib/api/opencode.ts:98` (cost type), schema from T1.

  **Acceptance**: [ ] After several executions: /usage shows non-zero totals + chart + per-task table.

  **QA**:
  ```
  Scenario: Usage page
    Tool: Playwright
    Steps: execute 3 tasks; navigate /usage
    Expected: Cards show Total Cost > 0; chart has 3 data points today; table lists 3 tasks
    Evidence: .sisyphus/evidence/task-33-usage.png
  ```

  **Commit**: `feat(ui): /usage analytics page with cost + token tracking`

---

### WAVE 5 — REBRAND + LANDING POLISH

- [x] 34. **Replace logo.png usages with SVG logomark + wordmark across desktop-ui + landing**

  **What to do**: Replace every `<img src="/logo.png">` with `<img src="/brand/logomark.svg">` (or wordmark where appropriate). Sites: `apps/desktop-ui/components/layout/sidebar.tsx:249` (sidebar logo, h-[16px]), `apps/desktop-ui/app/login/page.tsx:34` (login splash, larger), `apps/landing/components/header.tsx:21` (wordmark), `apps/landing/components/footer.tsx:95-97` (giant wordmark — use SVG wordmark scaled), any other refs from grep.

  Then delete `apps/desktop-ui/public/logo.png` (4MB), `logo.jpg`, `logo-trimmed.png`, repo root `logo.png` / `logo.jpg`.

  **Must NOT**: Don't delete brand SVGs; don't break favicon link (T5 set it to favicon.ico).

  **Agent**: `visual-engineering`. **Skills**: `frontend-design`.

  **Parallelization**: YES Wave 5. **Blocked By**: T5 (assets exist).

  **References**: T5 brand assets paths.

  **Acceptance**: [ ] `grep -rn "logo.png\|logo.jpg" apps/` returns 0 matches; sidebar logo crisp at 16px.

  **QA**:
  ```
  Scenario: Sidebar SVG renders
    Tool: Playwright
    Steps: login, screenshot sidebar
    Expected: Logomark visible at 16px, sharp (no PNG blur)
    Evidence: .sisyphus/evidence/task-34-sidebar.png
  ```

  **Commit**: `refactor(brand): replace PNG logos with SVG everywhere`

---

- [x] 35. **Tauri icon regeneration via tauri icon master.svg**

  **What to do**: Run `pnpm --filter @openlinear/desktop tauri icon apps/desktop-ui/public/brand/logomark.svg`. Verify outputs in `apps/desktop/src-tauri/icons/`. Commit generated files.

  **Must NOT**: Don't hand-edit generated icons; re-run CLI if logomark changes.

  **Agent**: `quick`. **Skills**: none.

  **Parallelization**: YES Wave 5. **Blocked By**: T5.

  **References**: T5.

  **Acceptance**: [ ] All Tauri icon files updated (32x32, 128x128, 128x128@2x, icon.ico, icon.icns, icon.png).

  **QA**:
  ```
  Scenario: Tauri icons regenerated
    Tool: Bash
    Steps: ls -la apps/desktop/src-tauri/icons/; file apps/desktop/src-tauri/icons/icon.icns
    Expected: Files present with reasonable sizes; icns valid
    Evidence: .sisyphus/evidence/task-35-tauri-icons.txt
  ```

  **Commit**: `chore(tauri): regenerate icon set from new brand SVG`

---

- [x] 36. **Font cleanup: delete Geist + Caveat; settle on Space Grotesk + DM Sans + DM Mono**

  **What to do**:
  - Delete `apps/desktop-ui/public/fonts/Geist*.woff2`, `apps/desktop-ui/app/fonts/Geist*.otf`
  - Remove `geist` from `apps/desktop-ui/package.json` deps
  - Remove `<link href="...Caveat...">` from `apps/desktop-ui/app/layout.tsx` (verify no usage via grep first)
  - Audit `EB_Garamond` usage via grep `font-editorial` and `<blockquote>`; if 0 usages, remove from layout.tsx; otherwise keep
  - Settle on: Space Grotesk (display), DM Sans (UI), DM Mono (code) — no serif unless used
  - Same review for `apps/landing/app/layout.tsx`

  **Must NOT**: Don't break currently-rendered text by removing a font that IS used.

  **Agent**: `quick`. **Skills**: none.

  **Parallelization**: YES Wave 5. **Blocked By**: None.

  **References**: `apps/desktop-ui/app/layout.tsx`, `apps/desktop-ui/public/fonts/`, `apps/desktop-ui/app/fonts/`, `apps/desktop-ui/package.json`.

  **Acceptance**: [ ] Bundle size for desktop-ui drops measurably (~2MB); no visual regression on any page.

  **QA**:
  ```
  Scenario: No font regressions
    Tool: Playwright
    Steps: visit each top-level page (/, /inbox, /my-issues, /projects, /teams, /archived, /settings); screenshot
    Expected: All text renders correctly with no system-font fallbacks
    Evidence: .sisyphus/evidence/task-36-fonts/*.png
  ```

  **Commit**: `chore(fonts): remove unused Geist + Caveat; settle on Space Grotesk + DM Sans + DM Mono`

---

- [x] 37. **Unify desktop + landing palette: pick canonical OpenLinear accent**

  **What to do**:
  - Pick canonical OpenLinear brand: keep blue accent `#1d4ed8` (already runtime-themable in desktop) as the SaaS brand color; landing uses same accent for CTAs but keeps warm neutral surfaces (gray-900/zinc-950)
  - Update `apps/landing/app/globals.css` to use the same `linear-*` HSL token system from desktop (or compatible variables); remove conflicting warm-cream variables OR scope them to landing-only marketing decoration
  - Sync `--linear-accent` defaults in both apps' globals.css
  - Document the brand palette in `docs/brand.md`: hex values, when to use what

  **Must NOT**: Don't break landing visual identity entirely; the warm-gold can stay as a SECONDARY decoration but accent CTAs must match.

  **Agent**: `visual-engineering`. **Skills**: `frontend-design`.

  **Parallelization**: YES Wave 5. **Blocked By**: T2.

  **References**: `apps/desktop-ui/app/globals.css:37-38`, `apps/landing/app/globals.css:80-145`, `apps/landing/components/hero.tsx`.

  **Acceptance**: [ ] CTA buttons same accent across both apps; brand doc exists.

  **QA**:
  ```
  Scenario: Palette consistency
    Tool: Playwright
    Steps: screenshot landing hero CTA + desktop sidebar accent
    Expected: Same blue hex value on both
    Evidence: .sisyphus/evidence/task-37-palette.png
  ```

  **Commit**: `refactor(brand): unified accent palette across desktop + landing + brand docs`

---

- [x] 38. **Remove raw hex literals: replace bg-[#1a1a1a] etc with linear-* tokens; extract status colors**

  **What to do**: Grep for `bg-\[#`, `text-\[#`, `border-\[#` across `apps/desktop-ui`; replace each with appropriate `linear-*` Tailwind class. Worst offenders: `task-form.tsx`, `dashboard-loading.tsx`. Extract status color map (todo/in_progress/done/cancelled etc.) from inline literals in `task-card.tsx` `progressConfig`, `execution-drawer.tsx`, `column.tsx` into `apps/desktop-ui/lib/design-tokens.ts:STATUS_COLORS` (created in T2). Replace stray `bg-zinc-950/80` in `god-mode-overlay.tsx:145,167`.

  **Must NOT**: Don't change any colors visually; this is a token-substitution refactor.

  **Agent**: `quick`. **Skills**: `frontend-design`.

  **Parallelization**: YES Wave 5. **Blocked By**: T2 (design-tokens.ts).

  **References**: ~10 files identified in research.

  **Acceptance**: [ ] `grep -rn 'bg-\[#\|text-\[#\|border-\[#' apps/desktop-ui/components/ apps/desktop-ui/app/` returns 0 matches.

  **QA**:
  ```
  Scenario: No regression
    Tool: Playwright
    Steps: screenshot board + task detail; compare pixel-diff against baseline
    Expected: Visual equivalent (within 1px tolerance)
    Evidence: .sisyphus/evidence/task-38-tokens.png
  ```

  **Commit**: `refactor(ui): replace raw hex literals with linear-* design tokens`

---

- [x] 39. **Landing copy purge: remove Zep/Mem0, fake stats, false integrations; rewrite truthfully**

  **What to do**:
  - `apps/landing/components/header.tsx:48`: remove fake "X 1.2k" stat
  - `apps/landing/components/performance-section.tsx:55,99,121`: remove all Zep/Mem0 comparisons; replace with genuine OpenLinear value props (parallel agent execution, cost tracking, human-in-loop review)
  - `apps/landing/components/integrations-section.tsx:51`: remove Google Drive/Notion/OneDrive false claims; replace with what IS real (GitHub, OpenAI/Anthropic/local LLMs via OpenCode)
  - `apps/landing/components/hero.tsx:35`: rewrite "now the best task execution platform" to a verifiable claim
  - `apps/landing/app/docs/page.tsx:888`: fix Docker container claim to match host-based architecture
  - `apps/landing/app/docs/page.tsx:173`: update `git clone` URL once T41 lands

  **Must NOT**: Don't remove correct content; don't ship typos.

  **Agent**: `writing`. **Skills**: `human-replies`.

  **Parallelization**: YES Wave 5. **Blocked By**: None.

  **References**: lines listed above.

  **Acceptance**: [ ] No Zep/Mem0/Google Drive/OneDrive/Notion claims; no fake stats.

  **QA**:
  ```
  Scenario: No false claims
    Tool: Bash
    Steps: `grep -rin "zep\|mem0\|google drive\|onedrive\|notion" apps/landing/`
    Expected: 0 matches
    Evidence: .sisyphus/evidence/task-39-copy.txt
  ```

  **Commit**: `docs(landing): remove template-leftover false claims and fake stats`

---

- [x] 40. **Landing footer + nav: wire all href="#" to real pages; unify domain to openlinear.tech**

  **What to do**:
  - Edit `apps/landing/components/footer.tsx:1-21,23-28`: replace all `href="#"` with real targets (Docs → /docs, Pricing → /pricing, GitHub → real org URL, etc.) OR remove entries that don't have real pages
  - Replace `openlinear.dev` with `openlinear.tech` in: `apps/landing/components/hero.tsx:156`, `apps/landing/app/contact/page.tsx:57,58,232,235`, `apps/landing/app/pricing/page.tsx:297,300`
  - Update `hello@openlinear.dev` → `hello@openlinear.tech`

  **Must NOT**: Don't link to pages that don't exist (better to remove entry).

  **Agent**: `quick`. **Skills**: none.

  **Parallelization**: YES Wave 5. **Blocked By**: None.

  **References**: lines listed above.

  **Acceptance**: [ ] `grep -rn 'href="#"' apps/landing/` returns 0 (or only intentional placeholders); `grep -rn 'openlinear\.dev' apps/landing/` returns 0.

  **QA**:
  ```
  Scenario: Footer links resolve
    Tool: Playwright
    Steps: click each footer link; verify destination
    Expected: All resolve to real pages or external sites
    Evidence: .sisyphus/evidence/task-40-footer.txt
  ```

  **Commit**: `fix(landing): wire footer links + unify domain to openlinear.tech`

---

- [x] 41. **kaizen403 → openlinear org rename across 14 sites**

  **What to do**: Replace `kaizen403/openlinear` → `openlinear/openlinear` (or `<chosen-org>/openlinear` — confirm with user via `[DECISION NEEDED]` if ambiguous; default to `openlinear/openlinear`) in: `README.md:60,126,127,128,130`, `docs/CICD.md:116,128`, `packaging/aur/openlinear-bin/PKGBUILD:6,10,13`, `packages/openlinear-cli/scripts/postinstall.js:17`, `packages/openlinear-cli/package.json:2,8` (rename `@kaizen403/openlinear-cli` → `@openlinear/cli`), `packages/openlinear/publish-github.sh:23,33,51`, `apps/landing/components/{vision-section,final-cta-section,header,hero}.tsx`, `apps/landing/app/contact/page.tsx:63,64,241,244`, `apps/landing/app/docs/page.tsx:173`.

  **Must NOT**: Don't change git history; don't break the actual GitHub remote until org migration is real.

  **Agent**: `quick`. **Skills**: none.

  **Parallelization**: YES Wave 5. **Blocked By**: None.

  **[DECISION NEEDED]**: Confirm new GitHub org name (default: `openlinear`).

  **References**: 14 sites listed.

  **Acceptance**: [ ] `grep -rn 'kaizen403' .` returns 0 matches outside `.git/`.

  **QA**:
  ```
  Scenario: No personal handle
    Tool: Bash
    Steps: `grep -rin "kaizen403" --exclude-dir=.git --exclude-dir=node_modules .`
    Expected: 0 matches
    Evidence: .sisyphus/evidence/task-41-handle.txt
  ```

  **Commit**: `chore(brand): kaizen403 → openlinear org migration across all references`

---

- [x] 42. **Seed user kaz → demo + remove personal traces from seed.ts**

  **What to do**: Edit `packages/db/prisma/seed.ts`: replace `seed-user-kaz` → `seed-user-demo` (lines 81, 84), `username: "kaz"` → `"demo"` (line 85), update name "Kaz" → "Demo User", email → `demo@openlinear.tech`. Update any cascading references at lines 116, 126.

  **Must NOT**: Don't break demo seed flow.

  **Agent**: `quick`. **Skills**: none.

  **Parallelization**: YES Wave 5. **Blocked By**: T1.

  **References**: `packages/db/prisma/seed.ts`.

  **Acceptance**: [ ] `pnpm db:seed` succeeds; resulting User row has `username='demo'`.

  **QA**:
  ```
  Scenario: Seed runs clean
    Tool: Bash
    Steps: docker exec openlinear sh -c "cd /app && pnpm db:seed"
    Expected: Exit 0; psql shows user with username='demo'
    Evidence: .sisyphus/evidence/task-42-seed.txt
  ```

  **Commit**: `chore(db): rename seed user kaz → demo`

---

### WAVE 6 — POLISH + BOUNDARIES

- [x] 43. **App Router error boundaries: loading.tsx + error.tsx + not-found.tsx**

  **What to do**: Add at root `apps/desktop-ui/app/`: `loading.tsx` (skeleton matching shell), `error.tsx` (`'use client'` with reset button + toast), `not-found.tsx` (themed 404 with link home). Same per major section: `app/inbox/`, `app/my-issues/`, `app/projects/`, `app/teams/`, `app/archived/`, `app/settings/`, `app/usage/`. Same `loading.tsx`/`error.tsx`/`not-found.tsx` at root of `apps/landing/app/`.

  **Must NOT**: Don't show stack traces in production; use generic messaging with "Try again" reset.

  **Agent**: `quick`. **Skills**: `frontend-design`.

  **Parallelization**: YES Wave 6. **Blocked By**: T2.

  **References**: Next.js App Router docs (loading/error/not-found conventions).

  **Acceptance**: [ ] Force a render error in any page → error.tsx renders themed UI with reset button; reset works.

  **QA**:
  ```
  Scenario: Error boundary catches
    Tool: Playwright
    Steps: temporarily inject throw in /projects/page.tsx; navigate
    Expected: Themed error page with "Try again" button; click → page reloads
    Evidence: .sisyphus/evidence/task-43-error.png
  ```

  **Commit**: `feat(ui): App Router error boundaries (loading/error/not-found)`

---

- [x] 44. **Empty states + skeletons: reusable EmptyState component**

  **What to do**: Create `apps/desktop-ui/components/empty-state.tsx` with icon + title + description + optional action button. Replace ad-hoc "No X yet" strings in: `app/inbox/page.tsx`, `app/my-issues/page.tsx`, `app/projects/page.tsx`, `app/teams/page.tsx`, `app/archived/page.tsx`, `components/board/kanban-board.tsx` (empty board), `components/label-picker.tsx`. Add `<Skeleton>` (from T2) loading states matching final layout shape.

  **Must NOT**: Don't replace error states (different component).

  **Agent**: `visual-engineering`. **Skills**: `frontend-design`, `shadcn-ui`.

  **Parallelization**: YES Wave 6. **Blocked By**: T2.

  **References**: ad-hoc empty strings across app.

  **Acceptance**: [ ] All empty states use `<EmptyState>`; loading uses `<Skeleton>`.

  **QA**:
  ```
  Scenario: Empty inbox
    Tool: Playwright
    Steps: navigate /inbox as user with 0 notifications
    Expected: Themed EmptyState with bell icon, "No notifications yet", description, action
    Evidence: .sisyphus/evidence/task-44-empty.png
  ```

  **Commit**: `feat(ui): EmptyState component + skeleton loading states`

---

- [x] 45. **Sidebar polish: fix close-button bug, remove headerLabel.replace defensive hack, user dropdown**

  **What to do**: Fix `apps/desktop-ui/components/layout/sidebar.tsx:198` — `handleClose` actually calls `minimize()`. Either rename to `handleMinimize` OR wire to real close API. Remove defensive `headerLabel.replace(/openlinear/gi, "Dashboard")` from `apps/desktop-ui/app/page.tsx:65` (post-rebrand it's no longer needed). Add user dropdown menu (using DropdownMenu from T2): avatar at sidebar bottom → menu with Profile / Settings / Sign out / Theme picker / Help.

  **Must NOT**: Don't break the macOS traffic-light buttons.

  **Agent**: `quick`. **Skills**: `shadcn-ui`.

  **Parallelization**: YES Wave 6. **Blocked By**: T2, T29 (theme integration), T34 (logo).

  **References**: `apps/desktop-ui/components/layout/sidebar.tsx:198,228-260`, `apps/desktop-ui/app/page.tsx:65`.

  **Acceptance**: [ ] Close button has clear purpose; user menu opens with all entries; sign out works.

  **QA**:
  ```
  Scenario: User menu
    Tool: Playwright
    Steps: click avatar at sidebar bottom
    Expected: DropdownMenu shows Profile / Settings / Sign out / Theme; sign out logs user out
    Evidence: .sisyphus/evidence/task-45-user-menu.gif
  ```

  **Commit**: `fix(ui): sidebar polish — close button + user dropdown + remove rebrand defensive`

---

- [x] 46. **Dead code removal: hooks/use-sse.ts + unused imports + defensive replaces**

  **What to do**: Delete `apps/desktop-ui/hooks/use-sse.ts` (dead code per research). Move types it exported (SSEEventType, SSEEventData) into `apps/desktop-ui/providers/sse-provider.tsx`. Remove dead imports across consumers. Audit and remove other dead code identified in research (unused fonts already in T36).

  **Must NOT**: Don't break SSE consumers.

  **Agent**: `quick`. **Skills**: none.

  **Parallelization**: YES Wave 6. **Blocked By**: T8 (SSE types stabilized).

  **References**: `apps/desktop-ui/hooks/use-sse.ts`.

  **Acceptance**: [ ] File deleted; consumers compile.

  **QA**:
  ```
  Scenario: Build passes
    Tool: Bash
    Steps: pnpm --filter @openlinear/desktop-ui build
    Expected: Exit 0
    Evidence: .sisyphus/evidence/task-46-build.txt
  ```

  **Commit**: `chore(ui): remove dead use-sse hook + consolidate SSE types`

---

- [x] 47. **Settings tab cleanup: hide non-functional 2FA + sessions; add real Profile tab**

  **What to do**: Edit `apps/desktop-ui/app/settings/page.tsx`:
  - Add new "Profile" tab (first): name, email, avatar (display GitHub-synced; "Reconnect GitHub" action); update via PATCH /api/auth/me
  - Hide or disable 2FA toggle (mark "Coming soon"); hide hardcoded sessions mock list
  - API keys tab: replace fake `sk-ol-...` string with empty state ("No API keys yet — generate one via Settings → Developer when this feature ships")
  - Notifications tab: wire to real per-user preferences if backend supports OR mark "Coming soon"

  **Must NOT**: Don't ship fake mock data anywhere.

  **Agent**: `unspecified-high`. **Skills**: `frontend-design`.

  **Parallelization**: YES Wave 6. **Blocked By**: T2, T3.

  **References**: `apps/desktop-ui/app/settings/page.tsx` (8 tabs).

  **Acceptance**: [ ] Profile tab functional; no fake mock data anywhere in settings.

  **QA**:
  ```
  Scenario: Profile updates
    Tool: Playwright
    Steps: navigate /settings/profile, change name, save
    Expected: Toast success; refresh shows new name
    Evidence: .sisyphus/evidence/task-47-profile.png
  ```

  **Commit**: `feat(ui): real Profile tab + remove fake mocks from settings`

---

- [x] 48. **Pagination on tasks list + inbox + archived endpoints**

  **What to do**: Add `?page=&pageSize=` (default 50, max 200) to `GET /api/tasks`, `/api/tasks/archived`, `/api/inbox`, `/api/notifications`, `/api/activity`, `/api/agent-runs`. Return `{ items, total, page, pageSize, hasMore }`. Update UI to show "Load more" button (or virtualize if list grows big — defer virtualization).

  **Must NOT**: Don't break existing callers (default page=1 if absent).

  **Agent**: `quick`. **Skills**: `prisma-expert`.

  **Parallelization**: YES Wave 6. **Blocked By**: T9 (validation), T13 (notifications/activity routes).

  **References**: `apps/api/src/routes/{tasks,inbox,notifications,activity-log,agent-runs}.ts`.

  **Acceptance**: [ ] curl `/api/tasks?page=2&pageSize=10` returns next page; UI shows "Load more" when hasMore=true.

  **QA**:
  ```
  Scenario: Pagination works
    Tool: Bash + Playwright
    Steps: seed 100 tasks; curl /api/tasks?pageSize=20 → 20 items, hasMore=true; UI shows Load more
    Expected: Pagination metadata correct; UI loads more on click
    Evidence: .sisyphus/evidence/task-48-pagination.txt
  ```

  **Commit**: `feat(api): pagination on list endpoints`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user; wait for explicit "okay".
> Do NOT mark F1-F4 checked before user's okay.

- [x] F1. **Plan Compliance Audit** — `oracle`
  Read plan end-to-end. For each "Must Have": verify implementation exists (read file, curl endpoint, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in `.sisyphus/evidence/`. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high`
  Run `pnpm typecheck` (across api, sidecar, desktop-ui, landing) + lint + build. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports, raw hex colors, raw exec(). Check AI slop: excessive comments, over-abstraction, generic names.
  Output: `Build [PASS/FAIL] | Lint [PASS/FAIL] | Files [N clean/N issues] | VERDICT`

- [x] F3. **Real Manual QA** — `unspecified-high` + `playwright` skill
  Boot fresh container. Execute EVERY QA scenario from EVERY task — exact steps, capture evidence to `.sisyphus/evidence/final-qa/`. End-to-end smoke: GitHub login → create project → connect repo → create task with markdown description → @mention user → execute task with model selector → see cost in detail → comment on task → assignee picker → archive task → check inbox notification. Test cross-task integration. Test edge cases.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (git log/diff). Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep). Check "Must NOT do" compliance. Detect cross-task contamination. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

> One logical commit per task by default. Conventional commits format. Pre-commit: `pnpm typecheck` for touched packages.

- **T1**: `feat(db): add Comment, AgentRun, Notification, ActivityLog models + assigneeId/creatorId/parentId on Task with indexes`
- **T2**: `feat(ui): add AlertDialog, Sheet, Tooltip, Avatar, Skeleton, Tabs, DropdownMenu, Command primitives + design token consolidation`
- **T3**: `refactor(ui): single apiFetch wrapper with 401 handler and lazy URL resolution`
- **T4**: `feat(api): pino logging, helmet, rate limiting, global error middleware, graceful shutdown`
- **T5**: `feat(brand): SVG logomark + wordmark + favicon + Tauri icon + OG/Twitter cards`
- **T6**: `fix(security): eliminate shell injection in git and worktree services (use execFile)`
- **T7**: `fix(security): require auth + ownership on all mutating routes`
- (continued per task — full list in task entries below)

---

## Success Criteria

### Verification Commands
```bash
# 1. Typecheck across workspaces
pnpm typecheck  # Expected: 0 errors

# 2. API security: POST without auth must 401
curl -i -X POST http://localhost:3001/api/tasks -H "Content-Type: application/json" -d '{"title":"test"}'  # Expected: 401

# 3. UI search now works
# Playwright: type in header search → KanbanBoard filters

# 4. No shell exec strings in git.ts/worktree.ts
grep -nE 'execAsync\(`|exec\(`' apps/sidecar/src/services/execution/git.ts apps/sidecar/src/services/worktree.ts  # Expected: 0 matches

# 5. No window.confirm in desktop-ui
grep -rn 'window\.confirm\|window\.alert\|window\.prompt' apps/desktop-ui/  # Expected: 0 matches

# 6. No raw localStorage token outside apiFetch
grep -rn "localStorage.getItem('token')" apps/desktop-ui/components/board/  # Expected: 0 matches

# 7. Logo is SVG
file apps/desktop-ui/public/logo.svg  # Expected: SVG file

# 8. No kaizen403 in landing
grep -rn 'kaizen403' apps/landing/  # Expected: 0 matches

# 9. No openlinear.dev in landing
grep -rn 'openlinear\.dev' apps/landing/  # Expected: 0 matches

# 10. AgentRun records exist after task execution
psql ... -c "SELECT count(*) FROM agent_runs;"  # Expected: > 0
```

### Final Checklist
- [x] All "Must Have" present
- [x] All "Must NOT Have" absent
- [x] All 4 final-wave reviews APPROVE
- [ ] User explicitly approves consolidated review summary
