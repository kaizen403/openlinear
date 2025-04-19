# Task Execution

## Overview

Task execution is the core feature of OpenLinear. When a user triggers execution on a task, the sidecar process clones the linked repository (or uses a local path), creates a feature branch, starts an OpenCode AI agent session, streams the agent's work back to the UI in real time, and — when the agent finishes — commits the changes, pushes the branch, and creates a GitHub pull request.

The execution engine lives entirely in `apps/sidecar/src/services/execution/`.

---

## Architecture

```
Desktop UI
    │  POST /api/tasks/:id/execute
    ▼
apps/sidecar/src/routes/execution.ts        ← HTTP layer
    │
    ▼
apps/sidecar/src/services/execution/
    ├── index.ts        ← public exports
    ├── lifecycle.ts    ← executeTask(), cancelTask()
    ├── state.ts        ← in-memory maps, types, helpers
    ├── events.ts       ← OpenCode event stream handler
    └── git.ts          ← clone, branch, commit, push, PR
    │
    ▼
OpenCode AI agent (local process, @opencode-ai/sdk)
    │
    ▼
GitHub API (PR creation)
```

The sidecar is a separate Express process from the main API. It handles all execution-related routes and communicates with the desktop UI via SSE events broadcast through `@openlinear/api/sse`.

---

## Data Model

Execution state is tracked in two places: in-memory during a run, and in the `tasks` table in PostgreSQL after completion.

### In-memory state (`apps/sidecar/src/services/execution/state.ts`)

```typescript
export interface ExecutionState {
  taskId: string;
  projectId: string;
  sessionId: string;           // OpenCode session ID (e.g. "ses_...")
  repoPath: string;            // local path to cloned repo
  branchName: string;          // e.g. "openlinear/abc12345"
  userId: string | null;
  accessToken: string | null;  // GitHub OAuth token
  timeoutId: NodeJS.Timeout;   // 30-minute hard timeout
  status: 'cloning' | 'executing' | 'committing' | 'creating_pr' | 'done' | 'error';
  logs: ExecutionLogEntry[];
  client: OpencodeClient;
  startedAt: Date;
  filesChanged: number;        // incremented on file.edited events
  toolsExecuted: number;       // incremented on tool.execute.after events
  promptSent: boolean;
  cancelled: boolean;
  promptAbortController: AbortController | null;
  pendingPermissions: PendingPermission[];
}
```

Three maps track active work:

```typescript
export const activeExecutions = new Map<string, ExecutionState>();   // taskId → state
export const startingExecutions = new Map<string, StartupExecutionState>(); // taskId → startup state
export const sessionToTask = new Map<string, string>();              // sessionId → taskId
```

`startingExecutions` holds tasks that are still cloning/branching before the OpenCode session is created. This allows cancellation during the startup phase.

### Persisted fields in `tasks` table

```prisma
executionStartedAt DateTime?
executionPausedAt  DateTime?
executionElapsedMs Int       @default(0)
executionProgress  Int?      // 0-100 estimated
prUrl              String?
outcome            String?   // human-readable summary
executionLogs      Json?     // persisted log entries
sessionId          String?
batchId            String?
```

---

## API Endpoints

