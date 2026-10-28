import { z } from 'zod';

export const updateSettingsBodySchema = z
  .object({
    parallelLimit: z.number().int().min(1).max(5).optional(),
    maxBatchSize: z.number().int().min(1).max(10).optional(),
    queueAutoApprove: z.boolean().optional(),
    stopOnFailure: z.boolean().optional(),
    conflictBehavior: z.enum(['skip', 'fail']).optional(),
    taskDeletionMode: z.enum(['archive', 'delete']).optional(),
    /** W15a: stop a run when its reported cost reaches this many USD (null = no limit). */
    maxRunCostUsd: z.number().positive().max(10_000).nullable().optional(),
    /** W15a: stop a run when its input + output tokens reach this (null = no limit). */
    maxRunTokens: z.number().int().min(1_000).max(1_000_000_000).nullable().optional(),
    /** FE-04: "ask" = runs wait for the user's approval of agent permission requests. */
    approvalMode: z.enum(['auto', 'ask']).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field required',
  });

export type UpdateSettingsBody = z.infer<typeof updateSettingsBodySchema>;
