# API Endpoints Reference

Quick reference for all API endpoints in OpenLinear.

## Authentication

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/auth/register` | None | Register new user |
| `POST` | `/api/auth/login` | None | Login with credentials |
| `GET` | `/api/auth/github` | None | Start GitHub OAuth flow |
| `GET` | `/api/auth/github/callback` | None | GitHub OAuth callback |
| `POST` | `/api/auth/github/device/start` | None | Start device flow |
| `POST` | `/api/auth/github/device/poll` | None | Poll device flow status |
| `GET` | `/api/auth/me` | Required | Get current user |
| `POST` | `/api/auth/logout` | Required | Logout |
| `POST` | `/api/auth/github/connect` | Required | Connect GitHub to existing account |
| `POST` | `/api/auth/refresh` | Required | Refresh auth token |

## Tasks

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/tasks` | Optional | List tasks (filterable by team/project) |
| `POST` | `/api/tasks` | Required | Create task |
| `GET` | `/api/tasks/:id` | Optional | Get task by ID |
| `PATCH` | `/api/tasks/:id` | Required | Update task |
| `DELETE` | `/api/tasks/:id` | Required | Delete task |
| `GET` | `/api/tasks/archived` | Optional | List archived tasks |
| `DELETE` | `/api/tasks/archived` | Required | Purge archived tasks |
| `POST` | `/api/tasks/:id/refresh-pr` | Required | Refresh PR status |

## Projects

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/projects` | Optional | List projects |
| `POST` | `/api/projects` | Required | Create project |
| `GET` | `/api/projects/:id` | Optional | Get project by ID |
| `PATCH` | `/api/projects/:id` | Required | Update project |
| `DELETE` | `/api/projects/:id` | Required | Delete project |

## Teams

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/teams` | Optional | List teams |
| `POST` | `/api/teams` | Required | Create team |
| `GET` | `/api/teams/:id` | Optional | Get team by ID |
| `PATCH` | `/api/teams/:id` | Required | Update team |
| `DELETE` | `/api/teams/:id` | Required | Delete team |
| `POST` | `/api/teams/:id/members` | Required | Add team member |
| `DELETE` | `/api/teams/:id/members/:userId` | Required | Remove team member |
| `PATCH` | `/api/teams/:id/members/:userId` | Required | Update member role |

## Repositories

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/repos` | Required | List user repositories |
| `GET` | `/api/repos/github` | Required | Search GitHub repos |
| `POST` | `/api/repos/import` | Required | Import repository |
| `POST` | `/api/repos/:id/activate` | Required | Activate repository |
| `GET` | `/api/repos/active` | Required | Get active repository |
| `PATCH` | `/api/repos/active/base-branch` | Required | Set base branch |
| `GET` | `/api/repos/active/public` | None | Get public active repo |
| `POST` | `/api/repos/:id/activate/public` | None | Activate public repo |

## Labels

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/labels` | Optional | List labels |
| `POST` | `/api/labels` | Required | Create label |
| `PATCH` | `/api/labels/:id` | Required | Update label |
| `DELETE` | `/api/labels/:id` | Required | Delete label |
| `POST` | `/api/labels/tasks/:id/labels` | Required | Add label to task |
| `DELETE` | `/api/labels/tasks/:id/labels/:labelId` | Required | Remove label from task |

## Inbox

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/inbox` | Required | List notifications |
| `GET` | `/api/inbox/count` | Required | Get unread count |
| `PATCH` | `/api/inbox/read/:id` | Required | Mark as read |
| `PATCH` | `/api/inbox/read-all` | Required | Mark all as read |

## Settings

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/settings` | Optional | Get settings |
| `PATCH` | `/api/settings` | Required | Update settings |

## Real-time

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/events` | Optional | SSE event stream |

## Sidecar (Local)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/execute` | None | Start task execution |
| `GET` | `/api/execute/:id` | None | Get execution status |
| `DELETE` | `/api/execute/:id` | None | Cancel execution |
| `POST` | `/api/batches` | None | Start batch execution |
| `GET` | `/api/batches/:id` | None | Get batch status |
| `DELETE` | `/api/batches/:id` | None | Cancel batch |
| `GET` | `/api/opencode/models` | None | List available AI models |
| `GET` | `/api/opencode/status` | None | Check agent status |
