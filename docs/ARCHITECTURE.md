# Architecture

A deep dive into how OpenLinear works — from authentication to container isolation to task execution.

<p align="center">
<img src="diagrams/architecture.svg" alt="OpenLinear Architecture" width="100%"/>
</p>

## System Overview

OpenLinear is a monorepo with four main components: a Next.js desktop UI, an Express API sidecar, per-user Docker containers running OpenCode, and a PostgreSQL database.

```
┌─────────────────────────────────────────────────────────────┐
│                    Desktop App (Tauri)                       │
│  ┌───────────────────────────────────────────────────────┐  │
│  │          Next.js UI (apps/desktop-ui)                 │  │
│  │   Kanban Board → Task Cards → Execute Button          │  │
│  │   SSE EventSource ← /api/events (real-time updates)   │  │
│  └───────────────────────┬───────────────────────────────┘  │
│                          │ HTTP + Bearer JWT                 │
│  ┌───────────────────────▼───────────────────────────────┐  │
│  │          API Sidecar (apps/api) — Express.js          │  │
│  │   Auth Routes │ Task Routes │ Batch Routes │ SSE      │  │
│  └──────┬────────────────┬──────────────────────────────┘  │
│         │                │                                   │
│  ┌──────▼──────┐  ┌──────▼────────────────────────────┐    │
│  │ PostgreSQL  │  │  Docker Containers (per user)      │    │
│  │  (Prisma)   │  │  ┌─────────────────────────────┐  │    │
│  └─────────────┘  │  │ opencode-user-{userId}      │  │    │
│                    │  │  OpenCode SDK Server :4096  │  │    │
│                    │  │  /home/opencode/repos (bind)│  │    │
│                    │  └─────────────────────────────┘  │    │
│                    └───────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## Authentication

OpenLinear supports two authentication methods, both producing the same JWT:

**Email/Password** — register with name, email, and password. Passwords are hashed with bcrypt. On login, a JWT is issued with `{ userId, username }`, signed with `JWT_SECRET`, 7-day expiry.

**GitHub OAuth** — sign in with GitHub (scopes: `read:user user:email repo`). The OAuth flow exchanges a code for a GitHub access token, upserts the user, stores the `accessToken` in the database, and redirects back to the frontend with a JWT in the URL.

### Token Flow

1. Frontend stores the JWT in `localStorage`
2. Every API call includes `Authorization: Bearer {token}`
3. API middleware (`requireAuth` / `optionalAuth`) verifies the JWT and populates `req.userId`
4. `req.userId` drives container-per-user execution — each user gets their own Docker container

### GitHub Token Usage

The `User.accessToken` (GitHub OAuth token) is used for:
- Fetching user repositories (`GET https://api.github.com/user/repos`)
- Cloning repos with auth (`https://oauth2:{token}@github.com/...`)
- Creating PRs via GitHub API (`POST /repos/{owner}/{repo}/pulls`)

## Container-Per-User Isolation

Each authenticated user gets a dedicated Docker container running OpenCode. This is the core of the architecture.

### Container Lifecycle

```
User triggers task execution
        │
        ▼
ensureContainer(userId)
        │
        ├── Container exists & running? → return it
        ├── Container exists but stopped? → recover it
        └── No container? → createContainer(userId)
                │
                ├── Allocate port (30000–31000 range)
                ├── Create container:
                │     name: "opencode-user-{userId}"
                │     image: opencode-worker:latest
                │     port: 4096 → hostPort
                │     memory: 512MB, cpuShares: 512, pidsLimit: 256
                │     volumes:
                │       opencode-auth-{userId}   → /home/opencode/.local/share/opencode
                │       opencode-config-{userId} → /home/opencode/.config/opencode
                │       /tmp/openlinear-repos    → /home/opencode/repos (bind mount)
                │     labels: { app: openlinear, component: opencode-worker, userId }
                │
                ├── container.start()
                └── waitForReady() — polls GET http://127.0.0.1:{hostPort}/api/session
```

### What Runs Inside Each Container

The `opencode-worker` Docker image (built from `docker/opencode-worker/Dockerfile`):

- **Base:** `node:20-slim` with git, curl, ssh, bash
- **OpenCode CLI:** installed via `curl -fsSL https://opencode.ai/install | bash`
- **OpenCode SDK:** `@opencode-ai/sdk` installed via npm
- **Server:** `server.mjs` starts an HTTP server via `createOpencodeServer({ hostname: '0.0.0.0', port: 4096 })`
- **Entrypoint:** sets `git config --global --add safe.directory '*'` and runs the server
- **Non-root user:** `opencode` (uid 1001)
- **Healthcheck:** `curl -f http://localhost:4096/` every 30s

### Container Recovery & Cleanup

- **In-memory map:** `Map<userId, UserContainer>` in the API process
- **Persistent recovery:** on API restart, `discoverExistingContainers()` queries Docker for containers with labels `app=openlinear, component=opencode-worker` and rebuilds the map
- **Idle cleanup:** every 5 minutes, containers idle for 2+ hours are destroyed
- **Restart policy:** `on-failure` with max 3 retries

