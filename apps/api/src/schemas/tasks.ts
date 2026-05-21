import { z } from 'zod';

const PriorityEnum = z.enum(['low', 'medium', 'high']);
const StatusEnum = z.enum(['todo', 'in_progress', 'done', 'cancelled']);

export const createTaskBodySchema = z
  .object({
    title: z.string().min(1, 'Title is required'),
    description: z.string().optional(),
    priority: PriorityEnum.optional().default('medium'),
    status: StatusEnum.optional().default('todo'),
    labelIds: z.array(z.string().uuid()).optional().default([]),
    teamId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    dueDate: z.string().datetime().nullable().optional(),
    model: z.string().min(1).nullable().optional(),
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
});

export const bulkCreateTasksSchema = z.object({
  projectId: z.string().uuid(),
  tasks: z.array(bulkTaskInputSchema).min(1).max(100),
});

export const updateTaskBodySchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  priority: PriorityEnum.optional(),
  status: StatusEnum.optional(),
  labelIds: z.array(z.string().uuid()).optional(),
  teamId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  model: z.string().min(1).nullable().optional(),
});

// "me" or a UUID — UUID is checked against caller's team membership in the route.
const meOrUuid = z.union([z.literal('me'), z.string().uuid()]);

export const listTasksQuerySchema = z.object({
  teamId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  assignee: meOrUuid.optional(),
  creator: meOrUuid.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export type CreateTaskBody = z.infer<typeof createTaskBodySchema>;
export type BulkCreateTasksBody = z.infer<typeof bulkCreateTasksSchema>;
export type UpdateTaskBody = z.infer<typeof updateTaskBodySchema>;
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;
