# Parallel Task Execution Architecture

## TL;DR

> **Quick Summary**: Implement batch execution system allowing users to multi-select tasks and execute them in parallel (up to N simultaneous) or queue (sequential) mode. Uses git worktrees for parallel branch work, auto-merges into single PR.
> 
> **Deliverables**:
> - Backend batch orchestrator with worktree management
> - Multi-select UI for tasks
> - Batch execution controls (parallel/queue buttons)
> - Real-time batch progress with per-task logs
> - Auto-merge into single PR per batch
> - New settings for batch behavior
> 
> **Estimated Effort**: Large
> **Parallel Execution**: YES - 3 waves
> **Critical Path**: Settings → Backend Batch Service → UI Multi-select → Batch Controls

---

## Context

### Original Request
User wants to execute multiple tasks in parallel or sequentially (queue), working on the same repo with different branches, producing a single batched PR.

### Interview Summary
**Key Discussions**:
- Shared repo with git worktrees for true parallelism
- Two modes: Parallel (up to N) and Queue (one-by-one)
- User multi-selects tasks to form a batch
- Single PR at end via auto-merge of task branches
- Ephemeral batches (in-memory, not persisted to DB)
- Skip conflicting tasks on merge, continue with others
- Cancel individual tasks within batch

### Metis Review
**Identified Gaps** (addressed):
- Batch lifecycle clarified as ephemeral
- Branch merge strategy: auto-merge with conflict skip
- Cancel granularity: per-task
- Max batch size: configurable, default 3

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Frontend (UI)                              │
├─────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐  │
│  │  Multi-Select   │  │  Batch Controls │  │  Batch Progress     │  │
│  │  Checkboxes     │  │  Parallel/Queue │  │  Per-task logs      │  │
│  └────────┬────────┘  └────────┬────────┘  └──────────┬──────────┘  │
│           │                    │                      │              │
│           └────────────────────┼──────────────────────┘              │
│                                │                                      │
│                    POST /api/batches                                  │
│                                │                                      │
└────────────────────────────────┼──────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Backend (API)                                 │
├─────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                    Batch Orchestrator                        │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │    │
│  │  │ BatchState  │  │ TaskQueue   │  │ WorktreeManager     │  │    │
│  │  │ (in-memory) │  │ (parallel/  │  │ (git worktree ops)  │  │    │
│  │  │             │  │  sequential)│  │                     │  │    │
│  │  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │    │
│  │         │                │                    │              │    │
│  │         └────────────────┼────────────────────┘              │    │
│  │                          │                                   │    │
│  │              Per-task OpenCode Sessions                      │    │
│  │                          │                                   │    │
│  └──────────────────────────┼───────────────────────────────────┘    │
│                             │                                        │
│                    ┌────────┴────────┐                               │
│                    │  SSE Broadcast  │                               │
│                    │  batch:*        │                               │
│                    │  execution:*    │                               │
│                    └─────────────────┘                               │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Git Worktree Structure                           │
├─────────────────────────────────────────────────────────────────────┤
│  /tmp/openlinear-repos/{projectId}/                                  │
│  ├── .main/                    ← Bare clone (shared .git)            │
│  ├── batch-{batchId}/                                                │
│  │   ├── task-{taskId1}/       ← Worktree: branch openlinear/{id1}  │
│  │   ├── task-{taskId2}/       ← Worktree: branch openlinear/{id2}  │
│  │   └── task-{taskId3}/       ← Worktree: branch openlinear/{id3}  │
│  └── ...                                                             │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Work Objectives

### Core Objective
Enable users to select multiple tasks and execute them in parallel or queue mode, with all changes merging into a single PR.

### Concrete Deliverables
1. `apps/api/src/services/batch.ts` - Batch orchestrator service
2. `apps/api/src/services/worktree.ts` - Git worktree manager
3. `apps/api/src/routes/batches.ts` - Batch API endpoints
4. Updated `apps/api/src/services/execution.ts` - Integration with batch
5. `apps/desktop-ui/components/board/batch-controls.tsx` - UI controls
6. Updated `apps/desktop-ui/components/board/kanban-board.tsx` - Multi-select
7. Updated `apps/desktop-ui/app/settings/page.tsx` - New settings
8. Updated `packages/db/prisma/schema.prisma` - Settings fields

