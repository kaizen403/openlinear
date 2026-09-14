import { z } from 'zod';

export const createInvitationBodySchema = z.object({
  email: z.string().email(),
  workspaceId: z.string().uuid(),
  role: z.enum(['admin', 'member', 'viewer']).optional().default('member'),
});

export const acceptInvitationBodySchema = z.object({
  token: z.string().uuid().optional(),
});

export type CreateInvitationBody = z.infer<typeof createInvitationBodySchema>;
export type AcceptInvitationBody = z.infer<typeof acceptInvitationBodySchema>;
