import type { TokenUsage } from '@openlinear/execution-core';
import { type Configuration, type EvalManifest, findPrice, type Price } from '../manifest/schema';
import { semanticsForRunner } from '../runners/classify';

/**
 * Usage and cost with an explicit basis (PRD §10, W15):
 * - provider-reported: the model provider's own receipt (e.g. a usage/cost field from the API);
 * - runner-reported: computed by the agent runtime itself (Claude Code `total_cost_usd`,
 *   OpenCode step cost) — a client-side list-price estimate, kept distinct;
 * - estimated: computed by this harness from tokens × the manifest price table;
 * - invoiced: reconciled against an invoice after the run;
 * - unknown: nothing reliable — cost is `null`, never 0.
 *
 * Token semantics stay provider-raw and are never added twice:
 * - cache-in-input (OpenAI family): cacheRead ⊂ input, reasoning ⊂ output;
 * - cache-disjoint (Anthropic family, OpenCode normalised): input, cacheRead, cacheWrite disjoint; reasoning ⊂ output.
 */

export type CostBasis = 'provider-reported' | 'runner-reported' | 'estimated' | 'invoiced' | 'unknown';
export type TokenSemantics = 'cache-in-input' | 'cache-disjoint' | 'unknown';

export interface UsageRecord {
  tokens: TokenUsage | null;
  tokenBasis: 'provider-reported' | 'runner-reported' | 'unknown';
  tokenSemantics: TokenSemantics;
  costUsd: number | null;
  costBasis: CostBasis;
  costSource: string;
}

export interface RawUsage {
  tokens: TokenUsage | null;
  tokenBasis: UsageRecord['tokenBasis'];
  semantics: TokenSemantics;
  /** Cost the runner/provider reported, if any. */
  reportedCostUsd: number | null;
  reportedCostBasis: 'provider-reported' | 'runner-reported' | null;
  reportedCostSource: string | null;
}

export const UNKNOWN_USAGE: RawUsage = {
  tokens: null,
  tokenBasis: 'unknown',
  semantics: 'unknown',
  reportedCostUsd: null,
  reportedCostBasis: null,
  reportedCostSource: null,
};

/** Billable tokens per category for the given semantics. */
export function billableTokens(tokens: TokenUsage, semantics: TokenSemantics): { freshInput: number; cacheRead: number; cacheWrite: number; output: number } {
  if (semantics === 'cache-in-input') {
    return { freshInput: Math.max(0, tokens.input - tokens.cacheRead), cacheRead: tokens.cacheRead, cacheWrite: tokens.cacheWrite, output: tokens.output };
  }
  return { freshInput: tokens.input, cacheRead: tokens.cacheRead, cacheWrite: tokens.cacheWrite, output: tokens.output };
}

/** Harness estimate from a price table; null when a needed price is missing or semantics are unknown. */
export function estimateCostUsd(tokens: TokenUsage, semantics: TokenSemantics, price: Price): number | null {
  if (semantics === 'unknown') return null;
  const b = billableTokens(tokens, semantics);
  if (b.cacheRead > 0 && price.cacheReadPerMTok === null) return null;
  if (b.cacheWrite > 0 && price.cacheWritePerMTok === null) return null;
  const perToken = (perMTok: number | null) => (perMTok ?? 0) / 1_000_000;
  return (
    b.freshInput * perToken(price.inputPerMTok) +
    b.cacheRead * perToken(price.cacheReadPerMTok) +
    b.cacheWrite * perToken(price.cacheWritePerMTok) +
    b.output * perToken(price.outputPerMTok)
  );
}

export function finalizeUsage(raw: RawUsage, price: Price | null): UsageRecord {
  const base = { tokens: raw.tokens, tokenBasis: raw.tokens ? raw.tokenBasis : 'unknown', tokenSemantics: raw.semantics } as const;
  if (raw.reportedCostUsd !== null && raw.reportedCostBasis !== null && Number.isFinite(raw.reportedCostUsd)) {
    return { ...base, costUsd: raw.reportedCostUsd, costBasis: raw.reportedCostBasis, costSource: raw.reportedCostSource ?? raw.reportedCostBasis };
  }
  if (raw.tokens && price) {
    const estimate = estimateCostUsd(raw.tokens, raw.semantics, price);
    if (estimate !== null) {
      return { ...base, costUsd: estimate, costBasis: 'estimated', costSource: `tokens × ${price.provider}/${price.model} list price as of ${price.asOf}` };
    }
  }
  return { ...base, costUsd: null, costBasis: 'unknown', costSource: raw.tokens ? 'no usable price for the reported tokens' : 'no usage reported' };
}

