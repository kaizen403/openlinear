# OpenLinear MVP - Work Plan

## TL;DR

> **Quick Summary**: Build a Linear-like kanban board that executes tasks via OpenCode agents. Turborepo monorepo with Next.js frontend, Express backend, PostgreSQL, and @opencode-ai/sdk for parallel AI task execution.
> 
> **Deliverables**:
> - Turborepo monorepo with pnpm workspaces
> - Next.js 14+ frontend with shadcn/ui dark theme (Linear-inspired)
> - Express backend with REST API + SSE
> - PostgreSQL database with Drizzle ORM
> - Kanban board (Todo, In Progress, Done, Cancelled)
> - Task CRUD with custom labels
> - OpenCode agent execution with parallel limit
> - Real-time status updates via SSE
> 
> **Estimated Effort**: Large (XL)
> **Parallel Execution**: YES - 3 waves
> **Critical Path**: Task 1 → 2 → 3 → 6 → 7 → 10 → 12 → 14

---

## Context

### Original Request
Build "OpenLinear" - a project management app like Linear, but focused on executing tasks via OpenCode agents. Users can create tasks on a kanban board, assign labels, and execute them in parallel using OpenCode. MVP focused with no auth or extra features.

### Interview Summary
**Key Discussions**:
- **Database**: PostgreSQL (via Docker)
- **Workspace**: Single shared workspace for all tasks
- **Labels**: Custom labels with colors, priority by label type
- **Parallel Execution**: Configurable limit
- **Progress Updates**: Live streaming via SSE
- **Kanban Columns**: Fixed 4 columns (Todo, In Progress, Done, Cancelled)
- **Testing**: Include tests with vitest
- **Theme**: Dark theme matching Linear's aesthetic

**Research Findings**:
- **OpenCode SDK**: `@opencode-ai/sdk` provides TypeScript SDK with `createOpencode()` to spawn server
- **Server Mode**: `opencode serve` exposes REST API; SDK can spawn programmatically
- **Session Management**: Create session per task, track via `sessionId`
- **Events**: SSE at `/event` endpoint with `session.idle`, `session.error`, etc.
- **Abort**: `client.session.abort()` to cancel running sessions

### Metis Review
**Identified Gaps** (addressed):
- **OpenCode server lifecycle**: Use `createOpencode()` to spawn from Express (auto-resolved)
- **Session-task mapping**: 1:1 - fresh session per task execution (auto-resolved)
- **Failure recovery**: Mark as failed after 30 min timeout, allow retry (auto-resolved)
- **Parallel conflict risk**: Accepted limitation for MVP, document clearly (disclosed)
- **PostgreSQL setup**: Include `docker-compose.yml` (auto-resolved)

---

## Work Objectives

### Core Objective
Build a functional MVP of OpenLinear that allows users to create tasks on a kanban board, manage labels, and execute tasks in parallel using OpenCode agents with real-time status updates.

### Concrete Deliverables
- `/apps/web` - Next.js 14+ frontend with App Router
- `/apps/api` - Express backend with TypeScript
- `/packages/db` - Drizzle ORM schema and client
- `/packages/types` - Shared TypeScript types
- `docker-compose.yml` - PostgreSQL for development
- Kanban board UI with 4 fixed columns
- Task CRUD API endpoints
- Label management (CRUD, assign to tasks)
- OpenCode integration for task execution
- SSE for real-time updates
- Settings page with parallel limit config

### Definition of Done
- [x] `pnpm install` succeeds from fresh clone
- [x] `docker compose up -d` starts PostgreSQL
- [x] `pnpm db:push` creates all tables
- [x] `pnpm dev` starts both frontend and backend
- [x] Tasks can be created, edited, deleted via UI
- [x] Labels can be created, assigned to tasks
- [x] Tasks can be executed (moved to In Progress, runs OpenCode)
- [x] Tasks can be cancelled (aborts OpenCode session)
- [x] Real-time updates show in UI via SSE (verified - events broadcast correctly)
- [x] Parallel limit enforced (rejects when exceeded)
- [x] `pnpm test` passes all tests (vitest configured, 11 tests passing)

### Must Have
- 4-column kanban board (Todo, In Progress, Done, Cancelled)
- Task CRUD with title, description, priority
- Custom labels with name + hex color
- Priority by label type
- Execute task → creates OpenCode session
- Cancel task → aborts session, moves to Cancelled
- Configurable parallel execution limit (1-5)
- SSE real-time updates
- Dark theme (Linear-inspired)
- PostgreSQL with Drizzle ORM
- Tests with vitest

### Must NOT Have (Guardrails)
- Authentication/login - MVP single-user
- Team/collaboration features
- Multiple workspaces - single shared workspace
- Task dependencies
- Drag-drop reorder within columns
- Conversation/transcript viewer - just status + last message
- Custom column names
- File attachments to tasks
- Provider/model selection UI - use OpenCode defaults
- Task history/versioning
- Undo/redo
- Mobile responsive - desktop-first
- Light theme - dark only
- Keyboard shortcuts
- Task templates
- Bulk operations beyond execute all

