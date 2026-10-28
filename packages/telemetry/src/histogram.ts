/**
 * Fixed-memory histogram for the in-process telemetry hooks (perf1).
 *
 * Log-linear buckets, 8 per power of two, from 2^-10 to 2^40 (about 0.001 to
 * 1.1e12), so it fits milliseconds, bytes and counts alike. A percentile read
 * from it is within half a bucket width (about 4.5 %) of the true value,
 * clamped to the observed min/max. Memory per series is one Uint32Array of
 * 402 buckets (~1.6 KB) however many values are recorded; values <= 0 are
 * counted in a dedicated zero bucket.
 *
 * Same scheme as apps/api/src/lib/latency-histogram.ts (route timing), which
 * this package cannot import.
 */

const SUB_BUCKETS_PER_OCTAVE = 8;
const MIN_EXPONENT = -10;
const MAX_EXPONENT = 40;
const OCTAVES = MAX_EXPONENT - MIN_EXPONENT;
/** zero/underflow bucket + log buckets + overflow bucket */
const BUCKETS = SUB_BUCKETS_PER_OCTAVE * OCTAVES + 2;
const MIN_VALUE = 2 ** MIN_EXPONENT;

function bucketIndex(value: number): number {
  if (!(value > MIN_VALUE)) return 0;
  const index = Math.floor((Math.log2(value) - MIN_EXPONENT) * SUB_BUCKETS_PER_OCTAVE) + 1;
  return index >= BUCKETS - 1 ? BUCKETS - 1 : index;
}

/** Geometric midpoint of bucket `index`. */
function bucketValue(index: number): number {
  if (index === 0) return 0;
  return MIN_VALUE * 2 ** ((index - 0.5) / SUB_BUCKETS_PER_OCTAVE);
}

export interface HistogramSummary {
  count: number;
  sum: number;
  mean: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
}

export class BoundedHistogram {
  private readonly counts = new Uint32Array(BUCKETS);
  private total = 0;
  private sum = 0;
  private min = Number.POSITIVE_INFINITY;
  private max = Number.NEGATIVE_INFINITY;

  record(value: number): void {
    if (!Number.isFinite(value)) return;
    const index = bucketIndex(value);
    this.counts[index] = (this.counts[index] ?? 0) + 1;
    this.total += 1;
    this.sum += value;
    if (value < this.min) this.min = value;
    if (value > this.max) this.max = value;
  }

  get count(): number {
    return this.total;
  }

  /** Value at quantile `q` in [0, 1] (nearest rank over buckets); 0 when empty. */
  quantile(q: number): number {
    if (this.total === 0) return 0;
    const rank = Math.max(1, Math.ceil(Math.min(Math.max(q, 0), 1) * this.total));
    let seen = 0;
    for (let index = 0; index < BUCKETS; index += 1) {
      seen += this.counts[index] ?? 0;
      if (seen >= rank) {
        if (index === 0) return this.min > 0 ? this.min : Math.min(0, this.max);
        if (index === BUCKETS - 1) return this.max;
        return Math.min(Math.max(bucketValue(index), this.min), this.max);
      }
    }
    return this.max;
  }

  summary(): HistogramSummary {
    const round = (value: number) => Math.round(value * 1000) / 1000;
    if (this.total === 0) return { count: 0, sum: 0, mean: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0 };
    return {
      count: this.total,
      sum: round(this.sum),
      mean: round(this.sum / this.total),
      min: round(this.min),
      max: round(this.max),
      p50: round(this.quantile(0.5)),
      p95: round(this.quantile(0.95)),
      p99: round(this.quantile(0.99)),
    };
  }
}

export const boundedHistogramInternals = { BUCKETS, bucketIndex, bucketValue };
