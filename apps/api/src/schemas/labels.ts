import { z } from 'zod';

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

export const createLabelBodySchema = z.object({
  name: z.string().min(1).max(50),
  color: hexColor,
  priority: z.number().int().min(0).default(0),
  projectId: z.string().uuid(),
});

export const updateLabelBodySchema = z.object({
  name: z.string().min(1).max(50).optional(),
  color: hexColor.optional(),
  priority: z.number().int().min(0).optional(),
});

export const assignLabelBodySchema = z.object({
  labelId: z.string().uuid(),
});

export const listLabelsQuerySchema = z.object({
  projectId: z.string().uuid(),
});

export type CreateLabelBody = z.infer<typeof createLabelBodySchema>;
export type UpdateLabelBody = z.infer<typeof updateLabelBodySchema>;
export type AssignLabelBody = z.infer<typeof assignLabelBodySchema>;
export type ListLabelsQuery = z.infer<typeof listLabelsQuerySchema>;