---

## Verification Strategy (MANDATORY)

### Test Decision
- **Infrastructure exists**: NO (new project)
- **User wants tests**: YES (TDD not required, tests alongside)
- **Framework**: vitest

### Automated Verification

Each TODO includes executable verification. Key patterns:

**For API endpoints** (using curl):
```bash
curl -s -X POST http://localhost:3001/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"Test","description":"Test desc","priority":"medium"}' \
  | jq '.id'
# Assert: Returns UUID
```

**For Frontend** (using playwright via dev-browser skill):
```
1. Navigate to: http://localhost:3000
2. Assert: 4 columns visible (Todo, In Progress, Done, Cancelled)
3. Click: "Create Task" button
4. Fill form, submit
5. Assert: Task appears in Todo column
```

**For Database** (using drizzle-kit):
```bash
pnpm --filter db db:push
# Assert: Exit code 0
# Assert: Tables created
```

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately):
├── Task 1: Turborepo + pnpm workspace init
└── Task 5: OpenCode SDK validation spike (standalone)

Wave 2 (After Wave 1):
├── Task 2: Docker + PostgreSQL setup
├── Task 3: Drizzle schema + migrations
└── Task 4: Shared types package

Wave 3 (After Wave 2):
├── Task 6: Express API foundation + SSE
├── Task 7: Task CRUD endpoints
└── Task 8: Label CRUD endpoints

Wave 4 (After Wave 3):
├── Task 9: OpenCode integration in API
├── Task 10: Settings endpoints

Wave 5 (After Wave 4):
├── Task 11: Next.js + shadcn setup
├── Task 12: Kanban board UI

Wave 6 (After Wave 5):
├── Task 13: Task form modal
├── Task 14: SSE client integration

