# OpenLinear — Codebase Index

> Auto-generated 2026-05-27. Maps every layer of the monorepo: API, Sidecar, Frontend, Desktop, MCP, Database, Shared packages, and CI/CD.
>
> **Partially corrected 2026-10-26.** Re-verified against the code and fixed: the
> MCP section (§5, 19 tools), counts in the overview and §1, monorepo layout,
> the sidecar's architecture (§2, W03a), the desktop rows (§4), CI/CD (§9) and
> production status (§11). Everything else is the 2026-05-27 snapshot and may
> be stale; line counts and file maps in §2–§3 were not re-checked. For the
> current state read `AGENTS.md`, `ISSUES.md`, `tasks/prd-backend-agent-platform.md`
> and the ledgers in `docs/reports/revamp-2026-10-26/`.

### Plans: which one is current

| Plan | Status |
|---|---|
| **Desktop revamp plan** (`~/Desktop/Open Linear Revamp Plan/`, off-repo, 2026-09-04; older notes cite `~/Downloads/…`) | **Historical research — do not implement from its phase rows.** Its versions, counts and `file:line` references are stale (see `docs/reports/revamp-plan-status-2026-10-25.md` §6). Backend scope is superseded by the PRD below; Phase 5 by the FE-01…FE-16 frontend backlog; Phase 6 by the cloud-services decision record. |
| `tasks/prd-backend-agent-platform.md` (W00–W21) | **Current backend roadmap.** |
| `docs/plans/backend-product-contracts.md` | Contracts for W02–W21. |
| `docs/reports/revamp-2026-10-26/` | **What was actually built** in the 2026-10-26 revamp rounds: one ledger per slice (evidence, decisions, leftovers). |
| `docs/reports/revamp-plan-status-2026-10-25.md` | Audit of the revamp plan against the code; required plan updates. |
| `docs/PERFORMANCE_IMPROVEMENT_PLAN.md` | P95 plan; Phase 0 baselines in `docs/reports/perf-baseline-2026-10-26/`. |

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│  Cloud API (api.openlinear.tech)                            │
│  Express 5.2.1 · Neon PostgreSQL · 31 route files           │
│  Auth: GitHub OAuth+JWT / PAT (`ol_pat_<32-hex>`)          │
│  Home Chat: 34 tools, SSE streaming, 16-round tool loop     │
│  SSE: Real-time events broadcast on every write             │
├──────────────────────────────────────────────────────────────┤
│  Web UI (openlinear.tech)                                   │
│  Next.js 16 · React 19 · Tailwind CSS · shadcn/ui           │
│  Kanban board, ChatPanel, OnboardingWizard, Settings        │
│  API client: JWT + sidecar fallback, SSE connections        │
├──────────────────────────────────────────────────────────────┤
│  Local Sidecar (apps/sidecar, port 3003)                    │
│  Express 5.2.1 · OpenCode SDK · git worktrees               │
│  No DATABASE_URL: persists through the cloud API (W03a)     │
│  Single-task + batch execution (parallel/queue/combined)    │
│  Seatbelt/bubblewrap sandbox, git hardening (W09a)          │
├──────────────────────────────────────────────────────────────┤
│  Desktop Shell (apps/desktop)                                │
│  Tauri v2 (Rust) wrapping desktop-ui webview                │
│  Sidecar auto-spawn, deep-link OAuth, window controls       │
├──────────────────────────────────────────────────────────────┤
│  MCP Server (mcp.openlinear.tech)                           │
│  Cloudflare Worker · Stateless · 19 tools                   │
│  `bulk_create_plan`: project + phases + tasks in 1 call     │
└──────────────────────────────────────────────────────────────┘
```

### Monorepo Layout

```
openlinear/
├── apps/
│   ├── api/                     ← Express 5.2.1 REST API, port 3001
│   ├── desktop-ui/              ← Next.js 16 web/desktop UI, port 3000
│   ├── desktop/                 ← Tauri v2 (Rust shell wrapping desktop-ui)
│   ├── sidecar/                 ← Express 5.2.1 AI execution engine, port 3003
│   ├── mcp/                     ← Cloudflare Worker MCP server
│   ├── mcp-docs/                ← Next.js documentation site for MCP tools
│   ├── landing/                 ← Next.js 16 marketing site, port 3002
│   └── intro-video/             ← Intro video generation app
├── packages/
│   ├── db/                      ← Prisma 7.4.0 + Postgres schema
│   ├── execution-core/          ← Shared execution logic (batch, state, runner contracts)
│   ├── api-client/              ← Typed HTTP client for apps/api (used by the sidecar)
│   ├── api-core/                ← API helpers: error envelope, pagination, ETag, scopes, cache, logger
│   ├── telemetry/               ← In-memory counters/histograms behind api-core telemetry hooks
│   └── openlinear-cli/          ← npm CLI that installs the Linux AppImage
│                                  (packages/types was deleted 2026-05-25)
├── scripts/                     ← dev/build/release scripts (scripts/ci, scripts/release, scripts/perf)
├── .github/workflows/           ← dev.yml (PR + push CI), deploy-azure.yml, release.yml,
│                                  sandbox.yml, deploy.yml (legacy VPS)
├── docs/                        ← Architecture, ADRs, project context
└── ISSUES.md                    ← Agent work log
```

### By the Numbers

| Layer | Files | Key Modules |
|-------|-------|-------------|
| **API** | 31 route files, 155 routes in `registry.ts` (2026-10-26), 55 test files | Tasks, Chat tools (34), SSE + outbox, PATs, `/api/executions` |
| **Sidecar** | 5 routers (`/api/tasks` execution, `/api/opencode`, `/api/batches`, `/api/transcribe`, `/api/events`) | Lifecycle, batch orchestrator, worktrees, sandbox, runners (not re-counted) |
| **Frontend** | 15 pages, 27 component dirs, 8+ hooks (2026-05 count) | KanbanBoard, ChatPanel, CommandPalette, AppShell |
| **Desktop** | 5 Rust source files | Sidecar manager, deeplink handler, OpenCode check, lib.rs |
| **MCP** | 7 tool modules, 19 tools | plan.ts (`bulk_create_plan`), issues.ts, stateless Worker |
| **Database** | 25+ models, 13 enums, 10+ migrations | Task (team-scoped numbering), PATs, Chat persistence |
| **Shared** | execution-core (batch types), db (Prisma client) | BatchMode, BatchState, BatchTask |

### Tech Stack

| Layer | Tech |
|-------|------|
| API | Express 5.2.1, TypeScript, Zod validation, Vitest |
| Database | PostgreSQL via Prisma 7.4.0 (Neon in prod) |
| Web UI | Next.js 16, React 19, Tailwind CSS, shadcn/ui, Framer Motion |
| Desktop | Tauri v2 (Rust), webview pointing at desktop-ui |
| MCP Server | Cloudflare Worker + `@modelcontextprotocol/server` 2.4.0 (web-standard handler, no Express) |
| Package manager | pnpm 9 (workspaces) |
| Build | Turborepo |

---

## 1. API Layer (`apps/api/src/`)

### Entry Points

| File | Description |
|------|-------------|
| `apps/api/src/index.ts` | Entry point: dotenv, startup env validation, server creation, graceful shutdown (SIGTERM/SIGINT) |
| `apps/api/src/app.ts` | Express app factory (372 lines). Helmet (CSP disabled for Tauri), Pino HTTP logging with request IDs, CORS with loopback aliases (localhost↔127.0.0.1, tauri://localhost), 4 rate limiters, mounts 28 route files, `/health` endpoint. Shared `buildErrorHandler()` produces structured JSON errors |

### Middleware

| File | Purpose |
|------|---------|
| `middleware/auth.ts` | Dual auth: GitHub OAuth + JWT (humans, 7-day) + PAT detection (`ol_pat_` prefix → SHA-256 hash lookup → scope check). `requireAuth()` overloaded (no args or scoped `['tasks:write']`). `optionalAuth` for optional routes |
| `middleware/validate.ts` | Zod-based body/query validation (`validateBody`, `validateQuery`) |
| `middleware/permissions.ts` | CASL ability builder from workspace/team/project memberships (`defineAbilityFor`, `requirePermission`) |

### Route Map (28 of the 31 route files; also `executions.ts` → `/api/executions` (sidecar attempt/capability API, W03a), `models.ts` → `/api/models`, `uploads.ts` → `/uploads`)

| File | Mount | Purpose |
|------|-------|---------|
| `routes/auth.ts` | `/api/auth` | GitHub OAuth, `/me`, `/logout`, desktop callback HTML bridge |
| `routes/totp.ts` | `/api/auth/2fa` | TOTP two-factor authentication |
| `routes/tasks.ts` | `/api/tasks` | Task CRUD + `POST /bulk` (max 100) + archived cleanup |
| `routes/projects.ts` | `/api/projects` | Project CRUD + access control + repo linking |
| `routes/teams.ts` | `/api/teams` | Team CRUD + member management + invite codes |
| `routes/workspaces.ts` | `/api/workspaces` | Workspace CRUD + member bulk ops + structure |
| `routes/chat.ts` | `/api/chat` | Chat sessions CRUD + SSE message streaming |
| `routes/chat-attachments.ts` | `/api/chat/attachments` | File attachments for chat |
| `routes/events.ts` | `/api/events` | SSE real-time event stream (`?token=<jwt>`) |
| `routes/notifications.ts` | `/api/notifications` | Inbox notifications + preferences |
| `routes/inbox.ts` | `/api/inbox` | Done/cancelled task feed |
| `routes/pats.ts` | `/api/pats` | Personal Access Token create/list/revoke |
| `routes/search.ts` | `/api/search` | Full-text search across tasks/projects/teams |
| `routes/comments.ts` | `/api` | Comments (mounted at root, task-scoped) |
| `routes/labels.ts` | `/api/labels` | Label CRUD |
| `routes/repos.ts` | `/api/repos` | GitHub repository linking |
| `routes/users.ts` | `/api/users` | User management |
| `routes/invitations.ts` | `/api/invitations` | Workspace/team invitations |
| `routes/members.ts` | `/api/members` | Member management |
| `routes/settings.ts` | `/api/settings` | User settings |
| `routes/dashboard.ts` | `/api/dashboard` | Dashboard analytics |
| `routes/usage.ts` | `/api/usage` | Usage metrics |
| `routes/mcp-usage.ts` | `/api/mcp` | MCP usage tracking |
| `routes/activity-log.ts` | `/api/activity` | Activity log |
| `routes/agent-runs.ts` | `/api/agent-runs` | AI agent execution history (paginated, task/user filter) |
| `routes/sessions.ts` | `/api/sessions` | Session management |
| `routes/sso.ts` | `/api` | SSO (mounted at root) |
| `routes/audit.ts` | `/api/workspaces` | Audit logging |

### Key Services

| File | Lines | Description |
|------|-------|-------------|
| `services/tasks.ts` | 1241 | Core task CRUD. Team-scoped auto-incrementing issue numbers via `prisma.$transaction`. `bulkCreateTasks()` (max 100, dry-run, gapless IDs). `bulkUpdateTaskStatus()`, `bulkArchiveTasks()`. Every write broadcasts SSE + logs activity |
| `services/chat.ts` | — | Home Chat LLM orchestrator. SSE streaming, tool-call rounds (max 16). `runChatTurn()`, `maybeAutoTitle()` |
| `services/chat-tools/domain.ts` | 571 | 34 tool definitions (13 read, 21 write) mapping to service functions |
| `services/chat-tools/index.ts` | 161 | Tool dispatch, OpenAI function spec generation, idempotency (`sessionId_toolCallId`) |
| `services/ownership.ts` | — | `OwnershipError`, `assertTaskAccess`, `assertProjectAccess`, `assertTeamRole` |
| `services/pats.ts` | — | `generatePersonalAccessToken()`, `validatePersonalAccessToken()`, `hashPersonalAccessToken()` |
| `services/workspaces.ts` | — | Workspace CRUD, default workspace auto-creation, project key generation |
| `services/projects.ts` | — | Project CRUD with repo linking, access grants, label auto-creation |
| `sse.ts` | — | SSE client registry and scoped broadcast: `broadcastToUser`, `broadcastToTeam`, `broadcastToProject`, `broadcastToWorkspace` |
| `errors.ts` | — | `ValidationError`, `HttpError`, `OwnershipError` typed classes |
| `lib/http.ts` | — | Error envelope builder, pagination parser, in-memory idempotency cache |

### Home Chat Tools (34 Total)

**Read (13):** `list_workspaces` · `get_workspace` · `list_workspace_members` · `list_projects` · `get_project` · `list_project_access` · `list_teams` · `get_team` · `list_team_members` · `list_issues` · `get_issue` · `list_comments` · `list_labels` · `search`

**Write (21):** `create_issue` · `update_issue` · `move_issue` · `bulk_update_issues` · `archive_issues` · `comment_on_issue` · `bulk_create_issues` · `setup_project_plan` · `create_label` · `update_label` · `create_project` · `update_project` · `grant_project_access` · `create_team` · `update_team` · `invite_workspace_member` · `invite_team_member` · `change_workspace_member_role` · `change_team_member_role` · `update_workspace`

### Auth System

| Method | Header | Token Format | Storage | Usage |
|--------|--------|-------------|---------|-------|
| GitHub OAuth + JWT | `Authorization: Bearer <jwt>` | JWT, 7-day | `Session` table (hash, revocation check) | Human users |
| PAT | `Authorization: Bearer ol_pat_<32-hex>` | `ol_pat_<32-lowercase-hex>` | SHA-256 in `personal_access_tokens` | MCP, CLI, API clients, scoped |

### Error Handling

Global handler in `app.ts` maps errors to structured JSON:

| Error Origin | Status | Code |
|-------------|--------|------|
| `OwnershipError` | 403/404 | `OWNERSHIP_REQUIRED` |
| `ValidationError` | 400 | Zod flatten details |
| `HttpError` | varies | Custom code |
| Prisma P2002 | 409 | Unique constraint |
| Prisma P2025 | 404 | Record not found |
| Prisma P2003 | 409 | Foreign key constraint |
| Fallback | 500 | `INTERNAL_ERROR` |

Envelope format: `{ error, code, message, details, requestId }`

### Rate Limiters

| Limiter | Rate | Scope |
|---------|------|-------|
| Default | 100 req/min | Global |
| Auth | 60 req/min | Auth routes |
| GitHub OAuth | 120 req/min | OAuth callback |
| Repos URL | 10 req/min | Repository URL fetching |
| Chat messages | 60/min (configurable) | Per user |

### Tests (`apps/api/src/__tests__/`)

55 test files as of 2026-10-26 (16 when this index was generated; the table below lists the original set) using **Vitest + supertest**. Each calls `createApp()` for a fresh Express instance, seeds data via Prisma in `beforeAll`, cleans up in `afterAll`.

| File | Coverage |
|------|----------|
| `tasks.test.ts` | CRUD, bulk creation, cross-tenant isolation, PAT scope validation, execution state reset |
| `auth.test.ts` | CORS loopback, GitHub OAuth redirects, desktop callback HTML, `/me` auth |
| `workspaces.test.ts`, `workspaces.members.test.ts` | Workspace CRUD + member management |
| `teams.test.ts`, `teams.members.test.ts` | Team CRUD + member roles |
| `projects.test.ts` | Project lifecycle |
| `repos.test.ts` | Repository linking |
| `pats.test.ts` | PAT creation and validation |
| `chat.sessions.test.ts`, `chat.messages.test.ts`, `chat.streaming.test.ts`, `chat.tools.test.ts`, `chat.orchestrator.test.ts`, `chat.permissions.test.ts` | Chat subsystem |
| `crypto.test.ts`, `env.test.ts`, `health.test.ts` | Utilities |

---

## 2. Sidecar Execution Engine (`apps/sidecar/src/`)

### Architecture

The sidecar is an Express 5.2.1 server on the user's machine (port 3003 via `API_PORT`). **Since W03a (2026-10-26) it no longer imports `@openlinear/api` and holds no `DATABASE_URL`, JWT secret or token-encryption key.** It authenticates callers and persists through the cloud API over HTTP (`OPENLINEAR_API_URL`, `packages/api-client`, `/api/executions` attempt + run-scoped capability API), keeps a local run journal in `node:sqlite`, and serves its own local SSE stream. The file map, flow and safeguards below are the 2026-05 snapshot and were not re-verified (for example `services/batch/event-handler.ts` no longer exists, and execution now also goes through `runners/` and `sandbox/`). Data lives in `apps/sidecar/src/config/app-data.ts`'s directory: `~/Library/Application Support/OpenLinear` (macOS), `$XDG_DATA_HOME/openlinear` (Linux), `%LOCALAPPDATA%\OpenLinear` (Windows), or `OPENLINEAR_APP_DATA`.

### File Map

| File | Lines | Description |
|------|-------|-------------|
| **Entry Points** | | |
| `src/index.ts` | — | Loads env, creates app, recovers orphaned executions, starts OpenCode (single-tenant guard) |
| `src/app.ts` | 39 | Mounts 4 routers, re-mounts error handler |
| **Routes** | | |
| `routes/execution.ts` | 222 | `POST /:id/execute`, `POST /:id/refresh-pr`, `GET /:id/running`, `GET /:id/logs`, `POST /:id/cancel` |
| `routes/batches.ts` | — | `POST /`, `GET /`, `GET /:id`, `POST /:id/cancel`, `POST /:id/approve` |
| `routes/opencode.ts` | — | OpenCode provider status, setup, auth, model listing |
| `routes/transcribe.ts` | — | ElevenLabs Scribe STT |
| **Execution Services (17 files — no automated test coverage; see ISSUES.md)** | | |
| `services/execution/lifecycle.ts` | 376 | `executeTask()`: gather inputs → setup repo → create session → send prompt → subscribe events → handle completion |
| `services/execution/state.ts` | — | `ExecutionStateStore` singleton, session→task mapping, progress broadcast, log management |
| `services/execution/events.ts` | — | OpenCode SSE subscription, idle timeout, background task detection |
| `services/execution/event-stream-processor.ts` | — | Pure function: `processEvent()` → typed Action[] for testability |
| `services/execution/git.ts` | — | Clone, branch, commit, push, PR creation via GitHub API |
| `services/execution/agent-run.ts` | — | `createAgentRun()`, `finalizeAgentRun()` → Prisma + activity log |
| `services/execution/recovery.ts` | — | Boot recovery: marks orphaned tasks (>1h) as cancelled |
| `services/execution/exec.ts` | — | `execFileAsync` (no shell injection), 50MB maxBuffer |
| `services/execution/delta-buffer.ts` | — | Debounces token deltas (800ms) into whole sentences |
| **Batch Services (5 files)** | | |
| `services/batch/orchestrator.ts` | 446 | `createBatch()`, `startBatch()`, `launchTask()`, `startCombinedBatch()` |
| `services/batch/completion.ts` | — | `handleTaskComplete()`, `finalizeBatch()` (merge branches, handle conflicts, create PR) |
| `services/batch/shared.ts` | — | `activeBatches` Map, `sessionToBatch` Map, broadcast helpers |
| `services/batch/event-handler.ts` | — | Task/session SSE subscription, background task timeout |
| **Support Services** | | |
| `services/opencode.ts` | — | Spawns OpenCode binary, crash restart backoff (5 attempts), `getClientForUser()` |
| `services/worktree.ts` | — | Bare clone, create worktrees, merge branches (`--no-ff`), cleanup |
| `services/repo-storage.ts` | — | `assertPathInsideReposDir()` prevents path traversal |
| `services/git-credentials.ts` | — | Temp credential helper files (mode 0o600), auto-cleanup |
| `services/git-identity.ts` | — | Git author identity from env vars |
| `services/execution-settings.ts` | — | Per-user settings: parallelLimit, maxBatchSize, conflictBehavior |
| `services/delta-buffer.ts` | — | Streaming delta buffering |
| `utils/background-task.ts` | — | Regex-based background task detection from tool output |

### Execution Flow

```
User clicks "Execute"
  → POST /api/tasks (API marks task "in_progress", broadcasts SSE)
  → Sidecar detects task
  → executeTask()
    → gatherExecutionInputs()   — load task, decrypt token, resolve repo
    → setupRepository()          — clone or local branch: openlinear/<prefix>
    → startAgentSession()        — OpenCode SDK, prompt with execution contract
    → subscribeToSessionEvents() — OpenCode SSE stream
    → handleSessionComplete()    — commit, push, create PR
    → finalizeAgentRun()         — token usage, cost, activity log
  → SSE events broadcast to UI
