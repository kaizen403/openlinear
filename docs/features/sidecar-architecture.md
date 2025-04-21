# Sidecar Architecture

## Overview

The sidecar is a local Express server that runs alongside the Tauri desktop app. It owns the OpenCode process, manages task execution, handles git operations, and streams real-time progress to the desktop UI over SSE. The sidecar starts on port `3001` and also runs a lightweight OAuth interceptor on port `1455`.

---

## Architecture

```
apps/sidecar/src/
  index.ts                      Entry point, startup sequence
  app.ts                        Express app factory, route mounting
  routes/
    execution.ts                Task execute/cancel/logs/permissions endpoints
    opencode.ts                 Model catalog, provider auth endpoints
    batches.ts                  Batch execution endpoints
  services/
    opencode.ts                 OpenCode server lifecycle
    opencode-catalog.ts         Model catalog aggregation
    git-identity.ts             Git author/committer env vars
    delta-buffer.ts             LLM token delta buffering
    worktree.ts                 Git worktree management for batch runs
    batch.ts                    Batch execution orchestration
    execution/
      index.ts                  Public API re-exports
      lifecycle.ts              executeTask / cancelTask
      events.ts                 OpenCode event stream handler
      state.ts                  In-memory execution state, SSE helpers
      git.ts                    Clone, branch, commit, push, PR creation
```

---

## Implementation Details

### 1. Startup Sequence (`apps/sidecar/src/index.ts`)

The sidecar starts in two phases:

**Phase 1 — OpenCode initialization**

`initOpenCode()` resolves the binary, probes for an existing server, and spawns one if needed. If this fails, the sidecar logs a warning and continues — task execution will fail with a clear error, but the rest of the API remains available.

**Phase 2 — HTTP servers**

The main Express app listens on `API_PORT` (default `3001`). A second minimal Express app listens on port `1455` as an OAuth interceptor:

- `GET /callback` — redirects to `openlinear://callback?<params>` (Tauri deep link)
- `GET /auth/callback` — redirects to `FRONTEND_URL/auth/callback?<params>`

The interceptor handles the OAuth redirect from GitHub during provider authentication. If port `1455` is already in use, the sidecar logs a warning and continues without it.

---

### 2. Express App (`apps/sidecar/src/app.ts`)

`createSidecarApp()` calls `createApp()` from `@openlinear/api/app` (the shared base app with health, SSE, and CRUD routes) and mounts three additional routers:

| Mount point | Router | Purpose |
|---|---|---|
| `/api/tasks` | `executionRouter` | Execute, cancel, logs, permissions, PR refresh |
| `/api/opencode` | `opencodeRouter` | Model catalog, provider auth |
| `/api/batches` | `batchesRouter` | Batch task execution |

The execution router overrides the CRUD-only task routes from the base app with execution-aware endpoints.

---

### 3. Execution Engine

#### State (`apps/sidecar/src/services/execution/state.ts`)

Three in-memory maps track running work:

| Map | Key | Value | Purpose |
|---|---|---|---|
| `activeExecutions` | `taskId` | `ExecutionState` | Tasks past the startup phase |
| `startingExecutions` | `taskId` | `StartupExecutionState` | Tasks still cloning/branching |
| `sessionToTask` | `sessionId` | `taskId` | Fast reverse lookup for event routing |

`ExecutionState` holds everything needed for a running task:

```typescript
interface ExecutionState {
  taskId, projectId, sessionId, repoPath, branchName
  userId, accessToken
  timeoutId          // 30-minute hard timeout
  status             // 'cloning' | 'executing' | 'committing' | 'creating_pr' | 'done' | 'error'
  logs               // ExecutionLogEntry[]
  client             // OpencodeClient
  startedAt, filesChanged, toolsExecuted
  promptSent, cancelled
  promptAbortController
  pendingPermissions
}
```

The 30-minute timeout (`TASK_TIMEOUT_MS`) calls `cancelTask()` automatically.

`estimateProgress()` computes a 0–95% progress estimate from tools executed (5% each, max 40%), files changed (10% each, max 30%), and elapsed time (3% per minute, max 20%).

`persistLogs()` writes the in-memory log array to the `executionLogs` JSONB column in the `tasks` table via a raw SQL update.

#### Lifecycle (`apps/sidecar/src/services/execution/lifecycle.ts`)

`executeTask({ taskId, userId })` runs the full startup sequence:

