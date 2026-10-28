/**
 * Provider-neutral token usage and cost resolution for model invocations.
 *
 * Normalised semantics (one convention for every provider, never double
 * counted):
 *  - `inputTokens`: every prompt token the provider processed, INCLUDING cache
 *    reads and cache writes (OpenAI `prompt_tokens` semantics).
 *  - `cacheReadTokens` / `cacheWriteTokens`: subsets of `inputTokens`.
 *  - `outputTokens`: every generated token, INCLUDING reasoning tokens.
 *  - `reasoningTokens`: subset of `outputTokens`.
 *
 * A field is `null` when the provider did not report it. `null` never means
 * zero, and an unknown cost is never stored or reported as zero.
 */
import { z } from 'zod';

export interface ModelTokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
}

export interface NormalizedUsage extends ModelTokenUsage {
  /** USD cost the provider itself reported for this call, when trusted. */
  providerCostUsd: number | null;
  /** The provider's usage object, bounded in size, kept as the raw receipt. */
  raw: Record<string, unknown>;
}

const RAW_USAGE_MAX_CHARS = 2048;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A token count is a finite, non-negative integer; anything else is unreported. */
function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function firstCount(...values: unknown[]): number | null {
  for (const value of values) {
    const count = tokenCount(value);
    if (count !== null) return count;
  }
  return null;
}

function boundedRaw(raw: Record<string, unknown>): Record<string, unknown> {
  const serialized = JSON.stringify(raw);
  if (serialized.length <= RAW_USAGE_MAX_CHARS) {
    return JSON.parse(serialized) as Record<string, unknown>;
  }
  return { truncated: true, chars: serialized.length };
}

export interface NormalizeUsageOptions {
  /**
   * Accept `usage.cost` as a provider-reported USD amount. Only enable for
   * providers documented to report cost there (OpenRouter); elsewhere the
   * field may be absent or mean something else.
   */
  trustProviderCost?: boolean;
}

/**
 * Normalise an OpenAI-compatible (or Anthropic-style) `usage` object.
 *
 * Recognised fields:
 *  - OpenAI / Fireworks / OpenRouter: `prompt_tokens` (inclusive),
 *    `completion_tokens` (inclusive), `prompt_tokens_details.cached_tokens`,
 *    `completion_tokens_details.reasoning_tokens`.
 *  - DeepSeek: `prompt_cache_hit_tokens` (subset of `prompt_tokens`).
 *  - Moonshot: top-level `cached_tokens` (subset of `prompt_tokens`).
 *  - Anthropic-style: `input_tokens` EXCLUDES `cache_read_input_tokens` and
 *    `cache_creation_input_tokens`; they are added back so `inputTokens` keeps
 *    the inclusive meaning.
 */
export function normalizeProviderUsage(raw: unknown, options: NormalizeUsageOptions = {}): NormalizedUsage | null {
  const usage = asRecord(raw);
  if (!usage) return null;
  const promptDetails = asRecord(usage.prompt_tokens_details);
  const completionDetails = asRecord(usage.completion_tokens_details);

  const promptTokens = tokenCount(usage.prompt_tokens);
  const anthropicInput = tokenCount(usage.input_tokens);
  const anthropicCacheRead = tokenCount(usage.cache_read_input_tokens);
  const anthropicCacheWrite = tokenCount(usage.cache_creation_input_tokens);

  const cacheReadTokens = firstCount(
    promptDetails?.cached_tokens,
    anthropicCacheRead,
    usage.prompt_cache_hit_tokens,
    usage.cached_tokens,
  );
  const cacheWriteTokens = firstCount(anthropicCacheWrite, promptDetails?.cache_write_tokens, promptDetails?.cache_creation_tokens);

  let inputTokens: number | null;
  if (promptTokens !== null) {
    inputTokens = promptTokens;
  } else if (anthropicInput !== null) {
    // Anthropic counts cached prompt tokens separately from `input_tokens`.
    inputTokens = anthropicInput + (anthropicCacheRead ?? 0) + (anthropicCacheWrite ?? 0);
  } else {
    inputTokens = null;
  }

  const outputTokens = firstCount(usage.completion_tokens, usage.output_tokens);
  const reasoningTokens = firstCount(completionDetails?.reasoning_tokens, usage.reasoning_tokens);

  const reportedCost = usage.cost;
  const providerCostUsd = options.trustProviderCost && typeof reportedCost === 'number' && Number.isFinite(reportedCost) && reportedCost >= 0
    ? reportedCost
    : null;

  if (inputTokens === null && outputTokens === null && cacheReadTokens === null && providerCostUsd === null) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    providerCostUsd,
    raw: boundedRaw(usage),
  };
}

