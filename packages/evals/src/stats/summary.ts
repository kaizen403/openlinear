import { OUTCOMES, type Outcome } from '../grading/outcome';
import type { EvalManifest } from '../manifest/schema';
import type { TrialRecord } from '../records';
import { aggregateCost, type CostAggregate, sumTokens } from '../usage/cost';
import { type Cluster, clusterBootstrap, type Interval, type PairedResult, pairedBootstrap, quantile } from './bootstrap';
import { hashSeed } from '../util/random';

export interface LatencySummary {
  n: number;
  /** Trials stopped by a timeout/infra (their stop time is included, not dropped). */
  censored: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface CostPerResolved {
  usd: number | null;
  /** complete: every trial's cost known; lower-bound: some unknown; unavailable: no success or no known cost. */
  basis: 'complete' | 'lower-bound' | 'unavailable';
}

export interface ConfigurationSummary {
  configurationId: string;
  label: string;
  harness: string;
  runnerMode: 'real' | 'fake';
  trials: number;
  tasks: number;
  successes: number;
  success: Interval;
  outcomes: Record<Outcome, number>;
  rates: Record<Outcome, number>;
  cost: CostAggregate;
  costPerResolved: CostPerResolved;
  meanCostPerTrialUsd: number | null;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; unknownTrials: number };
  taskToArtifact: LatencySummary;
  agentLatency: LatencySummary;
  firstAction: LatencySummary;
  byCategory: Record<string, { trials: number; successRate: number }>;
}

export interface ComparisonSummary {
  treatment: string;
  baseline: string;
  paired: PairedResult;
  verdict: 'improvement' | 'regression' | 'non-inferior' | 'inconclusive';
  note: string;
}

export interface TaskRow {
  taskId: string;
  category: string;
  cluster: string;
  sealed: boolean;
  /** configuration id → per-repeat outcomes in repeat order. */
  outcomes: Record<string, Outcome[]>;
}

export interface Summary {
  view: 'intent-to-run' | 'adjudicated';
  configurations: ConfigurationSummary[];
  comparisons: ComparisonSummary[];
  tasks: TaskRow[];
}

function latency(values: Array<{ ms: number; censored: boolean }>): LatencySummary {
  const ms = values.map((v) => v.ms);
  return {
    n: values.length,
    censored: values.filter((v) => v.censored).length,
    p50Ms: ms.length > 0 ? quantile(ms, 0.5) : null,
    p95Ms: ms.length > 0 ? quantile(ms, 0.95) : null,
  };
}

function clustersFor(records: readonly TrialRecord[], clusterBy: 'task' | 'cluster'): Cluster[] {
  const byCluster = new Map<string, Map<string, number[]>>();
  for (const record of records) {
    const key = clusterBy === 'cluster' ? record.cluster : record.taskId;
    const tasks = byCluster.get(key) ?? new Map<string, number[]>();
    tasks.set(record.taskId, [...(tasks.get(record.taskId) ?? []), record.success ? 1 : 0]);
    byCluster.set(key, tasks);
  }
  return [...byCluster.entries()].map(([cluster, tasks]) => ({ cluster, tasks: [...tasks.entries()].map(([taskId, outcomes]) => ({ taskId, outcomes })) }));
}

const CENSORED: ReadonlySet<Outcome> = new Set(['timeout', 'infra']);

