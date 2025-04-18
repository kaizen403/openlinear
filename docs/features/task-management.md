# Task Management

Tasks are the core unit of work in OpenLinear. Each task maps to an AI execution job: it has a status lifecycle, optional team/project membership, execution tracking fields, and real-time updates delivered over SSE. The kanban board in the desktop UI renders tasks grouped by status and drives execution through a sidecar service.

## Data Model

The `Task` model in `packages/db/prisma/schema.prisma`:

```prisma
model Task {
  id          String      @id @default(uuid())
  title       String
  description String?
  priority    Priority    @default(medium)
  status      Status      @default(todo)
  sessionId   String?
  createdAt   DateTime    @default(now())
  updatedAt   DateTime    @updatedAt
  labels      TaskLabel[]

  // Execution tracking
  executionStartedAt DateTime?
  executionPausedAt  DateTime?
  executionElapsedMs Int       @default(0)
  executionProgress  Int?      // 0-100 estimated progress
  prUrl              String?
  outcome            String?   // Summary of what was accomplished
  executionLogs      Json?     // Persisted execution log entries
  archived           Boolean   @default(false)
  inboxRead          Boolean   @default(false)
  batchId            String?   // Groups tasks executed together in a batch
  teamId             String?
  team               Team?     @relation(fields: [teamId], references: [id], onDelete: SetNull)
  projectId          String?
  project            Project?  @relation(fields: [projectId], references: [id], onDelete: SetNull)
  number             Int?      // team-scoped issue number
  identifier         String?   // e.g. "ENG-1"
  dueDate            DateTime?
}
```

**Status enum**: `todo | in_progress | done | cancelled`

**Priority enum**: `low | medium | high`

The `identifier` field (e.g. `ENG-1`) is computed at creation time from the team's `key` and an auto-incrementing `nextIssueNumber` counter on the `Team` model. Tasks without a team have no identifier.

Labels are stored in a join table `TaskLabel` with a composite primary key `(taskId, labelId)`.

## API Endpoints

All task routes are mounted at `/api/tasks` in `apps/api/src/app.ts`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/tasks` | Optional | List active (non-archived) tasks |
| `POST` | `/api/tasks` | No | Create a task |
| `GET` | `/api/tasks/archived` | Optional | List archived tasks |
| `DELETE` | `/api/tasks/archived` | No | Permanently delete all archived tasks |
| `DELETE` | `/api/tasks/archived/:id` | No | Permanently delete one archived task |
| `GET` | `/api/tasks/:id` | No | Get a single task |
| `PATCH` | `/api/tasks/:id` | No | Update a task |
| `DELETE` | `/api/tasks/:id` | No | Archive a task (soft delete) |
| `POST` | `/api/tasks/:id/refresh-pr` | Yes | Refresh PR URL from GitHub API |

The route file is `apps/api/src/routes/tasks.ts`.

### Query Parameters for `GET /api/tasks`

- `teamId` — filter to a specific team
- `projectId` — filter to a specific project

When neither is provided and the request is authenticated, the handler calls `getUserTeamIds(userId)` from `apps/api/src/services/team-scope.ts` and returns tasks belonging to any of the user's teams. Unauthenticated requests with no filter return an empty array.

## Creating a Task

`POST /api/tasks` validates the body with Zod:

```typescript
const CreateTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
  status: z.enum(['todo', 'in_progress', 'done', 'cancelled']).default('todo'),
  labelIds: z.array(z.string().uuid()).default([]),
  teamId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  dueDate: z.string().datetime().nullable().optional(),
});
```

**Team resolution**: If `projectId` is provided, the handler calls `resolveProjectTeamId(projectId)` which looks up the project's `projectTeams` relation. A project must have exactly one team; if it has none the `teamId` is `null`, and if it has more than one the request is rejected with a 400.

**Issue number assignment**: When a `teamId` is resolved, the task is created inside a Prisma transaction:

```typescript
const created = await prisma.$transaction(async (tx) => {
  const team = await tx.team.update({
    where: { id: resolvedTeamId },
    data: { nextIssueNumber: { increment: 1 } },
    select: { key: true, nextIssueNumber: true },
  });
  const number = team.nextIssueNumber - 1;
  const identifier = `${team.key}-${number}`;
  return tx.task.create({ data: { ..., number, identifier } });
});
```

The transaction atomically increments `nextIssueNumber` on the team and captures the pre-increment value as the task's number. This prevents duplicate identifiers under concurrent creation.

After creation, `broadcast('task:created', transformedTask)` pushes the new task to all connected SSE clients.

## Updating a Task

`PATCH /api/tasks/:id` accepts partial updates. Notable behaviors:

- **Status reset on `in_progress`**: When `status` changes to `in_progress` from any other state, `executionStartedAt`, `executionPausedAt`, and `executionElapsedMs` are all reset to their defaults. This clears stale execution state from a previous run.
- **Project/team coupling**: Setting `projectId` automatically resolves and sets `teamId` via `resolveProjectTeamId`. Clearing `projectId` (setting it to `null`) also clears `teamId`.
- **Label replacement**: When `labelIds` is provided, all existing `TaskLabel` records for the task are deleted and recreated. This is a full replace, not a merge.

After update, `broadcast('task:updated', transformedTask)` fires.

## Soft Delete and Archive

`DELETE /api/tasks/:id` does not delete the database row. It sets `archived: true`:

```typescript
await prisma.task.update({ where: { id }, data: { archived: true } });
broadcast('task:deleted', { id });
```

The `GET /api/tasks` endpoint always filters `{ archived: false }`. Archived tasks are only visible via `GET /api/tasks/archived`.

Permanent deletion is available through `DELETE /api/tasks/archived/:id` (single) and `DELETE /api/tasks/archived` (all).

## PR URL Refresh

`POST /api/tasks/:id/refresh-pr` handles the case where a task's `prUrl` is a GitHub compare URL (e.g. `https://github.com/owner/repo/compare/main...branch`) rather than a real PR URL.