// ─── Pricing ──────────────────────────────────────────────────────────────────

const pricePerMTok = z.number().finite().nonnegative();

export const modelPriceSchema = z.object({
  inputPerMTok: pricePerMTok,
  outputPerMTok: pricePerMTok,
  cacheReadPerMTok: pricePerMTok.optional(),
  cacheWritePerMTok: pricePerMTok.optional(),
}).strict();

/**
 * Operator-supplied price snapshot (`MODEL_PRICING_JSON`). Prices are never
 * hard-coded: they change, differ by contract and must be validated when they
 * are configured. Keys are `<provider>:<model>` or a bare `<model>`.
 */
export const pricingTableSchema = z.object({
  revision: z.string().trim().min(1).max(100),
  models: z.record(z.string().min(1).max(200), modelPriceSchema),
}).strict();

export type ModelPrice = z.infer<typeof modelPriceSchema>;
export type PricingTable = z.infer<typeof pricingTableSchema>;

export type CostBasis = 'provider_reported' | 'estimated' | 'unknown';

export interface CostResolution {
  costUsd: number | null;
  basis: CostBasis;
  pricingRevision: string | null;
}

const UNKNOWN_COST: CostResolution = { costUsd: null, basis: 'unknown', pricingRevision: null };

function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function lookupPrice(pricing: PricingTable | null, provider: string, model: string): ModelPrice | null {
  if (!pricing) return null;
  return pricing.models[`${provider}:${model}`] ?? pricing.models[model] ?? null;
}

/**
 * Cost for one invocation.
 *
 * 1. A trusted provider-reported amount wins (`provider_reported`).
 * 2. Otherwise, with a configured price and reported token counts, estimate
 *    (`estimated`). Cached tokens are priced at the cache rate; if a cache rate
 *    is needed but not configured, the cost is unknown rather than guessed.
 * 3. Otherwise `unknown`, with `costUsd: null`.
 */
export function resolveCost(
  usage: NormalizedUsage | null,
  input: { provider: string; model: string; pricing: PricingTable | null },
): CostResolution {
  if (!usage) return UNKNOWN_COST;
  if (usage.providerCostUsd !== null) {
    return { costUsd: roundUsd(usage.providerCostUsd), basis: 'provider_reported', pricingRevision: null };
  }
  const price = lookupPrice(input.pricing, input.provider, input.model);
  if (!price || usage.inputTokens === null || usage.outputTokens === null) return UNKNOWN_COST;

  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  if (cacheRead > 0 && price.cacheReadPerMTok === undefined) return UNKNOWN_COST;
  if (cacheWrite > 0 && price.cacheWritePerMTok === undefined) return UNKNOWN_COST;

  const uncachedInput = Math.max(0, usage.inputTokens - cacheRead - cacheWrite);
  const usd = (
    uncachedInput * price.inputPerMTok
    + cacheRead * (price.cacheReadPerMTok ?? 0)
    + cacheWrite * (price.cacheWritePerMTok ?? 0)
    + usage.outputTokens * price.outputPerMTok
  ) / 1_000_000;
  return { costUsd: roundUsd(usd), basis: 'estimated', pricingRevision: input.pricing?.revision ?? null };
}

/** Share of prompt tokens served from the provider's cache, or null when unknown. */
export function cacheHitRate(usage: Pick<ModelTokenUsage, 'inputTokens' | 'cacheReadTokens'>): number | null {
  if (usage.inputTokens === null || usage.cacheReadTokens === null || usage.inputTokens === 0) return null;
  return Math.min(1, usage.cacheReadTokens / usage.inputTokens);
}
