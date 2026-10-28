import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mainFile } from '../../fakes/recordings';
import { DEFAULT_KNOWLEDGE_DIR, loadKnowledgeFixture, selectPromptKnowledge } from '../../features/knowledge';
import { FeatureConfigurationError, type FeatureEnvironment, prepareFeatureEnvironment } from '../../features/pipeline';
import { loadSidecarFeatures } from '../../features/sidecar';
import { runEvaluation } from '../../harness';
import { observeEnvironment } from '../../manifest/drift';
import { renderMarkdown } from '../../report/report';
import { replayEvaluation } from '../../replay';
import { OpenLinearAdapterRunner } from '../../runners/openlinear-adapter';
import { ReplayAgentRunner } from '../../runners/replay-agent-runner';
import type { HarnessRunner } from '../../runners/types';
import { loadHoldout } from '../../tasks/holdout';
import { SAMPLE_TASKS } from '../../tasks/samples';
import { ABLATION_NAMES, type AblationName, type AblationSmokeResult, buildAblationManifest, planAblation, runAblationSmoke, SAMPLE_KNOWLEDGE_FIXTURE } from '.';

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const smokes = new Map<AblationName, AblationSmokeResult>();
beforeAll(async () => {
  // All three ablations offline: 5 sample tasks × 2 arms × 2 repeats each, FAKE adapter runners, real sidecar code.
  await Promise.all(
    ABLATION_NAMES.map(async (name) => {
      const outDir = await mkdtemp(join(tmpdir(), `evals-ablation-${name}-`));
      dirs.push(outDir);
      smokes.set(name, await runAblationSmoke({ name, outDir, repeats: 2, concurrency: 4 }));
    }),
  );
}, 180_000);

function smoke(name: AblationName): AblationSmokeResult {
  const result = smokes.get(name);
  if (!result) throw new Error(`no smoke for ${name}`);
  return result;
}

const source = (taskId: string) => {
  const task = SAMPLE_TASKS.find((t) => t.id === taskId);
  if (!task) throw new Error(taskId);
  return task;
};

describe('offline ablation smoke (FAKE runners, paired report)', () => {
  it.each(ABLATION_NAMES)('%s passes its self-checks and reports the paired comparison', async (name) => {
    const result = smoke(name);
    expect(result.problems).toEqual([]);
    expect(result.manifest.track).toBe('ablation');
    expect(result.records.filter((r) => r.attempt === 1)).toHaveLength(SAMPLE_TASKS.length * 2 * 2);
    const ablation = result.report.ablation;
    expect(ablation?.comparisons).toHaveLength(1);
    expect(ablation?.comparisons[0]).toMatchObject({ treatment: result.manifest.analysis.comparisons[0]?.treatment, baseline: 'baseline' });
    expect(result.report.primary.comparisons).toHaveLength(1);
    const markdown = await readFile(result.reportMarkdownPath, 'utf8');
    expect(markdown).toContain('## Ablation: what the features applied, and the cost of the benefit');
    expect(markdown).toContain('these numbers prove the ablation plumbing, not a benefit');
    expect(result.report.caveats.join('\n')).toContain('FAKE ABLATION');
    // Baseline trials carry no receipt; treatment trials carry one per trial.
    for (const record of result.records) expect(record.features !== null).toBe(record.configurationId !== 'baseline');
  });
});

