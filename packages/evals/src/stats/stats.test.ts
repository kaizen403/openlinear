import { describe, expect, it } from 'vitest';
import { parseManifest } from '../manifest/schema';
import type { TrialRecord } from '../records';
import { testManifestInput } from '../testing/fixtures';
import { finalizeUsage, UNKNOWN_USAGE } from '../usage/cost';
import { clusterBootstrap, pairedBootstrap, quantile, taskWeightedRate } from './bootstrap';
import { summarize } from './summary';

const opts = { resamples: 2000, confidence: 0.95, seed: 11 };

describe('quantile', () => {
  it('uses linear interpolation (type 7)', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([10], 0.95)).toBe(10);
    expect(quantile([5, 1, 3], 0)).toBe(1);
    expect(quantile([5, 1, 3], 1)).toBe(5);
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
  });
});

describe('task-cluster bootstrap', () => {
  it('weights tasks equally and is deterministic for a seed', () => {
    const clusters = [
      { cluster: 'a', tasks: [{ taskId: 'a', outcomes: [1, 1, 1, 1, 1] }] },
      { cluster: 'b', tasks: [{ taskId: 'b', outcomes: [0] }] },
    ];
    expect(taskWeightedRate(clusters)).toBe(0.5);
    const one = clusterBootstrap(clusters, opts);
    expect(clusterBootstrap(clusters, opts)).toEqual(one);
    expect(one.low).toBeLessThanOrEqual(one.estimate);
    expect(one.high).toBeGreaterThanOrEqual(one.estimate);
  });

  it('degenerates correctly for all-pass and empty input', () => {
    const all = clusterBootstrap([{ cluster: 'x', tasks: [{ taskId: 'x', outcomes: [1, 1] }] }, { cluster: 'y', tasks: [{ taskId: 'y', outcomes: [1] }] }], opts);
    expect([all.estimate, all.low, all.high]).toEqual([1, 1, 1]);
    expect(Number.isNaN(clusterBootstrap([], opts).estimate)).toBe(true);
  });

  it('treats repeats as correlated: the interval is wider than a naive per-trial bootstrap would be', () => {
    // 10 tasks, 5 repeats each; tasks are either always solved or never solved.
    const clusters = Array.from({ length: 10 }, (_, i) => ({ cluster: `t${i}`, tasks: [{ taskId: `t${i}`, outcomes: Array(5).fill(i < 5 ? 1 : 0) }] }));
    const ci = clusterBootstrap(clusters, opts);
    // A per-trial bootstrap over 50 iid trials would give roughly ±14 points; clustering by task gives roughly ±31.
    expect(ci.high - ci.low).toBeGreaterThan(0.45);
  });

  it('resamples whole clusters (a repository with several tasks)', () => {
    const clusters = [
      { cluster: 'repo1', tasks: [{ taskId: 'a', outcomes: [1, 1] }, { taskId: 'b', outcomes: [1, 1] }] },
      { cluster: 'repo2', tasks: [{ taskId: 'c', outcomes: [0, 0] }] },
    ];
    const ci = clusterBootstrap(clusters, opts);
    expect(ci.estimate).toBeCloseTo(2 / 3, 10);
    expect(ci.low).toBe(0);
    expect(ci.high).toBe(1);
  });
});

describe('paired bootstrap', () => {
  it('reports a positive interval when the treatment dominates, and counts disagreements', () => {
    const pairs = Array.from({ length: 12 }, (_, i) => ({ cluster: `t${i}`, taskId: `t${i}`, treatment: [1, 1, 1], baseline: i < 8 ? [0, 0, 1] : [1, 1, 1] }));
    const result = pairedBootstrap(pairs, opts);
    expect(result.estimate).toBeCloseTo((8 * (2 / 3)) / 12, 10);
    expect(result.low).toBeGreaterThan(0);
    expect(result).toMatchObject({ tasks: 12, treatmentBetter: 8, baselineBetter: 0, ties: 4 });
  });

  it('is centred on zero for identical arms and ignores unpaired tasks', () => {
    const pairs = [
      { cluster: 'a', taskId: 'a', treatment: [1, 0], baseline: [1, 0] },
      { cluster: 'b', taskId: 'b', treatment: [0, 0], baseline: [0, 0] },
      { cluster: 'c', taskId: 'c', treatment: [1], baseline: [] },
    ];
    const result = pairedBootstrap(pairs, opts);
    expect(result.tasks).toBe(2);
    expect(result.estimate).toBe(0);
    expect(result.low).toBeLessThanOrEqual(0);
    expect(result.high).toBeGreaterThanOrEqual(0);
  });
});