1. **Guard checks** — rejects if already running or parallel limit reached (default 3, from `settings.parallelLimit`)
2. **Branch name** — `openlinear/<first 8 chars of taskId>`
3. **Startup state** — registers in `startingExecutions` with an `AbortController`
4. **Repository resolution** — checks `task.project.localPath` first (local dev), then `task.project.repository`, then falls back to the first active repository for the user
5. **Clone or branch** — for remote repos: `git clone --depth 1` then `git checkout -B <branch>`; for local paths: `git checkout -B <branch>` only
6. **Session creation** — `client.session.create({ body: { title } })` with the startup abort signal
7. **Transition** — moves from `startingExecutions` to `activeExecutions`, registers in `sessionToTask`
8. **Prompt construction** — concatenates `task.title`, `task.description`, and label names
9. **Model resolution** — calls `resolveOpenCodeModelSelection()` to get the active model; passes `{ providerID, modelID }` to the prompt if set
10. **Event subscription** — `subscribeToSessionEvents()` starts listening on the OpenCode event stream
11. **Prompt dispatch** — `client.session.prompt()` fires asynchronously; errors are caught and broadcast as `execution:progress` events

Cancellation during startup aborts the `AbortController`, which propagates to the in-flight `git clone` or `session.create` call via the `signal` parameter.

`cancelTask(taskId)` handles both startup and active phases:
- Startup: sets `cancelRequested`, aborts the controller
- Active: sets `cancelled`, aborts the prompt controller, calls `client.session.abort()`, persists logs, cleans up state

#### Events (`apps/sidecar/src/services/execution/events.ts`)

`subscribeToSessionEvents(taskId, client, sessionId)` calls `client.event.subscribe()` and iterates the async event stream. Each event is filtered by session ID before being dispatched to `handleOpenCodeEvent()`.

Event routing:

| Event type | Action |
|---|---|
| `session.idle` / `session.completed` | Flush delta buffer, call `handleSessionComplete()` |
| `session.error` | Extract error, classify as auth/rate-limit/generic, broadcast and cancel |
| `session.status` (busy) | Mark thinking, log "Agent is thinking..." |
| `session.status` (retry) | Log retry reason |
| `message.part.updated` (text) | Append to delta buffer |
| `message.part.updated` (tool) | Flush buffer, log tool start/complete/error |
| `message.part.updated` (reasoning) | Append to reasoning buffer |
| `tool.execute.before` | Flush buffer, log tool start |
| `tool.execute.after` | Increment `toolsExecuted`, log completion |
| `file.edited` | Increment `filesChanged`, log filename |
| `permission.updated` | Add to `pendingPermissions`, broadcast `permission:requested` |

`handleSessionComplete()` runs after the agent finishes:

1. Calls `commitAndPush()` — stages all changes, commits with `feat: <task title>`, force-pushes the branch
2. If pushed: calls `createPullRequest()` via GitHub API; falls back to a compare URL if no access token or API error
3. Updates task status to `done` with `prUrl` and `outcome`
4. Persists logs and cleans up state

#### Git Operations (`apps/sidecar/src/services/execution/git.ts`)

`cloneRepository()` clones with `--depth 1` for speed, injects the OAuth token into the URL as `https://oauth2:<token>@...`, and runs `chmod -R a+rwX` on the result to ensure the OpenCode process can write files.

`commitAndPush()` uses `getGitIdentityEnv()` to set author/committer identity, commits with a normalized message (`feat: <lowercase title, max 50 chars>`), and force-pushes. Force push is safe because these are ephemeral per-task branches created fresh each run.

`createPullRequest()` posts to the GitHub REST API. On any failure (no token, API error, network error) it returns a compare URL instead of throwing, so the user always gets a link.

---

### 4. Git Identity (`apps/sidecar/src/services/git-identity.ts`)

`getGitIdentityEnv()` returns a `Record<string, string>` with four git environment variables. Resolution order for each:

1. Standard git env var (`GIT_AUTHOR_NAME`, etc.)
2. OpenLinear-prefixed env var (`OPENLINEAR_GIT_AUTHOR_NAME`, etc.)
3. Default: name `'OpenLinear Agent'`, email `'agent@openlinear.local'`

Committer defaults to the same values as author unless overridden separately. This object is spread into `exec` options so git commits are attributed correctly.

---

### 5. Delta Buffering (`apps/sidecar/src/services/delta-buffer.ts`)

The OpenCode SDK streams LLM output as token-level deltas. Without buffering, each token becomes a separate log entry. The delta buffer accumulates tokens and flushes them as complete sentences.

