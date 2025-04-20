# Inbox Notifications

## Overview

The inbox is a view of completed and cancelled tasks. When a task finishes (status `done` or `cancelled`), it appears in the inbox. Each task carries an `inboxRead` boolean flag. The unread count drives the notification badge in the sidebar.

The inbox does not have its own database table. It's a filtered view of the `tasks` table, scoped to the authenticated user's teams.

---

## Key Files

| File | Role |
|------|------|
| `apps/api/src/routes/inbox.ts` | All inbox API endpoints |
| `packages/db/prisma/schema.prisma` | `Task` model with `inboxRead` and `archived` fields |
| `apps/api/src/services/team-scope.ts` | Resolves which team IDs a user can see |

---

## Database Schema

The inbox state lives directly on the `Task` model:

```prisma
model Task {
  // ...
  status    Status    @default(todo)   // 'done' | 'cancelled' triggers inbox inclusion
  archived  Boolean   @default(false)  // archived tasks are excluded from inbox
  inboxRead Boolean   @default(false)  // read/unread tracking

  teamId    String?
  team      Team?     @relation(fields: [teamId], references: [id], onDelete: SetNull)
  // ...
}
```

A task appears in the inbox when:
- `status` is `done` OR `cancelled`
- `archived` is `false`
- `teamId` is in the user's team memberships

---

## API Endpoints

All routes are mounted under `/api/inbox`.

### `GET /api/inbox/count`

Returns the total and unread counts for the current user's inbox.

**Auth:** `optionalAuth` middleware — returns `{ total: 0, unread: 0 }` for unauthenticated requests.

**Response:**
```json
{
  "total": 12,
  "unread": 3
}
```

**Implementation:**

```typescript
const baseWhere = { ...completedOrCancelled(), archived: false, ...scope };

const total = await prisma.task.count({ where: baseWhere });
const unread = await prisma.task.count({
  where: { ...baseWhere, inboxRead: false },
});
```

`completedOrCancelled()` returns `{ OR: [{ status: 'done' }, { status: 'cancelled' }] }`.

`teamScope(userId)` resolves the user's team IDs and returns `{ teamId: { in: teamIds } }`.

---

### `GET /api/inbox`

Returns all inbox tasks for the current user, ordered by most recently updated.

**Auth:** `optionalAuth` — returns `[]` for unauthenticated requests.

**Response:** Array of task objects with flattened labels, team, and project data.

**Includes:**
- `labels` — flattened from the `TaskLabel` join table to `{ id, name, color, priority }[]`
- `team` — `{ id, name, key, color }`
- `project` — `{ id, name, status, color }`

**Query:**
```typescript
const tasks = await prisma.task.findMany({
  where: {
    ...completedOrCancelled(),
    archived: false,
    ...scope,
  },
  include: {
    labels: { include: { label: true } },
    team: { select: { id: true, name: true, key: true, color: true } },
    project: { select: { id: true, name: true, status: true, color: true } },
  },
  orderBy: { updatedAt: 'desc' },
});
```

Labels are flattened before the response is sent:

```typescript
const flatTasks = tasks.map(task => ({
  ...task,
  labels: task.labels.map((tl) => tl.label),
}));
```

---

### `PATCH /api/inbox/read/:id`

Marks a single task as read.

**Auth:** None (no middleware applied).

**Params:** `:id` — task UUID.

**Response:** `{ success: true }`

**Implementation:**
```typescript
await prisma.task.update({
  where: { id },
  data: { inboxRead: true },
});
```

---

### `PATCH /api/inbox/read-all`

Marks every unread inbox task as read for the current user's teams.

**Auth:** `optionalAuth` — no-ops for unauthenticated requests.

**Response:** `{ success: true }`

**Implementation:**
```typescript
await prisma.task.updateMany({
  where: {
    ...completedOrCancelled(),
    inboxRead: false,
    archived: false,
    ...scope,
  },
  data: { inboxRead: true },
});
```

---

## Team Scoping

All inbox queries are scoped to the user's teams via `getUserTeamIds(userId)` from `apps/api/src/services/team-scope.ts`. This function returns the list of team IDs the user belongs to.

```typescript
async function teamScope(userId?: string): Promise<Record<string, unknown> | null> {
  if (!userId) return null;
  const teamIds = await getUserTeamIds(userId);
  return { teamId: { in: teamIds } };
}
```

If `userId` is undefined (unauthenticated), `teamScope` returns `null` and the route returns an empty result immediately.

---

## Read State and SSE

When a task transitions to `done` or `cancelled`, the execution system sets `inboxRead: false` on the task. The `task:updated` SSE event carries the updated `inboxRead` field, so the UI can update the unread badge without polling `/api/inbox/count`.

```typescript
// SSEEventData includes:
inboxRead?: boolean
```

The inbox count component subscribes to `task:updated` events and refreshes the count when it receives one.

---

## Data Flow: Task Completes

1. Execution engine updates task status to `done`, sets `inboxRead: false`.
2. Broadcasts `task:updated` with the full task payload including `inboxRead: false`.
3. UI receives the SSE event, increments the unread badge.
4. User opens the inbox — `GET /api/inbox` returns the task.
5. User clicks the task — `PATCH /api/inbox/read/:id` sets `inboxRead: true`.
6. UI decrements the unread badge locally (or re-fetches `/api/inbox/count`).

---

## Archiving

Tasks with `archived: true` are excluded from all inbox queries. Archiving is a separate operation (not covered by the inbox routes) that removes a task from the inbox view without deleting it.

---

## Endpoint Summary

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/inbox/count` | Optional | Unread and total counts |
| `GET` | `/api/inbox` | Optional | All inbox tasks |
| `PATCH` | `/api/inbox/read/:id` | None | Mark one task read |
| `PATCH` | `/api/inbox/read-all` | Optional | Mark all tasks read |
