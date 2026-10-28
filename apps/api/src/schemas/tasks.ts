import { z } from 'zod';
import { runnerIdSchema } from './runner';

const PriorityEnum = z.enum(['low', 'medium', 'high']);
const StatusEnum = z.enum(['todo', 'in_progress', 'done', 'cancelled']);

export const createTaskBodySchema = z
  .object({
    title: z.string().min(1, 'Title is required').max(500, 'Title is at most 500 characters'),
    description: z.string().optional(),
    priority: PriorityEnum.optional().default('medium'),
    status: StatusEnum.optional().default('todo'),
    labelIds: z.array(z.string().uuid()).optional().default([]),
    teamId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    dueDate: z.string().datetime().nullable().optional(),
    model: z.string().min(1).nullable().optional(),
    /** FE-02: agent runner for this task (null = the project's default, else OpenCode). */
    agent: runnerIdSchema.nullable().optional(),
    /** Primary assignee (shown on the board). Defaults to the first of `assigneeIds`. */
    assigneeId: z.string().uuid().nullable().optional(),
    /** Assignees (team members of the task's team); stored as `TaskAssignee` rows. */
    assigneeIds: z.array(z.string().uuid()).max(50).optional(),
  })
  .refine((data) => Boolean(data.teamId) || Boolean(data.projectId), {
    message: 'Task must belong to a team or a project',
    path: ['teamId'],
  });

const bulkTaskInputSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(10000).optional(),
  priority: PriorityEnum.optional().default('medium'),
  status: StatusEnum.optional().default('todo'),
  labelIds: z.array(z.string().uuid()).optional().default([]),
  parentId: z.string().uuid().optional(),
  dueDate: z.string().datetime().optional(),
  assigneeIds: z.array(z.string().uuid()).max(50).optional(),
});

export const bulkCreateTasksSchema = z.object({
  projectId: z.string().uuid(),
  tasks: z.array(bulkTaskInputSchema).min(1).max(100),
});

export const updateTaskBodySchema = z.object({
  title: z.string().min(1).max(500, 'Title is at most 500 characters').optional(),
  description: z.string().nullable().optional(),
  priority: PriorityEnum.optional(),
  status: StatusEnum.optional(),
  labelIds: z.array(z.string().uuid()).optional(),
  teamId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  assigneeIds: z.array(z.string().uuid()).optional(),
  watcherIds: z.array(z.string().uuid()).optional(),
  model: z.string().min(1).nullable().optional(),
  agent: runnerIdSchema.nullable().optional(),
});

// "me" or a UUID — UUID is checked against caller's team membership in the route.
const meOrUuid = z.union([z.literal('me'), z.string().uuid()]);

/**
 * A query value that may be repeated (`status=todo&status=done`) or
 * comma-separated (`status=todo,done`); both normalise to a de-duplicated
 * array. Empty items are dropped; nothing left means "not given".
 */
function listParam<T extends z.ZodTypeAny>(item: T, max: number) {
  return z.preprocess((value) => {
    if (value === undefined || value === null) return undefined;
    const raw: unknown[] = Array.isArray(value) ? value : [value];
    const items = raw
      .flatMap((entry) => (typeof entry === 'string' ? entry.split(',') : [entry]))
      .map((entry) => (typeof entry === 'string' ? entry.trim() : entry))
      .filter((entry) => entry !== '');
    return items.length > 0 ? [...new Set(items)] : undefined;
  }, z.array(item).min(1).max(max).optional());
}

export const TASK_LIST_MAX_PAGE_SIZE = 200;

/**
 * `GET /api/tasks`.
 *
 * Default (offset) mode keeps the original response shape
 * `{ items, total, page, pageSize, hasMore }`, plus an additive `nextCursor`.
 * `cursor=<token>` or `pagination=cursor` switches to keyset pagination:
 * `{ items, pageSize, hasMore, nextCursor }` (+ `total` with
 * `includeTotal=true`). Both modes order by `createdAt DESC, id DESC`.
 */
