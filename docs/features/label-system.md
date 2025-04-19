# Label System

## Overview

Labels are colored tags that can be attached to tasks for categorization and filtering. Each label has a name, a hex color, and a numeric priority that controls display order. The association between tasks and labels is a many-to-many join table. All label mutations broadcast SSE events so connected clients update in real time.

---

## Architecture

```
Desktop UI (LabelPicker component)
    │  GET /api/labels
    │  POST /api/labels/tasks/:id/labels
    │  DELETE /api/labels/tasks/:id/labels/:labelId
    ▼
apps/api/src/routes/labels.ts       ← HTTP layer + SSE broadcast
    │
    ▼
packages/db/prisma/schema.prisma    ← Label + TaskLabel models
    │
    ▼
PostgreSQL (labels + task_labels tables)
```

---

## Data Model

Defined in `packages/db/prisma/schema.prisma`:

```prisma
model Label {
  id       String      @id @default(uuid())
  name     String      @unique
  color    String                    // hex, e.g. "#6366f1"
  priority Int         @default(0)  // higher = shown first
  tasks    TaskLabel[]

  @@map("labels")
}

model TaskLabel {
  taskId  String
  labelId String
  task    Task   @relation(fields: [taskId], references: [id], onDelete: Cascade)
  label   Label  @relation(fields: [labelId], references: [id], onDelete: Cascade)

  @@id([taskId, labelId])           // composite PK prevents duplicates
  @@map("task_labels")
}
```

Key design decisions:
- `Label.name` has a `@unique` constraint — duplicate label names are rejected at the database level.
- `TaskLabel` uses a composite primary key `[taskId, labelId]`, so assigning the same label twice returns a 409.
- Both foreign keys use `onDelete: Cascade`, so deleting a task or label automatically removes all its join rows.
- Labels are global (not scoped to a user or project). Any task can use any label.

---

## API Endpoints

All routes are mounted at `/api/labels` in `apps/api/src/routes/labels.ts`. No authentication is required on any label endpoint.

### Label CRUD

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/labels` | List all labels, ordered by `priority DESC` |
| `POST` | `/api/labels` | Create a new label |
| `PATCH` | `/api/labels/:id` | Update a label's name, color, or priority |
| `DELETE` | `/api/labels/:id` | Delete a label (cascades to all task assignments) |

### Task-label associations

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/labels/tasks/:id/labels` | Assign a label to a task |
| `DELETE` | `/api/labels/tasks/:id/labels/:labelId` | Remove a label from a task |

---

## Validation

Label creation and updates are validated with Zod schemas defined at the top of `apps/api/src/routes/labels.ts`:

```typescript
const createLabelSchema = z.object({
  name: z.string().min(1).max(50),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Color must be a valid hex color'),
  priority: z.number().int().min(0).default(0),
});

const updateLabelSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Color must be a valid hex color').optional(),
  priority: z.number().int().min(0).optional(),
});

const assignLabelSchema = z.object({
  labelId: z.string().uuid(),
});
```

The color regex enforces exactly six hex digits with a leading `#`. Partial updates are supported — only the fields provided in the PATCH body are written.

---

## SSE Events

Every mutation broadcasts a real-time event via `broadcast()` from `apps/api/src/sse.ts`:

| Event | Payload | Trigger |
|-------|---------|---------|
| `label:created` | Full label object | `POST /api/labels` |
| `label:updated` | Updated label object | `PATCH /api/labels/:id` |
| `label:deleted` | `{ id }` | `DELETE /api/labels/:id` |
| `task:label:assigned` | `{ taskId, label }` | `POST /api/labels/tasks/:id/labels` |
| `task:label:removed` | `{ taskId, labelId }` | `DELETE /api/labels/tasks/:id/labels/:labelId` |

The `task:label:assigned` event includes the full label object (not just the ID) so clients can update their local state without a follow-up fetch.

---

## Implementation Details

### Creating a label

```typescript
// apps/api/src/routes/labels.ts
router.post('/', async (req, res) => {
  const parsed = createLabelSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json(...); return; }

  const label = await prisma.label.create({ data: parsed.data });
  broadcast('label:created', label);
  res.status(201).json(label);
});
```

Unique constraint violations (duplicate name) are caught and returned as 409.

### Assigning a label to a task

The route validates both the task and label exist before creating the join row:

```typescript
router.post('/tasks/:id/labels', async (req, res) => {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) { res.status(404).json({ error: 'Task not found' }); return; }

  const label = await prisma.label.findUnique({ where: { id: labelId } });
  if (!label) { res.status(404).json({ error: 'Label not found' }); return; }

  const taskLabel = await prisma.taskLabel.create({
    data: { taskId, labelId },
    include: { label: true },
  });

  broadcast('task:label:assigned', { taskId, label: taskLabel.label });
  res.status(201).json(taskLabel);
});
```

### Labels in task execution

When the sidecar executes a task, it includes label names in the prompt sent to the AI agent:

```typescript
// apps/sidecar/src/services/execution/lifecycle.ts
if (taskWithProject.labels.length > 0) {
  const labelNames = taskWithProject.labels
    .map((tl: TaskLabelRelation) => tl.label.name)
    .join(', ');
  prompt += `\n\nLabels: ${labelNames}`;
}
```

This gives the agent context about the task's category (e.g., "bug", "feature", "docs").

### Labels in task responses

Wherever a task is returned from the API, labels are flattened from the join table format into a plain array. This normalization happens in multiple places:

```typescript
// apps/sidecar/src/routes/execution.ts
function flattenLabels(task: any) {
  const { labels, ...rest } = task;
  return {
    ...rest,
    labels: (labels as Array<{ label: any }>).map((tl) => tl.label),
  };
}
```

The raw Prisma result returns `labels: [{ taskId, labelId, label: { id, name, color } }]`. The flattened form returns `labels: [{ id, name, color }]`.

---

## UI: LabelPicker Component

File: `apps/desktop-ui/components/label-picker.tsx`

The `LabelPicker` is a controlled component that renders a popover with checkboxes for each label. It fetches labels on mount from `GET /api/labels` and sorts them by `priority` ascending.

```typescript
interface LabelPickerProps {
  selectedIds: string[]       // controlled: array of selected label IDs
  onChange: (ids: string[]) => void
  triggerClassName?: string
}
```

Selected labels are rendered as colored badges below the trigger button. The badge background uses the label color at 12% opacity (`${label.color}20`) and the border at 25% opacity (`${label.color}40`), with the full color applied to the text.

Toggling a label calls `onChange` with the updated ID array — the component does not call the API directly. The parent component is responsible for persisting the selection via `POST /api/labels/tasks/:id/labels` or `DELETE /api/labels/tasks/:id/labels/:labelId`.

---

## Key Files

| File | Purpose |
|------|---------|
| `apps/api/src/routes/labels.ts` | All label and task-label HTTP handlers |
| `apps/desktop-ui/components/label-picker.tsx` | Label selection UI component |
| `packages/db/prisma/schema.prisma` | `Label` and `TaskLabel` model definitions |
| `apps/api/src/sse.ts` | SSE broadcast utility |