Wave 7 (After Wave 6):
├── Task 15: Settings page
├── Task 16: Polish + final testing
```

### Dependency Matrix

| Task | Depends On | Blocks | Can Parallelize With |
|------|------------|--------|---------------------|
| 1 | None | 2, 3, 4, 6, 11 | 5 |
| 2 | 1 | 3 | 4, 5 |
| 3 | 2 | 6, 7, 8, 9, 10 | 4, 5 |
| 4 | 1 | 6, 7, 11 | 2, 3, 5 |
| 5 | None | 9 | 1, 2, 3, 4 |
| 6 | 3, 4 | 7, 8, 9, 14 | - |
| 7 | 6 | 12, 13 | 8 |
| 8 | 6 | 13 | 7 |
| 9 | 5, 6 | 12 | 10 |
| 10 | 6 | 15 | 9 |
| 11 | 1 | 12, 13, 14, 15 | 6-10 |
| 12 | 7, 9, 11 | 14 | 13 |
| 13 | 7, 8, 11 | 14 | 12 |
| 14 | 6, 12, 13 | 16 | 15 |
| 15 | 10, 11 | 16 | 14 |
| 16 | 14, 15 | None | None (final) |

### Agent Dispatch Summary

| Wave | Tasks | Recommended Approach |
|------|-------|---------------------|
| 1 | 1, 5 | Parallel: turborepo init + SDK spike |
| 2 | 2, 3, 4 | Parallel after Wave 1 |
| 3 | 6, 7, 8 | API foundation, then CRUD in parallel |
| 4 | 9, 10 | OpenCode + settings |
| 5 | 11, 12 | Frontend shell + board |
| 6 | 13, 14 | Forms + SSE client |
| 7 | 15, 16 | Settings + polish |

---

## TODOs

### Infrastructure Setup

- [x] 1. Initialize Turborepo Monorepo

  **What to do**:
  - Run `pnpm dlx create-turbo@latest` with pnpm
  - Configure workspace structure: `apps/web`, `apps/api`, `packages/db`, `packages/types`
  - Setup shared TypeScript config
  - Add turbo.json with pipeline for build, dev, test, lint
  - Create root .gitignore, .nvmrc (Node 20+)
  - Verify with `pnpm install && pnpm build`

  **Must NOT do**:
  - Add CI/CD pipelines
  - Add husky/lint-staged hooks
  - Add complex ESLint rules beyond defaults

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: [`turborepo`]
    - `turborepo`: Direct match for Turborepo configuration

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 5)
  - **Blocks**: Tasks 2, 3, 4, 6, 11
  - **Blocked By**: None (can start immediately)

  **References**:
  - Turborepo official docs: https://turbo.build/repo/docs/getting-started/create-new

  **Acceptance Criteria**:
  ```bash
  # Verify structure
  ls apps/web apps/api packages/db packages/types
  # Assert: All directories exist
  
  # Verify pnpm workspace
  cat pnpm-workspace.yaml | grep -E "apps/\*|packages/\*"
  # Assert: Both patterns present
  
  # Verify turbo config
  cat turbo.json | jq '.pipeline.build'
  # Assert: Pipeline defined
  
  # Verify install works
  pnpm install
  # Assert: Exit code 0
  ```

  **Commit**: YES
  - Message: `chore: initialize turborepo monorepo with pnpm`
  - Files: All files in root and skeleton directories

---

- [x] 2. Setup Docker + PostgreSQL

  **What to do**:
  - Create `docker-compose.yml` with PostgreSQL 16
  - Configure volume for persistence
  - Set environment variables (POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB)
  - Create `.env.example` with database URL template
  - Add docker-compose commands to root package.json scripts

  **Must NOT do**:
  - Add production Docker configuration
  - Add Redis or other services
  - Create multi-environment docker configs

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: [`docker-expert`]
    - `docker-expert`: Docker Compose configuration

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 3, 4)
  - **Blocks**: Task 3
  - **Blocked By**: Task 1

  **References**:
  - PostgreSQL Docker official image: https://hub.docker.com/_/postgres

  **Acceptance Criteria**:
  ```bash
  # Start database
  docker compose up -d
  # Assert: Exit code 0
  
  # Verify running
  docker compose ps --format json | jq '.[0].State'
  # Assert: "running"
  
  # Test connection
  docker compose exec -T postgres psql -U openlinear -d openlinear -c "SELECT 1"
  # Assert: Returns "1"
  
  # Stop database
  docker compose down
  # Assert: Exit code 0
  ```

  **Commit**: YES
  - Message: `chore: add docker-compose for PostgreSQL`
  - Files: docker-compose.yml, .env.example

---

- [x] 3. Setup Drizzle Schema + Migrations

  **What to do**:
  - Initialize `packages/db` with Drizzle ORM + drizzle-kit
  - Install `drizzle-orm`, `drizzle-kit`, `@types/pg`, `pg`
  - Create schema:
    - `tasks` table: id (UUID), title, description, priority (enum), column (enum), sessionId, createdAt, updatedAt
    - `labels` table: id (UUID), name, color, priority (for execution order)
    - `task_labels` junction table
    - `settings` table: id, parallelLimit
  - Create drizzle.config.ts
  - Add db:push and db:studio scripts
  - Export typed client

  **Must NOT do**:
  - Add complex indexes beyond primary keys
  - Add triggers or stored procedures
  - Add migration history tracking (use push for MVP)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-low`
  - **Skills**: []
    - No specific skill for Drizzle, but straightforward ORM setup

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential
  - **Blocks**: Tasks 6, 7, 8, 9, 10
  - **Blocked By**: Task 2

  **References**:
  - Drizzle ORM docs: https://orm.drizzle.team/docs/overview
  - Drizzle PostgreSQL: https://orm.drizzle.team/docs/get-started-postgresql

  **Acceptance Criteria**:
  ```bash
  # Install deps
  pnpm --filter db install
  # Assert: Exit code 0
  
  # Push schema
  pnpm --filter db db:push
  # Assert: Exit code 0
  
  # Verify tables created
  docker compose exec -T postgres psql -U openlinear -d openlinear -c "\dt"
  # Assert: Output contains "tasks", "labels", "task_labels", "settings"
  
  # Test import
  bun -e "import { db } from './packages/db/src'; console.log(typeof db)"
  # Assert: "object"
  ```

  **Commit**: YES
  - Message: `feat(db): add drizzle schema for tasks, labels, settings`
  - Files: packages/db/**

---

- [x] 4. Create Shared Types Package

  **What to do**:
  - Initialize `packages/types` with TypeScript
  - Define types matching Drizzle schema:
    - `Task`, `TaskCreate`, `TaskUpdate`
    - `Label`, `LabelCreate`, `LabelUpdate`
    - `Settings`
    - `TaskStatus` = 'todo' | 'in_progress' | 'done' | 'cancelled'
    - `Priority` = 'low' | 'medium' | 'high'
  - Define API response types
  - Define SSE event types
  - Export all types

  **Must NOT do**:
  - Add runtime validation (Zod in API only)
  - Add React-specific types here
  - Duplicate Drizzle types (infer from schema)

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 2, 3)
  - **Blocks**: Tasks 6, 7, 11
  - **Blocked By**: Task 1

  **References**:
  - Drizzle inferring types: https://orm.drizzle.team/docs/goodies#type-api

  **Acceptance Criteria**:
  ```bash
  # Verify exports compile
  cd packages/types && pnpm build
  # Assert: Exit code 0
  
  # Verify types exported
  bun -e "import { Task, Label, Settings, TaskStatus, Priority } from './packages/types'; console.log('types ok')"
  # Assert: "types ok"
  ```

  **Commit**: YES
  - Message: `feat(types): add shared type definitions`
  - Files: packages/types/**

---

### OpenCode Integration

- [x] 5. OpenCode SDK Validation Spike

  **What to do**:
  - Create standalone test script `scripts/opencode-spike.ts`
  - Install `@opencode-ai/sdk` in root (or packages/opencode)
  - Test: `createOpencode()` spawns server
  - Test: `client.session.create()` creates session
  - Test: `client.session.prompt()` sends message and gets response
  - Test: `client.event.subscribe()` receives events
  - Test: `client.session.abort()` cancels session
  - Document findings and any issues
  - Delete spike after validation (or keep as reference)

  **Must NOT do**:
  - Build full integration yet
  - Add error handling beyond basic try/catch
  - Integrate with database

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []
    - Requires investigation and experimentation

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 1)
  - **Blocks**: Task 9
  - **Blocked By**: None (can start immediately)

  **References**:
  - OpenCode SDK: https://www.npmjs.com/package/@opencode-ai/sdk
  - OpenCode docs: https://opencode.ai/docs

  **Acceptance Criteria**:
  ```bash
  # Run spike script
  bun scripts/opencode-spike.ts
  # Assert: Output contains "Server started"
  # Assert: Output contains "Session created"
  # Assert: Output contains "Event received"
  # Assert: Output contains "Session aborted"
  # Assert: Exit code 0
  ```

  **Commit**: YES
  - Message: `chore: validate opencode sdk integration`
  - Files: scripts/opencode-spike.ts, package.json (deps)

---

### Backend API

- [x] 6. Setup Express API Foundation + SSE

  **What to do**:
  - Initialize `apps/api` with Express + TypeScript
  - Install: `express`, `cors`, `zod`, `uuid`, `@types/*`
  - Create src/index.ts with Express app
  - Setup CORS middleware
  - Create health endpoint: `GET /health`
  - Create SSE infrastructure:
    - `GET /api/events` - SSE endpoint
    - Connection management with Map
    - Heartbeat (every 30s)
    - Cleanup on disconnect
    - `broadcast(event, data)` helper
  - Add to turbo dev pipeline

  **Must NOT do**:
  - Add authentication middleware
  - Add rate limiting
  - Add request logging beyond errors

  **Recommended Agent Profile**:
  - **Category**: `unspecified-low`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential (blocks API tasks)
  - **Blocks**: Tasks 7, 8, 9, 14
  - **Blocked By**: Tasks 3, 4

  **References**:
  - Express SSE pattern: Node.js EventSource documentation

  **Acceptance Criteria**:
  ```bash
  # Start API
  pnpm --filter api dev &
  sleep 3
  
  # Health check
  curl -s http://localhost:3001/health
  # Assert: {"status":"ok"}
  
  # SSE connection
  timeout 5 curl -N http://localhost:3001/api/events &
  # Assert: Receives heartbeat within 5s
  
  # Cleanup
  kill %1 %2
  ```

  **Commit**: YES
  - Message: `feat(api): express foundation with sse infrastructure`
  - Files: apps/api/**

---

- [x] 7. Task CRUD Endpoints

  **What to do**:
  - Create task routes:
    - `GET /api/tasks` - List all tasks
    - `POST /api/tasks` - Create task
    - `GET /api/tasks/:id` - Get task
    - `PATCH /api/tasks/:id` - Update task
    - `DELETE /api/tasks/:id` - Delete task
  - Add Zod validation for request bodies
  - Connect to Drizzle database
  - Broadcast SSE events on changes:
    - `task:created`, `task:updated`, `task:deleted`
  - Add tests with vitest

  **Must NOT do**:
  - Add pagination (list all for MVP)
  - Add filtering beyond column
  - Add sorting

  **Recommended Agent Profile**:
  - **Category**: `unspecified-low`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Task 8)
  - **Blocks**: Tasks 12, 13
  - **Blocked By**: Task 6

  **References**:
  - Drizzle CRUD: https://orm.drizzle.team/docs/select
  - Zod validation: https://zod.dev

  **Acceptance Criteria**:
  ```bash
  # Create task
  TASK_ID=$(curl -s -X POST http://localhost:3001/api/tasks \
    -H "Content-Type: application/json" \
    -d '{"title":"Test Task","description":"Test description here","priority":"medium"}' \
    | jq -r '.id')
  # Assert: TASK_ID is valid UUID
  
  # List tasks
  curl -s http://localhost:3001/api/tasks | jq 'length'
  # Assert: >= 1
  
  # Get task
  curl -s http://localhost:3001/api/tasks/$TASK_ID | jq '.title'
  # Assert: "Test Task"
  
  # Update task
  curl -s -X PATCH http://localhost:3001/api/tasks/$TASK_ID \
    -H "Content-Type: application/json" \
    -d '{"priority":"high"}' | jq '.priority'
  # Assert: "high"
  
  # Delete task
  curl -s -X DELETE http://localhost:3001/api/tasks/$TASK_ID
  # Assert: HTTP 204
  
  # Run tests
  pnpm --filter api test
  # Assert: All tests pass
  ```

  **Commit**: YES
  - Message: `feat(api): task crud endpoints with sse`
  - Files: apps/api/src/routes/tasks.ts, apps/api/src/**/*.test.ts

