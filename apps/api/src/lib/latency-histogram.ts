/**
 * Fixed-size latency histogram (performance plan, Phase 0).
 *
 * Log-linear buckets: 8 per power of two from 0.125 ms to about 137 s, so a
 * percentile read from the histogram is within about 4.5 % of the true value
 * (half a bucket width) and memory per series is constant (one Uint32Array),
 * however many observations are recorded. Replaces "push every sample into an
 * array" for long-lived processes.
 */

const SUB_BUCKETS_PER_OCTAVE = 8;
const MIN_MS = 0.125;
const OCTAVES = 20;
const BUCKETS = SUB_BUCKETS_PER_OCTAVE * OCTAVES + 2; // + underflow + overflow
const LOG2_MIN = Math.log2(MIN_MS);

function bucketIndex(ms: number): number {
  if (!(ms > MIN_MS)) return 0;
  const position = (Math.log2(ms) - LOG2_MIN) * SUB_BUCKETS_PER_OCTAVE;
  const index = Math.floor(position) + 1;
  return index >= BUCKETS - 1 ? BUCKETS - 1 : index;
}

/** Lower bound of bucket `index` in ms (index >= 1). */
function bucketLowerBound(index: number): number {
  return MIN_MS * 2 ** ((index - 1) / SUB_BUCKETS_PER_OCTAVE);
}

/** Representative value: geometric midpoint of the bucket. */
function bucketValue(index: number): number {
  if (index === 0) return MIN_MS;
  return MIN_MS * 2 ** ((index - 0.5) / SUB_BUCKETS_PER_OCTAVE);
}

export interface LatencySummary {
  count: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export class LatencyHistogram {
  private readonly counts = new Uint32Array(BUCKETS);
  private total = 0;
  private sum = 0;
  private max = 0;

  record(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.counts[bucketIndex(ms)] += 1;
    this.total += 1;
    this.sum += ms;
    if (ms > this.max) this.max = ms;
  }

  get count(): number {
    return this.total;
  }

  /** Percentile in ms (`q` in [0, 1]); 0 when empty. Clamped to the observed max. */
  quantile(q: number): number {
    if (this.total === 0) return 0;
    const rank = Math.max(1, Math.ceil(Math.min(Math.max(q, 0), 1) * this.total));
    let seen = 0;
    for (let index = 0; index < BUCKETS; index += 1) {
      seen += this.counts[index];
      if (seen >= rank) {
        if (index === BUCKETS - 1) return this.max;
        return Math.min(bucketValue(index), this.max);
      }
    }
    return this.max;
  }

  summary(): LatencySummary {
    const round = (value: number) => Math.round(value * 100) / 100;
    return {
      count: this.total,
      meanMs: this.total === 0 ? 0 : round(this.sum / this.total),
      p50Ms: round(this.quantile(0.5)),
      p95Ms: round(this.quantile(0.95)),
      p99Ms: round(this.quantile(0.99)),
      maxMs: round(this.max),
    };
  }

  reset(): void {
    this.counts.fill(0);
    this.total = 0;
    this.sum = 0;
    this.max = 0;
  }
}

/** Exposed for tests: bucket bounds used by `quantile`. */
export const latencyHistogramInternals = { bucketIndex, bucketLowerBound, bucketValue, BUCKETS };

/**
 * Coarse, bounded label for a duration, for log filtering and dashboards.
 * Never more than nine distinct values.
 */
export function durationBucket(ms: number): string {
  if (ms < 10) return 'lt10ms';
  if (ms < 50) return '10-50ms';
  if (ms < 100) return '50-100ms';
  if (ms < 250) return '100-250ms';
  if (ms < 500) return '250-500ms';
  if (ms < 1_000) return '500ms-1s';
  if (ms < 2_500) return '1-2.5s';
  if (ms < 5_000) return '2.5-5s';
  return 'gte5s';
}
