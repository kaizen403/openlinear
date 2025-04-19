# Batch Execution

## Overview

Batch execution lets users run multiple tasks simultaneously (or sequentially) against a shared repository. Instead of cloning a fresh copy per task, the batch system uses git worktrees — lightweight checkouts branched off a single bare clone. When all tasks complete, their branches are merged into a shared batch branch, pushed to GitHub, and a single pull request is created covering all the work.

---

## Architecture

```
Desktop UI (batch-*.tsx components)
    │  POST /api/batches
    │  GET  /api/batches/:id
    │  POST /api/batches/:id/cancel
    │  POST /api/batches/:id/approve
    ▼
apps/sidecar/src/routes/batches.ts          ← HTTP layer
    │
    ▼
apps/sidecar/src/services/batch.ts          ← Batch orchestration
    │
    ├── apps/sidecar/src/services/worktree.ts   ← Git worktree management
    │
    └── OpenCode AI agent (one session per task)
            │
            ▼
        GitHub API (push + PR creation)
```

The batch service is entirely in-memory during execution. There is no `Batch` database model — the batch ID is stored on each `Task` record via the `batchId` field, and the batch state lives in the `activeBatches` Map.

---

## Data Model

### In-memory batch state (`apps/sidecar/src/services/batch.ts`)

```typescript
// From apps/sidecar/src/types/batch.ts (referenced in batch.ts)
interface BatchState {
  id: string;
  projectId: string;
  mode: 'parallel' | 'queue';
  status: 'pending' | 'running' | 'merging' | 'completed' | 'failed' | 'cancelled';
  tasks: BatchTask[];
  settings: BatchSettings;
  mainRepoPath: string;         // path to the bare clone
  batchBranch: string;          // e.g. "openlinear/batch-{id.slice(0,8)}"
  prUrl: string | null;
  accessToken: string | null;
  userId: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

interface BatchTask {
  taskId: string;
  title: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped';
  worktreePath: string | null;  // e.g. "/tmp/openlinear-repos/{projectId}/batch-{batchId}/task-{taskId}"
  branch: string;               // e.g. "openlinear/{taskId}"
  sessionId: string | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

interface BatchSettings {
  maxConcurrent: number;        // from Settings.maxBatchSize, default 3
  autoApprove: boolean;         // from Settings.queueAutoApprove, default false
  stopOnFailure: boolean;       // from Settings.stopOnFailure, default false
  conflictBehavior: 'skip' | 'fail'; // from Settings.conflictBehavior, default 'skip'
}
```

Two lookup maps are maintained:

```typescript
const activeBatches = new Map<string, BatchState>();
const sessionToBatch = new Map<string, { batchId: string; taskId: string }>();
```

### Database fields

The `Task` model stores the batch association:

```prisma
batchId String?   // groups tasks executed together
```

Execution results are written back to the task:

```prisma
executionStartedAt DateTime?
executionElapsedMs Int
executionProgress  Int?
prUrl              String?
outcome            String?
executionLogs      Json?
```

### Settings model

```prisma
model Settings {
  id               String  @id @default("default")
  maxBatchSize     Int     @default(3)
  queueAutoApprove Boolean @default(false)
  stopOnFailure    Boolean @default(false)
  conflictBehavior String  @default("skip")
}
```

---

## API Endpoints