---

- [x] 8. Label CRUD Endpoints

  **What to do**:
  - Create label routes:
    - `GET /api/labels` - List all labels
    - `POST /api/labels` - Create label (name, color, priority)
    - `PATCH /api/labels/:id` - Update label
    - `DELETE /api/labels/:id` - Delete label
  - Create task-label assignment routes:
    - `POST /api/tasks/:id/labels` - Assign label
    - `DELETE /api/tasks/:id/labels/:labelId` - Remove label
  - Add Zod validation (color as hex pattern)
  - Broadcast SSE events on changes
  - Add tests

  **Must NOT do**:
  - Cascade delete tasks when label deleted
  - Add label icons/emoji
  - Add label groups

  **Recommended Agent Profile**:
  - **Category**: `unspecified-low`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Task 7)
  - **Blocks**: Task 13
  - **Blocked By**: Task 6

  **References**:
  - Drizzle many-to-many: https://orm.drizzle.team/docs/rqb#many-to-many

  **Acceptance Criteria**:
  ```bash
  # Create label
  LABEL_ID=$(curl -s -X POST http://localhost:3001/api/labels \
    -H "Content-Type: application/json" \
    -d '{"name":"bug","color":"#ef4444","priority":1}' \
    | jq -r '.id')
  # Assert: LABEL_ID is valid UUID
  
  # List labels
  curl -s http://localhost:3001/api/labels | jq 'length'
  # Assert: >= 1
  
  # Assign to task
  curl -s -X POST http://localhost:3001/api/tasks/$TASK_ID/labels \
    -H "Content-Type: application/json" \
    -d "{\"labelId\":\"$LABEL_ID\"}"
  # Assert: HTTP 200
  
  # Verify assignment
  curl -s http://localhost:3001/api/tasks/$TASK_ID | jq '.labels | length'
  # Assert: >= 1
  
  # Run tests
  pnpm --filter api test
  # Assert: All tests pass
  ```

  **Commit**: YES
  - Message: `feat(api): label crud and task-label assignment`
  - Files: apps/api/src/routes/labels.ts, apps/api/src/**/*.test.ts