```

### Batch Modes

| Mode | Behavior | Worktrees | Final PR |
|------|----------|-----------|----------|
| **parallel** | All tasks launch simultaneously | Per-task | Per-task commits → merge → single PR |
| **queue** | One at a time, auto/manual approval | Per-task | Sequential commits → merge → single PR |
| **combined** | Single OpenCode session for all tasks | One shared | One commit → PR |

### Safeguards

| Safeguard | Mechanism |
|-----------|-----------|
| Shell injection prevention | `execFileAsync` (array args, no shell) |
| Path traversal prevention | `assertPathInsideReposDir()` |
| Git credential isolation | Temp files (mode 0o600), auto-cleanup |
| Task timeout | 30 min (`TASK_TIMEOUT_MS`) |
| Idle detection | 30s SSE idle → extended to 10 min with background subtasks |
| Boot recovery | Orphaned executions >1h → cancelled (`sidecar_restart_orphan`) |
| Single-tenant guard | Refuses to boot OpenCode with multi-user DB |
| Rate limiting | Express rate-limit with custom 429 JSON |
| Graceful shutdown | 10s drain window, disconnects Prisma, exits cleanly |
| Delta buffering | Debounces token deltas (800ms) → whole sentences |
| Conflict handling | `conflictBehavior: 'skip' \| 'fail'` during batch merge |

---

## 3. Frontend (`apps/desktop-ui/`)

### Tech Stack

Next.js 16 · React 19 · Tailwind CSS · shadcn/ui (Radix primitives) · Framer Motion · `@tauri-apps/api` · `@hello-pangea/dnd` · `react-hook-form` + Zod · `react-markdown` + `remark-gfm`

### App Router Structure

| Route | Purpose |
|-------|---------|
| `app/layout.tsx` | Root: ThemeProvider, AuthProvider, SSEProvider, WorkspaceProvider, ProjectProvider, ChatProviders, global overlays |
| `app/(app)/layout.tsx` | Authenticated shell: wraps children in `<AppShell>` |
| `app/(app)/page.tsx` | Home: OnboardingWizard if new user, else ChatPanel |
| `app/(app)/projects/board/page.tsx` | Kanban board |
| `app/(app)/projects/issues/page.tsx` | Issue list |
| `app/(app)/inbox/page.tsx` | Notification / done task feed |
| `app/(app)/my-issues/page.tsx` | User-assigned issues |
| `app/(app)/teams/page.tsx` | Team management |
| `app/(app)/settings/page.tsx` | Settings pages |
| `app/(app)/archived/page.tsx` | Archived tasks |
| `app/(app)/usage/page.tsx` | Usage analytics |
| `app/login/page.tsx` | Login page |
| `app/auth/callback/page.tsx` | OAuth callback (desktop deep-link handling) |

### Component Directories (27)

`auth/` · `board/` · `brainstorm/` · `chat/` · `command-palette/` · `comments-thread/` · `desktop/` · `empty-state/` · `execution-drawer/` · `god-mode-overlay/` · `label-picker/` · `layout/` · `markdown-view/` · `onboarding/` · `projects/` · `provider-setup-dialog/` · `quick-capture/` · `repo-connector/` · `settings/` · `shared/` · `shortcuts-overlay/` · `task-detail-view/` · `task-form-model-selector/` · `task-form/` · `theme-meta/` · `themed-toaster/` · `ui/`

### Key Components

| Component | Purpose |
|-----------|---------|
| `layout/app-shell.tsx` | Resizable sidebar (200–400px, persisted), mobile overlay, drag handle |
| `layout/sidebar.tsx` | Workspace switcher, project tree, nav links, user dropdown, Tauri window controls |
| `board/kanban-board.tsx` | `@hello-pangea/dnd` kanban, keyboard shortcuts, batch progress, inline creation |
| `command-palette.tsx` | Global `Cmd+K` search (tasks, projects, teams, quick actions) |
| `board/use-kanban-board.ts` | Board state: tasks, selection, batch, drag, inline creation |

### State Management (Context-based, no Redux/Zustand)

| Hook/Provider | Holds |
|---------------|-------|
| `hooks/use-auth.tsx` (AuthContext) | `user`, `activeRepository`, `isAuthenticated`, JWT/token management |
| `hooks/use-workspace.tsx` (WorkspaceContext) | `workspaces`, `activeWorkspace`, localStorage persistence, SSE updates |
| `hooks/use-project.tsx` (ProjectContext) | `projects`, `activeProject`, scoped to workspace, SSE updates |
| `providers/sse-provider.tsx` (SSEContext) | EventSource connections (cloud + sidecar), exponential backoff, listener broadcast |
| `hooks/use-task-sse.ts` | SSE consumer: task lifecycle, execution progress, batch events |
| `lib/execution-state-store.ts` | `useSyncExternalStore` for execution logs and progress |
| `board/board-state.ts` | Pure functions for optimistic task updates, DnD reordering |

### API Client

| File | Purpose |
|------|---------|
| `lib/api/client.ts` | URL resolution: web uses `NEXT_PUBLIC_API_URL`, desktop uses sidecar (`http://127.0.0.1:<port>`) |
| `lib/api/fetch.ts` | `apiFetch<T>()`: auto auth headers, 401 → `auth:expired` event, `ApiError`, `NetworkError` |
| `lib/api/tasks.ts` | Task CRUD, execute, cancel, logs, inbox |
| `lib/api/projects.ts` | Project CRUD, access management |
| `lib/api/chat.ts` | Chat session CRUD + streaming send with `response.body.getReader()` NDJSON parsing |
| `lib/api/auth.ts` | Login, logout, callback verification |

