import { z } from 'zod';

/** W15b insights: the window ends now and starts at UTC midnight `days - 1` days ago (today included). */
export const INSIGHTS_RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90 } as const;
export type InsightsRange = keyof typeof INSIGHTS_RANGE_DAYS;

export const insightsQuerySchema = z.object({
  range: z.enum(['7d', '30d', '90d']).default('30d'),
}).strict();

export type InsightsQuery = z.infer<typeof insightsQuerySchema>;
