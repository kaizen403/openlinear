# API Reference

Base URL: `http://localhost:3001` (configurable via `API_PORT`)

All request/response bodies are JSON. Authentication uses Bearer JWT tokens where noted.

---

## Health

### `GET /health`
Returns server status and connected SSE client count.

```json
{ "status": "ok", "timestamp": "...", "clients": 2 }
```

---

## Authentication

### `GET /api/auth/github`
Redirects to GitHub OAuth authorization page.

### `GET /api/auth/github/callback`
Handles OAuth callback. Exchanges code for token, creates/updates user, redirects to frontend with JWT.

### `GET /api/auth/me`
**Auth: required**. Returns the authenticated user (excludes access token).

### `POST /api/auth/logout`
Returns `{ success: true }`. Client should clear the stored JWT.

---

## Repositories

### `POST /api/repos/url`
Connect a public repository by URL. No auth required.

Body: `{ "url": "https://github.com/owner/repo" }`

### `GET /api/repos/github`
**Auth: required**. Fetch user's GitHub repos.

### `POST /api/repos/import`
**Auth: required**. Import a GitHub repo.

Body: `{ "repo": { id, name, full_name, clone_url, default_branch, private, description } }`

### `POST /api/repos/:id/activate`
**Auth: required**. Set as active repository for the authenticated user.

### `GET /api/repos/active`
**Auth: required**. Get user's active repository.

### `GET /api/repos`
**Auth: required**. List user's imported repositories.

### `GET /api/repos/public`
List all public (unauthenticated) repositories.

### `GET /api/repos/active/public`
Get the active public repository.

### `POST /api/repos/:id/activate/public`
Set a public repository as active.

---

## Tasks

### `GET /api/tasks`
List non-archived tasks. Optional query params: `teamId`, `projectId`.

### `POST /api/tasks`
Create a task.

Body:
```json
{
  "title": "Fix login button",
  "description": "Optional longer description",
  "priority": "high",
  "labelIds": ["uuid-1"],
  "teamId": "uuid",
  "projectId": "uuid"
}
```

### `GET /api/tasks/:id`
Get a single task with labels, team, and project.

### `PATCH /api/tasks/:id`
Update a task. Any field from create, plus `status`. Setting `labelIds` replaces all labels.

### `DELETE /api/tasks/:id`
Archives the task (soft delete). Broadcasts `task:deleted`.

### `POST /api/tasks/:id/execute`
**Auth: optional**. Start AI execution. Returns 400 if task is already running or parallel limit reached.

### `POST /api/tasks/:id/cancel`
Cancel a running task. Returns 400 if task is not running.

### `GET /api/tasks/:id/running`
Check if a task is currently executing. Returns `{ "running": true/false }`.

### `GET /api/tasks/:id/logs`
Get execution logs. Returns in-memory logs for active executions, or persisted logs from the database for completed ones.

### `POST /api/tasks/:id/refresh-pr`
**Auth: optional**. Check if a PR exists for a task's compare URL branch and update the link.

### `GET /api/tasks/archived`
List archived tasks.

### `DELETE /api/tasks/archived`
Permanently delete all archived tasks.

### `DELETE /api/tasks/archived/:id`
Permanently delete a single archived task.

---

## Labels

### `GET /api/labels`
List all labels ordered by priority (descending).

### `POST /api/labels`
Create a label. Body: `{ "name": "bug", "color": "#ff5733", "priority": 0 }`

### `PATCH /api/labels/:id`
Update a label's name, color, or priority.

### `DELETE /api/labels/:id`
Delete a label.

### `POST /api/labels/tasks/:id/labels`
Assign a label to a task. Body: `{ "labelId": "uuid" }`

### `DELETE /api/labels/tasks/:id/labels/:labelId`
Remove a label from a task.

---

## Settings

### `GET /api/settings`
Get execution settings. Auto-creates defaults if not present.

### `PATCH /api/settings`
Update settings. Body can include any combination of: `parallelLimit`, `maxBatchSize`, `queueAutoApprove`, `stopOnFailure`, `conflictBehavior`.

---

## Batches

### `POST /api/batches`
Create and start a batch. Body: `{ "taskIds": ["uuid-1", ...], "mode": "parallel" | "queue" }`

### `GET /api/batches`
List active batches.

### `GET /api/batches/:id`
Get batch status with per-task progress breakdown.

### `POST /api/batches/:id/cancel`
Cancel entire batch. Aborts running tasks, marks queued tasks cancelled.

### `POST /api/batches/:id/tasks/:taskId/cancel`
Cancel a single task within a batch.

### `POST /api/batches/:id/approve`
Approve the next queued task in queue mode (when auto-approve is off).

---

## Teams

### `GET /api/teams`
List all teams with member counts.

### `POST /api/teams`
**Auth: optional**. Create a team. Creator becomes owner.

### `GET /api/teams/:id`
Get team with members and project associations.

### `PATCH /api/teams/:id`
**Auth: optional**. Update team.

### `DELETE /api/teams/:id`
**Auth: optional**. Delete team with cascading cleanup.

### `GET /api/teams/:id/members`
List team members.

### `POST /api/teams/:id/members`
**Auth: required**. Add a member by email or userId.

### `DELETE /api/teams/:id/members/:userId`
**Auth: optional**. Remove a member.

---

## Projects

### `GET /api/projects`
List all projects with teams and task counts.

### `POST /api/projects`
**Auth: required**. Create a project.

### `GET /api/projects/:id`
Get project with team associations.

### `PATCH /api/projects/:id`
**Auth: required**. Update project.

### `DELETE /api/projects/:id`
**Auth: required**. Delete project (unlinks tasks).

---

## Inbox

### `GET /api/inbox`
List completed (done, non-archived) tasks with labels, team, and project.

### `GET /api/inbox/count`
Get count of unread inbox items.

### `PATCH /api/inbox/read/:id`
Mark a single inbox item as read.

### `PATCH /api/inbox/read-all`
Mark all inbox items as read.

---

## Events

### `GET /api/events`
SSE endpoint. Optional query param: `clientId`. See [Real-time Events](real-time-events.md) for the full event catalog.

---

## OpenCode

### `GET /api/opencode/status`
Returns OpenCode server state: `{ status, url, error, startedAt }`.
