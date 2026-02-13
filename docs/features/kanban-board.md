# Kanban Board

The board is the primary interface. It displays tasks in four fixed columns that map directly to task statuses.

## Columns

| Column | Status | Description |
|--------|--------|-------------|
| Todo | `todo` | Tasks waiting to be worked on |
| In Progress | `in_progress` | Tasks currently being executed by an agent |
| Done | `done` | Completed tasks (may include a PR link) |
| Cancelled | `cancelled` | Tasks stopped mid-execution or manually cancelled |

Columns are not renameable or reorderable.

## Drag and Drop

Tasks can be dragged between columns to change their status. The board uses `@hello-pangea/dnd` for drag-and-drop. Dropping a task into a different column updates its status in the database and broadcasts a `task:updated` SSE event.

## Task Cards

Each card shows:
- Title
- Priority indicator (low / medium / high)
- Assigned labels (colored badges)
- Due date with overdue indicator (if set)
- Execution status (when running: cloning, executing, committing, etc.)
- PR link (when execution is complete)

Clicking a card opens the task detail view in a side panel.

## Multi-Select and Batch Operations

Tasks can be selected with checkboxes for batch operations:
- Click individual checkboxes to select specific tasks
- Use column-level select-all to select all tasks in a column
- When tasks are selected, a floating control bar appears at the bottom with options:
  - Execute Parallel -- run all selected tasks simultaneously
  - Execute Queue -- run selected tasks one at a time
  - Move to In Progress
  - Clear selection

## Real-Time Updates

The board subscribes to the SSE endpoint (`/api/events`) and handles these events:
- `task:created` -- adds a new card
- `task:updated` -- moves card between columns, updates status/labels
- `task:deleted` -- removes card (archives it)
- `execution:progress` -- updates execution status on the card
- `execution:log` -- appends to the task's live log
- `batch:*` events -- updates batch progress indicators

No manual refresh is needed. All changes from the API, agent execution, or other clients appear instantly.

## Project Filtering

When a project is selected in the sidebar, the board filters to show only tasks assigned to that project. The filter is applied via a `projectId` query parameter to the tasks API.
