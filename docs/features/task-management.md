# Task Management

## Creating Tasks

Tasks are created via the task form dialog (+ button in any column) or through the Brainstorm feature.

**Fields:**

| Field | Required | Type | Default | Notes |
|-------|----------|------|---------|-------|
| title | yes | string (min 1 char) | -- | |
| description | no | string | null | Sent to the AI agent as part of the prompt |
| priority | no | enum: low, medium, high | medium | |
| labels | no | array of label IDs | [] | |
| teamId | no | UUID | null | Enables team-scoped numbering |
| projectId | no | UUID | null | Associates task with a project |

When a task is created with a `teamId`, the system auto-assigns the next issue number for that team and generates an identifier (e.g. `ENG-1`, `DSN-5`).

**API:** `POST /api/tasks`

## Updating Tasks

All fields are editable after creation, including status. Updating labels replaces the full set (delete all existing, create new associations).

**API:** `PATCH /api/tasks/:id`

## Deleting Tasks

Deleting a task soft-deletes it by setting `archived: true`. The task disappears from the board but remains in the database. Archived tasks can be viewed, permanently deleted individually, or bulk-deleted.

**API:**
- `DELETE /api/tasks/:id` -- archives the task
- `GET /api/tasks/archived` -- list archived tasks
- `DELETE /api/tasks/archived/:id` -- permanently delete one
- `DELETE /api/tasks/archived` -- permanently delete all archived

## Task Detail View

Clicking a task card opens a side panel with:
- Full title and description
- Priority, labels, team, project
- Execution status and progress
- Live execution logs (when running)
- PR link (when done)
- Execution outcome summary

## Labels

Labels are colored tags attached to tasks for categorization.

**Fields:**
- `name` -- unique string (1-50 chars)
- `color` -- hex color (e.g. `#ff5733`)
- `priority` -- integer for ordering (higher = shown first)

**API:**
- `GET /api/labels` -- list all labels (ordered by priority desc)
- `POST /api/labels` -- create label
- `PATCH /api/labels/:id` -- update label
- `DELETE /api/labels/:id` -- delete label
- `POST /api/labels/tasks/:id/labels` -- assign label to task
- `DELETE /api/labels/tasks/:id/labels/:labelId` -- unassign label from task

## Team-Scoped Issue Numbers

When a task belongs to a team, it receives an auto-incrementing number scoped to that team. The team's `nextIssueNumber` is atomically incremented in a transaction.

Example: Team with key `ENG` creates its third task. The task gets `number: 3` and `identifier: ENG-3`.
