/** Exact percentile statistics over raw samples (nearest-rank). */

export interface Distribution {
  n: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

export function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1];
}

export function distribution(samples: readonly number[]): Distribution {
  if (samples.length === 0) return { n: 0, mean: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    mean: round2(sum / sorted.length),
    p50: round2(percentile(sorted, 0.5)),
    p95: round2(percentile(sorted, 0.95)),
    p99: round2(percentile(sorted, 0.99)),
    min: round2(sorted[0]),
    max: round2(sorted[sorted.length - 1]),
  };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return round2(sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}

export { round2 };