---

- [x] 9. OpenCode Integration in API

  **What to do**:
  - Create `src/services/opencode.ts` service
  - Initialize OpenCode server on API startup via `createOpencode()`
  - Track active sessions: `Map<taskId, sessionId>`
  - Create execution routes:
    - `POST /api/tasks/:id/execute` - Start task execution
    - `POST /api/tasks/:id/cancel` - Cancel running task
  - Execute flow:
    1. Check parallel limit (return 429 if exceeded)
    2. Create OpenCode session with task description
    3. Update task column to 'in_progress'
    4. Store sessionId in task
    5. Broadcast SSE event
  - Cancel flow:
    1. Call `session.abort()`
    2. Update task column to 'cancelled'
    3. Clear sessionId
    4. Broadcast SSE event
  - Subscribe to OpenCode events:
    - `session.idle` → move task to 'done'
    - `session.error` → move task to 'cancelled' with error message
  - Add 30 min timeout
  - Add tests with mocked OpenCode client

  **Must NOT do**:
  - Queue tasks when limit reached (reject immediately)
  - Store full conversation history
  - Parse agent output

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []
    - Core integration requiring careful implementation

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Task 10)
  - **Blocks**: Task 12
  - **Blocked By**: Tasks 5, 6

  **References**:
  - OpenCode SDK API: @opencode-ai/sdk documentation
  - Task 5 spike script findings

  **Acceptance Criteria**:
  ```bash
  # Execute task
  RESULT=$(curl -s -X POST http://localhost:3001/api/tasks/$TASK_ID/execute)
  echo $RESULT | jq '.status'
  # Assert: "running"
  echo $RESULT | jq '.sessionId'
  # Assert: Not null
  
  # Verify task status
  curl -s http://localhost:3001/api/tasks/$TASK_ID | jq '.column'
  # Assert: "in_progress"
  
  # Test parallel limit (with limit set to 1)
  curl -s -X POST http://localhost:3001/api/tasks/$TASK_ID2/execute
  # Assert: HTTP 429, body contains "parallel_limit_reached"
  
  # Cancel task
  curl -s -X POST http://localhost:3001/api/tasks/$TASK_ID/cancel
  # Assert: HTTP 200
  
  # Verify cancelled
  curl -s http://localhost:3001/api/tasks/$TASK_ID | jq '.column'
  # Assert: "cancelled"
  
  # Run tests
  pnpm --filter api test
  # Assert: All tests pass
  ```

  **Commit**: YES
  - Message: `feat(api): opencode integration for task execution`
  - Files: apps/api/src/services/opencode.ts, apps/api/src/routes/tasks.ts

