# Real-Time Events (SSE)

All state changes are broadcast to connected clients via Server-Sent Events.

## Connection

```
GET /api/events?clientId=optional-id
```

Returns a `text/event-stream` response. If no `clientId` is provided, a random UUID is assigned. A heartbeat comment is sent every 30 seconds to keep the connection alive.

Initial event on connection:
```json
{"type": "connected", "clientId": "uuid"}
```

## Event Catalog

### Task Events

| Event | Payload | Trigger |
|-------|---------|---------|
| `task:created` | full task object | Task created via API or brainstorm insert |
| `task:updated` | full task object | Any task field changed (status, labels, priority, etc.) |
| `task:deleted` | `{ id }` | Task archived |

### Label Events

| Event | Payload | Trigger |
|-------|---------|---------|
| `label:created` | label object | Label created |
| `label:updated` | label object | Label name/color/priority changed |
| `label:deleted` | `{ id }` | Label deleted |
| `task:label:assigned` | `{ taskId, label }` | Label assigned to a task |
| `task:label:removed` | `{ taskId, labelId }` | Label removed from a task |

### Execution Events

| Event | Payload | Trigger |
|-------|---------|---------|
| `execution:progress` | `{ taskId, status, message, ...data }` | Execution stage change (cloning, executing, committing, etc.) |
| `execution:log` | `{ taskId, entry }` | New log entry (agent text, tool call, error, etc.) |

### Batch Events

| Event | Payload | Trigger |
|-------|---------|---------|
| `batch:created` | `{ batchId, mode, status, tasks }` | Batch initialized |
| `batch:started` | `{ batchId, mode, status, tasks }` | Execution begins |
| `batch:task:started` | `{ batchId, taskId, title }` | Individual task starts |
| `batch:task:completed` | `{ batchId, taskId }` | Individual task finishes |
| `batch:task:failed` | `{ batchId, taskId, error }` | Individual task fails |
| `batch:task:skipped` | `{ batchId, taskId }` | Task skipped (merge conflict) |
| `batch:task:cancelled` | `{ batchId, taskId }` | Task cancelled |
| `batch:merging` | `{ batchId }` | Merge phase started |
| `batch:completed` | `{ batchId, prUrl }` | Batch done, PR created |
| `batch:failed` | `{ batchId }` | Batch failed |
| `batch:cancelled` | `{ batchId }` | Batch cancelled |

### Settings Events

| Event | Payload | Trigger |
|-------|---------|---------|
| `settings:updated` | settings object | Any setting changed |

### OpenCode Events

| Event | Payload | Trigger |
|-------|---------|---------|
| `opencode:status` | `{ status, url?, error? }` | Server status change (starting, running, unhealthy, error, stopped) |

### Team and Project Events

| Event | Payload | Trigger |
|-------|---------|---------|
| `team:created` | team object | Team created |
| `team:updated` | team object | Team updated |
| `team:deleted` | `{ id }` | Team deleted |
| `project:created` | project object | Project created |
| `project:updated` | project object | Project updated |
| `project:deleted` | `{ id }` | Project deleted |