function record(partial: Partial<TrialRecord> & Pick<TrialRecord, 'configurationId' | 'taskId' | 'repeat' | 'outcome'>): TrialRecord {
  const success = partial.outcome === 'pass';
  return {
    schemaVersion: 'openlinear.eval.trial/v1',
    trialId: `${partial.configurationId}-${partial.taskId}-${partial.repeat}`,
    slotId: `${partial.configurationId}-${partial.taskId}-${partial.repeat}`,
    attempt: 1,
    supersededBy: null,
    order: 0,
    manifestId: 'm',
    manifestDigest: 'd',
    harness: 'native',
    transport: 'cli',
    runnerId: 'codex',
    runnerMode: 'real',
    suiteId: 'holdout',
    taskChecksum: 'x',
    category: partial.taskId === 't1' ? 'logic' : 'parsing',
    cluster: partial.taskId,
    sealed: false,
    memoryPromotionAllowed: false,
    termination: 'completed',
    terminationDetail: '',
    grade: null,
    safety: [],
    success,
    reason: '',
    gradeValid: true,
    usage: finalizeUsage({ tokens: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, tokenBasis: 'provider-reported', semantics: 'cache-in-input', reportedCostUsd: 1, reportedCostBasis: 'provider-reported', reportedCostSource: null }, null),
    timings: { setupMs: 1, agentMs: 100, captureMs: 1, gradeMs: 1, taskToArtifactMs: 100, firstActionMs: 10 },
    observedModel: null,
    observedRunnerVersion: null,
    invocation: null,
    patch: { sha256: '', bytes: 0, changedPaths: [] },
    artifactsDir: '',
    startedAt: '',
    finishedAt: '',
    ...partial,
  };
}

describe('summarize', () => {
  const manifest = parseManifest(testManifestInput({ analysis: { comparisons: [{ treatment: 'a', baseline: 'b' }], practicalThresholdPts: 5, nonInferiorityMarginPts: 3 } }));

  it('keeps failed and censored trials in the denominators and latency', () => {
    const records = [
      record({ configurationId: 'a', taskId: 't1', repeat: 1, outcome: 'pass' }),
      record({ configurationId: 'a', taskId: 't1', repeat: 2, outcome: 'timeout', timings: { setupMs: 1, agentMs: 3_000_000, captureMs: 1, gradeMs: 1, taskToArtifactMs: 3_000_000, firstActionMs: null } }),
      record({ configurationId: 'a', taskId: 't2', repeat: 1, outcome: 'infra', usage: finalizeUsage(UNKNOWN_USAGE, null) }),
      record({ configurationId: 'a', taskId: 't2', repeat: 2, outcome: 'pass' }),
      record({ configurationId: 'b', taskId: 't1', repeat: 1, outcome: 'fail' }),
      record({ configurationId: 'b', taskId: 't1', repeat: 2, outcome: 'fail' }),
      record({ configurationId: 'b', taskId: 't2', repeat: 1, outcome: 'pass' }),
      record({ configurationId: 'b', taskId: 't2', repeat: 2, outcome: 'refusal' }),
    ];
    const summary = summarize(records, manifest, 'intent-to-run');
    const a = summary.configurations.find((c) => c.configurationId === 'a');
    expect(a?.trials).toBe(4);
    expect(a?.successes).toBe(2);
    expect(a?.success.estimate).toBe(0.5);
    expect(a?.outcomes).toMatchObject({ pass: 2, timeout: 1, infra: 1 });
    expect(a?.taskToArtifact).toMatchObject({ n: 4, censored: 2 });
    expect(a?.taskToArtifact.p95Ms).toBeGreaterThan(1_000_000);
    expect(a?.costPerResolved).toEqual({ usd: 1.5, basis: 'lower-bound' });
    expect(a?.meanCostPerTrialUsd).toBeNull();
    expect(a?.byCategory.logic).toEqual({ trials: 2, successRate: 0.5 });
    const b = summary.configurations.find((c) => c.configurationId === 'b');
    expect(b?.costPerResolved).toEqual({ usd: 4, basis: 'complete' });
    expect(summary.comparisons[0]).toMatchObject({ treatment: 'a', baseline: 'b' });
    expect(summary.comparisons[0]?.paired.estimate).toBeCloseTo(0.25, 10);
    expect(summary.comparisons[0]?.verdict).toBe('inconclusive');
    expect(summary.tasks.find((t) => t.taskId === 't2')?.outcomes.b).toEqual(['pass', 'refusal']);
  });
});
