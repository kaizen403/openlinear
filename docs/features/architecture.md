# Architecture

## Monorepo Structure

```
openlinear/
  apps/
    desktop-ui/       Next.js frontend (rendered in Tauri webview)
      components/     React components (board, task forms, overlays, settings)
      hooks/          Custom hooks (SSE subscription, auth)
      lib/            API client, utilities
    api/              Cloud metadata API (deployed at openlinear.tech)
      src/
        routes/       REST endpoints (auth, tasks, labels, settings, teams, projects, inbox, repos)
        services/     Business logic (github, team-scope)
        middleware/   Auth middleware (JWT verification)
    sidecar/          Local execution sidecar (bundled in Tauri desktop app)
      src/
        routes/       Execution routes (execute, cancel, opencode, batches, brainstorm, transcribe)
        services/     Execution logic (execution, opencode, batch, brainstorm, worktree, delta-buffer, git-identity)
  packages/
    db/               Prisma schema + generated client
      prisma/
        schema.prisma
  docs/
    diagrams/         Architecture SVGs
    features/         Feature documentation
```

## Desktop App

Built with Tauri (Rust shell wrapping the Next.js frontend). The sidecar binary (`openlinear-sidecar`) runs as a Tauri sidecar process alongside the desktop window, handling all execution locally.

Key Tauri integrations:
- `check_opencode` command: checks if the OpenCode binary exists on the system
- `@tauri-apps/plugin-shell`: opens external links in the default browser
- `@tauri-apps/plugin-os`: detects platform and architecture
- Window controls: macOS-style traffic lights for close/minimize/maximize

## Database

PostgreSQL via Prisma ORM. Schema lives at `packages/db/prisma/schema.prisma`.

### Models

| Model | Description |
|-------|-------------|
| `Task` | Core work unit: title, description, priority, status, execution tracking, team/project association |
| `Label` | Colored tag with name and priority ordering |
| `TaskLabel` | Many-to-many join between tasks and labels |
| `Settings` | Singleton config for execution behavior |
| `User` | Authenticated user (username/password or GitHub OAuth) with optional access token |
| `Repository` | Connected GitHub repository (clone URL, default branch, active flag) |
| `Team` | Team with key for issue numbering, members, color |
| `TeamMember` | User membership in a team with role |
| `Project` | High-level initiative with status, dates, lead, team associations |
| `ProjectTeam` | Many-to-many join between projects and teams |

### Enums

| Enum | Values |
|------|--------|
| `Priority` | low, medium, high |
| `Status` | todo, in_progress, done, cancelled |
| `TeamRole` | owner, admin, member |
| `ProjectStatus` | planned, in_progress, paused, completed, cancelled |

## API

The cloud API (`apps/api`) is an Express server deployed at openlinear.tech. It handles metadata only — no execution, no OpenCode. Routes are mounted under `/api/`:

**Cloud API routes:**
- `/api/auth` -- username/password registration and login, GitHub OAuth
- `/api/repos` -- repository management
- `/api/tasks` -- task CRUD (no execution endpoints)
- `/api/labels` -- label CRUD and task-label associations
- `/api/settings` -- execution settings
- `/api/teams` -- team CRUD and membership
- `/api/projects` -- project CRUD
- `/api/inbox` -- completed task notifications
- `/api/events` -- SSE endpoint
- `/health` -- health check

**Local Sidecar routes (`apps/sidecar`):**
- `/api/tasks/:id/execute` -- trigger task execution
- `/api/tasks/:id/cancel` -- cancel running execution
- `/api/batches` -- batch execution (parallel, queue, and combined modes)
- `/api/opencode` -- OpenCode management, provider auth, status
- `/api/brainstorm` -- AI task generation
- `/api/transcribe` -- audio transcription

The sidecar imports the shared Express app via `@openlinear/api/app`, SSE utilities via `@openlinear/api/sse`, and auth middleware via `@openlinear/api/middleware`, then adds its execution routes on top.

### Authentication

Two middleware functions:
- `optionalAuth`: extracts `userId` from JWT if present, continues either way
- `requireAuth`: rejects request with 401 if no valid JWT

## Real-Time Communication

Server-Sent Events (SSE) at `GET /api/events`. Each connected client gets a unique ID. The `broadcast()` function sends events to all connected clients. Heartbeat every 30 seconds to keep connections alive.

## Git Strategy

**Single task execution:** shallow clone (`git clone --depth 1`) into a fresh directory per task.

**Batch execution:** bare clone as the main repo, git worktrees for each task or one combined worktree. Parallel and Queue task branches are merged into a batch branch via temporary worktrees with `--no-ff` merges. Combined mode commits directly on the batch branch from one shared session.

## Host-Based Execution

OpenCode runs directly on the host machine, managed by the local sidecar (`apps/sidecar`). The sidecar is a separate package from the cloud API. It connects to the cloud API for task metadata, then runs all execution locally. Each task is isolated in its own git worktree with an independent branch and working directory. Provider credentials are configured per-user through the OpenCode instance the sidecar manages.

See [OpenCode Integration](opencode-integration.md) for full details.

## Production Database

The cloud API uses Neon cloud PostgreSQL. The `DATABASE_URL` environment variable must point to the Neon connection string in production.

## CI/CD

Release builds are triggered by pushing a `v*` tag. The GitHub Actions workflow at `.github/workflows/release.yml` builds:
- Linux AppImage and .deb desktop bundles (Tauri, bundling `openlinear-sidecar` and OpenCode binaries)
- The sidecar binary (`openlinear-sidecar`) for each supported target triple

Artifacts are uploaded to the corresponding GitHub Release.

## Distribution

| Format | Platform | Notes |
|--------|----------|-------|
| AppImage | Linux | Self-contained, no install needed |
| .deb | Linux (Debian/Ubuntu) | Standard package |
| AUR | Arch Linux | `openlinear-bin` package in `packaging/aur/` |
| npm CLI | Any | `@openlinear/openlinear-cli` via GitHub Packages, downloads AppImage on install |
| GitHub Releases | Any | Tag-triggered CI builds (`v*` tags) |