---

- [x] 10. Settings Endpoints

  **What to do**:
  - Create settings routes:
    - `GET /api/settings` - Get current settings
    - `PATCH /api/settings` - Update settings
  - Settings model (single row, created on first access):
    - `parallelLimit`: 1-5, default 3
  - Add Zod validation
  - Broadcast SSE on settings change
  - Add tests

  **Must NOT do**:
  - Add user-specific settings
  - Add workspace settings
  - Add API key management

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Task 9)
  - **Blocks**: Task 15
  - **Blocked By**: Task 6

  **References**:
  - Task 3 schema for settings table

  **Acceptance Criteria**:
  ```bash
  # Get settings
  curl -s http://localhost:3001/api/settings | jq '.parallelLimit'
  # Assert: 3 (default)
  
  # Update settings
  curl -s -X PATCH http://localhost:3001/api/settings \
    -H "Content-Type: application/json" \
    -d '{"parallelLimit":5}' | jq '.parallelLimit'
  # Assert: 5
  
  # Validate range
  curl -s -X PATCH http://localhost:3001/api/settings \
    -H "Content-Type: application/json" \
    -d '{"parallelLimit":10}'
  # Assert: HTTP 400, validation error
  
  # Run tests
  pnpm --filter api test
  # Assert: All tests pass
  ```

  **Commit**: YES
  - Message: `feat(api): settings endpoints with validation`
  - Files: apps/api/src/routes/settings.ts

---

### Frontend

