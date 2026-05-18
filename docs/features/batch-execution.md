# Batch Execution

Run multiple tasks together: simultaneously, one at a time, or combined into one agent session.

## Creating a Batch

Select multiple tasks from the board using checkboxes, then choose a mode from the floating control bar.

**API:** `POST /api/batches`

```json
{
  "taskIds": ["uuid-1", "uuid-2", "uuid-3"],
  "mode": "parallel"
}
```

Maximum 20 tasks per batch request.

## Execution Modes

### Parallel

Runs up to `maxConcurrent` tasks at the same time (configured in Settings, default 3). When a task finishes, the next queued task starts automatically.

### Queue

Runs tasks strictly one at a time. Two sub-modes:
- **Auto-approve** (`queueAutoApprove: true`): the next task starts immediately when the current one finishes.
- **Manual approval** (`queueAutoApprove: false`): waits for the user to approve the next task via `POST /api/batches/:id/approve`.

### Combined

Runs all selected tasks in one OpenCode session with one combined prompt. Combined mode uses one worktree and one branch for the whole selected set, then marks all selected tasks Done together when the session completes with committable changes. If the combined session fails, no selected task is marked Done.

## Git Isolation with Worktrees

Unlike single-task execution (which uses a full shallow clone), batch execution uses git worktrees for efficiency:

1. A bare clone is created (or fetched) as the main repo at `{REPOS_DIR}/{projectId}/.main`
2. Parallel and Queue tasks each get their own worktree at `{REPOS_DIR}/{projectId}/batch-{batchId}/task-{taskId}`
3. Combined mode gets one worktree at `{REPOS_DIR}/{projectId}/batch-{batchId}/combined`
4. Parallel and Queue tasks use per-task branches: `openlinear/{taskId}`
5. Combined mode uses the batch branch directly: `openlinear/batch-{batchId}`

This means multiple tasks can work in the same repo simultaneously without conflicts during execution.

## Merge Phase

When all tasks complete, the batch enters the merge phase:

1. For Parallel and Queue, create a batch branch: `openlinear/batch-{batchId}` from the default branch
2. For each completed Parallel or Queue task, merge its branch into the batch branch
3. For Combined, use the already-committed batch branch directly
4. Push the batch branch
5. Create a single PR containing all completed changes

### Conflict Handling

| Setting | Behavior |
|---------|----------|
| `skip` (default) | Conflicting tasks are skipped; remaining tasks are included in the PR |
| `fail` | First conflict fails the entire batch; no PR is created |

## Task Lifecycle Within a Batch

```
queued -> running -> completed
                  -> failed
                  -> skipped (merge conflict with skip mode)
                  -> cancelled (manual cancel)
```

## Batch Lifecycle

```
pending -> running -> merging -> completed
                             -> failed
                   -> cancelled
```

## Stop on Failure

When `stopOnFailure` is enabled, the batch is cancelled as soon as any task fails. All remaining queued tasks are not started.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/batches` | Create and start a batch |
| `GET` | `/api/batches` | List active batches |
| `GET` | `/api/batches/:id` | Get batch status with per-task progress |
| `POST` | `/api/batches/:id/cancel` | Cancel entire batch |
| `POST` | `/api/batches/:id/tasks/:taskId/cancel` | Cancel one task in a batch |
| `POST` | `/api/batches/:id/approve` | Approve next task (queue mode) |

## SSE Events

- `batch:created` -- batch initialized
- `batch:started` -- execution begins
- `batch:task:started` -- individual task starts
- `batch:task:completed` -- individual task finishes successfully
- `batch:task:failed` -- individual task fails
- `batch:task:skipped` -- task skipped due to merge conflict
- `batch:task:cancelled` -- individual task cancelled
- `batch:merging` -- merge phase started
- `batch:completed` -- batch done, PR created
- `batch:failed` -- batch failed (conflict in fail mode or fatal error)
- `batch:cancelled` -- batch cancelled by user

## Batch Progress Response

```json
{
  "id": "batch-uuid",
  "status": "running",
  "mode": "parallel",
  "tasks": [...],
  "prUrl": null,
  "progress": {
    "total": 5,
    "completed": 2,
    "failed": 0,
    "running": 2,
    "queued": 1,
    "skipped": 0,
    "cancelled": 0,
    "percentage": 40
  }
}
```