### Provider Authentication Per User

Each user's LLM provider credentials (API keys for Anthropic, OpenAI, etc.) are stored inside their container's persistent volume `opencode-auth-{userId}`. The API proxies key setup through:

- `POST /api/opencode/auth` — sets API key via SDK
- `POST /api/opencode/auth/oauth/authorize` — initiates provider OAuth flow
- `POST /api/opencode/auth/oauth/callback` — completes provider OAuth flow

Since each user has separate volumes, their provider credentials are completely isolated.

## Task Execution

OpenLinear supports two execution modes: **parallel** and **queue**. Both modes use git worktrees to isolate each task in its own branch and working directory, and merge results into a single batched PR.

### Single Task Execution

Each task follows a complete lifecycle: clone → branch → agent session → commit → PR.

<p align="center">
  <img src="diagrams/agent-integration.svg" alt="Agent Integration Flow" width="100%"/>
</p>

```
UI: Click "Execute" on TaskCard
        │
        ▼
Frontend: POST /api/tasks/{id}/execute (with Bearer JWT)
        │
        ▼
API: executeTask({ taskId, userId })
        │
        ▼
1. CONCURRENCY CHECK
   └── If running >= parallelLimit (default 3) → reject

2. REPOSITORY SETUP
   ├── Clone: git clone https://oauth2:{token}@github.com/{repo} /tmp/openlinear-repos/{taskId}
   └── Branch: git checkout -b openlinear/{taskId}

3. CONTAINER CLIENT
   ├── ensureContainer(userId) → get/create Docker container
   ├── toContainerPath() → map host path to /home/opencode/repos/{taskId}
   └── createOpencodeClient({ baseUrl, directory })

4. OPENCODE SESSION
   ├── client.session.create({ title, directory })
   ├── subscribeToSessionEvents() → listen to event stream
   └── client.session.prompt({ parts: [{ type: "text", text: prompt }] })

5. EVENT STREAMING (async)
   ├── message.part.updated → LLM output (buffered via delta-buffer)
   ├── tool.execute.before/after → tool call tracking
   ├── file.edited → file edit counting
   ├── session.completed/idle → triggers completion
   └── Each event → SSE broadcast to frontend

6. COMPLETION
   ├── git add -A && git commit && git push
   ├── Create PR via GitHub API
   ├── Save prUrl to database
   └── SSE broadcast: execution:completed
```

### Batch Execution

Batch execution runs multiple tasks, each in its own git worktree (not a full clone), and merges results into a single PR.

#### Parallel Mode

Run multiple tasks simultaneously, up to a configurable concurrency limit.

<p align="center">
  <img src="diagrams/parallel-execution.svg" alt="Parallel Execution" width="100%"/>
</p>

- Tasks run in isolated git worktrees with independent agent sessions
- Concurrency limit is configurable via settings (default: 3)
- When a task finishes, the next queued task fills the open slot
- All completed branches merge into a single batch branch
- Merge conflicts are handled gracefully — conflicting tasks are skipped, the rest are included

#### Queue Mode

Run tasks one at a time, sequentially. Optionally require user approval before starting the next task.

<p align="center">
  <img src="diagrams/queue-execution.svg" alt="Queue Execution" width="100%"/>
</p>

- Tasks execute strictly in order, one after another
- **Auto-approve** mode starts the next task immediately on completion
- **Manual approval** mode waits for user confirmation before proceeding
- Individual tasks can be cancelled without stopping the whole queue
- Same merge + PR flow as parallel mode

#### Batch Flow

```
UI: Select tasks → "Execute Batch" → Choose mode
        │
        ▼
POST /api/batches { taskIds, mode }
        │
        ▼
1. REPO SETUP
   └── ensureMainRepo() → git clone --bare into /tmp/openlinear-repos/{projectId}/.main

2. PER-TASK EXECUTION
   ├── createWorktree() → git worktree add .../batch-{batchId}/task-{taskId}
   ├── getClientForUser(userId, worktreePath) → same container-per-user model
   ├── client.session.create({ directory: containerPath })
   ├── Subscribe to events + send prompt
   └── On completion: commit changes in worktree

3. MERGE PHASE (after all tasks complete)
   ├── createBatchBranch("openlinear/batch-{batchId}")
   ├── For each completed task:
   │     mergeBranch() → git merge --no-ff
   │     If conflict: skip task (configurable)
   ├── pushBranch() → push batch branch to remote
   └── Create single PR for entire batch

4. CLEANUP
   └── cleanupBatch() → remove all worktrees and batch directory
```

#### Single vs Batch

| Aspect | Single Task | Batch |
|--------|-------------|-------|
| Git strategy | Full clone per task | Bare clone + worktrees |
| Branch | `openlinear/{taskId}` | Per-task branches merged into `openlinear/batch-{batchId}` |
| PR | One PR per task | One PR for entire batch |
| Concurrency | Respects parallelLimit | Same limit, with queue option |
| Conflicts | N/A | Handled during merge (skip or fail) |

