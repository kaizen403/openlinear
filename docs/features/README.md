# Feature Documentation

Detailed implementation documentation for each major feature in OpenLinear.

## Core Features

| Document | Description |
|----------|-------------|
| [Authentication](authentication.md) | GitHub OAuth, device flow, JWT middleware |
| [Task Management](task-management.md) | Kanban board, task CRUD, status workflow |
| [Project Management](project-management.md) | Projects, repository linking, team associations |
| [Team Management](team-management.md) | Teams, members, roles, invite codes |
| [Repository Management](repository-management.md) | GitHub import, activation, local folders |
| [Label System](label-system.md) | Labels, colors, task-label associations |

## Execution Engine

| Document | Description |
|----------|-------------|
| [Task Execution](task-execution.md) | Sidecar execution engine, git worktree, PR creation |
| [Batch Execution](batch-execution.md) | Batch operations, parallel/sequential, progress |
| [Sidecar Architecture](sidecar-architecture.md) | Sidecar service overview, routes, services |
| [OpenCode Agent](opencode-agent-integration.md) | OpenCode SDK, model catalog, agent execution |

## Infrastructure

| Document | Description |
|----------|-------------|
| [Real-time SSE](realtime-sse.md) | Server-sent events, reconnection, heartbeat |
| [Inbox & Notifications](inbox-notifications.md) | Inbox system, read/unread tracking |
| [Settings](settings-configuration.md) | Settings management, execution config |
| [Desktop Integration](desktop-integration.md) | Tauri integration, deep linking, shell |
| [NPM Package](npm-package.md) | CLI launcher, validation, feature flags |
