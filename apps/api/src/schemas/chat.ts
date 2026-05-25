import { z } from 'zod';

export const chatSessionListQuerySchema = z.object({
  workspaceId: z.string().min(1),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const createChatSessionBodySchema = z.object({
  workspaceId: z.string().min(1),
  projectId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(60).optional(),
});

export const chatMessagesQuerySchema = z.object({
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const updateChatSessionBodySchema = z.object({
  title: z.string().trim().min(1).max(60).optional(),
  projectId: z.string().uuid().nullable().optional(),
});

export const sendChatMessageBodySchema = z.object({
  content: z.string().trim().min(1).max(20000),
  attachmentIds: z.array(z.string().uuid()).max(10).optional(),
});

export const prioritySchema = z.enum(['low', 'medium', 'high']);
export const statusSchema = z.enum(['todo', 'in_progress', 'done', 'cancelled']);
export const projectStatusSchema = z.enum(['planned', 'in_progress', 'paused', 'completed', 'cancelled']);
export const workspaceRoleSchema = z.enum(['owner', 'admin', 'member', 'viewer']);
export const teamRoleSchema = z.enum(['owner', 'admin', 'member']);
export const projectPermissionSchema = z.enum(['full', 'view', 'deny']);

export type ChatSessionListQuery = z.infer<typeof chatSessionListQuerySchema>;
export type CreateChatSessionBody = z.infer<typeof createChatSessionBodySchema>;
export type ChatMessagesQuery = z.infer<typeof chatMessagesQuerySchema>;
export type UpdateChatSessionBody = z.infer<typeof updateChatSessionBodySchema>;
export type SendChatMessageBody = z.infer<typeof sendChatMessageBodySchema>;
