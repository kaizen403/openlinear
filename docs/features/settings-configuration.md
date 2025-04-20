# Settings and Configuration

## Overview

OpenLinear stores a single global settings record in the database. Settings control how the execution engine runs tasks: how many can run in parallel, how large a batch can be, whether to stop on failure, and how to handle conflicts. Changes are persisted immediately and broadcast to all connected clients via SSE.

---

## Key Files

| File | Role |
|------|------|
| `apps/api/src/routes/settings.ts` | GET and PATCH endpoints |
| `apps/api/src/sse.ts` | `broadcast()` called after every update |
| `packages/db/prisma/schema.prisma` | `Settings` model definition |

---

## Database Schema

```prisma
model Settings {
  id            String  @id @default("default")
  parallelLimit Int     @default(3)
  executionModel String?

  // Batch execution settings
  maxBatchSize     Int     @default(3)
  queueAutoApprove Boolean @default(false)
  stopOnFailure    Boolean @default(false)
  conflictBehavior String  @default("skip") // "skip" | "fail"

  @@map("settings")
}
```

The `id` is always `"default"`. There is exactly one settings row. The upsert pattern in both endpoints ensures the row is created on first access if it doesn't exist yet.

### Field reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `parallelLimit` | `Int` | `3` | Max tasks running concurrently (1–5) |
| `executionModel` | `String?` | `null` | AI model identifier for execution |
| `maxBatchSize` | `Int` | `3` | Max tasks in a single batch (1–10) |
| `queueAutoApprove` | `Boolean` | `false` | Skip manual approval for queued batches |
| `stopOnFailure` | `Boolean` | `false` | Halt the batch if any task fails |
| `conflictBehavior` | `String` | `"skip"` | What to do on git conflict: `"skip"` or `"fail"` |

---

## API Endpoints

Both routes are mounted under `/api/settings`.

### `GET /api/settings`

Returns the current settings. Creates the default row if it doesn't exist.

**Auth:** None.

**Response:**
```json
{
  "id": "default",
  "parallelLimit": 3,
  "executionModel": null,
  "maxBatchSize": 3,
  "queueAutoApprove": false,
  "stopOnFailure": false,
  "conflictBehavior": "skip"
}
```

**Implementation:**

```typescript
const settings = await prisma.settings.upsert({
  where: { id: 'default' },
  update: {},
  create: { id: 'default' },
});
```

The `update: {}` means the upsert never modifies an existing row — it only creates one if absent.

---

### `PATCH /api/settings`

Updates one or more settings fields. Validates the request body with Zod, persists the change, and broadcasts `settings:updated` to all SSE clients.

**Auth:** None.

**Request body** (all fields optional, at least one required):
```json
{
  "parallelLimit": 2,
  "maxBatchSize": 5,
  "queueAutoApprove": true,
  "stopOnFailure": false,
  "conflictBehavior": "fail"
}
```

**Response:** The full updated settings object.

**Validation schema:**

```typescript
const UpdateSettingsSchema = z.object({
  parallelLimit: z.number().int().min(1).max(5).optional(),
  maxBatchSize: z.number().int().min(1).max(10).optional(),
  queueAutoApprove: z.boolean().optional(),
  stopOnFailure: z.boolean().optional(),
  conflictBehavior: z.enum(['skip', 'fail']).optional(),
}).refine(data => Object.keys(data).length > 0, {
  message: 'At least one field required'
});
```

Constraints enforced by Zod:
- `parallelLimit`: integer, 1 to 5 inclusive
- `maxBatchSize`: integer, 1 to 10 inclusive
- `conflictBehavior`: must be exactly `"skip"` or `"fail"`
- At least one field must be present (the `.refine` check)

**Implementation:**

```typescript
const settings = await prisma.settings.upsert({
  where: { id: 'default' },
  update: parsed.data,
  create: { id: 'default', ...parsed.data },
});

broadcast('settings:updated', settings);
res.json(settings);
```

The upsert here applies the validated partial update. After the write, `broadcast` pushes the full updated settings object to every connected SSE client.

---

## SSE Broadcast on Update

After every successful PATCH, the settings route calls:

```typescript
import { broadcast } from '../sse';
// ...
broadcast('settings:updated', settings);
```

The `settings:updated` event carries the complete settings object. Clients subscribed via `useSSESubscription` receive it and can update their local settings cache immediately, without a separate GET request.

The `SSEProvider` in `apps/desktop-ui/providers/sse-provider.tsx` includes `'settings:updated'` in its `ALL_EVENT_TYPES` array, so it's automatically forwarded to all subscribers.

---

## Conflict Behavior

The `conflictBehavior` field controls what happens when the execution engine encounters a git merge conflict during a batch run.

| Value | Behavior |
|-------|----------|
| `"skip"` | The conflicting task is marked skipped; the batch continues |
| `"fail"` | The conflicting task is marked failed; if `stopOnFailure` is also true, the batch halts |

---

## Parallel Limit

`parallelLimit` caps how many tasks the execution engine runs at the same time. The engine reads this value before starting each batch. Changing it mid-batch does not affect the currently running batch — the new value takes effect on the next batch.

Valid range: 1 (sequential) to 5 (maximum concurrency).

---

## Execution Model

`executionModel` is a nullable string that identifies which AI model the execution engine should use. The field has no validation constraints beyond being a string — the execution engine is responsible for interpreting it.

---

## Data Flow: Changing a Setting

1. UI sends `PATCH /api/settings` with `{ parallelLimit: 2 }`.
2. Zod validates the body.
3. Prisma upserts the `settings` row with `id = "default"`.
4. `broadcast('settings:updated', settings)` writes the event to all open SSE streams.
5. Every connected UI instance receives `settings:updated` and updates its local state.
6. The API responds with the full updated settings object.

---

## Endpoint Summary

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/settings` | None | Fetch current settings (creates defaults if absent) |
| `PATCH` | `/api/settings` | None | Update one or more settings fields |
