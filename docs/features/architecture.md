# Architecture

## Monorepo Structure

```
openlinear/
  apps/
    desktop-ui/       Next.js frontend (rendered in Tauri webview)
      components/     React components (board, task forms, overlays, settings)
      hooks/          Custom hooks (SSE subscription, auth)
      lib/            API client, utilities
    api/              Express API sidecar
      src/
        routes/       REST endpoints (tasks, labels, batches, auth, repos, teams, projects, inbox, settings)
        services/     Business logic (execution, batch, opencode, github, worktree, delta-buffer)
        middleware/    Auth middleware (JWT verification)
  packages/
    db/               Prisma schema + generated client
      prisma/
        schema.prisma
  docs/
    diagrams/         Architecture SVGs
    features/         Feature documentation
```

## Desktop App

Built with Tauri (Rust shell wrapping the Next.js frontend). The API runs as a sidecar process alongside the desktop window.

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
| `User` | GitHub-authenticated user with access token |
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

Express server with JSON body parsing, CORS, and cookie support. Routes are mounted under `/api/`:

- `/api/auth` -- GitHub OAuth
- `/api/repos` -- repository management
- `/api/tasks` -- task CRUD and execution
- `/api/labels` -- label CRUD and task-label associations
- `/api/settings` -- execution settings
- `/api/batches` -- batch execution
- `/api/teams` -- team CRUD and membership
- `/api/projects` -- project CRUD
- `/api/inbox` -- completed task notifications
- `/api/events` -- SSE endpoint
- `/api/opencode/status` -- OpenCode server status
- `/health` -- health check

### Authentication

Two middleware functions:
- `optionalAuth`: extracts `userId` from JWT if present, continues either way
- `requireAuth`: rejects request with 401 if no valid JWT

## Real-Time Communication

Server-Sent Events (SSE) at `GET /api/events`. Each connected client gets a unique ID. The `broadcast()` function sends events to all connected clients. Heartbeat every 30 seconds to keep connections alive.

## Git Strategy

**Single task execution:** shallow clone (`git clone --depth 1`) into a fresh directory per task.

**Batch execution:** bare clone as the main repo, git worktrees for each task. Worktrees are created from the default branch. After completion, task branches are merged into a batch branch via temporary worktrees with `--no-ff` merges.

## Distribution

| Format | Platform | Notes |
|--------|----------|-------|
| AppImage | Linux | Self-contained, no install needed |
| .deb | Linux (Debian/Ubuntu) | Standard package |
| AUR | Arch Linux | `openlinear-bin` package in `packaging/aur/` |
| npm CLI | Any | `@openlinear/openlinear-cli` via GitHub Packages, downloads AppImage on install |
| GitHub Releases | Any | Tag-triggered CI builds (`v*` tags) |
