import { z } from 'zod';

export const workspaceRoleSchema = z.enum(['owner', 'admin', 'member', 'viewer']);

export const createWorkspaceBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
});

export const updateWorkspaceBodySchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
});

export const addWorkspaceMemberBodySchema = z.object({
  username: z.string().trim().min(1).max(100),
  role: z.enum(['admin', 'member', 'viewer']),
});

export const updateWorkspaceMemberBodySchema = z.object({
  role: workspaceRoleSchema,
});

export const bulkWorkspaceMembersBodySchema = z.object({
  invites: z
    .array(
      z.object({
        username: z.string().trim().min(1).max(100),
        role: z.enum(['owner', 'admin', 'member', 'viewer']),
      }),
    )
    .min(1)
    .max(200),
});

export type CreateWorkspaceBody = z.infer<typeof createWorkspaceBodySchema>;
export type UpdateWorkspaceBody = z.infer<typeof updateWorkspaceBodySchema>;
export type AddWorkspaceMemberBody = z.infer<typeof addWorkspaceMemberBodySchema>;
export type UpdateWorkspaceMemberBody = z.infer<typeof updateWorkspaceMemberBodySchema>;
export type BulkWorkspaceMembersBody = z.infer<typeof bulkWorkspaceMembersBodySchema>;
