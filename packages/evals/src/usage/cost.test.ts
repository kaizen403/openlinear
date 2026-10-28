import { describe, expect, it } from 'vitest';
import type { Price } from '../manifest/schema';
import { aggregateCost, estimateCostUsd, finalizeUsage, UNKNOWN_USAGE } from './cost';

const price: Price = { provider: 'p', model: 'm', currency: 'USD', inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75, asOf: '2026-10-26', source: 'test' };
const tokens = { input: 1_000_000, output: 100_000, cacheRead: 400_000, cacheWrite: 50_000, reasoning: 20_000 };

describe('cost', () => {
  it('never double counts subset categories', () => {
    // cache-in-input: 600k fresh input + 400k cache reads; reasoning is inside output.
    expect(estimateCostUsd(tokens, 'cache-in-input', price)).toBeCloseTo(0.6 * 3 + 0.4 * 0.3 + 0.05 * 3.75 + 0.1 * 15, 10);
    // disjoint: all of input is fresh.
    expect(estimateCostUsd(tokens, 'cache-disjoint', price)).toBeCloseTo(1 * 3 + 0.4 * 0.3 + 0.05 * 3.75 + 0.1 * 15, 10);
    expect(estimateCostUsd(tokens, 'unknown', price)).toBeNull();
    expect(estimateCostUsd(tokens, 'cache-disjoint', { ...price, cacheReadPerMTok: null })).toBeNull();
  });

  it('prefers reported cost, then estimates, else unknown (null, never 0)', () => {
    const reported = finalizeUsage({ tokens, tokenBasis: 'provider-reported', semantics: 'cache-disjoint', reportedCostUsd: 1.23, reportedCostBasis: 'runner-reported', reportedCostSource: 'claude' }, price);
    expect(reported).toMatchObject({ costUsd: 1.23, costBasis: 'runner-reported', costSource: 'claude' });
    const estimated = finalizeUsage({ tokens, tokenBasis: 'provider-reported', semantics: 'cache-in-input', reportedCostUsd: null, reportedCostBasis: null, reportedCostSource: null }, price);
    expect(estimated.costBasis).toBe('estimated');
    expect(estimated.costUsd).toBeGreaterThan(0);
    const noPrice = finalizeUsage({ ...UNKNOWN_USAGE, tokens, tokenBasis: 'provider-reported', semantics: 'cache-in-input' }, null);
    expect(noPrice).toMatchObject({ costUsd: null, costBasis: 'unknown' });
    const nothing = finalizeUsage(UNKNOWN_USAGE, price);
    expect(nothing).toMatchObject({ tokens: null, tokenBasis: 'unknown', costUsd: null, costBasis: 'unknown', costSource: 'no usage reported' });
  });

  it('aggregates known cost and reports incompleteness', () => {
    const known = finalizeUsage({ tokens, tokenBasis: 'provider-reported', semantics: 'cache-disjoint', reportedCostUsd: 2, reportedCostBasis: 'runner-reported', reportedCostSource: null }, null);
    const unknown = finalizeUsage(UNKNOWN_USAGE, null);
    const agg = aggregateCost([known, known, unknown]);
    expect(agg).toMatchObject({ knownUsd: 4, knownTrials: 2, unknownTrials: 1, complete: false });
    expect(agg.byBasis).toMatchObject({ 'runner-reported': 2, unknown: 1 });
    expect(aggregateCost([known]).complete).toBe(true);
    expect(aggregateCost([]).complete).toBe(false);
  });
});
