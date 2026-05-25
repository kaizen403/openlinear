import { z } from 'zod';

export const updateUserBodySchema = z.object({
  displayName: z.string().max(100).optional(),
  email: z.string().email().optional(),
  avatarUrl: z.string().url().optional(),
});

export type UpdateUserBody = z.infer<typeof updateUserBodySchema>;
