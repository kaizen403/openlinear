import { mulberry32 } from '../util/random';

/**
 * Task-cluster bootstrap (PRD §10): repeats of one task are correlated, so
 * the resampling unit is the cluster (a task, or a repository holding
 * several tasks). Two stages: draw clusters with replacement; inside each
 * drawn cluster keep its tasks and redraw each task's repeats with
 * replacement. The statistic weights every task equally (mean of per-task
 * success rates), which equals the plain trial mean when repeats are equal.
 */

export interface TaskOutcomes {
  taskId: string;
  /** 1 = success, 0 = anything else (failed/censored trials included). */
  outcomes: number[];
}

export interface Cluster {
  cluster: string;
  tasks: TaskOutcomes[];
}

export interface Interval {
  estimate: number;
  low: number;
  high: number;
  confidence: number;
  resamples: number;
}

export interface BootstrapOptions {
  resamples: number;
  confidence: number;
  seed: number;
}

/** Type-7 (linear interpolation) sample quantile; `values` need not be sorted. */
export function quantile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (h - lo) * (b - a);
}

const mean = (values: readonly number[]) => (values.length === 0 ? Number.NaN : values.reduce((sum, v) => sum + v, 0) / values.length);

function resampleMean(values: readonly number[], random: () => number): number {
  if (values.length === 0) return Number.NaN;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) sum += values[Math.floor(random() * values.length)] as number;
  return sum / values.length;
}

/** Mean of per-task success rates (tasks with no trials are ignored). */
export function taskWeightedRate(clusters: readonly Cluster[]): number {
  const rates = clusters.flatMap((c) => c.tasks.filter((t) => t.outcomes.length > 0).map((t) => mean(t.outcomes)));
  return mean(rates);
}

export function clusterBootstrap(clusters: readonly Cluster[], options: BootstrapOptions): Interval {
  const usable = clusters.filter((c) => c.tasks.some((t) => t.outcomes.length > 0));
  const estimate = taskWeightedRate(usable);
  if (usable.length === 0) return { estimate: Number.NaN, low: Number.NaN, high: Number.NaN, confidence: options.confidence, resamples: 0 };
  const random = mulberry32(options.seed);
  const stats: number[] = [];
  for (let r = 0; r < options.resamples; r += 1) {
    const taskMeans: number[] = [];
    for (let k = 0; k < usable.length; k += 1) {
      const cluster = usable[Math.floor(random() * usable.length)] as Cluster;
      for (const task of cluster.tasks) if (task.outcomes.length > 0) taskMeans.push(resampleMean(task.outcomes, random));
    }
    stats.push(mean(taskMeans));
  }
  const alpha = (1 - options.confidence) / 2;
  return { estimate, low: quantile(stats, alpha), high: quantile(stats, 1 - alpha), confidence: options.confidence, resamples: options.resamples };
}

export interface PairedTask {
  cluster: string;
  taskId: string;
  treatment: number[];
  baseline: number[];
}

export interface PairedResult extends Interval {
  /** Tasks present in both configurations. */
  tasks: number;
  treatmentBetter: number;
  baselineBetter: number;
  ties: number;
}

/**
 * Paired difference (treatment − baseline) of task-weighted success over the
 * tasks both configurations ran. The same resampled clusters are used for
 * both arms (pairing); repeats are redrawn independently per arm.
 */
export function pairedBootstrap(pairs: readonly PairedTask[], options: BootstrapOptions): PairedResult {
  const usable = pairs.filter((p) => p.treatment.length > 0 && p.baseline.length > 0);
  const byCluster = new Map<string, PairedTask[]>();
  for (const pair of usable) byCluster.set(pair.cluster, [...(byCluster.get(pair.cluster) ?? []), pair]);
  const clusters = [...byCluster.values()];
  const diffs = usable.map((p) => mean(p.treatment) - mean(p.baseline));
  const estimate = mean(diffs);
  const counts = {
    tasks: usable.length,
    treatmentBetter: diffs.filter((d) => d > 0).length,
    baselineBetter: diffs.filter((d) => d < 0).length,
    ties: diffs.filter((d) => d === 0).length,
  };
  if (clusters.length === 0) return { estimate: Number.NaN, low: Number.NaN, high: Number.NaN, confidence: options.confidence, resamples: 0, ...counts };
  const random = mulberry32(options.seed);
  const stats: number[] = [];
  for (let r = 0; r < options.resamples; r += 1) {
    const taskDiffs: number[] = [];
    for (let k = 0; k < clusters.length; k += 1) {
      const cluster = clusters[Math.floor(random() * clusters.length)] as PairedTask[];
      for (const pair of cluster) taskDiffs.push(resampleMean(pair.treatment, random) - resampleMean(pair.baseline, random));
    }
    stats.push(mean(taskDiffs));
  }
  const alpha = (1 - options.confidence) / 2;
  return { estimate, low: quantile(stats, alpha), high: quantile(stats, 1 - alpha), confidence: options.confidence, resamples: options.resamples, ...counts };
}
