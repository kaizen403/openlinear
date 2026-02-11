# Teams & Projects - Learnings

## Session: ses_3bb732e96ffeNSKpyvPLbkgpuc
## Started: 2026-02-09T22:36:45.403Z

## Codebase Structure

### Prisma Schema (`packages/db/prisma/schema.prisma`)
- `Project` model at lines 93-108, mapped to `@@map("projects")` DB table
- `User` model has `projects Project[]` relation at line 88
- All models use `@@map()` for snake_case table names

### API Patterns
- Routes in `apps/api/src/routes/` follow express Router pattern
- Zod validation with `safeParse` + 400 response on failure
- Broadcast events via `broadcast('entity:action', data)` from `sse.ts`
- Auth middleware: `requireAuth` (enforced) and `optionalAuth` (optional)
- Tests use vitest + supertest, clean DB in beforeEach/afterEach
- Routes mounted in `app.ts`

### Files referencing `prisma.project.*`
- `apps/api/src/routes/repos.ts` - findFirst, findMany, updateMany, update
- `apps/api/src/services/github.ts` - findFirst, update, updateMany, create, upsert, findMany
- `apps/api/src/services/execution.ts` - findUnique, findFirst (lines 318, 582, 586)
- `apps/api/src/services/batch.ts` - findFirst, findUnique (lines 31, 118, 425, 475)

### Frontend `Project` type references
- `apps/desktop-ui/lib/api.ts` - Project interface, PublicProject interface, functions
- `apps/desktop-ui/hooks/use-auth.tsx` - imports Project, activeProject context
- `apps/desktop-ui/components/auth/project-selector.tsx` - imports Project
- `apps/desktop-ui/components/layout/sidebar.tsx` - uses activeProject
- `apps/desktop-ui/app/projects/page.tsx` - has its OWN local Project interface (Linear-style, NOT repo)

### SSE Event Pattern
- Type union in `use-sse.ts` enumerates all event types
- Each event needs explicit `addEventListener` call in the hook
- Event names follow `entity:action` pattern

### Existing UI Pages
- `app/teams/page.tsx` - empty data array, has table structure ready
- `app/projects/page.tsx` - hardcoded demo data, has table structure ready
- Both use `AppShell` wrapper


## Task 1: Rename Prisma Project → Repository

### Patterns
- Prisma generate command: `pnpm --filter @openlinear/db db:generate` (uses Prisma v5.22.0 in this project; v7+ has breaking changes with datasource `url`)
- `@@map("projects")` preserves DB table name while renaming the model — no migration needed
- LSP errors from Prisma model renames clear after running `prisma generate`

### Gotchas
- 3 additional consumer files not listed in original spec also used old types/functions:
  - `apps/desktop-ui/app/page.tsx` (uses `activeProject` from useAuth)
  - `apps/desktop-ui/components/board/kanban-board.tsx` (uses `activeProject`, `getActivePublicProject`, `PublicProject`)
  - `apps/desktop-ui/components/repo-connector.tsx` (uses `PublicProject`, `getActivePublicProject`)
- Always grep the full codebase for renamed exports, not just the files in the spec
- The `User` interface field was `projects: Project[]` → `repositories: Repository[]` (in both Prisma schema and frontend api.ts)
- `projectId` in ExecutionState was correctly left alone — it's an internal field name, not a Prisma model reference

### Files Changed (11 total)
1. `packages/db/prisma/schema.prisma` — Model rename + User relation
2. `apps/api/src/services/github.ts` — 5 function renames + prisma.repository calls
3. `apps/api/src/routes/repos.ts` — Import updates + prisma.repository calls
4. `apps/api/src/services/execution.ts` — prisma.repository calls (3 occurrences)
5. `apps/api/src/services/batch.ts` — prisma.repository calls (4 occurrences)
6. `apps/desktop-ui/lib/api.ts` — Interface + function renames
7. `apps/desktop-ui/hooks/use-auth.tsx` — Context type + state renames
8. `apps/desktop-ui/components/auth/project-selector.tsx` — Type + function updates
9. `apps/desktop-ui/components/layout/sidebar.tsx` — activeProject → activeRepository
10. `apps/desktop-ui/app/page.tsx` — activeProject → activeRepository
11. `apps/desktop-ui/components/board/kanban-board.tsx` — Type + function updates
12. `apps/desktop-ui/components/repo-connector.tsx` — Type + function updates

## Task 2: Teams + Projects Schema Models (2026-02-10)

- `prisma generate` and `db:push` both succeeded on first try — schema is valid
- New enums `TeamRole` and `ProjectStatus` use `@@map()` for snake_case table names (`team_roles`, `project_statuses`)
- Project model uses `@@map("linear_projects")` to avoid collision with Repository's `@@map("projects")`
- All new fields on Task model (teamId, projectId, number, identifier) are nullable — no migration risk
- ProjectTeam uses composite `@@id([projectId, teamId])` — no separate `id` field needed for join tables
- TeamMember uses `@@unique([teamId, userId])` to prevent duplicate memberships + has its own UUID `id`
- Prisma v5.22.0 handles enum `@@map` fine with PostgreSQL

## Task 3: Teams API Route + Tests (2026-02-10)

### Architecture Decisions
- 8 endpoints: GET /, POST /, PATCH /:id, DELETE /:id, GET /:id, GET /:id/members, POST /:id/members, DELETE /:id/members/:userId
- Creator auto-added as `owner` member via nested Prisma `create` in POST
- DELETE cascades: nullify `task.teamId` before deleting team to avoid FK violations
- `addMemberSchema` uses Zod `.refine()` for "either email or userId required" validation
- No SSE events for membership changes (per constraint)

### Neon Pooling Test Strategy (CRITICAL)
- **NEVER use `beforeEach`/`afterEach` with Neon** — pooled connections cause data visibility issues between test hooks and test bodies
- Use `beforeAll`/`afterAll` for setup/teardown instead
- Tests that create→read→update/delete must go through API routes (supertest), NOT direct Prisma calls
- Even POST→GET→PATCH pattern can fail with Neon pooling (different connections see stale data)
- Adding a GET confirmation between POST and PATCH/DELETE helps but isn't 100% reliable
- Tests eventually pass consistently with the `beforeAll`/`afterAll` pattern — the flakiness was from connection pool churn during `beforeEach`/`afterEach`
- Set `testTimeout: 30000` and `hookTimeout: 30000` in vitest config — Neon round-trips are ~500ms each

### Test Results
- teams.test.ts: 15/15 pass
- health.test.ts + auth.test.ts: 9/9 pass (unaffected)
- tasks.test.ts + projects.test.ts: timeout (pre-existing issue from other tasks using `beforeEach`/`afterEach` — NOT our files, cannot modify per constraints)

### Files Created/Modified
1. `apps/api/src/routes/teams.ts` — Created, 262 lines, all 8 endpoints
2. `apps/api/src/app.ts` — Added import + `app.use('/api/teams', teamsRouter)`
3. `apps/api/src/__tests__/teams.test.ts` — Created, 254 lines, 15 tests
4. `apps/api/vitest.config.ts` — Bumped testTimeout to 30000, added hookTimeout: 30000
