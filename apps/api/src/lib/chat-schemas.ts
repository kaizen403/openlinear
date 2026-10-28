/**
 * Request schemas for the round-7 Home Chat routes (confirmation revoke,
 * budget administration). They sit next to the other chat modules so the
 * chat surface can be reviewed in one place; `schemas/chat.ts` keeps the
 * original session/message schemas.
 */
import { z } from 'zod';
import { MAX_TOKEN_LIMIT, MAX_USD_LIMIT, UNKNOWN_COST_POLICIES } from './chat-budget-config';

export const revokeConfirmationBodySchema = z.object({
  code: z.string().trim().regex(/^CONFIRM-[0-9A-HJKMNP-TV-Z]{8}$/i, 'must be a CONFIRM-XXXXXXXX code'),
}).strict();

/** USD with at most 6 decimals (DECIMAL(12,6)); null clears the override. */
const usdLimit = z.number().finite().min(0).max(MAX_USD_LIMIT)
  .refine((value) => Math.abs(Math.round(value * 1e6) - value * 1e6) < 1e-6, 'at most 6 decimal places');
const tokenLimit = z.number().int().min(0).max(MAX_TOKEN_LIMIT);

export const workspaceBudgetBodySchema = z.object({
  monthlyUsdLimit: usdLimit.nullable().optional(),
  monthlyTokenLimit: tokenLimit.nullable().optional(),
  perUserMonthlyUsdLimit: usdLimit.nullable().optional(),
  perUserMonthlyTokenLimit: tokenLimit.nullable().optional(),
  unknownCostPolicy: z.enum(UNKNOWN_COST_POLICIES).nullable().optional(),
}).strict().refine((body) => Object.keys(body).length > 0, 'send at least one field');

export const memberBudgetBodySchema = z.object({
  monthlyUsdLimit: usdLimit.nullable().optional(),
  monthlyTokenLimit: tokenLimit.nullable().optional(),
}).strict().refine((body) => Object.keys(body).length > 0, 'send at least one field');

export type RevokeConfirmationBody = z.infer<typeof revokeConfirmationBodySchema>;
export type WorkspaceBudgetBody = z.infer<typeof workspaceBudgetBodySchema>;
export type MemberBudgetBody = z.infer<typeof memberBudgetBodySchema>;
