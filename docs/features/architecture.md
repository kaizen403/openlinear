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

Express server with JSON body parsing, CORS, and cookie support. Routes are mounted under `/api/`:

- `/api/auth` -- username/password registration and login, GitHub OAuth
- `/api/repos` -- repository management
- `/api/tasks` -- task CRUD and execution
- `/api/labels` -- label CRUD and task-label associations
- `/api/settings` -- execution settings
- `/api/batches` -- batch execution
- `/api/teams` -- team CRUD and membership
- `/api/projects` -- project CRUD
- `/api/inbox` -- completed task notifications
- `/api/events` -- SSE endpoint
- `/api/opencode` -- OpenCode container management, provider auth, status
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

## Container-Per-User Architecture

Each user gets a dedicated Docker container running OpenCode for isolated task execution. The `container-manager` service handles:

- **Port allocation**: dynamic host ports in the 30000--31000 range
- **Container lifecycle**: create, health-check, recover on API restart, idle cleanup
- **Resource limits**: 512 MB memory, 512 CPU shares, 256 max PIDs per container
- **Persistent volumes**: auth tokens, config files, and cloned repos survive container restarts

Containers idle for 2 hours are automatically stopped. See [OpenCode Integration](opencode-integration.md) for full details.

## Docker Services

Defined in `docker-compose.yml`:

| Service | Image | Purpose |
|---------|-------|---------|
| `postgres` | `postgres:16-alpine` | PostgreSQL database (port 5432) |
| `opencode-worker` | `opencode-worker:latest` | Build target for the per-user worker container (build-only profile) |

The `opencode-worker` image is built from `docker/opencode-worker/Dockerfile` (Node 20 Alpine with git, OpenCode CLI/SDK, non-root user).

## CI/CD

Release builds are triggered by pushing a `v*` tag. The GitHub Actions workflow at `.github/workflows/release.yml` builds:
- Linux AppImage and .deb desktop bundles
- A standalone API sidecar binary

Artifacts are uploaded to the corresponding GitHub Release.

## Local Development vs NPM Package

There is an important distinction between developing OpenLinear locally and installing the published npm package:

**1. Developing Locally (`pnpm dev`)**
When you run `pnpm dev` in the cloned repository, it runs `./scripts/dev.sh`. This is strictly for contributors to test and build the application. It automatically:
- Starts a temporary local PostgreSQL database using Docker (so you don't mess up production data).
- Seeds the database with test data.
- Starts the API server.
- Starts the Tauri desktop app (or falls back to a Next.js web view if Tauri isn't fully configured on your machine).

**2. The Published NPM Package (`npm install -g @kaizen403/openlinear`)**
The published npm package is just a lightweight launcher for end-users. It does **not** include the `pnpm dev` script, does not require Docker, and does not start a local database. Instead, the npm package:
- Downloads the pre-compiled, standalone Desktop Application (Linux AppImage) directly from GitHub Releases during the `postinstall` step.
- Acts as a CLI shortcut (`openlinear`) that launches the downloaded desktop app.

## Distribution

| Format | Platform | Notes |
|--------|----------|-------|
| AppImage | Linux | Self-contained, no install needed |
| .deb | Linux (Debian/Ubuntu) | Standard package |
| AUR | Arch Linux | `openlinear-bin` package in `packaging/aur/` |
| npm installer | Any | `@kaizen403/openlinear` via GitHub Packages, downloads AppImage on install |
| GitHub Releases | Any | Tag-triggered CI builds (`v*` tags) |
