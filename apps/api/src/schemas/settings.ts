import { z } from 'zod';

export const updateSettingsBodySchema = z
  .object({
    parallelLimit: z.number().int().min(1).max(5).optional(),
    maxBatchSize: z.number().int().min(1).max(10).optional(),
    queueAutoApprove: z.boolean().optional(),
    stopOnFailure: z.boolean().optional(),
    conflictBehavior: z.enum(['skip', 'fail']).optional(),
    taskDeletionMode: z.enum(['archive', 'delete']).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field required',
  });

export type UpdateSettingsBody = z.infer<typeof updateSettingsBodySchema>;