Each task gets a `BufferState` with separate accumulators for `text` and `reasoning`, plus debounce timers.

**Text deltas** (`appendTextDelta`): accumulated and flushed after 800ms of silence. Entries longer than 500 characters are dropped (partial tool output, not useful as log lines).

**Reasoning deltas** (`appendReasoningDelta`): accumulated and flushed after 800ms, prefixed with `"Thinking: "` and truncated to 200 characters.

**Immediate flush** (`flushDeltaBuffer`): called before any non-text event (tool call, session complete) to ensure buffered text is emitted before the next event.

**Cleanup** (`cleanupDeltaBuffer`): called during `cleanupExecution()` to cancel pending timers and remove the buffer from the map.

---

### 6. Worktree Management (`apps/sidecar/src/services/worktree.ts`)

The worktree service is used by the batch execution path. Instead of cloning a fresh copy per task, it maintains a single bare clone per project and creates git worktrees for each task.

**`ensureMainRepo(projectId, cloneUrl, accessToken)`** — creates a bare clone at `$REPOS_DIR/<projectId>/.main` on first call, or runs `git fetch origin --prune` on subsequent calls.

**`createWorktree(projectId, batchId, taskId, defaultBranch)`** — creates a worktree at `$REPOS_DIR/<projectId>/batch-<batchId>/task-<taskId>` on branch `openlinear/<taskId>`. Before creating, it removes any stale worktree or branch with the same name.

**`removeWorktree(projectId, worktreePath)`** — runs `git worktree remove --force` and falls back to `rmSync` if the git command fails.

**`mergeBranch(projectId, taskBranch, targetBranch)`** — creates a temporary worktree at `merge-temp`, runs `git merge --no-ff`, updates the target branch ref directly in the bare repo, and cleans up. Returns `false` on merge conflict without throwing.

**`pushBranch(projectId, branchName, cloneUrl, accessToken)`** — pushes from the bare repo using `git push <url> <branch>`.

**`cleanupBatch(projectId, batchId)`** — removes all worktrees under `batch-<batchId>/` and deletes the batch directory.

---

### 7. Execution Routes (`apps/sidecar/src/routes/execution.ts`)

All routes are mounted at `/api/tasks`.

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/:id/execute` | Optional | Start task execution |
| `POST` | `/:id/cancel` | None | Cancel running task |
| `GET` | `/:id/running` | None | Check if task is running |
| `GET` | `/:id/logs` | None | Get execution logs (memory or DB) |
| `GET` | `/:id/permissions` | None | Get pending permissions |
| `POST` | `/:id/permissions/:permissionId/respond` | None | Respond to a permission request |
| `POST` | `/:id/refresh-pr` | Optional | Upgrade compare URL to real PR URL |

The logs endpoint falls back to the database when the task is no longer in memory — it queries `executionLogs` from the `tasks` table via raw SQL.

The `refresh-pr` endpoint parses a GitHub compare URL (`/compare/base...branch`), queries the GitHub API for open/closed PRs on that branch, and updates the task record if a real PR is found.

Permission responses are forwarded to the OpenCode session via `client.postSessionIdPermissionsPermissionId()` with the user's choice (`once`, `always`, or `reject`).

---

## Key Files

| File | Role |
|---|---|
| `apps/sidecar/src/index.ts` | Entry point, startup sequence, OAuth interceptor |
| `apps/sidecar/src/app.ts` | Express app factory, route mounting |
| `apps/sidecar/src/routes/execution.ts` | Task execution REST API |
| `apps/sidecar/src/routes/opencode.ts` | Model catalog and provider auth REST API |
| `apps/sidecar/src/services/execution/lifecycle.ts` | `executeTask` and `cancelTask` |
| `apps/sidecar/src/services/execution/events.ts` | OpenCode event stream handler |
| `apps/sidecar/src/services/execution/state.ts` | In-memory maps, SSE helpers, log persistence |
| `apps/sidecar/src/services/execution/git.ts` | Clone, branch, commit, push, PR creation |
| `apps/sidecar/src/services/delta-buffer.ts` | Token delta accumulation and debounced flush |
| `apps/sidecar/src/services/worktree.ts` | Bare clone + git worktree management for batches |
| `apps/sidecar/src/services/git-identity.ts` | Git author/committer env var resolution |
| `apps/sidecar/src/services/opencode.ts` | OpenCode server lifecycle |