All routes are mounted at `/api/tasks` in `apps/sidecar/src/routes/execution.ts`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/tasks/:id/execute` | optional | Start execution for a task |
| `POST` | `/api/tasks/:id/cancel` | none | Cancel a running execution |
| `GET` | `/api/tasks/:id/running` | none | Check if a task is currently running |
| `GET` | `/api/tasks/:id/logs` | none | Get execution logs (in-memory or persisted) |
| `GET` | `/api/tasks/:id/permissions` | none | Get pending permission requests |
| `POST` | `/api/tasks/:id/permissions/:permissionId/respond` | none | Respond to a permission request |
| `POST` | `/api/tasks/:id/refresh-pr` | optional | Refresh a compare URL to a real PR URL |

---

## Execution Lifecycle

### Step 1: Pre-flight checks (`lifecycle.ts`)

`executeTask({ taskId, userId })` runs these checks before doing any work:

1. Reject if the task is already in `activeExecutions` or `startingExecutions`.
2. Check `Settings.parallelLimit` (default: 3). Reject if `activeExecutions.size + startingExecutions.size >= limit`.
3. Register a `StartupExecutionState` in `startingExecutions` immediately, so concurrent calls are blocked.

### Step 2: Repository resolution

The sidecar resolves the repository in this priority order:

1. `task.project.localPath` — use the local folder directly, skip cloning.
2. `task.project.repository` — use the linked `Repository` record.
3. User's active repository (`isActive: true` for the user).
4. Public active repository (`userId: null, isActive: true`).

### Step 3: Clone and branch (`git.ts`)

For remote repos:

```typescript
// git.ts
await cloneRepository(project.cloneUrl, repoPath, accessToken, project.defaultBranch, signal);
// → git clone --depth 1 --branch {defaultBranch} {url} {repoPath}
// → chmod -R a+rwX {repoPath}

await createBranch(repoPath, branchName, signal);
// → git checkout -B openlinear/{taskId.slice(0,8)}
```

The clone URL is modified to embed the OAuth token for private repos:
```
https://oauth2:{accessToken}@github.com/owner/repo.git
```

For local paths, only `createBranch` is called — no clone.

The repo is placed at `{REPOS_DIR}/{projectName}/{taskId.slice(0,8)}` where `REPOS_DIR` defaults to `/tmp/openlinear-repos`.

### Step 4: OpenCode session

```typescript
const client = await getClientForUser(userId, repoPath);
const sessionResponse = await client.session.create({ body: { title: task.title } });
const sessionId = sessionResponse.data?.id;
```

The client is configured to point OpenCode at `repoPath` as its working directory. The session ID (format: `ses_...`) is stored in both `ExecutionState.sessionId` and the `sessionToTask` lookup map.

A 30-minute hard timeout is set:
```typescript
const timeoutId = setTimeout(async () => {
  await cancelTask(taskId);
}, TASK_TIMEOUT_MS); // 30 * 60 * 1000
```

### Step 5: Prompt construction

The prompt sent to the agent combines the task title, description, and label names:

```typescript
let prompt = taskWithProject.title;
if (taskWithProject.description) prompt += `\n\n${taskWithProject.description}`;
if (taskWithProject.labels.length > 0) {
  const labelNames = taskWithProject.labels.map(tl => tl.label.name).join(', ');
  prompt += `\n\nLabels: ${labelNames}`;
}
```

If a model override is configured (via `resolveOpenCodeModelSelection`), it's passed in the prompt body.

### Step 6: Event streaming (`events.ts`)

`subscribeToSessionEvents(taskId, client, sessionId)` opens an async event stream from OpenCode and dispatches each event to `handleOpenCodeEvent()`.

Key events handled:

| OpenCode event | Action |
|----------------|--------|
| `session.idle` / `session.completed` | Trigger `handleSessionComplete()` |
| `session.error` | Log error, update task to `cancelled`, cleanup |
| `session.status` (busy) | Set `promptSent = true`, log "Agent is thinking..." |
| `message.part.updated` (text) | Append to delta buffer (batched for efficiency) |
| `message.part.updated` (tool) | Log tool start/complete/error |
| `message.part.updated` (reasoning) | Append to reasoning delta buffer |
| `tool.execute.before` | Flush delta buffer, log tool start |
| `tool.execute.after` | Increment `toolsExecuted`, log completion |
| `file.edited` | Increment `filesChanged`, log file path |
| `permission.updated` | Add to `pendingPermissions`, broadcast `permission:requested` |

The `sessionToTask` map is used to route events to the correct task — events from other sessions are ignored.

### Step 7: Commit and push (`events.ts` → `git.ts`)

When `session.completed` fires, `handleSessionComplete()` runs:

```typescript
// git.ts
const { stdout: status } = await execAsync('git status --porcelain', { cwd: repoPath });
if (!status.trim()) return { status: 'no_changes' };