### Real-Time (SSE)

- **SSEProvider** maintains two EventSource connections: cloud API + sidecar
- Token passed via `?token=<jwt>` query param (EventSource can't set custom headers)
- Exponential backoff reconnect with jitter (max 30s)
- Event types: `task:*`, `execution:progress`, `execution:log`, `batch:*`, `notification:*`, workspace/team/project changes

### Keyboard Shortcuts (Kanban Board)

| Key | Action |
|-----|--------|
| `j/k` | Navigate tasks |
| `x` | Select task |
| `e` | Execute selected |
| `d` | Delete selected |
| `l` | Move to in_progress |
| `1-4` | Status changes |
| `Cmd+A` | Select all |
| `Escape` | Clear selection |
| `Cmd+K` | Command palette |

---

## 4. Desktop Tauri (`apps/desktop/`)

### Rust Source Files

| File | Purpose |
|------|---------|
| `src-tauri/src/lib.rs` | App builder: single-instance, deep-link, sidecar auto-spawn on setup. Invoke commands: `opencode::check_opencode`, `opencode::pick_local_folder`, `deeplink::consume_pending_auth_callback`, `sidecar::start/stop/get_port` |
| `src-tauri/src/sidecar.rs` | Spawns `openlinear-sidecar` binary. Dynamic port selection, allowlisted environment (`API_PORT`, `OPENLINEAR_API_URL`, `HOME`, `XDG_*`, proxies, `OPENCODE_BIN`; never `DATABASE_URL`, `JWT_SECRET`, `TOKEN_ENCRYPTION_KEY` — W03a), opt-in secret passthrough (`sidecar_env_passthrough` setting), stdout/stderr streaming via Tauri events, `sidecar:ready` event with `port`/`api_url`/`health_url` |
| `src-tauri/src/deeplink.rs` | Handles `openlinear://callback?code=…&state=…` (single-use code + PKCE; no token in the URL, nothing printed). Stores in `PendingAuthCallback`, emits `auth:callback` event, focuses window |
| `src-tauri/src/opencode.rs` | `check_opencode`, `pick_local_folder`; resolves the bundled `opencode` binary |
| `src-tauri/src/main.rs` | Delegates to `lib.rs` |

### Tauri Config (`src-tauri/tauri.conf.json`)

- **Window**: 1200x800, `decorations: false`, background `#0a0a0a`
- **Deep-link**: `openlinear://`
- **External binaries**: `openlinear-sidecar`, `opencode`
- **CSP**: production CSP in `tauri.conf.json` (`script-src 'self'`, no `unsafe-eval`/`unsafe-inline` scripts since 2026-10-26; see `docs/reports/revamp-2026-10-26/release.md` §5.2)
- **Bundle**: macOS `dmg`/`app`; Linux `deb` only via `tauri.linux.conf.json`, plus an AppImage from `scripts/build-appimage-workaround.sh` (pinned, checksummed `appimagetool`)
- **App data**: Tauri's own data (`settings.json`, `sidecar.pid`) in `com.openlinear.app` under `~/Library/Application Support` (macOS) / `$XDG_DATA_HOME` (Linux); the sidecar's data in `OpenLinear`/`openlinear` beside it (see §2)
- **Shell plugin**: for opening external URLs (`https:`/`mailto:` only)

---

## 5. MCP Server (`apps/mcp/`)

### Architecture

*(Re-verified 2026-10-26; full tool table with annotations and schemas: `docs/reports/revamp-2026-10-26/mcp.md` §3; generated reference: `apps/mcp-docs/lib/tool-catalog.json`.)*

**Runtime**: Cloudflare Worker, plain `fetch` handler (`src/index.ts`)  
**Framework**: `@modelcontextprotocol/server` 2.4.0 — one web-standard handler per request, no Express; serves 2025-era clients (initialize handshake) and the 2026-07-28 protocol revision  
**Auth**: every request (including `initialize` and `tools/list`) needs a PAT the API accepts; verified tokens cached 60 s, a 401 from the API evicts; missing/invalid tokens get 401 + `WWW-Authenticate` pointing at `/.well-known/oauth-protected-resource`  
**Retries**: creates send a deterministic `Idempotency-Key` derived from the tool arguments  
**Deployment**: `mcp.openlinear.tech` via `wrangler.toml`  
**API URL**: `OPENLINEAR_API_URL=https://api.openlinear.tech` (that host is down, see §11, so tools that reach the API fail until it is restored)

### File Map

| File | Purpose |
|------|---------|
| `src/index.ts` | Worker entry point; builds the worker once per isolate |
| `src/worker.ts` | Routing, origin validation, auth, protected-resource metadata, body limit (2 MB) |
| `src/auth.ts` | PAT extraction and verification (`PatVerifier`, 60 s cache) |
| `src/config.ts`, `src/version.ts` | Environment parsing; server name/version |
| `src/mcp/server.ts` | Server factory and tool list |
| `src/mcp/tools/*.ts` | Tool implementations: `workspaces`, `projects`, `teams`, `labels`, `issues`, `search`, `plan` (`bulk_create_plan`) |
| `src/mcp/{tool,inputs,shapes,errors,idempotency,context}.ts` | Tool helper, strict input/output schemas, error mapping, idempotency keys, request scope |
| `src/openlinear/client.ts` | The worker's own HTTP client for apps/api (no longer `packages/api-client`) |

### Registered Tools (19)

All carry readOnly/destructive/idempotent/openWorld annotations, strict input schemas and output schemas.

| Tool | Purpose |
|------|---------|
| `openlinear_list_workspaces` / `openlinear_list_projects` / `openlinear_list_teams` / `openlinear_list_labels` | Read workspaces, projects, teams, labels/phases |
| `openlinear_get_project` | Project + teams, repository, labels/phases (not tasks) |
| `openlinear_create_project` / `openlinear_create_team` | Create (keyed, retry-safe) |
| `openlinear_create_label` / `openlinear_create_phase` | Ensure a label / phase label (`phase:N — Name`) exists |
| `openlinear_search` | Search tasks/projects |
| `openlinear_list_issues` / `openlinear_get_issue` | List with filters; get one issue (+ comments, sub-issues, `ENG-12` lookup) |
| `openlinear_create_issue` / `openlinear_update_issue` | Create (keyed) / update a task |
| `openlinear_assign_issue` / `openlinear_label_issue` | Assign (`"me"`/uuid/null); add/remove labels |
| `openlinear_bulk_update_status` | Status change for 1–100 explicit task ids |
| `openlinear_add_comment` | Comment on a task |
| `openlinear_bulk_create_plan` | Project + phases + tasks in one call; reports `complete`/`partial`, re-run finishes a partial plan without duplicates |

### API Integration

The MCP Worker is **stateless** — it calls the main API with the caller's PAT:

```
MCP Client → Authorization: Bearer ol_pat_xxxx
  → Cloudflare Worker (verifies the PAT against the API, cached 60 s)
    → https://api.openlinear.tech/api/... (same PAT header)
      → API hash-lookups PAT → registry scope check → executes
```

### Client Config

```json
{
  "mcpServers": {
    "openlinear": {
      "url": "https://mcp.openlinear.tech/mcp",
      "headers": { "Authorization": "Bearer ol_pat_xxxxx" }
    }
  }
}
```

---

## 6. Database (`packages/db/`)

### Prisma Schema (`prisma/schema.prisma` — 760 lines)

**Enums (13):** Priority, Status, TeamRole, ProjectStatus, WorkspaceRole, ProjectPermission, AgentRunStatus, NotificationType, ChatMessageRole, ChatToolCallStatus, ActivityAction, InvitationStatus, Permission

**Core Models:**

| Model | Table | Key Fields |
|-------|-------|------------|
| `Task` | `tasks` | `parentId` (self-relation subtasks), `projectId`, `teamId`, `status`, `priority`, `batchId`, `archived`, `model`, `dueDate`, `number` (team-scoped), `identifier` (e.g. "ENG-1"), execution state fields |
| `Project` | `linear_projects` | `workspaceId`, `key`, `status`, `repositoryId`, `localPath`, `repoUrl` |
| `Workspace` | `workspaces` | Top-level tenant, auto-created per user |
| `Team` | `teams` | `key` (issue prefix), `nextIssueNumber` (atomic numbering) |
| `Label` | `labels` | Project-scoped, m:m with Task via `TaskLabel` |
| `User` | `users` | `githubId` (unique), `email`, `accessToken`, `totpSecret`, `totpEnabled`, `backupCodes` |
| `PersonalAccessToken` | `personal_access_tokens` | `tokenHash` (SHA-256, unique), `tokenPrefix`, `scopes[]`, `lastUsedAt`, `expiresAt`, `revokedAt` |
| `ChatSession` | `chat_sessions` | Home Chat sessions with workspace scope |
| `ChatMessage` | `chat_messages` | User/assistant/tool messages |
| `ChatToolCall` | `chat_tool_calls` | Persisted tool calls: `input`, `output`, `latencyMs`, `status` |
| `AgentRun` | `agent_runs` | Execution history: `agent`, `model`, `costUsd`, `inputTokens`, `outputTokens`, `prUrl` |
| `Repository` | `repositories` | GitHub metadata: `githubRepoId`, `fullName`, `cloneUrl` |
| `Settings` | `settings` | Per-user: `parallelLimit`, `maxBatchSize`, `conflictBehavior` |

**Support Models (12+):** Comment, CommentMention, Notification, NotificationPreference, ActivityLog, AuditLog, Invitation, Session, Batch, McpToolCall, TaskAssignee, ProjectAccess, TeamMember, WorkspaceMember, Role, ChatAttachment, SSOConfig

**Key Indexes:**
- `tasks(projectId, archived, createdAt)` — list hot path
- `tasks(teamId, archived)` — team-scoped lists
- `tasks(status)`, `tasks(assigneeId)` — board queries
- `chat_sessions(userId, workspaceId, archivedAt, updatedAt)` — session list
- `chat_tool_calls(sessionId, toolCallId)` (unique) — idempotency

### Prisma Client (`src/client.ts`)

- PrismaPg adapter for PostgreSQL connection pooling
- Global singleton proxy to prevent hot-reload connection leaks
- Connection pool: `connection_limit: 10`

### DB Commands

```bash
pnpm --filter @openlinear/db db:generate   # Regenerate Prisma client
pnpm --filter @openlinear/db db:push       # Sync schema in dev
pnpm --filter @openlinear/db db:migrate:deploy  # Apply migrations in prod
```

### Migration Patterns

- Located in `packages/db/prisma/migrations/` with timestamp-prefixed directories
- Raw SQL using `CREATE TYPE`, `CREATE TABLE`, `CREATE INDEX`, `ALTER TABLE`
- Some migrations use `IF NOT EXISTS` / `DO $$` blocks for production safety

---

## 7. Shared Packages

### `packages/execution-core/`

| File | Purpose |
|------|---------|
| `batch/types.ts` | `BatchMode`, `BatchStatus`, `BatchTask`, `BatchState`, `BatchSettings`, `BatchEventType`, API request/response types |
| `batch/state.ts` | `createBatchState()`, `createBatchTasks()` factories |
| `batch/modes.ts` | `formatExecutionMode()`, `getInitialBatchLaunchIndexes()` |
| `batch/prompts.ts` | `buildSingleTaskPrompt()`, `buildCombinedBatchPrompt()` |
| `batch/responses.ts` | Response serializers: `toCreateBatchResponse`, `toBatchStatusResponse` |
| `batch/status.ts` | Predicates: `isBatchTaskTerminal`, `findNextQueuedBatchTaskIndex` |

### `packages/openlinear-cli/`

CLI launcher and installer (`bin/openlinear.js`, `lib/installer.js`): downloads the Linux AppImage of its own package version from `kaizen403/openlinear` releases and verifies it against `SHA256SUMS`.

### `packages/types/`

Deleted 2026-05-25. Shared types live in `execution-core`, `api-core`, `api-client`, `db` (Prisma generated) and the apps.

---

## 8. Other Apps

| App | Tech | Port | Purpose |
|-----|------|------|---------|
| `apps/landing/` | Next.js 16 | 3002 | Public marketing site |
| `apps/mcp-docs/` | Next.js | — | Documentation for MCP integrations |
| `apps/intro-video/` | Remotion 4 | — | Intro video generation |

---

## 9. CI/CD

*(Re-verified 2026-10-26.)*

| Workflow | Trigger | What it does |
|---|---|---|
| `.github/workflows/dev.yml` | push to `dev`, PRs to `dev`/`main`, manual | Lint & typecheck + migration safety review (`scripts/ci/migration-safety.sh`), secret scan (gitleaks on the new commits only, `.gitleaks.toml`), tests (Postgres 16 service), build, API Docker image build + smoke (no push) when its inputs change |
| `.github/workflows/deploy-azure.yml` | push to `main`, manual | Checks (incl. Prisma drift check) then build/push/deploy the API to Azure Container Apps. Last successful deploy 2026-05-24 |
| `.github/workflows/release.yml` | `v*` tags, manual (existing tag) | Desktop builds (macOS arm64/x64, Linux deb + AppImage) with the Node 22 sidecar and pinned OpenCode, checksums, provenance, draft release; opt-in CLI publish |
| `.github/workflows/sandbox.yml` | PRs/pushes touching `apps/sidecar/src/sandbox/**`, `services/opencode.ts`, `services/git-credentials.ts` | Sandbox provider checks (W09a) |
| `.github/workflows/deploy.yml` | manual only ("Legacy - Disabled") | Old VPS deploy (SSH + PM2) |

---

## 10. Key Patterns & Conventions

### TypeScript
- **Strict mode** throughout — no `as any`, `@ts-ignore`, `@ts-expect-error`
- Zod schemas for all request validation
- Prisma `satisfies Prisma.XInclude` for type-safe includes

### Database
- `prisma.$transaction()` for all multi-row writes (15s timeout, 5s maxWait)
- Atomic auto-incrementing issue numbers via `nextIssueNumber: { increment: 1 }`
- Cursor-based pagination for chat/notifications; offset-based for tasks
- Idempotency via `sessionId_toolCallId` unique constraint (chat) and `Idempotency-Key` header (CRUD)

### Real-Time
- SSE for everything: task lifecycle, execution progress, batch events, notifications, member changes
- Bi-directional connection (cloud + sidecar) when desktop is running locally
- Exponential backoff reconnect with jitter

### Security
- PATs are SHA-256 hashed, never stored plaintext
- `OwnershipError` collapses 404/403 to prevent resource existence leaks
- Sidecar: `execFileAsync` (no shell), `assertPathInsideReposDir()`, temp git credential files
- Sidecar: single-tenant guard for OpenCode
- Rate limiting on auth, OAuth, repo URLs, chat messages

### Error Handling
- Consistent `{ error, code, message, details, requestId }` envelope
- Prisma error codes mapped to HTTP statuses (P2002→409, P2025→404, P2003→409)
- Activity logging and notifications are best-effort (fire-and-forget, don't break primary mutations)

---

## 11. Production URLs

Status as verified by the 2026-10-25 audit (`docs/reports/revamp-plan-status-2026-10-25.md` §2); nothing has been deployed since.

| Service | URL | Status |
|---------|-----|--------|
| API | `api.openlinear.tech` (Azure Container Apps) | **Down.** The CNAME target does not resolve; last successful deploy 2026-05-24 |
| Landing | `openlinear.tech` (Vercel behind Cloudflare) | Up (marketing site, not the app) |
| MCP Worker | `mcp.openlinear.tech` (Cloudflare Worker) | Up, but tools that call the API fail while the API is down |
| Database | Neon (`ap-southeast-1`) | Exists; production credential rotation still blocked (see `docs/runbooks/rotate-leaked-secrets.md`) |
| MCP Docs | `docs.openlinear.tech` (also `mcp-docs-one.vercel.app`) | Up |
| Desktop | GitHub Releases `kaizen403/openlinear` | Last release v0.1.61 (2026-05-13), pre-Phase-0 code |

---

## 12. Key Commands

```bash
# Dev
pnpm --filter @openlinear/api dev          # API on :3001
pnpm --filter @openlinear/desktop-ui dev   # UI on :3000
pnpm --filter @openlinear/sidecar dev      # Sidecar on :3003
pnpm dev-live                              # API + UI + sidecar

# Type check
pnpm --filter @openlinear/api typecheck
pnpm --filter @openlinear/desktop-ui typecheck
pnpm --filter @openlinear/mcp typecheck

# Test
pnpm --filter @openlinear/api test

# DB
pnpm --filter @openlinear/db db:generate
pnpm --filter @openlinear/db db:migrate:deploy
pnpm --filter @openlinear/db db:push

# MCP deploy
cd apps/mcp && wrangler deploy

# Build
pnpm build
```
