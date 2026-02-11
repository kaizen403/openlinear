# Inbox

A notification-style feed for completed tasks.

## What It Shows

The inbox lists all tasks with status `done` that are not archived. It serves as a log of completed AI executions so you can review results, check PR links, and mark items as read.

## Unread Count

The sidebar shows a badge with the count of unread items (done tasks where `inboxRead` is false).

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/inbox` | List all inbox items (done, non-archived tasks) with labels, team, and project |
| `GET` | `/api/inbox/count` | Get count of unread items |
| `PATCH` | `/api/inbox/read/:id` | Mark a single item as read |
| `PATCH` | `/api/inbox/read-all` | Mark all items as read |

Items are ordered by `updatedAt` descending (most recently completed first).