await execAsync('git add -A', { cwd: repoPath });
const commitMessage = `feat: ${taskTitle.toLowerCase().replace(/[^a-z0-9\s]/g, '').slice(0, 50)}`;
await execAsync(`git commit -m "${commitMessage}"`, { cwd: repoPath, env });
await execAsync(`git push --force -u origin ${branchName}`, { cwd: repoPath, env });
```

Force push is intentional — these are ephemeral task branches created fresh each run.

### Step 8: Pull request creation (`git.ts`)

```typescript
export async function createPullRequest(
  fullName, branchName, defaultBranch, taskTitle, taskDescription, accessToken
): Promise<PullRequestResult>
```

If `accessToken` is available, it calls `POST https://api.github.com/repos/{owner}/{repo}/pulls`. On failure (or no token), it falls back to a compare URL:

```
https://github.com/{owner}/{repo}/compare/{defaultBranch}...{branchName}
```

The `PullRequestResult` type distinguishes between a real PR (`type: 'pr'`) and a compare link (`type: 'compare'`).

### PR URL refresh (`POST /api/tasks/:id/refresh-pr`)

If the task has a compare URL (not a real PR URL), this endpoint polls the GitHub API to check if a PR has been opened for the branch:

```typescript
GET https://api.github.com/repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=all&per_page=1
```

If a PR is found, the task's `prUrl` is updated in the database and broadcast via SSE.

---

## Cancellation

Cancellation works differently depending on the execution phase:

**During startup** (task is in `startingExecutions`):
- Sets `cancelRequested = true` and calls `abortController.abort()`.
- The `AbortSignal` is passed to `git clone` and `git checkout` commands, which abort immediately.

**During execution** (task is in `activeExecutions`):
- Sets `execution.cancelled = true`.
- Aborts the prompt's `AbortController`.
- Calls `client.session.abort({ path: { id: sessionId } })` to stop the OpenCode agent.
- Persists logs and cleans up the execution state.

Progress at cancellation time is estimated:
```typescript
export function estimateProgress(execution: ExecutionState): number {
  const baseProgress = Math.min(execution.toolsExecuted * 5, 40);
  const fileProgress = Math.min(execution.filesChanged * 10, 30);
  const elapsedMinutes = (Date.now() - execution.startedAt.getTime()) / 60000;
  const timeProgress = Math.min(elapsedMinutes * 3, 20);
  return Math.min(Math.round(baseProgress + fileProgress + timeProgress), 95);
}
```

---

## SSE Events Broadcast to UI

| Event | Payload |
|-------|---------|
| `execution:progress` | `{ taskId, status, message, ...data }` |
| `execution:log` | `{ taskId, entry: ExecutionLogEntry }` |
| `task:updated` | Full task object (flattened labels) |
| `permission:requested` | `{ taskId, permission }` |
| `permission:resolved` | `{ taskId, permissionId }` |

---

## Key Files

| File | Purpose |
|------|---------|
| `apps/sidecar/src/routes/execution.ts` | HTTP route handlers |
| `apps/sidecar/src/services/execution/lifecycle.ts` | `executeTask()`, `cancelTask()` |
| `apps/sidecar/src/services/execution/state.ts` | In-memory maps, types, `broadcastProgress()`, `addLogEntry()` |
| `apps/sidecar/src/services/execution/events.ts` | OpenCode event stream subscription and dispatch |
| `apps/sidecar/src/services/execution/git.ts` | `cloneRepository()`, `createBranch()`, `commitAndPush()`, `createPullRequest()` |
| `apps/sidecar/src/services/execution/index.ts` | Public re-exports |
| `packages/db/prisma/schema.prisma` | `Task` model with execution fields |
