# Decisions - Parallel Execution Plan

## Architecture
- Batches are EPHEMERAL (in-memory only, NOT persisted to DB)
- Git worktrees for true parallel task execution (shared .git, separate working dirs)
- Worktree base path: `/tmp/openlinear-repos/{projectId}/`
- Main bare clone at `.main/`, worktrees at `batch-{batchId}/task-{taskId}/`
- Single batched PR: merge all task branches into batch branch, then PR

## User Decisions
- Repo Strategy: Shared repo, different branches (git worktrees)
- Queue Behavior: Default wait-for-approval, option auto-continue (settings)
- Failure Handling: Continue others, settings option for stop-all
- PR Strategy: Batched single PR (separate branches, auto-merge into batch branch)
- Conflict Handling: Skip conflicting task, continue others, notify user
- Cancel Granularity: Individual tasks within batch
- Max Batch Size: Configurable in settings, default 3