The handler parses the branch name from the compare URL, then queries the GitHub API:

```
GET https://api.github.com/repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=all&per_page=1
```

If a PR exists, the task's `prUrl` is updated to the actual PR URL. If the task has a `batchId`, all tasks in the same batch with the same old URL are also updated via `updateMany`.

This endpoint requires authentication (`requireAuth`) because it uses the user's GitHub access token fetched via `getLegacyTokenForOperation`.

## Response Shape

All task responses go through `flattenLabels()`, which transforms the nested Prisma include structure:

```typescript
// Input from Prisma:
{ labels: [{ taskId, labelId, label: { id, name, color, priority } }] }

// Output:
{ labels: [{ id, name, color, priority }] }
```

The full include used for all task queries:

```typescript
const taskInclude = {
  labels: { include: { label: true } },
  team: { select: { id: true, name: true, key: true, color: true } },
  project: { select: { id: true, name: true, status: true, color: true } },
};
```

## Real-Time Updates (SSE)

The API server maintains an in-memory `Map<string, SSEClient>` in `apps/api/src/sse.ts`. Clients connect to `GET /api/events` which sets `Content-Type: text/event-stream` and registers the response object. A heartbeat comment (`: heartbeat`) is sent every 30 seconds to keep the connection alive.

Every mutating task operation calls `broadcast(eventType, data)`, which iterates all connected clients and writes:

```
event: task:created\ndata: {...}\n\n
```

SSE event types for tasks: `task:created`, `task:updated`, `task:deleted`.

## Kanban Board (Desktop UI)

The kanban board is implemented in `apps/desktop-ui/components/board/`. The main logic lives in `apps/desktop-ui/components/board/use-kanban-board.ts`, a custom hook that:

1. Fetches tasks from `GET /api/tasks` on mount, with up to 5 automatic retries at 1.5-second intervals.
2. Subscribes to SSE events via `useSSESubscription` (from `apps/desktop-ui/providers/sse-provider`), which wraps the `useSSE` hook in `apps/desktop-ui/hooks/use-sse.ts`.
3. Applies SSE events as local state mutations without re-fetching, keeping the UI in sync with zero polling.

**Columns**: The board has four fixed columns defined as:

```typescript
export const COLUMNS = [
  { id: "todo",        title: "All Issues",  status: "todo"        },
  { id: "in_progress", title: "In Progress", status: "in_progress" },
  { id: "done",        title: "Done",        status: "done"        },
  { id: "cancelled",   title: "Cancelled",   status: "cancelled"   },
];
```

**Drag and drop**: Uses `@hello-pangea/dnd`. `handleDragEnd` reads `destination.droppableId` as the new status and calls `PATCH /api/tasks/:id` with the updated status. Batch groups (tasks sharing a `batchId`) are dragged as a unit using a `draggableId` prefixed with `batch-group-`.

**Execution**: `handleExecute(taskId)` first checks `getSetupStatus()` to verify the AI provider is configured. If not, it shows a provider setup modal. Otherwise it POSTs to `{SIDECAR_URL}/api/tasks/{taskId}/execute`. The sidecar URL defaults to `http://localhost:3001`. Execution progress arrives via `execution:progress` and `execution:log` SSE events.

**Execution polling**: When a task is selected and `in_progress`, the hook polls `{SIDECAR_URL}/api/tasks/{taskId}/logs` every 2500ms and also re-fetches the task list silently.

**Batch execution**: `handleBatchExecute(mode)` POSTs to `{SIDECAR_URL}/api/batches` with `{ taskIds, mode }` where mode is `"parallel"` or `"queue"`. Batch lifecycle events (`batch:created`, `batch:started`, `batch:task:*`, `batch:completed`, etc.) update the `activeBatch` state in the hook.

**Permission handling**: When an AI task needs user approval, the sidecar emits `permission:requested` over SSE. The hook stores pending permissions keyed by `taskId` and shows a toast. `handlePermissionRespond` POSTs to `{SIDECAR_URL}/api/tasks/{taskId}/permissions/{permissionId}/respond`.

## Key Files

| File | Purpose |
|------|---------|
| `apps/api/src/routes/tasks.ts` | All task CRUD route handlers |
| `apps/api/src/sse.ts` | SSE client registry and broadcast function |
| `apps/api/src/app.ts` | SSE endpoint (`GET /api/events`) setup |
| `apps/api/src/services/team-scope.ts` | `getUserTeamIds` helper |
| `apps/desktop-ui/components/board/use-kanban-board.ts` | Board state, SSE handling, execution logic |
| `apps/desktop-ui/hooks/use-sse.ts` | `useSSE` hook, EventSource management, reconnect logic |
| `apps/desktop-ui/components/board/kanban-board.tsx` | Board rendering component |
| `apps/desktop-ui/components/board/task-card.tsx` | Individual task card |
| `packages/db/prisma/schema.prisma` | `Task`, `Label`, `TaskLabel` models |