### Definition of Done
- [x] User can multi-select tasks via checkboxes
- [x] "Execute Parallel" button starts up to N tasks simultaneously
- [x] "Execute Queue" button starts tasks one-by-one
- [x] Each task works in its own git worktree
- [x] Single PR created at batch end with merged changes
- [x] Conflicting task branches skipped with notification
- [x] Individual tasks can be cancelled mid-batch
- [x] Real-time progress shown per-task

### Must Have
- Multi-select UI for tasks
- Parallel and Queue execution modes
- Git worktree isolation per task
- Auto-merge into batch branch
- Single PR per batch
- Per-task progress/logs
- Cancel individual tasks
- Settings for batch size, queue behavior

### Must NOT Have (Guardrails)
- ❌ Database persistence of batches (keep ephemeral)
- ❌ Task dependency graphs or DAG execution
- ❌ Retry/backoff logic (beyond simple conflict skip)
- ❌ Scheduling/cron capabilities
- ❌ Cross-repo batches (single project per batch)
- ❌ Force-push or auto-resolve merge conflicts
- ❌ Pause/resume batch (only cancel)
- ❌ Reorder tasks within running batch

---

## Verification Strategy

### Test Decision
- **Infrastructure exists**: YES (bun test)
- **Automated tests**: Tests-after (unit tests for critical services)
- **Agent-Executed QA**: Playwright for UI, curl for API, tmux for git ops

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately):
├── Task 1: Update Prisma schema with new settings fields
├── Task 2: Create worktree manager service
└── Task 3: Create batch state types and interfaces

Wave 2 (After Wave 1):
├── Task 4: Create batch orchestrator service
├── Task 5: Create batch API routes
└── Task 6: Update settings page with new options

Wave 3 (After Wave 2):
├── Task 7: Add multi-select to kanban board
├── Task 8: Create batch controls component
└── Task 9: Add batch progress UI

Wave 4 (After Wave 3):
├── Task 10: Integrate batch with existing execution
├── Task 11: Add SSE batch events
└── Task 12: End-to-end testing

Critical Path: Task 1 → Task 4 → Task 10 → Task 12
```

---

## TODOs

### Task 1: Update Prisma Schema with Batch Settings

**What to do**:
- Add new fields to `Settings` model for batch configuration
- Run `prisma generate` to update client

**Files to modify**:
- `packages/db/prisma/schema.prisma`

**Schema changes**:
```prisma
model Settings {
  id             String  @id @default("default")
  parallelLimit  Int     @default(3)
  // NEW FIELDS:
  maxBatchSize       Int     @default(3)
  queueAutoApprove   Boolean @default(false)
  stopOnFailure      Boolean @default(false)
  conflictBehavior   String  @default("skip") // "skip" | "fail"
}
```

**Acceptance Criteria**:
- [x] `pnpm --filter @openlinear/db db:generate` completes without error
- [x] `pnpm --filter @openlinear/db db:push` applies schema to database
- [x] New settings fields accessible via Prisma client

**Commit**: YES
- Message: `feat(db): add batch execution settings to schema`

---

### Task 2: Create Worktree Manager Service

**What to do**:
- Create `apps/api/src/services/worktree.ts`
- Implement git worktree operations: create, list, remove
- Handle main repo clone and worktree creation

**Must NOT do**:
- Run concurrent git operations on same worktree
- Leave orphaned worktrees on error

**References**:
- `apps/api/src/services/execution.ts:cloneRepository()` - Current clone pattern

**Implementation**:
```typescript
// worktree.ts
interface WorktreeManager {
  ensureMainRepo(projectId: string, cloneUrl: string, accessToken: string | null): Promise<string>
  createWorktree(mainRepoPath: string, taskId: string, branch: string): Promise<string>
  removeWorktree(worktreePath: string): Promise<void>
  listWorktrees(mainRepoPath: string): Promise<string[]>
  cleanupBatch(batchPath: string): Promise<void>
}
```

**Git Commands**:
```bash
# Create main bare clone (once per project)
git clone --bare {url} /tmp/openlinear-repos/{projectId}/.main

# Create worktree for task
git -C /tmp/openlinear-repos/{projectId}/.main worktree add \
  ../batch-{batchId}/task-{taskId} -b openlinear/{taskId}

# Remove worktree
git -C /tmp/openlinear-repos/{projectId}/.main worktree remove \
  ../batch-{batchId}/task-{taskId}