export const listTasksQuerySchema = z.object({
  teamId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  /** `me`, a user id, or `none` (unassigned). Matches the primary assignee or any `TaskAssignee` assignee. */
  assignee: z.union([meOrUuid, z.literal('none')]).optional(),
  creator: meOrUuid.optional(),
  status: listParam(StatusEnum, 4),
  /** One or more label ids; a task matches when it has any of them. */
  labelId: listParam(z.string().uuid(), 20),
  /** Case-insensitive substring of the title, description or identifier. */
  q: z.string().trim().min(1).max(200).optional(),
  /**
   * Exact identifier such as `ENG-12`, case-insensitive (never `ENG-120`).
   * Identifiers are unique per team, not globally, so this can still match
   * several visible issues in different workspaces; the CLI refuses that as
   * ambiguous. Combined with the other filters as AND.
   */
  identifier: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,9}$/).optional(),
  /** Sub-issues of one parent, or `none` for top-level issues only. */
  parentId: z.union([z.string().uuid(), z.literal('none')]).optional(),
  pagination: z.enum(['offset', 'cursor']).optional(),
  cursor: z.string().min(1).max(512).optional(),
  includeTotal: z.enum(['true', 'false']).optional(),
  /** `compact` omits `executionLogs` (the heaviest column) from every row. */
  view: z.enum(['full', 'compact']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(TASK_LIST_MAX_PAGE_SIZE).default(50),
});

/**
 * Bulk endpoints act on one project (`projectId`, as before) or on one
 * team's project-less issues (`teamId`). Exactly one is required; the
 * service answers 400 `BULK_SCOPE_INVALID` otherwise.
 */
const bulkScope = {
  projectId: z.string().uuid().optional(),
  teamId: z.string().uuid().optional(),
};

export const bulkStatusBodySchema = z.object({
  ...bulkScope,
  status: StatusEnum,
  /**
   * Required, 1–100 ids. Omitted or empty used to mean "every issue in the
   * project"; that is now refused with 400 `TASK_IDS_REQUIRED`.
   */
  taskIds: z.array(z.string().uuid()).max(100).optional(),
});

export const bulkArchiveBodySchema = z.object({
  ...bulkScope,
  taskIds: z.array(z.string().uuid()).max(100).optional(),
  identifiers: z.array(z.string().min(1)).max(100).optional(),
});

export const bulkDeleteBodySchema = z.object({
  ...bulkScope,
  taskIds: z.array(z.string().uuid()).min(1).max(100),
  permanent: z.boolean().optional(),
});

/** W17a: `POST /api/tasks/:id/dependencies` — this task is blocked by `dependsOnTaskId`. */
export const taskDependencyBodySchema = z.object({
  dependsOnTaskId: z.string().uuid(),
}).strict();

/** W17a: `GET /api/tasks/dependencies?taskIds=a,b` — edges among those tasks (batch ordering). */
export const dependencyEdgesQuerySchema = z.object({
  taskIds: listParam(z.string().uuid(), 100).refine((value) => value !== undefined, { message: 'taskIds is required' }),
}).strict();

/** FE-11: `GET /api/tasks/similar?projectId=&title=` — duplicate hints. */
export const similarTasksQuerySchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().trim().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(10).default(5),
  excludeTaskId: z.string().uuid().optional(),
}).strict();

export type CreateTaskBody = z.infer<typeof createTaskBodySchema>;
export type BulkCreateTasksBody = z.infer<typeof bulkCreateTasksSchema>;
export type UpdateTaskBody = z.infer<typeof updateTaskBodySchema>;
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;
export type BulkStatusBody = z.infer<typeof bulkStatusBodySchema>;
export type BulkArchiveBody = z.infer<typeof bulkArchiveBodySchema>;
export type BulkDeleteBody = z.infer<typeof bulkDeleteBodySchema>;
export type TaskDependencyBody = z.infer<typeof taskDependencyBodySchema>;
export type DependencyEdgesQuery = z.infer<typeof dependencyEdgesQuerySchema>;
export type SimilarTasksQuery = z.infer<typeof similarTasksQuerySchema>;