- [x] 11. Next.js + shadcn Setup

  **What to do**:
  - Initialize `apps/web` with Next.js 14+ (App Router)
  - Install and configure shadcn/ui with dark theme
  - Setup Tailwind CSS with Linear-inspired dark colors
  - Create app layout with:
    - Dark background matching Linear (#1a1a1a or similar)
    - Sidebar placeholder (left)
    - Main content area
  - Add API client helper using fetch
  - Configure environment variables for API URL
  - Add turbo pipeline integration

  **Must NOT do**:
  - Add full sidebar navigation yet
  - Add auth pages
  - Add multiple themes

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
  - **Skills**: [`shadcn-ui`, `frontend-ui-ux`]
    - `shadcn-ui`: Component library setup
    - `frontend-ui-ux`: Dark theme design

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 5 (can run while Tasks 6-10 complete)
  - **Blocks**: Tasks 12, 13, 14, 15
  - **Blocked By**: Task 1

  **References**:
  - shadcn/ui: https://ui.shadcn.com/docs/installation/next
  - Linear design: Reference screenshots provided

  **Acceptance Criteria**:
  ```
  # Agent executes via playwright browser automation:
  1. Navigate to: http://localhost:3000
  2. Assert: Page loads without errors
  3. Assert: Background color is dark (#1a1a1a or similar)
  4. Assert: No layout shift or hydration errors
  5. Screenshot: .sisyphus/evidence/task-11-shell.png
  ```

  **Commit**: YES
  - Message: `feat(web): nextjs shell with shadcn dark theme`
  - Files: apps/web/**

---

- [x] 12. Kanban Board UI

  **What to do**:
  - Create Kanban board component at `/` route
  - 4 fixed columns: Todo, In Progress, Done, Cancelled
  - Column styling:
    - Column header with count badge
    - Scrollable task list
    - Column background slightly different shade
  - Task card component:
    - Title (bold)
    - Priority indicator (color dot or badge)
    - Labels as colored chips
    - Status indicator for running tasks
  - Fetch tasks from API on load
  - Display tasks in appropriate columns
  - Add "Create Task" button (opens modal - Task 13)
  - Add "Execute" button on todo tasks
  - Add "Cancel" button on in_progress tasks

  **Must NOT do**:
  - Drag-and-drop reordering
  - Column customization
  - Virtual scrolling (simple list OK for MVP)

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
  - **Skills**: [`shadcn-ui`, `frontend-ui-ux`]
    - `shadcn-ui`: Card, Badge, Button components
    - `frontend-ui-ux`: Linear-inspired design

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 5 (with Task 13)
  - **Blocks**: Task 14
  - **Blocked By**: Tasks 7, 9, 11

  **References**:
  - Linear UI: Reference screenshots provided
  - shadcn Card: https://ui.shadcn.com/docs/components/card

  **Acceptance Criteria**:
  ```
  # Agent executes via playwright browser automation:
  1. Navigate to: http://localhost:3000
  2. Assert: 4 columns visible with headers "Todo", "In Progress", "Done", "Cancelled"
  3. Assert: Each column shows task count badge
  4. Assert: Tasks display with title, priority indicator, labels
  5. Assert: "Create Task" button visible
  6. Assert: Todo tasks have "Execute" button
  7. Assert: In Progress tasks have "Cancel" button
  8. Screenshot: .sisyphus/evidence/task-12-board.png
  ```

  **Commit**: YES
  - Message: `feat(web): kanban board with columns and task cards`
  - Files: apps/web/app/page.tsx, apps/web/components/board/**

---

- [x] 13. Task Form Modal + Label Management

  **What to do**:
  - Create task form modal using shadcn Dialog:
    - Title input (required)
    - Description textarea (required, min 10 chars)
    - Priority select (low, medium, high)
    - Label multi-select with color display
  - Create/edit mode (same form)
  - Form validation with react-hook-form + zod
  - Label management inline:
    - Add new label button
    - Color picker for label
    - Delete label option
  - Submit creates/updates via API
  - Close modal on success

  **Must NOT do**:
  - Rich text editor for description
  - File attachments
  - Due dates

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
  - **Skills**: [`shadcn-ui`, `frontend-ui-ux`]
    - `shadcn-ui`: Dialog, Form, Input, Select components
    - `frontend-ui-ux`: Form UX

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 6 (with Task 14)
  - **Blocks**: Task 14
  - **Blocked By**: Tasks 7, 8, 11

  **References**:
  - shadcn Dialog: https://ui.shadcn.com/docs/components/dialog
  - shadcn Form: https://ui.shadcn.com/docs/components/form

  **Acceptance Criteria**:
  ```
  # Agent executes via playwright browser automation:
  1. Navigate to: http://localhost:3000
  2. Click: "Create Task" button
  3. Assert: Modal opens with form
  4. Fill: Title = "Test Task from UI"
  5. Fill: Description = "This is a test task created from the UI"
  6. Select: Priority = "high"
  7. Click: Submit button
  8. Assert: Modal closes
  9. Assert: Task appears in Todo column
  10. Screenshot: .sisyphus/evidence/task-13-form.png
  ```

  **Commit**: YES
  - Message: `feat(web): task form modal with label management`
  - Files: apps/web/components/task-form.tsx, apps/web/components/label-picker.tsx

---

- [x] 14. SSE Client Integration

  **What to do**:
  - Create SSE client hook: `useSSE()`
  - Connect to `/api/events` on mount
  - Handle reconnection on disconnect
  - Parse events and update React Query cache:
    - `task:created` → add to list
    - `task:updated` → update in list
    - `task:deleted` → remove from list
    - `label:*` → update labels
    - `settings:updated` → update settings
  - Show toast on task execution complete/failed
  - Show running indicator on in_progress tasks

  **Must NOT do**:
  - WebSocket fallback
  - Store events in history
  - Replay missed events

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: Real-time UX patterns

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 6 (with Task 13)
  - **Blocks**: Task 16
  - **Blocked By**: Tasks 6, 12, 13

  **References**:
  - EventSource API: https://developer.mozilla.org/en-US/docs/Web/API/EventSource
  - React Query cache updates

  **Acceptance Criteria**:
  ```
  # Agent executes via playwright browser automation:
  1. Navigate to: http://localhost:3000
  2. Create task via curl in background
  3. Assert: Task appears in UI without refresh (SSE update)
  4. Execute task via curl
  5. Assert: Task moves to "In Progress" column without refresh
  6. Assert: Running indicator visible on task
  7. Screenshot: .sisyphus/evidence/task-14-sse.png
  ```

  **Commit**: YES
  - Message: `feat(web): sse client integration for real-time updates`
  - Files: apps/web/hooks/use-sse.ts, apps/web/lib/query.ts

---

- [x] 15. Settings Page

  **What to do**:
  - Create `/settings` page
  - Add sidebar navigation link
  - Settings form:
    - Parallel execution limit (1-5 slider or number input)
    - Save button
  - Fetch current settings on load
  - Update via API on save
  - Show success toast on save

  **Must NOT do**:
  - Theme settings
  - User profile
  - API keys

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: [`shadcn-ui`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 7 (with Task 16)
  - **Blocks**: Task 16
  - **Blocked By**: Tasks 10, 11

  **References**:
  - shadcn Slider: https://ui.shadcn.com/docs/components/slider
  - shadcn Toast: https://ui.shadcn.com/docs/components/toast

  **Acceptance Criteria**:
  ```
  # Agent executes via playwright browser automation:
  1. Navigate to: http://localhost:3000/settings
  2. Assert: Settings page loads
  3. Assert: Parallel limit slider/input visible
  4. Change limit to 5
  5. Click: Save button
  6. Assert: Success toast appears
  7. Refresh page
  8. Assert: Limit still shows 5
  9. Screenshot: .sisyphus/evidence/task-15-settings.png
  ```

  **Commit**: YES
  - Message: `feat(web): settings page with parallel limit config`
  - Files: apps/web/app/settings/page.tsx

---

### Polish & Testing

- [x] 16. Polish + Final Testing

  **What to do**:
  - Add README.md with:
    - Project overview
    - Setup instructions
    - Available scripts
    - Architecture diagram (text-based)
  - Verify all tests pass: `pnpm test`
  - Verify build succeeds: `pnpm build`
  - Fix any TypeScript errors
  - Ensure consistent styling
  - Add loading states where missing
  - Add error boundaries
  - Test full flow:
    1. Create task
    2. Add labels
    3. Execute task
    4. Verify SSE updates
    5. Cancel task
    6. Change settings

  **Must NOT do**:
  - Performance optimization
  - SEO optimization
  - Analytics

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: [`frontend-ui-ux`]

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Final (sequential)
  - **Blocks**: None (final task)
  - **Blocked By**: Tasks 14, 15

  **References**:
  - All previous task outputs

  **Acceptance Criteria**:
  ```bash
  # Build succeeds
  pnpm build
  # Assert: Exit code 0
  
  # Tests pass
  pnpm test
  # Assert: Exit code 0
  
  # TypeScript clean
  pnpm typecheck
  # Assert: Exit code 0
  
  # Full flow via playwright
  # (Execute complete user journey - see test script)
  ```

  ```
  # Agent executes full flow via playwright:
  1. Start fresh: docker compose up -d && pnpm dev
  2. Navigate to: http://localhost:3000
  3. Create task: "Fix login button"
  4. Add label: "fe" with blue color
  5. Assign label to task
  6. Execute task
  7. Assert: Task moves to In Progress
  8. Assert: Running indicator visible
  9. Cancel task
  10. Assert: Task moves to Cancelled
  11. Navigate to settings
  12. Change parallel limit
  13. Assert: Setting persists
  14. Screenshot: .sisyphus/evidence/task-16-final.png
  ```

  **Commit**: YES
  - Message: `docs: add readme and final polish`
  - Files: README.md, various fixes

---

## Commit Strategy

| After Task | Message | Files | Verification |
|------------|---------|-------|--------------|
| 1 | `chore: initialize turborepo monorepo with pnpm` | turbo.json, pnpm-workspace.yaml, packages/* | pnpm install |
| 2 | `chore: add docker-compose for PostgreSQL` | docker-compose.yml, .env.example | docker compose up |
| 3 | `feat(db): add drizzle schema for tasks, labels, settings` | packages/db/** | pnpm db:push |
| 4 | `feat(types): add shared type definitions` | packages/types/** | pnpm build |
| 5 | `chore: validate opencode sdk integration` | scripts/* | bun scripts/opencode-spike.ts |
| 6 | `feat(api): express foundation with sse infrastructure` | apps/api/** | curl /health |
| 7 | `feat(api): task crud endpoints with sse` | apps/api/src/routes/tasks.ts | curl /api/tasks |
| 8 | `feat(api): label crud and task-label assignment` | apps/api/src/routes/labels.ts | curl /api/labels |
| 9 | `feat(api): opencode integration for task execution` | apps/api/src/services/opencode.ts | curl /api/tasks/:id/execute |
| 10 | `feat(api): settings endpoints with validation` | apps/api/src/routes/settings.ts | curl /api/settings |
| 11 | `feat(web): nextjs shell with shadcn dark theme` | apps/web/** | localhost:3000 |
| 12 | `feat(web): kanban board with columns and task cards` | apps/web/components/board/** | UI visible |
| 13 | `feat(web): task form modal with label management` | apps/web/components/task-form.tsx | Create task via UI |
| 14 | `feat(web): sse client integration for real-time updates` | apps/web/hooks/use-sse.ts | Live updates work |
| 15 | `feat(web): settings page with parallel limit config` | apps/web/app/settings/page.tsx | Settings save |
| 16 | `docs: add readme and final polish` | README.md | pnpm test passes |

---

## Success Criteria

### Verification Commands
```bash
# 1. Fresh clone setup
git clone <repo> && cd openlinear
pnpm install          # Exit code 0
docker compose up -d  # Starts PostgreSQL
pnpm db:push         # Creates tables

# 2. Start development
pnpm dev             # Starts API (3001) and Web (3000)

# 3. Verify API
curl http://localhost:3001/health
# Output: {"status":"ok"}

# 4. Verify UI
# Open http://localhost:3000 - see 4-column kanban board

# 5. Full flow test
pnpm test
# All tests pass
```

### Final Checklist
- [x] All "Must Have" present:
  - [x] Kanban board with 4 columns
  - [x] Task CRUD
  - [x] Custom labels with colors
  - [x] Priority by label type
  - [x] Execute/cancel tasks
  - [x] Parallel limit enforced
  - [x] SSE real-time updates (verified - events broadcast correctly)
  - [x] Dark theme
  - [x] PostgreSQL + Prisma (deviation from plan's Drizzle)
  - [x] Tests with vitest (11 tests passing)
- [x] All "Must NOT Have" absent:
  - [x] No authentication
  - [x] No teams
  - [x] No drag-drop
  - [x] No multiple workspaces
  - [x] No light theme
- [x] All tests pass (11 tests)
- [x] pnpm build succeeds
- [x] README with setup instructions