All routes are mounted at `/api/batches` in `apps/sidecar/src/routes/batches.ts`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/batches` | optional | Create and start a batch |
| `GET` | `/api/batches` | none | List all active batches (summary) |
| `GET` | `/api/batches/:id` | none | Get batch status with progress breakdown |
| `POST` | `/api/batches/:id/cancel` | none | Cancel an entire batch |
| `POST` | `/api/batches/:id/tasks/:taskId/cancel` | none | Cancel a single task within a batch |
| `POST` | `/api/batches/:id/approve` | none | Approve the next queued task (queue mode) |

### `POST /api/batches` request body

```typescript
{
  taskIds: string[],   // 1–20 task IDs
  mode: 'parallel' | 'queue'
}
```

### `GET /api/batches/:id` response

```typescript
{
  id: string,
  status: string,
  mode: string,
  tasks: BatchTask[],
  prUrl: string | null,
  createdAt: string,
  completedAt: string | null,
  progress: {
    total: number,
    completed: number,
    failed: number,
    running: number,
    queued: number,
    skipped: number,
    cancelled: number,
    percentage: number,   // (completed + failed + skipped + cancelled) / total * 100
  }
}
```

---

## Implementation Details

### Batch creation (`createBatch`)

1. Generate a UUID for the batch.
2. Read `Settings` from the database to populate `BatchSettings`.
3. Resolve the repository: check `task.project.repository` first, then fall back to the user's active repository.
4. Call `ensureMainRepo(projectId, cloneUrl, accessToken)` to set up the bare clone.
5. Build `BatchTask` objects for each task ID, all starting with `status: 'queued'`.
6. Write `batchId` to all tasks in the database via `prisma.task.updateMany`.
7. Broadcast `batch:created` SSE event.

### Worktree setup (`worktree.ts`)

The batch system uses a bare clone as the central repository, with one git worktree per task:

```
/tmp/openlinear-repos/
  {projectId}/
    .main/                          ← bare clone (git clone --bare)
    batch-{batchId}/
      task-{taskId1}/               ← worktree for task 1
      task-{taskId2}/               ← worktree for task 2
    merge-temp/                     ← temporary worktree used during merge
```

`ensureMainRepo` either creates the bare clone or fetches the latest from origin:

```typescript
if (existsSync(mainRepoPath)) {
  await execAsync(`git -C ${mainRepoPath} fetch origin --prune`);
} else {
  await execAsync(`git clone --bare ${url} ${mainRepoPath}`);
}
```

`createWorktree` creates an isolated checkout for each task:

```typescript
// Clean up any stale worktree or branch with the same name
await execAsync(`git -C ${mainRepoPath} branch -D ${branchName}`).catch(() => {});

// Create the worktree on a new branch
await execAsync(
  `git -C ${mainRepoPath} worktree add ${worktreePath} -b ${branchName} ${defaultBranch}`
);
```

### Parallel vs. queue mode

**Parallel mode**: On `startBatch`, up to `settings.maxConcurrent` tasks are started simultaneously. When any task completes, `advanceQueue` starts the next queued task to maintain the concurrency level.

**Queue mode**: Only one task runs at a time. After each task completes, `advanceQueue` checks `settings.autoApprove`. If true, the next task starts automatically. If false, execution pauses until `POST /api/batches/:id/approve` is called.

```typescript
async function advanceQueue(batch: BatchState): Promise<void> {
  const hasRemaining = batch.tasks.some(t => t.status === 'queued' || t.status === 'running');
  if (!hasRemaining) { await finalizeBatch(batch.id); return; }

  const nextIndex = batch.tasks.findIndex(t => t.status === 'queued');
  if (nextIndex === -1) return;

  if (batch.mode === 'parallel') {
    startTask(batch, nextIndex);
  } else if (batch.settings.autoApprove) {
    startTask(batch, nextIndex);
  }
  // else: wait for manual approval
}
```

### Per-task execution

Each task in a batch follows this flow inside `startTask`:

1. Create a worktree via `createWorktree`.
2. Get an OpenCode client pointed at the worktree path.
3. Create an OpenCode session.
4. Register `sessionId` in `sessionToBatch` for event routing.
5. Subscribe to OpenCode events via `subscribeToTaskEvents`.
6. Send the task prompt (title + description + optional model override).

### Event handling in batch context

`subscribeToTaskEvents` mirrors the single-task event handler but routes events through `sessionToBatch` instead of `sessionToTask`. The same event types are handled (`session.completed`, `session.error`, `message.part.updated`, `tool.execute.before/after`, `file.edited`).

On `session.completed` or `session.idle`, `handleTaskComplete(batchId, taskId, true)` runs:

1. Check `git status --porcelain` in the worktree.
2. If changes exist: `git add -A` + `git commit -m "feat: {title}"`.
3. Update task status to `done` in the database.
4. Persist logs to `task.executionLogs`.
5. Call `advanceQueue` to start the next task.

### Finalization and merge (`finalizeBatch`)

When all tasks are done (no more `queued` or `running`):

1. Set batch status to `'merging'`.
2. Create the batch branch: `git -C {mainRepoPath} branch openlinear/batch-{id} {defaultBranch}`.
3. For each completed task, merge its branch into the batch branch using a temporary worktree:

```typescript
// Creates merge-temp worktree on the batch branch
await execAsync(`git -C ${mainRepoPath} worktree add ${mergePath} ${targetBranch}`);
await execAsync(`git -C ${mergePath} merge --no-ff ${taskBranch} -m "Merge ${taskBranch}"`, { env });
// Updates the batch branch ref to the merge commit
await execAsync(`git -C ${mainRepoPath} update-ref refs/heads/${targetBranch} ${mergeCommit}`);
```

4. On merge conflict:
   - `conflictBehavior: 'skip'` — mark the task as `skipped`, continue.
   - `conflictBehavior: 'fail'` — mark the task as `failed`, abort the entire batch.

5. Push the batch branch: `git -C {mainRepoPath} push {url} {batchBranch}`.
6. Create a GitHub PR via `POST https://api.github.com/repos/{owner}/{repo}/pulls`:
   - Title: `Batch: {N} tasks`
   - Body: lists each completed task title
   - Falls back to a compare URL if no access token or API failure.