```

**Acceptance Criteria**:
- [x] `ensureMainRepo()` creates bare clone if not exists
- [x] `createWorktree()` creates worktree with unique branch
- [x] `removeWorktree()` cleans up worktree and branch
- [x] Concurrent worktree creation for same project works

**Commit**: YES
- Message: `feat(api): add git worktree manager service`

---

### Task 3: Create Batch State Types and Interfaces

**What to do**:
- Create `apps/api/src/types/batch.ts` with all batch-related types
- Define batch states, task states within batch, events

**Types to define**:
```typescript
type BatchMode = 'parallel' | 'queue'
type BatchStatus = 'pending' | 'running' | 'merging' | 'completed' | 'failed'
type BatchTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled'

interface BatchTask {
  taskId: string
  status: BatchTaskStatus
  worktreePath: string | null
  branch: string
  sessionId: string | null
  error: string | null
  startedAt: Date | null
  completedAt: Date | null
}

interface BatchState {
  id: string
  projectId: string
  mode: BatchMode
  status: BatchStatus
  tasks: BatchTask[]
  settings: BatchSettings
  mainRepoPath: string
  batchBranch: string
  prUrl: string | null
  createdAt: Date
  completedAt: Date | null
}

interface BatchSettings {
  maxConcurrent: number
  autoApprove: boolean
  stopOnFailure: boolean
  conflictBehavior: 'skip' | 'fail'
}

// SSE Events
interface BatchEvent {
  type: 'batch:created' | 'batch:progress' | 'batch:task:started' | 
        'batch:task:completed' | 'batch:task:failed' | 'batch:merging' |
        'batch:completed' | 'batch:failed'
  batchId: string
  data: Record<string, unknown>
}
```

**Acceptance Criteria**:
- [x] Types compile without error
- [x] Types exported and usable in other services

**Commit**: YES (groups with Task 2)
- Message: `feat(api): add batch execution types`

---

### Task 4: Create Batch Orchestrator Service

**What to do**:
- Create `apps/api/src/services/batch.ts`
- Implement batch creation, execution orchestration, task management
- Handle parallel vs queue mode execution
- Integrate with worktree manager and existing execution

**Must NOT do**:
- Persist batches to database
- Implement retry logic

**Key methods**:
```typescript
interface BatchOrchestrator {
  createBatch(params: CreateBatchParams): Promise<BatchState>
  startBatch(batchId: string): Promise<void>
  cancelBatch(batchId: string): Promise<void>
  cancelTask(batchId: string, taskId: string): Promise<void>
  getBatch(batchId: string): BatchState | undefined
  getActiveBatches(): BatchState[]
}
```

**Parallel mode logic**:
```
1. Take first N tasks (N = maxConcurrent)
2. Start all N simultaneously
3. When one completes, start next queued task
4. Continue until all tasks processed
```

**Queue mode logic**:
```
1. Start first task
2. Wait for completion
3. If autoApprove: start next immediately
4. If !autoApprove: wait for user approval (via API call)
5. Continue until all tasks processed
```

**Acceptance Criteria**:
- [x] `createBatch()` validates tasks belong to same project
- [x] Parallel mode starts up to N tasks simultaneously
- [x] Queue mode executes tasks sequentially
- [x] Task completion triggers next task start
- [x] Broadcast SSE events for all state changes

**Commit**: YES
- Message: `feat(api): add batch orchestrator service`

---

### Task 5: Create Batch API Routes

**What to do**:
- Create `apps/api/src/routes/batches.ts`
- Implement REST endpoints for batch operations
- Register routes in main app

**Endpoints**:
```
POST   /api/batches              - Create and start batch
GET    /api/batches              - List active batches
GET    /api/batches/:id          - Get batch details
POST   /api/batches/:id/cancel   - Cancel entire batch
POST   /api/batches/:id/tasks/:taskId/cancel - Cancel specific task
POST   /api/batches/:id/approve  - Approve next task (queue mode)
```

**Request/Response**:
```typescript
// POST /api/batches
interface CreateBatchRequest {
  taskIds: string[]
  mode: 'parallel' | 'queue'
}

