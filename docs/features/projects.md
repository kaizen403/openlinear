# Projects

Projects represent higher-level initiatives that group tasks and span across teams.

## Creating a Project

| Field | Required | Type | Default |
|-------|----------|------|---------|
| name | yes | string (1-100 chars) | -- |
| description | no | string (max 1000 chars) | null |
| status | no | planned, in_progress, paused, completed, cancelled | planned |
| color | no | hex color | #6366f1 |
| icon | no | string | null |
| startDate | no | ISO 8601 datetime | null |
| targetDate | no | ISO 8601 datetime | null |
| leadId | no | user UUID | null |
| teamIds | yes | array of team UUIDs (exactly 1) | -- |
| repoUrl | no | string (GitHub URL) | null |
| localPath | no | string (local filesystem path) | null |

## Team Associations

Projects can be associated with multiple teams via the `ProjectTeam` join table. Updating `teamIds` replaces all existing associations.

## Repository Linking

A project can be linked to a GitHub repository in two ways:

- **`repoUrl`**: A GitHub URL (e.g. `https://github.com/owner/repo`). When provided during creation, the system automatically imports the repository and sets `repositoryId`.
- **`localPath`**: A local filesystem path for the project's working directory.

The linked repository appears in the project API response with its name, clone URL, and default branch.

## Project Selector

After first login, users see a project selector screen where they choose or create a project. This sets the active project context for the board, filtering tasks to the selected project.

## Task Assignment

Tasks can be assigned to a project via their `projectId` field. The board can be filtered by project to show only relevant tasks. Each project includes a task count in its API response.

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/projects` | no | List all projects with teams and task counts |
| `POST` | `/api/projects` | yes | Create project |
| `GET` | `/api/projects/:id` | no | Get project with team associations |
| `PATCH` | `/api/projects/:id` | yes | Update project |
| `DELETE` | `/api/projects/:id` | yes | Delete project (unlinks tasks, removes associations) |

## Deletion

Deleting a project sets `projectId` to null on all associated tasks (tasks are not deleted) and removes all project-team associations.
