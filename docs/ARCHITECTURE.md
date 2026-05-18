# Architecture

A deep dive into how OpenLinear works — from authentication to task execution.

<p align="center">
<img src="diagrams/architecture.svg" alt="OpenLinear Architecture" width="100%"/>
</p>

## System Overview

OpenLinear is a monorepo with four main components: a Next.js desktop UI (`apps/desktop-ui`), a cloud metadata API (`apps/api`), a local execution sidecar (`apps/sidecar`), and a Neon cloud PostgreSQL database. The cloud API runs at openlinear.tech and handles all metadata (auth, tasks, teams, repos, etc.). The sidecar runs locally inside the Tauri desktop app, manages OpenCode, and handles all task execution.

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
│  │        Local Sidecar (apps/sidecar) — Express.js      │  │
│  │   Execute │ Cancel │ Batch │ OpenCode │ Brainstorm     │  │
│  │   Imports @openlinear/api/{app,sse,middleware}         │  │
│  └──────┬────────────────────┬─────────────────────────┘   │
│         │ HTTP (metadata)    │ spawn + manage               │
└─────────┼────────────────────┼─────────────────────────────┘
          │                    │
┌─────────▼──────────────┐  ┌──▼────────────────────────────┐
│  Cloud API (apps/api)  │  │  OpenCode (host machine)      │
│  Express — openlinear.tech    │  │  No containers, direct run    │
│  Auth, Tasks, Labels   │  └───────────────────────────────┘
│  Teams, Repos, Inbox   │
│  Neon PostgreSQL       │
└────────────────────────┘
```

## Authentication

GitHub OAuth is the only login method. The OAuth flow exchanges a code for a GitHub access token, upserts the user, stores the `accessToken` in the database, and redirects back to the frontend with a JWT in the URL. Scopes requested: `read:user user:email repo`.

After login, all AI provider keys (OpenAI, Anthropic, etc.) are managed by OpenCode itself on the user's machine, not by OpenLinear.

### Token Flow

1. Frontend stores the JWT in `localStorage`
2. Every API call includes `Authorization: Bearer {token}`
3. API middleware (`requireAuth` / `optionalAuth`) verifies the JWT and populates `req.userId`
4. `req.userId` drives task execution — each task runs with the user's credentials

### GitHub Token Usage

The `User.accessToken` (GitHub OAuth token) is used for:
- Fetching user repositories (`GET https://api.github.com/user/repos`)
- Cloning repos with auth (`https://oauth2:{token}@github.com/...`)
- Creating PRs via GitHub API (`POST /repos/{owner}/{repo}/pulls`)

## OpenCode on Host Machine

OpenCode runs directly on your machine, managed by the local sidecar (`apps/sidecar`). No containers, no isolation overhead — the agent works with your local repositories and system environment.

OpenCode uses a local SDK server that communicates directly with the host filesystem, allowing tasks to be executed in isolated git worktrees without container overhead.

## Task Execution

OpenLinear supports three batch execution modes: **parallel**, **queue**, and **combined**. Parallel and Queue use git worktrees to isolate each task in its own branch and working directory, then merge results into a single batched PR. Combined uses one worktree, one branch, and one agent session for all selected tasks.

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
Sidecar: executeTask({ taskId, userId })
        │ (fetches task metadata from Cloud API)
        ▼
1. CONCURRENCY CHECK
   └── If running >= parallelLimit (default 3) → reject

2. REPOSITORY SETUP
   ├── Clone: git clone https://oauth2:{token}@github.com/{repo} /tmp/openlinear-repos/{taskId}
   └── Branch: git checkout -b openlinear/{taskId}

3. OPENCODE SESSION
    ├── OpenCode runs on the host machine
    ├── Create session with task directory
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

Batch execution runs multiple tasks through git worktrees (not full clones) and produces a single PR.

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

#### Combined Mode

- Runs all selected tasks in one OpenCode session with one combined prompt
- Uses one worktree at `batch-{batchId}/combined`
- Commits directly on `openlinear/batch-{batchId}`
- Marks all selected tasks Done together only when the combined session succeeds

#### Batch Flow

```
UI: Select tasks → "Execute Batch" → Choose mode
        │
        ▼
POST /api/batches to sidecar { taskIds, mode }
        │
        ▼
1. REPO SETUP
   └── ensureMainRepo() → git clone --bare into /tmp/openlinear-repos/{projectId}/.main

2. PER-TASK EXECUTION
   ├── createWorktree() → git worktree add .../batch-{batchId}/task-{taskId}
   ├── combined mode uses createBatchWorktree() → .../batch-{batchId}/combined
   ├── getClientForUser(userId, worktreePath) → connects to OpenCode sidecar
   ├── client.session.create({ directory: worktreePath })
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
| Branch | `openlinear/{taskId}` | Per-task branches merged into `openlinear/batch-{batchId}`; combined commits directly on the batch branch |
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
Sidecar                                  Frontend
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

OpenCode is the AI agent that executes tasks. The agent runs directly on your machine, managed by the local sidecar (`apps/sidecar`). Task execution is designed to support multiple providers:

| Agent | Status |
|-------|--------|
| OpenCode | Integrated |
| Claude Code | Planned |
| Codex | Planned |
| Aider | Planned |

## Production Deployment

Production runs on a DigitalOcean droplet at `https://openlinear.tech`.

```
┌─────────────────────────────────────────────────────────────┐
│              DigitalOcean Droplet (openlinear.tech)                 │
│                                                             │
│  PM2 Process Manager                                        │
│  ├── openlinear-api  (Express, port 3001)                   │
│  └── openlinear-web  (Next.js, port 3000)                   │
│                                                             │
│  Metadata API only: auth, tasks, labels, settings,          │
│  teams, projects, inbox, repos, SSE events, health          │
│  No execution, no OpenCode                                  │
│                                                             │
│  Database: Neon cloud PostgreSQL (external)                 │
│                                                             │
│  /opt/openlinear/          ← deploy directory               │
└─────────────────────────────────────────────────────────────┘
```

### CI/CD Pipeline

Push to `main` triggers automatic deployment:

1. GitHub Actions builds API + Web
2. SSH to droplet → run `/opt/openlinear/deploy.sh`
3. Deploy script: `git pull` → `pnpm install` → prisma migrate → build apps → PM2 restart
4. Health check: `curl https://openlinear.tech/health`

### Release Pipeline

Tag push (`v*`) triggers desktop distribution:

1. Builds Tauri desktop app (AppImage + .deb) with sidecar binary (`openlinear-sidecar`) and OpenCode binary
2. Uploads to GitHub Releases
3. Publishes CLI package to GitHub Packages (npm)
4. AUR package available via `packaging/aur/openlinear-bin/PKGBUILD`

## Data Model

```
User
  ├── id, githubId, username, email, avatarUrl
  ├── accessToken (GitHub OAuth)
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
| `REPOS_DIR` | Host path for cloned repos | `/tmp/openlinear-repos` |
| `API_PORT` | API server port | `3001` |
| `CORS_ORIGIN` | Allowed CORS origin | `http://localhost:3000` |
