/**
 * Operator defaults for Home Chat budgets (W15), validated from the
 * environment. Budgets are monthly (UTC calendar month) and count every chat
 * model call in the `model_usage` ledger (`chat.*` surfaces: turns, titles,
 * summaries).
 *
 * Variables (all optional; unset = no operator cap):
 *  - CHAT_BUDGET_WORKSPACE_MONTHLY_USD     cap per workspace
 *  - CHAT_BUDGET_WORKSPACE_MONTHLY_TOKENS  cap per workspace (input + output tokens)
 *  - CHAT_BUDGET_USER_MONTHLY_USD          cap per member within a workspace
 *  - CHAT_BUDGET_USER_MONTHLY_TOKENS       cap per member within a workspace
 *  - CHAT_BUDGET_UNKNOWN_COST              `allow` (default: run, with a
 *                                          warning, when a USD cap applies but
 *                                          the cost cannot be priced) or
 *                                          `block` (refuse such turns)
 *  - CHAT_BUDGET_TURN_RESERVE_USD          held per admission/extension (default 0.05)
 *  - CHAT_BUDGET_TURN_RESERVE_TOKENS       held per admission/extension (default 50000)
 *  - CHAT_BUDGET_WARN_AT                   warn when a cap is this full (0-1, default 0.8)
 *
 * Operator values are ceilings: workspace owners/admins can tighten them
 * (lower caps, `block`) through `PUT /api/chat/budgets/:workspaceId`, never
 * loosen them. Invalid values fail closed (`CHAT_BUDGET_MISCONFIGURED`).
 */
import { z } from 'zod';

export const UNKNOWN_COST_POLICIES = ['block', 'allow'] as const;
export type UnknownCostPolicy = (typeof UNKNOWN_COST_POLICIES)[number];

/** Upper bound for a token cap (fits the INTEGER columns). */
export const MAX_TOKEN_LIMIT = 2_000_000_000;
/** Upper bound for a USD cap (fits DECIMAL(12,6)). */
export const MAX_USD_LIMIT = 1_000_000;

export interface ChatBudgetConfig {
  workspaceMonthlyUsd: number | null;
  workspaceMonthlyTokens: number | null;
  userMonthlyUsd: number | null;
  userMonthlyTokens: number | null;
  unknownCostPolicy: UnknownCostPolicy;
  turnReserveUsd: number;
  turnReserveTokens: number;
  warnAt: number;
}

export type ChatBudgetConfigResult = { ok: true; config: ChatBudgetConfig } | { ok: false; issues: string[] };

const usdString = z.string().trim().regex(/^\d+(\.\d{1,6})?$/, 'must be a non-negative decimal with at most 6 places')
  .transform(Number).pipe(z.number().min(0).max(MAX_USD_LIMIT));
const tokenString = z.string().trim().regex(/^\d+$/, 'must be a whole number')
  .transform(Number).pipe(z.number().int().min(0).max(MAX_TOKEN_LIMIT));
const ratioString = z.string().trim().regex(/^(0(\.\d+)?|1(\.0+)?)$/, 'must be between 0 and 1').transform(Number);

const envSchema = z.object({
  CHAT_BUDGET_WORKSPACE_MONTHLY_USD: usdString.optional(),
  CHAT_BUDGET_WORKSPACE_MONTHLY_TOKENS: tokenString.optional(),
  CHAT_BUDGET_USER_MONTHLY_USD: usdString.optional(),
  CHAT_BUDGET_USER_MONTHLY_TOKENS: tokenString.optional(),
  CHAT_BUDGET_UNKNOWN_COST: z.string().trim().toLowerCase().pipe(z.enum(UNKNOWN_COST_POLICIES)).optional(),
  CHAT_BUDGET_TURN_RESERVE_USD: usdString.optional(),
  CHAT_BUDGET_TURN_RESERVE_TOKENS: tokenString.optional(),
  CHAT_BUDGET_WARN_AT: ratioString.optional(),
});

function pickEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const picked: Record<string, string | undefined> = {};
  for (const key of Object.keys(envSchema.shape)) {
    const value = env[key];
    picked[key] = value !== undefined && value.trim().length > 0 ? value : undefined;
  }
  return picked;
}

export function loadChatBudgetConfig(env: NodeJS.ProcessEnv = process.env): ChatBudgetConfigResult {
  const parsed = envSchema.safeParse(pickEnv(env));
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`) };
  }
  const values = parsed.data;
  return {
    ok: true,
    config: {
      workspaceMonthlyUsd: values.CHAT_BUDGET_WORKSPACE_MONTHLY_USD ?? null,
      workspaceMonthlyTokens: values.CHAT_BUDGET_WORKSPACE_MONTHLY_TOKENS ?? null,
      userMonthlyUsd: values.CHAT_BUDGET_USER_MONTHLY_USD ?? null,
      userMonthlyTokens: values.CHAT_BUDGET_USER_MONTHLY_TOKENS ?? null,
      unknownCostPolicy: values.CHAT_BUDGET_UNKNOWN_COST ?? 'allow',
      turnReserveUsd: values.CHAT_BUDGET_TURN_RESERVE_USD ?? 0.05,
      turnReserveTokens: values.CHAT_BUDGET_TURN_RESERVE_TOKENS ?? 50_000,
      warnAt: values.CHAT_BUDGET_WARN_AT ?? 0.8,
    },
  };
}
