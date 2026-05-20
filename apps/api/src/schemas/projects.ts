import { z } from 'zod';

const branchNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._/-]+$/);

export const createProjectBodySchema = z.object({
  workspaceId: z.string().min(1).optional(),
  key: z
    .string()
    .trim()
    .min(2)
    .max(12)
    .regex(/^[A-Za-z][A-Za-z0-9]*$/)
    .transform((value) => value.toUpperCase())
    .optional(),
  name: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  status: z
    .enum(['planned', 'in_progress', 'paused', 'completed', 'cancelled'])
    .optional(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
  icon: z.string().optional(),
  startDate: z.string().datetime().optional(),
  targetDate: z.string().datetime().optional(),
  leadId: z.string().uuid().optional(),
  teamIds: z.array(z.string().uuid()).min(1).max(1).optional(),
  repoUrl: z.string().optional(),
  repositoryId: z.string().uuid().optional(),
  defaultBranch: branchNameSchema.optional(),
  localPath: z.string().optional(),
});

export const updateProjectBodySchema = z.object({
  workspaceId: z.string().min(1).nullable().optional(),
  key: z
    .string()
    .trim()
    .min(2)
    .max(12)
    .regex(/^[A-Za-z][A-Za-z0-9]*$/)
    .transform((value) => value.toUpperCase())
    .nullable()
    .optional(),
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).nullable().optional(),
  status: z
    .enum(['planned', 'in_progress', 'paused', 'completed', 'cancelled'])
    .optional(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
  icon: z.string().nullable().optional(),
  startDate: z.string().datetime().nullable().optional(),
  targetDate: z.string().datetime().nullable().optional(),
  leadId: z.string().uuid().nullable().optional(),
  teamIds: z.array(z.string().uuid()).max(1).optional(),
  repoUrl: z.string().nullable().optional(),
  localPath: z.string().nullable().optional(),
});

export const listProjectsQuerySchema = z.object({
  teamId: z.string().uuid().optional(),
  workspaceId: z.string().min(1).optional(),
});

export const projectAccessBodySchema = z.object({
  userId: z.string().min(1),
  permission: z.enum(['full', 'view', 'deny']).default('full'),
});

export const bulkProjectAccessBodySchema = z.object({
  grants: z
    .array(
      z.object({
        userId: z.string().min(1),
        permission: z.enum(['full', 'view', 'deny']).default('full'),
      }),
    )
    .min(1)
    .max(200),
});

export type CreateProjectBody = z.infer<typeof createProjectBodySchema>;
export type UpdateProjectBody = z.infer<typeof updateProjectBodySchema>;
export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;
export type ProjectAccessBody = z.infer<typeof projectAccessBodySchema>;
export type BulkProjectAccessBody = z.infer<typeof bulkProjectAccessBodySchema>;
