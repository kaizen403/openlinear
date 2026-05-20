import { z } from 'zod';

export const createTeamBodySchema = z.object({
  name: z.string().min(1).max(50),
  key: z
    .string()
    .min(1)
    .max(10)
    .regex(/^[A-Z][A-Z0-9]*$/, 'Key must be uppercase alphanumeric starting with a letter'),
  description: z.string().max(500).optional(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
  icon: z.string().optional(),
  private: z.boolean().optional(),
});

export const updateTeamBodySchema = z.object({
  name: z.string().min(1).max(50).optional(),
  key: z
    .string()
    .min(1)
    .max(10)
    .regex(/^[A-Z][A-Z0-9]*$/, 'Key must be uppercase alphanumeric starting with a letter')
    .optional(),
  description: z.string().max(500).nullable().optional(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
  icon: z.string().nullable().optional(),
  private: z.boolean().optional(),
});

export const joinTeamBodySchema = z.object({
  inviteCode: z.string().min(1),
});

export const addMemberBodySchema = z
  .object({
    email: z.string().email().optional(),
    userId: z.string().uuid().optional(),
    role: z.enum(['owner', 'admin', 'member']).optional().default('member'),
  })
  .refine((data) => Boolean(data.email) || Boolean(data.userId), {
    message: 'Either email or userId is required',
  });

export const updateTeamMemberBodySchema = z.object({
  role: z.enum(['owner', 'admin', 'member']),
});

export type CreateTeamBody = z.infer<typeof createTeamBodySchema>;
export type UpdateTeamBody = z.infer<typeof updateTeamBodySchema>;
export type JoinTeamBody = z.infer<typeof joinTeamBodySchema>;
export type AddMemberBody = z.infer<typeof addMemberBodySchema>;
export type UpdateTeamMemberBody = z.infer<typeof updateTeamMemberBodySchema>;
