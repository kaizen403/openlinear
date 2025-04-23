# Data Models Reference

Complete reference for all Prisma data models used in OpenLinear.

## Entity Relationship Overview

```
User ──────┬──── Repository (1:N)
           ├──── TeamMember (1:N)
           └──── Task (via team membership)

Team ──────┬──── TeamMember (1:N)
           ├──── Task (1:N)
           └──── ProjectTeam (M:N with Project)

Project ───┬──── Task (1:N)
           ├──── Repository (1:1)
           └──── ProjectTeam (M:N with Team)

Task ──────┬──── TaskLabel (M:N with Label)
           ├──── Team (N:1)
           └──── Project (N:1, optional)

Label ─────└──── TaskLabel (M:N with Task)
```

## User

The User model represents authenticated users in the system.

| Field | Type | Description |
|-------|------|-------------|
| `id` | String (cuid) | Primary key |
| `username` | String (unique) | Display name |
| `passwordHash` | String? | Bcrypt hash for local auth |
| `githubId` | String? (unique) | GitHub user ID |
| `githubUsername` | String? | GitHub login name |
| `githubAccessToken` | String? | Encrypted OAuth token |
| `avatarUrl` | String? | Profile image URL |
| `createdAt` | DateTime | Account creation timestamp |
| `updatedAt` | DateTime | Last modification timestamp |

**Relations:** `repositories` (Repository[]), `teamMembers` (TeamMember[])

## Team

Teams are the primary organizational unit. Each team has its own issue numbering sequence.

| Field | Type | Description |
|-------|------|-------------|
| `id` | String (cuid) | Primary key |
| `name` | String | Team display name |
| `key` | String (unique) | Short key (e.g., "ENG") used in issue IDs |
| `description` | String? | Team description |
| `color` | String? | Hex color for UI display |
| `icon` | String? | Icon identifier |
| `private` | Boolean | Whether team is private (default: false) |
| `inviteCode` | String? (unique) | Code for joining the team |
| `nextIssueNumber` | Int | Auto-incrementing issue counter (default: 1) |
| `createdAt` | DateTime | Creation timestamp |
| `updatedAt` | DateTime | Last modification timestamp |

**Relations:** `members` (TeamMember[]), `tasks` (Task[]), `projectTeams` (ProjectTeam[])

## TeamMember

Join table linking users to teams with role-based access.

| Field | Type | Description |
|-------|------|-------------|
| `id` | String (cuid) | Primary key |
| `teamId` | String | Foreign key to Team |
| `userId` | String | Foreign key to User |
| `role` | String | One of: `owner`, `admin`, `member` |
| `sortOrder` | Int | Display ordering (default: 0) |
| `createdAt` | DateTime | Join timestamp |

**Unique constraint:** `(teamId, userId)`

## Task

Tasks are the core work items displayed on the kanban board.

| Field | Type | Description |
|-------|------|-------------|
| `id` | String (cuid) | Primary key |
| `title` | String | Task title |
| `description` | String? | Markdown description |
| `status` | String | One of: `todo`, `in_progress`, `done`, `cancelled` |
| `priority` | String | One of: `low`, `medium`, `high` |
| `dueDate` | DateTime? | Optional deadline |
| `archived` | Boolean | Soft delete flag (default: false) |
| `sortOrder` | Int | Position within column (default: 0) |
| `issueNumber` | Int? | Team-scoped issue number |
| `teamId` | String? | Foreign key to Team |
| `projectId` | String? | Foreign key to Project |
| `batchId` | String? | Batch execution group ID |

### Execution Fields

| Field | Type | Description |
|-------|------|-------------|
| `startedAt` | DateTime? | When execution began |
| `pausedAt` | DateTime? | When execution was paused |
| `elapsedMs` | Int | Cumulative execution time in ms (default: 0) |
| `progress` | Float | Execution progress 0.0-1.0 (default: 0) |
| `prUrl` | String? | Pull request URL after execution |
| `outcome` | String? | Execution result summary |
| `logs` | String? | Execution log output |
| `executionModel` | String? | AI model used for execution |

**Relations:** `team` (Team?), `project` (Project?), `taskLabels` (TaskLabel[])

## Project

Projects group tasks and link to a code repository.

| Field | Type | Description |
|-------|------|-------------|
| `id` | String (cuid) | Primary key |
| `name` | String | Project name |
| `description` | String? | Project description |
| `status` | String | One of: `planned`, `in_progress`, `paused`, `completed`, `cancelled` |
| `color` | String? | Hex color for UI |
| `icon` | String? | Icon identifier |
| `startDate` | DateTime? | Planned start date |
| `targetDate` | DateTime? | Target completion date |
| `leadId` | String? | Foreign key to User (project lead) |
| `repositoryId` | String? | Foreign key to Repository |
| `localPath` | String? | Local filesystem path (alternative to repo) |
| `createdAt` | DateTime | Creation timestamp |
| `updatedAt` | DateTime | Last modification timestamp |

**Relations:** `lead` (User?), `repository` (Repository?), `tasks` (Task[]), `projectTeams` (ProjectTeam[])

## Repository

Represents a GitHub repository or local code folder.

| Field | Type | Description |
|-------|------|-------------|
| `id` | String (cuid) | Primary key |
| `githubRepoId` | String? | GitHub numeric repo ID |
| `name` | String | Repository short name |
| `fullName` | String | Owner/repo format (e.g., "org/repo") |
| `cloneUrl` | String | HTTPS clone URL |
| `defaultBranch` | String | Default branch name (default: "main") |
| `isActive` | Boolean | Whether this is the active repo (default: false) |
| `userId` | String | Foreign key to owning User |
| `createdAt` | DateTime | Import timestamp |
| `updatedAt` | DateTime | Last modification timestamp |

**Relations:** `user` (User), `projects` (Project[])

## Label

Labels for categorizing tasks.

| Field | Type | Description |
|-------|------|-------------|
| `id` | String (cuid) | Primary key |
| `name` | String | Label display name |
| `color` | String | Hex color code |
| `priority` | Int | Sort order (default: 0) |
| `createdAt` | DateTime | Creation timestamp |

**Relations:** `taskLabels` (TaskLabel[])

## Settings

Global application settings (singleton).

| Field | Type | Description |
|-------|------|-------------|
| `id` | String (cuid) | Primary key |
| `parallelLimit` | Int | Max concurrent executions (default: 1) |
| `executionModel` | String? | Default AI model for execution |
| `maxBatchSize` | Int | Max tasks per batch (default: 10) |
| `queueAutoApprove` | Boolean | Auto-approve queued tasks (default: false) |
| `stopOnFailure` | Boolean | Stop batch on first failure (default: true) |
| `conflictBehavior` | String | How to handle conflicts: `skip` or `fail` (default: "skip") |
| `updatedAt` | DateTime | Last modification timestamp |