interface CreateBatchResponse {
  id: string
  status: BatchStatus
  tasks: BatchTask[]
}
```

**Acceptance Criteria**:
- [x] POST /api/batches creates batch with selected tasks
- [x] GET /api/batches returns all active batches
- [x] Cancel endpoints stop execution gracefully
- [x] All endpoints validate authentication

**Commit**: YES
- Message: `feat(api): add batch execution API routes`

---

### Task 6: Update Settings Page with Batch Options

**What to do**:
- Add new settings section for batch execution
- Add controls: max batch size, auto-approve, stop-on-failure, conflict behavior

**UI elements**:
```
Batch Execution
├── Max Batch Size: [Slider 1-10, default 3]
├── Queue Auto-Approve: [Toggle, default off]
├── Stop on Failure: [Toggle, default off]
└── Conflict Behavior: [Select: Skip / Fail, default Skip]
```

**References**:
- `apps/desktop-ui/app/settings/page.tsx` - Existing settings pattern

**Acceptance Criteria**:
- [x] All new settings displayed in settings page
- [x] Changes saved to API on update
- [x] Settings loaded on page mount

**Commit**: YES
- Message: `feat(ui): add batch execution settings`

---

### Task 7: Add Multi-Select to Kanban Board

**What to do**:
- Add checkbox to each task card
- Track selected task IDs in state
- Show selection count and controls when tasks selected

**UI behavior**:
- Checkbox appears on card hover (always visible when in selection mode)
- Clicking checkbox toggles selection
- Clicking card body still opens detail view
- Selection state persists across column scrolling

**References**:
- `apps/desktop-ui/components/board/kanban-board.tsx` - Board component
- `apps/desktop-ui/components/board/task-card.tsx` - Card component

**State additions**:
```typescript
const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set())
const [selectionMode, setSelectionMode] = useState(false)
```

**Acceptance Criteria**:
- [x] Checkbox shown on task cards
- [x] Selected tasks tracked in state
- [x] Selection persists while interacting with board
- [x] Can select tasks from any column

**Commit**: YES
- Message: `feat(ui): add multi-select to kanban board`

---

### Task 8: Create Batch Controls Component

**What to do**:
- Create `apps/desktop-ui/components/board/batch-controls.tsx`
- Show when tasks are selected
- Buttons: "Execute Parallel", "Execute Queue", "Clear Selection"

**UI mockup**:
```
┌─────────────────────────────────────────────────────────────────┐
│  ☑ 3 tasks selected    [Execute Parallel] [Execute Queue] [✕]  │
└─────────────────────────────────────────────────────────────────┘
```

**Props**:
```typescript
interface BatchControlsProps {
  selectedCount: number
  onExecuteParallel: () => void
  onExecuteQueue: () => void
  onClearSelection: () => void
  disabled?: boolean
}
```

**Acceptance Criteria**:
- [x] Component renders when selectedCount > 0
- [x] Buttons trigger respective callbacks
- [x] Disabled state prevents interaction
- [x] Matches Linear dark theme styling

**Commit**: YES (groups with Task 7)
- Message: `feat(ui): add batch execution controls`

---

### Task 9: Add Batch Progress UI

**What to do**:
- Show active batch progress on board
- Group selected tasks visually with border
- Status bar showing batch progress

**UI elements**:
```
┌─────────────────────────────────────────────────────────────┐
│  ⚡ Batch executing: 2/5 complete  [Cancel Batch]          │
│  ═══════════════░░░░░░░░░░░░░░░░░░░░░░░ 40%                │
└─────────────────────────────────────────────────────────────┘

Tasks in batch get visual indicator:
┌──────────────────────┐
│ ● Running            │  ← Task card with status badge
│ Task Title           │
└──────────────────────┘
```

**Batch task badges**:
- 🔵 Queued
- 🟡 Running  
- 🟢 Completed
- 🔴 Failed
- ⚪ Skipped
- ⭕ Cancelled

**Acceptance Criteria**:
- [x] Batch progress bar shows overall completion
- [x] Tasks in batch show status badges
- [x] Cancel batch button stops all tasks
- [x] Progress updates in real-time via SSE

**Commit**: YES
- Message: `feat(ui): add batch execution progress UI`

---

### Task 10: Integrate Batch with Execution Service

**What to do**:
- Modify `execution.ts` to work with worktrees instead of fresh clones
- Add batch context to execution state
- Route completion events through batch orchestrator

**Changes to execution.ts**:
```typescript
interface ExecutionState {
  // ... existing fields
  batchId: string | null      // NEW
  worktreePath: string | null // NEW (alternative to repoPath)
}

// Modify executeTask to accept worktree path
async function executeTask(params: ExecuteTaskParams): Promise<...> {
  if (params.batchId && params.worktreePath) {
    // Use existing worktree
  } else {
    // Current behavior: clone fresh
  }
}
```

**Completion flow**:
```
Task completes → handleSessionComplete()
  ├── If batchId exists: 
  │     → Notify batch orchestrator
  │     → Orchestrator handles next steps
  └── If no batchId:
        → Current behavior (create PR immediately)