export interface CostAggregate {
  /** Sum over trials whose cost is known. */
  knownUsd: number;
  knownTrials: number;
  unknownTrials: number;
  /** True only when every trial's cost is known (otherwise `knownUsd` is a lower bound). */
  complete: boolean;
  byBasis: Record<CostBasis, number>;
}

export function aggregateCost(records: readonly UsageRecord[]): CostAggregate {
  const byBasis: Record<CostBasis, number> = { 'provider-reported': 0, 'runner-reported': 0, estimated: 0, invoiced: 0, unknown: 0 };
  let knownUsd = 0;
  let knownTrials = 0;
  for (const record of records) {
    byBasis[record.costBasis] += 1;
    if (record.costUsd !== null) {
      knownUsd += record.costUsd;
      knownTrials += 1;
    }
  }
  const unknownTrials = records.length - knownTrials;
  return { knownUsd, knownTrials, unknownTrials, complete: unknownTrials === 0 && records.length > 0, byBasis };
}

export function sumTokens(records: readonly UsageRecord[]): { tokens: TokenUsage; unknownTrials: number } {
  const tokens: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  let unknownTrials = 0;
  for (const record of records) {
    if (!record.tokens) {
      unknownTrials += 1;
      continue;
    }
    tokens.input += record.tokens.input;
    tokens.output += record.tokens.output;
    tokens.cacheRead += record.tokens.cacheRead;
    tokens.cacheWrite += record.tokens.cacheWrite;
    tokens.reasoning += record.tokens.reasoning;
  }
  return { tokens, unknownTrials };
}

/**
 * A trial's (or one session's) usage under the configuration's price: token
 * semantics fall back to the runner family when the runner reported tokens
 * without saying how to read them.
 */
export function finalizeTrialUsage(manifest: EvalManifest, config: Configuration, raw: RawUsage): UsageRecord {
  const price = findPrice(manifest, config.model.provider, config.model.snapshot || config.model.requested);
  return finalizeUsage(raw.semantics === 'unknown' && raw.tokens ? { ...raw, semantics: semanticsForRunner(config.runner.id) } : raw, price);
}

/**
 * Usage of several sessions of one trial (W21 reviewer arm): tokens and
 * reported cost add up only when every session reported them; otherwise
 * they are unknown (never a partial sum presented as complete).
 */
export function mergeRawUsage(parts: readonly RawUsage[]): RawUsage {
  const [first, ...rest] = parts;
  if (!first) return UNKNOWN_USAGE;
  if (rest.length === 0) return first;
  const allTokens = parts.every((part) => part.tokens !== null);
  const tokens: TokenUsage | null = allTokens
    ? parts.reduce<TokenUsage>(
        (sum, part) => ({
          input: sum.input + (part.tokens?.input ?? 0),
          output: sum.output + (part.tokens?.output ?? 0),
          cacheRead: sum.cacheRead + (part.tokens?.cacheRead ?? 0),
          cacheWrite: sum.cacheWrite + (part.tokens?.cacheWrite ?? 0),
          reasoning: sum.reasoning + (part.tokens?.reasoning ?? 0),
        }),
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      )
    : null;
  const allCost = parts.every((part) => part.reportedCostUsd !== null && part.reportedCostBasis === first.reportedCostBasis);
  return {
    tokens,
    tokenBasis: tokens ? first.tokenBasis : 'unknown',
    semantics: parts.every((part) => part.semantics === first.semantics) ? first.semantics : 'unknown',
    reportedCostUsd: allCost ? parts.reduce((sum, part) => sum + (part.reportedCostUsd ?? 0), 0) : null,
    reportedCostBasis: allCost ? first.reportedCostBasis : null,
    reportedCostSource: allCost ? first.reportedCostSource : null,
  };
}
