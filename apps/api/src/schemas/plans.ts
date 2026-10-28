import { z } from 'zod';

/**
 * W17b plan spec: what a plan proposes, by task key. Stored verbatim (and
 * hashed) in each immutable revision; approving the latest revision turns
 * keys into tasks.
 */

export const PLAN_TASK_KEY = /^[A-Za-z0-9._-]{1,40}$/;
export const PLAN_ESTIMATES = ['xs', 's', 'm', 'l', 'xl'] as const;
export const MAX_PLAN_TASKS = 100;

const planTaskKey = z.string().regex(PLAN_TASK_KEY, 'letters, digits, dot, dash or underscore (1-40)');

export const planTaskSpecSchema = z.object({
  key: planTaskKey,
  title: z.string().trim().min(1).max(500),
  description: z.string().max(10_000).optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  /** How to tell the task is done; copied into the task as a checklist. */
  acceptance: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  estimate: z.enum(PLAN_ESTIMATES).optional(),
  /** How likely the task is to go wrong or need a human (shown in review). */
  risk: z.enum(['low', 'medium', 'high']).optional(),
  /** Keys of plan tasks that must be done first. */
  blockedBy: z.array(planTaskKey).max(20).optional(),
}).strict();

export const planSpecSchema = z.object({
  summary: z.string().max(5_000).optional(),
  tasks: z.array(planTaskSpecSchema).min(1).max(MAX_PLAN_TASKS),
}).strict();

export const createPlanBodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  spec: planSpecSchema,
  note: z.string().trim().max(1_000).optional(),
}).strict();

export const revisePlanBodySchema = z.object({
  /** The revision this one is based on; must be the latest (optimistic concurrency). */
  baseRevision: z.number().int().min(1),
  spec: planSpecSchema,
  title: z.string().trim().min(1).max(200).optional(),
  note: z.string().trim().max(1_000).optional(),
}).strict();

export const approvePlanBodySchema = z.object({
  /** The revision being approved; must still be the latest. */
  revision: z.number().int().min(1),
}).strict();

export const getPlanQuerySchema = z.object({
  revision: z.coerce.number().int().min(1).optional(),
}).strict();

export type PlanTaskSpec = z.infer<typeof planTaskSpecSchema>;
export type PlanSpec = z.infer<typeof planSpecSchema>;
export type CreatePlanBody = z.infer<typeof createPlanBodySchema>;
export type RevisePlanBody = z.infer<typeof revisePlanBodySchema>;
export type ApprovePlanBody = z.infer<typeof approvePlanBodySchema>;
export type GetPlanQuery = z.infer<typeof getPlanQuerySchema>;