describe('each arm changes what the runner receives', () => {
  it('repository context: the treatment prompt carries the section citing the file to fix; the baseline prompt is the task alone', async () => {
    const result = smoke('repository-context');
    const holdout = await loadHoldout(join(result.outDir, 'holdout'));
    const instruction = (taskId: string) => holdout.tasks.find((t) => t.spec.id === taskId)?.instruction ?? '';
    for (const call of result.fake.calls) {
      const taskId = call.runId.split('--')[1] ?? '';
      if (call.runId.startsWith('baseline--')) {
        expect(call.prompt).toBe(instruction(taskId));
      } else {
        expect(call.prompt.startsWith(`${instruction(taskId).trimEnd()}\n\n## Repository context`)).toBe(true);
        expect(call.prompt).toContain(JSON.stringify(mainFile(source(taskId))));
        expect(call.prompt).toContain('<untrusted-repository-content');
      }
      expect(call.phase).toBe('run');
    }
    const receipt = result.records.find((r) => r.configurationId === 'repo-context')?.features?.repositoryContext;
    expect(receipt).toMatchObject({ section: true, reason: null });
    expect(receipt?.chars).toBeGreaterThan(0);
    expect(receipt?.chars).toBeLessThanOrEqual(result.manifest.configurations.find((c) => c.id === 'repo-context')?.features?.repositoryContext?.maxChars ?? 0);
  });

  it('project knowledge: the treatment prompt carries the sidecar-rendered section of the pinned fixture', async () => {
    const result = smoke('project-knowledge');
    const sidecar = await loadSidecarFeatures();
    const fixture = await loadKnowledgeFixture(DEFAULT_KNOWLEDGE_DIR, SAMPLE_KNOWLEDGE_FIXTURE);
    const section = sidecar.projectKnowledgeSection(selectPromptKnowledge(fixture.fixture.entries).map(({ kind, title, body }) => ({ kind, title, body })));
    expect(section).toMatch(/^## Project knowledge\n/);
    const treatment = result.fake.calls.filter((call) => call.runId.startsWith('knowledge--'));
    expect(treatment.length).toBe(SAMPLE_TASKS.length * 2);
    for (const call of treatment) expect(call.prompt.endsWith(`\n\n${section}`)).toBe(true);
    for (const call of result.fake.calls.filter((c) => c.runId.startsWith('baseline--'))) expect(call.prompt).not.toContain('## Project knowledge');
    const knowledge = result.manifest.configurations.find((c) => c.id === 'knowledge')?.features?.knowledge;
    expect(knowledge).toEqual({ fixture: SAMPLE_KNOWLEDGE_FIXTURE, checksum: fixture.checksum });
    expect(result.records.find((r) => r.configurationId === 'knowledge')?.features?.knowledge).toMatchObject({ fixture: SAMPLE_KNOWLEDGE_FIXTURE, checksum: fixture.checksum, entries: expect.arrayContaining([{ kind: 'convention', title: 'Ranges are inclusive and order-free' }]) });
  });

  it('reviewer: run → review (deny policy, reviewer contract, disposable checkout) → follow-up with the findings; the baseline runs once', async () => {
    const result = smoke('reviewer');
    const sidecar = await loadSidecarFeatures();
    const byTrial = new Map<string, string[]>();
    for (const call of result.fake.calls) {
      const trial = call.runId.split('--').slice(0, 4).join('--');
      byTrial.set(trial, [...(byTrial.get(trial) ?? []), call.phase]);
    }
    for (const [trial, phases] of byTrial) {
      if (trial.startsWith('baseline--')) expect(phases).toEqual(['run']);
      else expect([['run'], ['run', 'review'], ['run', 'review', 'follow-up']]).toContainEqual(phases);
    }
    const reviews = result.fake.calls.filter((call) => call.phase === 'review');
    expect(reviews.length).toBeGreaterThan(0);
    for (const call of reviews) {
      expect(call.permissions).toBe('deny');
      expect(call.systemContract).toBe(sidecar.reviewerSystemContract);
      expect(call.worktree).toContain(join('review', 'checkout'));
      expect(call.prompt).toMatch(/^Review the change made for this task at commit [0-9a-f]{40}/);
    }
    const followUps = result.fake.calls.filter((call) => call.phase === 'follow-up');
    expect(followUps.length).toBeGreaterThan(0);
    for (const call of followUps) {
      expect(call.permissions).toBe('allow');
      expect(call.worktree).toMatch(/worktree$/);
      expect(call.prompt).toMatch(/^Follow-up on a task that a previous agent session already worked on/);
      expect(call.prompt).toMatch(/Comment 1 — file "src\/[a-z]+\.mjs", line \d+ \(new side of the diff\):\n> Major: /);
    }
    // Findings are anchored by the sidecar's contract against the reviewed commit.
    const reviewed = result.records.filter((r) => r.features?.reviewer?.status === 'completed');
    expect(reviewed.flatMap((r) => r.features?.reviewer?.findings ?? []).every((f) => f.evidence === 'verified' && f.inDiff)).toBe(true);
    expect(result.records.some((r) => r.features?.reviewer?.status === 'skipped')).toBe(true);
  });

  it('reviewer: the extra sessions are counted into the treatment trial\'s cost', () => {
    const result = smoke('reviewer');
    const withReview = result.records.filter((r) => (r.features?.phases.length ?? 0) > 1);
    expect(withReview.length).toBeGreaterThan(0);
    for (const record of withReview) {
      const phases = record.features?.phases ?? [];
      const sum = phases.reduce((total, phase) => total + (phase.costUsd ?? Number.NaN), 0);
      expect(record.usage.costUsd).toBeCloseTo(sum, 9);
      expect(record.usage.costUsd ?? 0).toBeGreaterThan(phases[0]?.costUsd ?? 0);
      expect(record.usage.tokens?.input).toBe(phases.reduce((total, phase) => total + (phase.tokens?.input ?? 0), 0));
    }
    const arm = result.report.ablation?.arms.find((a) => a.configurationId === 'reviewer');
    expect(arm?.reviewer?.extraUsd).toBeGreaterThan(0);
    expect(arm?.sessions).toBeGreaterThan(arm?.trials ?? 0);
    const comparison = result.report.ablation?.comparisons[0];
    expect(comparison?.deltaMeanCostUsd).toBeGreaterThan(0);
  });

  it('reviewer: the merged trajectories replay offline to the same outcomes and costs', async () => {
    const result = smoke('reviewer');
    const holdout = await loadHoldout(join(result.outDir, 'holdout'));
    const replayed = await replayEvaluation({ manifest: result.manifest, tasks: holdout.tasks, recordingsDir: result.outDir, outDir: join(result.outDir, 'replay'), systemContract: 'replay' });
    const original = new Map(result.records.map((r) => [r.trialId, r]));
    expect(replayed.records).toHaveLength(result.records.length);
    for (const record of replayed.records) {
      expect(record.outcome, record.trialId).toBe(original.get(record.trialId)?.outcome);
      expect(record.usage.costUsd ?? 0).toBeCloseTo(original.get(record.trialId)?.usage.costUsd ?? -1, 9);
      expect(record.features).toBeNull();
    }
  }, 120_000);
});

describe('funded plan (nothing runs)', () => {
  it('prints trials, the worst case through planFundedRun (reviewer sessions counted) and the blocking problems', async () => {
    const plan = await planAblation({ name: 'reviewer' });
    dirs.push(join(plan.holdout.root, '..'));
    expect(plan.manifest.purpose).toBe('validation');
    expect(plan.manifest.configurations.every((c) => c.runner.mode === 'real' && c.harness === 'openlinear' && c.transport === 'adapter')).toBe(true);
    // Sealed tasks are left out of the funded ablation.
    const ids = plan.manifest.suites.flatMap((s) => s.tasks.map((t) => t.id));
    expect(ids).toHaveLength(4);
    expect(ids).not.toContain('semver-numeric-compare');
    expect(plan.plan.trials).toBe(4 * 5 * 2);
    expect(plan.plan.configurations.map((c) => [c.id, c.sessionsPerTrial])).toEqual([['baseline', 1], ['reviewer', 3]]);
    expect(plan.plan.worstCaseUsd).toBeCloseTo((20 * 1 + 20 * 3) * 10 * 1.1, 6);
    expect(plan.problems).toEqual(expect.arrayContaining([expect.stringMatching(/^floating reference \/configurations\/0\/model\/snapshot/), expect.stringMatching(/no price entry/)]));
    expect(plan.text).toContain('nothing is run');
    expect(plan.text).toContain('Worst case: $880.00');
    expect(plan.text).toContain('--confirm-spend');

    const context = await planAblation({ name: 'repository-context', repeats: 3 });
    dirs.push(join(context.holdout.root, '..'));
    expect(context.plan.worstCaseUsd).toBeCloseTo(4 * 3 * 2 * 10 * 1.1, 6);
  });

  it('notes in-sample knowledge and refuses a fixture derived from a sealed task (plan, preparation and the harness)', async () => {
    const knowledge = await planAblation({ name: 'project-knowledge' });
    dirs.push(join(knowledge.holdout.root, '..'));
    expect(knowledge.notes.join('\n')).toMatch(/in-sample/);
    expect(knowledge.problems.filter((p) => p.startsWith('knowledge fixture'))).toEqual([]);

    const dir = await mkdtemp(join(tmpdir(), 'evals-knowledge-'));
    dirs.push(dir);
    const fixture = JSON.parse(await readFile(join(DEFAULT_KNOWLEDGE_DIR, `${SAMPLE_KNOWLEDGE_FIXTURE}.json`), 'utf8')) as { entries: unknown[] };
    fixture.entries.push({ kind: 'convention', title: 'Versions compare numerically', body: 'Split on dots and compare numbers.', provenance: { author: 'someone tuning', derivedFrom: ['semver-numeric-compare'] } });
    await writeFile(join(dir, 'tainted.json'), JSON.stringify(fixture));
    const tainted = await planAblation({ name: 'project-knowledge', knowledgeDir: dir, knowledge: 'tainted' });
    dirs.push(join(tainted.holdout.root, '..'));
    expect(tainted.problems).toContainEqual(expect.stringMatching(/derived from sealed task semver-numeric-compare/));

    // The smoke manifest (sealed task included) is refused before anything runs.
    const holdout = tainted.holdout;
    const pinned = await loadKnowledgeFixture(dir, 'tainted');
    const manifest = buildAblationManifest({ name: 'project-knowledge', mode: 'smoke', holdout, environment: await observeEnvironment(), repeats: 1, seed: 1, knowledge: { fixture: 'tainted', checksum: pinned.checksum } });
    await expect(prepareFeatureEnvironment({ manifest, tasks: holdout.tasks, knowledgeDir: dir })).rejects.toThrow(FeatureConfigurationError);
    await expect(prepareFeatureEnvironment({ manifest, tasks: holdout.tasks, knowledgeDir: dir })).rejects.toThrow(/sealed tasks never feed knowledge/);
    // The harness re-checks what it is handed, so a hand-built environment cannot slip the fixture past it.
    const env: FeatureEnvironment = { sidecar: await loadSidecarFeatures(), knowledge: new Map([['tainted', pinned]]), contextEngine: null, notes: [] };
    const never = new ReplayAgentRunner({
      id: 'opencode',
      pick: () => {
        throw new Error('no trial may start');
      },
    });
    const runners = new Map<string, HarnessRunner>(manifest.configurations.map((c) => [c.id, new OpenLinearAdapterRunner({ runner: never, fake: true })]));
    await expect(runEvaluation({ manifest, tasks: holdout.tasks, runners, outDir: join(dir, 'run'), systemContract: 'x', features: env })).rejects.toThrow(/sealed tasks never feed knowledge/);

    // A fixture edited after the manifest pinned it is refused too.
    await copyFile(join(DEFAULT_KNOWLEDGE_DIR, `${SAMPLE_KNOWLEDGE_FIXTURE}.json`), join(dir, 'edited.json'));
    const original = await loadKnowledgeFixture(dir, 'edited');
    await writeFile(join(dir, 'edited.json'), (await readFile(join(dir, 'edited.json'), 'utf8')).replace('Run the visible test', 'Run every test'));
    const stale = buildAblationManifest({ name: 'project-knowledge', mode: 'smoke', holdout, environment: await observeEnvironment(), repeats: 1, seed: 1, knowledge: { fixture: 'edited', checksum: original.checksum } });
    await expect(prepareFeatureEnvironment({ manifest: stale, tasks: holdout.tasks, knowledgeDir: dir })).rejects.toThrow(/differs from the manifest's/);
  });
});

describe('report rendering', () => {
  it('keeps the ablation section in the re-rendered markdown', () => {
    const result = smoke('repository-context');
    expect(renderMarkdown(result.report)).toContain('| repo-context | repositoryContext |');
  });
});