```

**Acceptance Criteria**:
- [x] Execution works with worktree paths
- [x] Batch orchestrator notified on task completion
- [x] Non-batch execution unchanged

**Commit**: YES
- Message: `feat(api): integrate batch execution with worktrees`

---

### Task 11: Add Batch PR Creation with Auto-Merge

**What to do**:
- After all tasks complete, merge task branches into batch branch
- Create single PR from batch branch
- Handle merge conflicts by skipping conflicting branches

**Merge flow**:
```bash
# Create batch branch from default branch
git checkout -b openlinear/batch-{batchId} origin/{defaultBranch}

# Merge each task branch
for task in completed_tasks:
  git merge --no-ff openlinear/{taskId} -m "Merge task {taskId}"
  # If conflict: skip this task, mark as skipped

# Push and create PR
git push origin openlinear/batch-{batchId}
# Create PR via GitHub API
```

**Acceptance Criteria**:
- [x] Batch branch created after all tasks complete
- [x] Successful task branches merged
- [x] Conflicting branches skipped with notification
- [x] Single PR created with merged changes
- [x] PR URL broadcast to frontend

**Commit**: YES
- Message: `feat(api): add batched PR creation with auto-merge`

---

### Task 12: Add SSE Batch Events

**What to do**:
- Add batch event types to SSE broadcast
- Frontend subscribes and updates batch state

**Event types**:
```typescript
broadcast('batch:created', { batchId, tasks, mode })
broadcast('batch:task:started', { batchId, taskId })
broadcast('batch:task:completed', { batchId, taskId })
broadcast('batch:task:failed', { batchId, taskId, error })
broadcast('batch:task:skipped', { batchId, taskId, reason })
broadcast('batch:merging', { batchId })
broadcast('batch:completed', { batchId, prUrl })
broadcast('batch:failed', { batchId, error })
```

**Frontend handling**:
```typescript
useEffect(() => {
  eventSource.addEventListener('batch:*', handleBatchEvent)
}, [])
```

**Acceptance Criteria**:
- [x] All batch state changes broadcast via SSE
- [x] Frontend receives and processes batch events
- [x] UI updates in real-time

**Commit**: YES
- Message: `feat: add SSE batch events for real-time updates`

---

## Commit Strategy

| After Task | Message | Files |
|------------|---------|-------|
| 1 | `feat(db): add batch execution settings to schema` | schema.prisma |
| 2, 3 | `feat(api): add worktree manager and batch types` | worktree.ts, batch.ts types |
| 4 | `feat(api): add batch orchestrator service` | batch.ts |
| 5 | `feat(api): add batch execution API routes` | batches.ts routes |
| 6 | `feat(ui): add batch execution settings` | settings/page.tsx |
| 7, 8 | `feat(ui): add multi-select and batch controls` | kanban-board.tsx, batch-controls.tsx |
| 9 | `feat(ui): add batch execution progress UI` | batch-progress.tsx |
| 10 | `feat(api): integrate batch execution with worktrees` | execution.ts |
| 11 | `feat(api): add batched PR creation with auto-merge` | batch.ts |
| 12 | `feat: add SSE batch events for real-time updates` | sse.ts, kanban-board.tsx |

---

## Success Criteria

### Verification Commands
```bash
# API health check
curl http://localhost:3001/health

# Create batch (parallel mode)
curl -X POST http://localhost:3001/api/batches \
  -H 'Content-Type: application/json' \
  -d '{"taskIds": ["task-1", "task-2", "task-3"], "mode": "parallel"}'
# Expected: {"id": "batch-xxx", "status": "running", ...}

# Get batch status
curl http://localhost:3001/api/batches/{batchId}
# Expected: Batch state with task statuses

# Verify worktrees created
ls /tmp/openlinear-repos/{projectId}/batch-{batchId}/
# Expected: task-{id}/ directories

# Settings updated
curl http://localhost:3001/api/settings
# Expected: New batch settings fields present
```

### Final Checklist
- [x] Multi-select works on task cards
- [x] "Execute Parallel" starts up to N tasks simultaneously
- [x] "Execute Queue" starts tasks one-by-one
- [x] Git worktrees created for each task
- [x] Tasks execute in their worktrees
- [x] Single PR created after batch completes
- [x] Merge conflicts result in skipped tasks
- [x] Real-time progress updates via SSE
- [x] Individual task cancellation works
- [x] New settings configurable and saved
