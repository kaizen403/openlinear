import { z } from 'zod';

export const updateUserBodySchema = z.object({
  displayName: z.string().max(100).optional(),
  avatarUrl: z.string().url().optional(),
}).refine((value) => value.displayName !== undefined || value.avatarUrl !== undefined, {
  message: 'No updatable fields provided',
});

export type UpdateUserBody = z.infer<typeof updateUserBodySchema>;