7. Write `prUrl` to all completed tasks in the database.
8. Broadcast `batch:completed`.
9. Clean up all worktrees and the batch directory.

### Cancellation

**Cancel entire batch** (`cancelBatch`):
- Sets `batch.status = 'cancelled'`.
- For each running task: calls `client.session.abort()` and marks it `cancelled`.
- For each queued task: marks it `cancelled` without starting.
- Cleans up all worktrees.

**Cancel single task** (`cancelTask(batchId, taskId)`):
- Marks the task `cancelled`.
- Calls `client.session.abort()` if a session exists.
- Does not affect other tasks in the batch.

### Log persistence

Each task maintains a `BatchLogEntry[]` in `batchTaskLogs` (a module-level Map). On task completion or failure, logs are written to `task.executionLogs` as JSON and the in-memory entry is deleted:

```typescript
await prisma.task.update({
  where: { id: taskId },
  data: { executionLogs: JSON.parse(JSON.stringify(logs)) },
});
batchTaskLogs.delete(taskId);
```

---

## SSE Events

| Event | Payload |
|-------|---------|
| `batch:created` | `{ batchId, mode, status, tasks }` |
| `batch:started` | `{ batchId, mode, status, tasks }` |
| `batch:task:started` | `{ batchId, taskId, title }` |
| `batch:task:completed` | `{ batchId, taskId }` |
| `batch:task:failed` | `{ batchId, taskId, error }` |
| `batch:task:skipped` | `{ batchId, taskId }` |
| `batch:task:cancelled` | `{ batchId, taskId }` |
| `batch:merging` | `{ batchId }` |
| `batch:completed` | `{ batchId, prUrl }` |
| `batch:failed` | `{ batchId }` |
| `batch:cancelled` | `{ batchId }` |
| `execution:log` | `{ taskId, entry }` (per-task log entries) |
| `task:updated` | Full task object (on status changes) |

All batch events include a `timestamp` field added by `broadcastBatchEvent`.

---

## Key Files

| File | Purpose |
|------|---------|
| `apps/sidecar/src/routes/batches.ts` | HTTP route handlers |
| `apps/sidecar/src/services/batch.ts` | Full batch orchestration: create, start, task execution, finalize, cancel |
| `apps/sidecar/src/services/worktree.ts` | Bare clone management, worktree create/remove/merge/push |
| `apps/sidecar/src/types/batch.ts` | TypeScript types for batch state |
| `packages/db/prisma/schema.prisma` | `Task.batchId`, `Settings` batch fields |