### Execution Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Parallel Limit | Max concurrent tasks in parallel mode | `3` |
| Max Batch Size | Max tasks per batch | `3` |
| Auto-Approve | Auto-start next task in queue mode | `off` |
| Stop on Failure | Halt queue/batch if a task fails | `off` |
| Conflict Behavior | `skip` conflicting merges or `fail` the batch | `skip` |

## Real-Time Updates (SSE)

The execution engine streams real-time events to the UI through Server-Sent Events — you see every tool call, file edit, and status change as it happens.

```
API Process                              Frontend
    │                                         │
    │  GET /api/events                        │
    │  Content-Type: text/event-stream        │
    │                                         │
    │  event: execution:progress              │
    │  data: { taskId, status, progress }     │ → Updates progress bar
    │                                         │
    │  event: execution:log                   │
    │  data: { taskId, level, message }       │ → Appends to log panel
    │                                         │
    │  event: execution:completed             │
    │  data: { taskId, prUrl, outcome }       │ → Shows PR link
    │                                         │
    │  event: batch:task:completed            │
    │  event: batch:completed                 │ → Updates batch UI
```

The server maintains a `Map<clientId, Response>` of connected SSE clients. `broadcast(event, data)` writes to all. The frontend `SSEProvider` component wraps the app, and `useKanbanBoard` processes events to update React state.

## Agent Integration

Each user gets a dedicated Docker container running OpenCode for isolated task execution. The agent layer is designed to support multiple providers:

| Agent | Status |
|-------|--------|
| OpenCode | Integrated |
| Claude Code | Planned |
| Codex | Planned |
| Aider | Planned |

## Production Deployment

Production runs on a DigitalOcean droplet at `https://rixie.in`.

```
┌─────────────────────────────────────────────────────────────┐
│              DigitalOcean Droplet (rixie.in)                 │
│                                                             │
│  PM2 Process Manager                                        │
│  └── openlinear-api  (Express, port 3001)                   │
│                                                             │
│  Note: Dashboard is desktop-only (Tauri app).               │
│        Landing page deployed separately on Vercel.          │
│                                                             │
│  Docker                                                     │
│  ├── openlinear-db         (PostgreSQL 16, port 5432)       │
│  ├── opencode-user-{uid1}  (port 30000)                     │
│  ├── opencode-user-{uid2}  (port 30001)                     │
│  └── ...                   (one per active user)            │
│                                                             │
│  /opt/openlinear/          ← deploy directory               │
│  /tmp/openlinear-repos/    ← cloned repos + worktrees       │
│                                                             │
│  Docker volumes:                                            │
│    opencode-auth-{userId}   → provider API keys             │
│    opencode-config-{userId} → OpenCode config               │
│    postgres-data            → database                      │
└─────────────────────────────────────────────────────────────┘
```

### CI/CD Pipeline

**API Deployment (Droplet):**
Push to `main` triggers automatic deployment of the API:

1. GitHub Actions builds API
2. SSH to droplet → run `/opt/openlinear/deploy.sh`
3. Deploy script: `git pull` → `pnpm install` → postgres up → prisma migrate → build worker image → build API → PM2 restart
4. Health check: `curl https://api.yourdomain.com/health`

**Landing Page (Vercel):**
The marketing landing page (`apps/landing`) is deployed separately to Vercel.

**Desktop App:**
The dashboard UI is only available in the Tauri desktop app, not deployed as a web service.

### Release Pipeline

Tag push (`v*`) triggers desktop distribution:

1. Builds Tauri desktop app (AppImage + .deb) with API sidecar binary
2. Uploads to GitHub Releases
3. Publishes CLI package to GitHub Packages (npm)
4. AUR package available via `packaging/aur/openlinear-bin/PKGBUILD`

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

## Data Model

```
User
  ├── id, githubId, username, email, avatarUrl
  ├── accessToken (GitHub OAuth), passwordHash (email/password)
  └── teams, settings

Project
  ├── id, name, description
  ├── cloneUrl, defaultBranch
  └── tasks[]

Task
  ├── id, title, description, status, priority, order, labels
  ├── executionStatus, executionProgress
  ├── branchName, prUrl, prNumber
  └── logs (execution log entries)

Settings
  ├── parallelLimit, maxBatchSize
  ├── autoApprove, stopOnFailure
  └── conflictBehavior (skip/fail)
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection | — |
| `JWT_SECRET` | Secret for signing JWTs | — |
| `GITHUB_CLIENT_ID` | GitHub OAuth app client ID | — |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app client secret | — |
| `GITHUB_REDIRECT_URI` | GitHub OAuth callback URL | `http://localhost:3001/api/auth/github/callback` |
| `OPENCODE_IMAGE` | Docker image for worker containers | `opencode-worker:latest` |
| `REPOS_DIR` | Host path for cloned repos | `/tmp/openlinear-repos` |
| `CONTAINER_IDLE_TIMEOUT_MS` | Idle container cleanup timeout | `7200000` (2 hours) |
| `API_PORT` | API server port | `3001` |
| `CORS_ORIGIN` | Allowed CORS origin | `http://localhost:3000` |