export function summarize(records: readonly TrialRecord[], manifest: EvalManifest, view: Summary['view']): Summary {
  const { analysis } = manifest;
  const options = (label: string) => ({ resamples: analysis.bootstrapResamples, confidence: analysis.confidence, seed: hashSeed(manifest.concurrency.seed, label) });
  const configurations: ConfigurationSummary[] = manifest.configurations.map((config) => {
    const mine = records.filter((record) => record.configurationId === config.id);
    const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, mine.filter((r) => r.outcome === o).length])) as Record<Outcome, number>;
    const rates = Object.fromEntries(OUTCOMES.map((o) => [o, mine.length > 0 ? outcomes[o] / mine.length : 0])) as Record<Outcome, number>;
    const successes = mine.filter((r) => r.success).length;
    const cost = aggregateCost(mine.map((r) => r.usage));
    const costPerResolved: CostPerResolved =
      successes === 0 || cost.knownTrials === 0 ? { usd: null, basis: 'unavailable' } : { usd: cost.knownUsd / successes, basis: cost.complete ? 'complete' : 'lower-bound' };
    const tokenSum = sumTokens(mine.map((r) => r.usage));
    const categories = [...new Set(mine.map((r) => r.category))].sort();
    const byCategory = Object.fromEntries(
      categories.map((category) => {
        const inCategory = mine.filter((r) => r.category === category);
        return [category, { trials: inCategory.length, successRate: inCategory.filter((r) => r.success).length / inCategory.length }];
      }),
    );
    return {
      configurationId: config.id,
      label: config.label,
      harness: `${config.harness}/${config.transport}/${config.runner.id}`,
      runnerMode: config.runner.mode,
      trials: mine.length,
      tasks: new Set(mine.map((r) => r.taskId)).size,
      successes,
      success: clusterBootstrap(clustersFor(mine, analysis.clusterBy), options(`success:${config.id}`)),
      outcomes,
      rates,
      cost,
      costPerResolved,
      meanCostPerTrialUsd: cost.complete && mine.length > 0 ? cost.knownUsd / mine.length : null,
      tokens: { ...tokenSum.tokens, unknownTrials: tokenSum.unknownTrials },
      taskToArtifact: latency(mine.map((r) => ({ ms: r.timings.taskToArtifactMs, censored: CENSORED.has(r.outcome) }))),
      agentLatency: latency(mine.map((r) => ({ ms: r.timings.agentMs, censored: CENSORED.has(r.outcome) }))),
      firstAction: latency(mine.filter((r) => r.timings.firstActionMs !== null).map((r) => ({ ms: r.timings.firstActionMs ?? 0, censored: false }))),
      byCategory,
    };
  });

  const comparisons: ComparisonSummary[] = analysis.comparisons.map(({ treatment, baseline }) => {
    const taskIds = [...new Set(records.map((r) => r.taskId))].sort();
    const pairs = taskIds.map((taskId) => {
      const t = records.filter((r) => r.configurationId === treatment && r.taskId === taskId);
      const b = records.filter((r) => r.configurationId === baseline && r.taskId === taskId);
      const cluster = analysis.clusterBy === 'cluster' ? (t[0]?.cluster ?? b[0]?.cluster ?? taskId) : taskId;
      return { cluster, taskId, treatment: t.map((r) => (r.success ? 1 : 0)), baseline: b.map((r) => (r.success ? 1 : 0)) };
    });
    const paired = pairedBootstrap(pairs, options(`paired:${treatment}:${baseline}`));
    const threshold = analysis.practicalThresholdPts;
    const margin = analysis.nonInferiorityMarginPts;
    let verdict: ComparisonSummary['verdict'] = 'inconclusive';
    let note = 'interval includes zero';
    if (paired.low > 0 && (threshold === null || paired.estimate * 100 >= threshold)) {
      verdict = 'improvement';
      note = threshold === null ? 'interval excludes zero (no preregistered practical threshold)' : `interval excludes zero and the estimate meets the ${threshold}-point threshold`;
    } else if (paired.high < 0) {
      verdict = 'regression';
      note = 'interval entirely below zero';
    } else if (margin !== null && paired.low > -margin / 100) {
      verdict = 'non-inferior';
      note = `lower bound above −${margin} points`;
    } else if (paired.low > 0) {
      note = `interval excludes zero but the estimate is below the ${threshold}-point practical threshold`;
    }
    return { treatment, baseline, paired, verdict, note };
  });

  const taskKeys = new Map<string, TrialRecord>();
  for (const record of records) if (!taskKeys.has(record.taskId)) taskKeys.set(record.taskId, record);
  const tasks: TaskRow[] = [...taskKeys.values()]
    .sort((a, b) => a.taskId.localeCompare(b.taskId))
    .map((first) => ({
      taskId: first.taskId,
      category: first.category,
      cluster: first.cluster,
      sealed: first.sealed,
      outcomes: Object.fromEntries(
        manifest.configurations.map((config) => [
          config.id,
          records
            .filter((r) => r.taskId === first.taskId && r.configurationId === config.id)
            .sort((a, b) => a.repeat - b.repeat)
            .map((r) => r.outcome),
        ]),
      ),
    }));

  return { view, configurations, comparisons, tasks };
}
