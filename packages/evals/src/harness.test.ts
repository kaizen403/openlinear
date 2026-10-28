import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runEvaluation } from './harness';
import { parseManifest } from './manifest/schema';
import { assertPromotionAllowed, SealedPromotionError, type TrialRecord } from './records';
import { renderMarkdown } from './report/report';
import { OpenLinearAdapterRunner } from './runners/openlinear-adapter';
import { ReplayAgentRunner } from './runners/replay-agent-runner';
import { buildSmokeManifest, runSmoke, SMOKE_CONFIGURATIONS } from './smoke';
import { observeEnvironment } from './manifest/drift';
import { loadHoldout, TaskIntegrityError } from './tasks/holdout';
import { SAMPLE_TASKS, writeSampleHoldout } from './tasks/samples';
import { type AtifTrajectory, validateAtif } from './trajectory/atif';
import { parseTrajectory } from './trajectory/types';
import { synthesizeRecording } from './fakes/recordings';
import { planFundedRun } from './funded';
import { replayEvaluation } from './replay';

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe('offline smoke (end to end, FAKE runners)', () => {
  it('runs 5 tasks × 4 configurations × 5 repeats, passes its self-checks and writes the artifacts', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'evals-smoke-test-'));
    dirs.push(outDir);
    const result = await runSmoke({ outDir, concurrency: 4 });
    expect(result.problems).toEqual([]);
    expect(result.records.filter((r) => r.attempt === 1)).toHaveLength(SAMPLE_TASKS.length * SMOKE_CONFIGURATIONS.length * 5);
    expect(result.report.fake).toBe(true);
    expect(result.report.gates.every((g) => g.ok)).toBe(true);
    expect(result.report.infraReruns).toBeGreaterThan(0);
    expect(existsSync(result.reportMarkdownPath)).toBe(true);
    expect(await readFile(result.reportMarkdownPath, 'utf8')).toContain('FAKE RUNNERS');
    expect(existsSync(join(outDir, 'trials.jsonl'))).toBe(true);
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(true);

    // Schedule is randomized and interleaved, not grouped by configuration.
    const firstTen = result.records.filter((r) => r.attempt === 1).slice(0, 10).map((r) => r.configurationId);
    expect(new Set(firstTen).size).toBeGreaterThan(1);

    // Superseded originals are kept; reruns point back through supersededBy.
    const superseded = result.records.filter((r) => r.supersededBy !== null);
    expect(superseded.length).toBe(result.report.infraReruns);
    for (const original of superseded) {
      expect(original.outcome).toBe('infra');
      expect(result.records.find((r) => r.trialId === original.supersededBy)?.attempt).toBe(2);
    }

    // Sealed trials can never feed memory; development trials of our own corpus can.
    const sealed = result.records.filter((r) => r.sealed);
    expect(sealed.length).toBeGreaterThan(0);
    for (const record of sealed) expect(() => assertPromotionAllowed(record)).toThrow(SealedPromotionError);
    const dev = result.records.find((r) => r.taskId === 'sum-range-inclusive') as TrialRecord;
    expect(() => assertPromotionAllowed(dev)).not.toThrow();
    expect(result.records.find((r) => r.taskId === 'parse-duration-compound')?.memoryPromotionAllowed).toBe(false);

    // Every trial's artifacts exist and its trajectory is replayable.
    const sample = result.records[0] as TrialRecord;
    for (const file of ['trajectory.json', 'trajectory.atif.json', 'patch.diff', 'logs.txt', 'grade.json', 'record.json']) expect(existsSync(join(outDir, sample.artifactsDir, file))).toBe(true);
    for (const record of result.records) {
      const atif = JSON.parse(await readFile(join(outDir, record.artifactsDir, 'trajectory.atif.json'), 'utf8')) as AtifTrajectory;
      expect(validateAtif(atif), record.trialId).toEqual([]);
    }
    const trajectory = parseTrajectory(JSON.parse(await readFile(join(outDir, sample.artifactsDir, 'trajectory.json'), 'utf8')));
    expect(trajectory.taskId).toBe(sample.taskId);

    // Unknown cost is null, never 0; the markdown keeps "unknown" visible.
    for (const record of result.records) if (record.usage.costBasis === 'unknown') expect(record.usage.costUsd).toBeNull();
    expect(renderMarkdown(result.report)).toContain('unknown');

    // Replaying the recorded trajectories offline reproduces every outcome (incl. timeouts and reruns).
    const holdout = await loadHoldout(join(outDir, 'holdout'));
    const replayed = await replayEvaluation({ manifest: result.manifest, tasks: holdout.tasks, recordingsDir: outDir, outDir: join(outDir, 'replay'), systemContract: 'replay' });
    expect(replayed.manifest.id).toBe('smoke-offline.replay');
    const original = new Map(result.records.map((r) => [r.trialId, r.outcome]));
    const differing = replayed.records.filter((r) => original.get(r.trialId) !== r.outcome).map((r) => `${r.trialId}: ${original.get(r.trialId)} → ${r.outcome}`);
    expect(differing).toEqual([]);
    expect(replayed.records).toHaveLength(result.records.length);
  }, 180_000);
});

describe('runEvaluation guards', () => {
  it('refuses tasks whose content differs from the frozen manifest', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'evals-guard-'));
    dirs.push(outDir);
    await writeSampleHoldout(join(outDir, 'holdout'));
    const holdout = await loadHoldout(join(outDir, 'holdout'));
    const smoke = buildSmokeManifest({ holdout, environment: await observeEnvironment(), repeats: 1, seed: 1 });
    const tampered = parseManifest({ ...smoke, suites: smoke.suites.map((s) => ({ ...s, tasks: s.tasks.map((t, i) => (i === 0 ? { ...t, checksum: '0'.repeat(64) } : t)) })) });
    const replay = new ReplayAgentRunner({
      id: 'opencode',
      pick: (input) => synthesizeRecording({ task: SAMPLE_TASKS[0] as (typeof SAMPLE_TASKS)[number], kind: 'noop', runner: 'opencode', model: 'm', format: null, seedLabel: input.runId }),
    });
    const runners = new Map(tampered.configurations.map((c) => [c.id, new OpenLinearAdapterRunner({ runner: replay, fake: true })]));
    await expect(runEvaluation({ manifest: tampered, tasks: holdout.tasks, runners, outDir: join(outDir, 'run'), systemContract: 'x' })).rejects.toThrow(TaskIntegrityError);
  });
});

describe('funded run plan', () => {
  it('computes the trial count and worst-case spend, and lists blockers', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'evals-funded-'));
    dirs.push(outDir);
    await writeSampleHoldout(join(outDir, 'holdout'));
    const holdout = await loadHoldout(join(outDir, 'holdout'));
    const smoke = buildSmokeManifest({ holdout, environment: await observeEnvironment(), repeats: 5, seed: 1 });
    const plan = planFundedRun(smoke);
    expect(plan.trials).toBe(5 * 5 * 4);
    expect(plan.worstCaseUsd).toBeCloseTo(100 * 10 * 1.1, 6);
    expect(plan.problems).toContainEqual(expect.stringContaining('smoke manifests run offline'));
  });
});
