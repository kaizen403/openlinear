import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AblationFake, type AblationFakeModel } from '../../fakes/ablation';
import { mainFile } from '../../fakes/recordings';
import { DEFAULT_KNOWLEDGE_DIR, loadKnowledgeFixture } from '../../features/knowledge';
import { loadPinnedKnowledge, prepareFeatureEnvironment } from '../../features/pipeline';
import { type FundedRunPlan, planFundedRun } from '../../funded';
import { runEvaluation, type RunEvaluationResult } from '../../harness';
import { observeEnvironment } from '../../manifest/drift';
import type { EvalManifest } from '../../manifest/schema';
import { OpenLinearAdapterRunner } from '../../runners/openlinear-adapter';
import { ReplayAgentRunner } from '../../runners/replay-agent-runner';
import type { HarnessRunner } from '../../runners/types';
import { EVAL_SYSTEM_CONTRACT, FAKE_SNAPSHOT } from '../../smoke';
import { type LoadedHoldout, loadHoldout } from '../../tasks/holdout';
import { graderCanary, SAMPLE_TASKS, writeSampleHoldout } from '../../tasks/samples';
import { type AblationName, ablationDefinition, type KnowledgePin } from './definitions';
import { type AblationRunnerChoice, buildAblationManifest } from './manifest';

export * from './definitions';
export * from './manifest';

/** The knowledge fixture written for the sample holdout (fixtures/knowledge/sample-holdout.json). */
export const SAMPLE_KNOWLEDGE_FIXTURE = 'sample-holdout';

async function pinKnowledge(name: AblationName, dir: string, fixture: string | undefined): Promise<KnowledgePin | null> {
  if (name !== 'project-knowledge') return null;
  if (!fixture) throw new Error('the project-knowledge ablation needs --knowledge NAME (a fixture <knowledge dir>/NAME.json written for this holdout)');
  const loaded = await loadKnowledgeFixture(dir, fixture);
  return { fixture: loaded.name, checksum: loaded.checksum };
}

// ---------------------------------------------------------------------------
// Offline smoke (FAKE runners)
// ---------------------------------------------------------------------------

export interface AblationSmokeOptions {
  name: AblationName;
  outDir: string;
  repeats?: number;
  seed?: number;
  concurrency?: number;
  sidecarSrc?: string;
  fake?: AblationFakeModel;
  onProgress?: (line: string) => void;
}

export interface AblationSmokeResult extends RunEvaluationResult {
  manifest: EvalManifest;
  /** Every session the fake runner received (prompt, phase, policy). */
  fake: AblationFake;
  problems: string[];
}

/**
 * `ablation smoke <name>`: the sample holdout, both arms with the FAKE
 * adapter runner, the real sidecar feature code, the real grader and
 * statistics — offline, no inference. Self-checks fail the smoke when an
 * arm did not get (or the baseline did get) what its configuration says.
 */
export async function runAblationSmoke(options: AblationSmokeOptions): Promise<AblationSmokeResult> {
  const holdoutRoot = join(options.outDir, 'holdout');
  const sample = await writeSampleHoldout(holdoutRoot);
  const holdout = await loadHoldout(holdoutRoot);
  const repeats = options.repeats ?? 4;
  const knowledge = await pinKnowledge(options.name, DEFAULT_KNOWLEDGE_DIR, SAMPLE_KNOWLEDGE_FIXTURE);
  const manifest = buildAblationManifest({ name: options.name, mode: 'smoke', holdout, environment: await observeEnvironment(), repeats, seed: options.seed ?? 20261027, concurrency: options.concurrency, knowledge });
  const canaries = SAMPLE_TASKS.map((task) => graderCanary(task.id));
  const features = await prepareFeatureEnvironment({ manifest, tasks: holdout.tasks, sidecarSrc: options.sidecarSrc, canaries });
  const fake = new AblationFake({ sources: sample.sources, model: FAKE_SNAPSHOT, runner: 'opencode', ...(options.fake ? { fake: options.fake } : {}) });
  const runners = new Map<string, HarnessRunner>();
  for (const config of manifest.configurations) {
    runners.set(config.id, new OpenLinearAdapterRunner({ runner: new ReplayAgentRunner({ id: 'opencode', timeScale: 0.04, pick: fake.pick }), fake: true, stopGraceMs: 300 }));
  }
  const result = await runEvaluation({ manifest, tasks: holdout.tasks, runners, outDir: options.outDir, systemContract: EVAL_SYSTEM_CONTRACT, features, onProgress: options.onProgress });

  // Self-checks: an ablation whose arms silently got the wrong prompt or flow is worse than a failing one.
  const definition = ablationDefinition(options.name);
  const problems: string[] = [];
  const failedGates = result.report.gates.filter((gate) => !gate.ok);
  if (failedGates.length > 0) problems.push(`task gates failed: ${failedGates.map((g) => g.taskId).join(', ')}`);
  const first = result.records.filter((record) => record.attempt === 1);
  const expected = holdout.tasks.length * manifest.configurations.length * repeats;
  if (first.length !== expected) problems.push(`expected ${expected} first attempts, got ${first.length}`);
  const calls = (configurationId: string) => fake.calls.filter((call) => call.runId.startsWith(`${configurationId}--`));
  for (const call of calls(definition.baselineId)) {
    if (call.phase !== 'run') problems.push(`${call.runId}: the baseline started a ${call.phase} session`);
    if (call.prompt.includes('## Repository context') || call.prompt.includes('## Project knowledge')) problems.push(`${call.runId}: the baseline prompt carries a feature section`);
  }
  for (const record of result.records) {
    const isTreatment = record.configurationId === definition.treatmentId;
    if (!isTreatment && record.features) problems.push(`${record.trialId}: the baseline has a feature receipt`);
    if (isTreatment && record.outcome !== 'infra' && !record.features) problems.push(`${record.trialId}: the treatment has no feature receipt`);
  }
  const treatment = result.records.filter((record) => record.configurationId === definition.treatmentId && record.features);
  const runPrompts = calls(definition.treatmentId).filter((call) => call.phase === 'run');
  if (options.name === 'repository-context') {
    for (const record of treatment) {
      const source = sample.sources.get(record.taskId);
      if (!record.features?.repositoryContext?.section) problems.push(`${record.trialId}: no repository context section (${record.features?.repositoryContext?.reason ?? 'no receipt'})`);
      else if (source && !record.features.repositoryContext.citations.includes(mainFile(source))) problems.push(`${record.trialId}: the section does not cite ${mainFile(source)}`);
    }
    if (runPrompts.some((call) => !call.prompt.includes('## Repository context'))) problems.push('a treatment run prompt lacks the Repository context section');
  }
  if (options.name === 'project-knowledge') {
    for (const record of treatment) if (!record.features?.knowledge?.entries.length) problems.push(`${record.trialId}: no knowledge entries given`);
    if (runPrompts.some((call) => !call.prompt.includes('## Project knowledge'))) problems.push('a treatment run prompt lacks the Project knowledge section');
  }
  if (options.name === 'reviewer') {
    const reviews = calls(definition.treatmentId).filter((call) => call.phase === 'review');
    if (reviews.length === 0) problems.push('no reviewer session ran');
    for (const call of reviews) {
      if (call.permissions !== 'deny') problems.push(`${call.runId}: the reviewer ran with permissions ${call.permissions}`);
      if (call.systemContract !== features.sidecar.reviewerSystemContract) problems.push(`${call.runId}: the reviewer did not get the reviewer contract`);
      if (!call.worktree.includes(`${join('review', 'checkout')}`)) problems.push(`${call.runId}: the reviewer did not work in the disposable checkout`);
    }
    if (!treatment.some((record) => record.features?.reviewer?.followUp === 'ran')) problems.push('no follow-up turn ran');
    const t = result.report.primary.configurations.find((c) => c.configurationId === definition.treatmentId);
    const b = result.report.primary.configurations.find((c) => c.configurationId === definition.baselineId);
    if (!t?.cost.complete || !b?.cost.complete || t.cost.knownUsd <= b.cost.knownUsd) problems.push('the reviewer arm\'s cost does not include its extra sessions');
  }
  for (const record of result.records) if (record.usage.costBasis === 'unknown' && record.usage.costUsd !== null) problems.push(`${record.trialId}: unknown cost must be null`);
  if (result.report.ablation?.comparisons.length !== 1) problems.push('the report has no paired ablation comparison');
  if (first.some((record) => record.sealed && record.memoryPromotionAllowed)) problems.push('a sealed trial allows memory promotion');
  return { ...result, manifest, fake, problems };
}

// ---------------------------------------------------------------------------
// Funded plan (nothing runs)
// ---------------------------------------------------------------------------

export interface AblationPlanOptions {
  name: AblationName;
  /** A private holdout; default: the five sample tasks written to a temp dir (illustration only). */
  holdoutDir?: string;
  knowledgeDir?: string;
  /** Knowledge fixture name (default for the sample holdout: `sample-holdout`). */
  knowledge?: string;
  repeats?: number;
  seed?: number;
  runner?: AblationRunnerChoice;
  holdoutRevision?: string;
}

export interface AblationPlan {
  manifest: EvalManifest;
  holdout: LoadedHoldout;
  sample: boolean;
  plan: FundedRunPlan;
  /** Blocking: what must change before `run --confirm-spend` accepts the manifest. */
  problems: string[];
  notes: string[];
  text: string;
}

const usd = (v: number | null) => (v === null ? 'UNBOUNDED' : `$${v.toFixed(2)}`);

export async function planAblation(options: AblationPlanOptions): Promise<AblationPlan> {
  const sample = !options.holdoutDir;
  const holdoutRoot = options.holdoutDir ?? join(await mkdtemp(join(tmpdir(), 'openlinear-ablation-plan-')), 'holdout');
  if (sample) await writeSampleHoldout(holdoutRoot);
  const holdout = await loadHoldout(holdoutRoot);
  const knowledgeDir = options.knowledgeDir ?? DEFAULT_KNOWLEDGE_DIR;
  const knowledge = await pinKnowledge(options.name, knowledgeDir, options.knowledge ?? (sample ? SAMPLE_KNOWLEDGE_FIXTURE : undefined));
  const repeats = options.repeats ?? 5;
  const manifest = buildAblationManifest({
    name: options.name,
    mode: 'funded',
    holdout,
    environment: await observeEnvironment(),
    repeats,
    seed: options.seed ?? 20261027,
    knowledge,
    ...(options.runner ? { runner: options.runner } : {}),
    ...(options.holdoutRevision ? { holdoutRevision: options.holdoutRevision } : {}),
  });
  const plan = planFundedRun(manifest);
  const pinned = await loadPinnedKnowledge({ manifest, tasks: holdout.tasks, knowledgeDir });
  const problems = [...plan.problems, ...pinned.problems];
  const notes = [...pinned.notes];
  const definition = ablationDefinition(options.name);
  const tasks = manifest.suites.reduce((n, suite) => n + suite.tasks.length, 0);
  const sealed = holdout.tasks.filter((task) => task.sealed).length;
  const [config] = manifest.configurations;
  const perTask = plan.worstCaseUsd === null ? null : plan.worstCaseUsd / Math.max(1, tasks);
  const lines = [
    `ABLATION PLAN: ${definition.name} — nothing is run`,
    definition.title,
    `Question: ${definition.question}`,
    `PRD: ${definition.prd}`,
    `Holdout: ${holdout.index.id} — ${tasks} task(s)${sealed ? ` (${sealed} sealed task(s) left out: sealed tasks are release evidence only)` : ''}${sample ? ' [the synthetic sample: pass --holdout DIR for the private holdout]' : ''}`,
    `Arms: ${manifest.configurations.map((c) => c.id).join(' vs ')} — ${config ? `${config.harness}/${config.transport} + ${config.runner.id}, model ${config.model.requested} (${config.model.provider})` : ''}`,
    `Trials: ${plan.trials} (${plan.configurations.map((c) => `${c.id} ${c.trials}`).join(', ')}; ${tasks} task(s) × ${repeats} repeat(s) per arm)`,
    `Agent sessions per trial: ${plan.configurations.map((c) => `${c.id} ${c.sessionsPerTrial}`).join(', ')}`,
    `Worst case: ${usd(plan.worstCaseUsd)} = Σ arms (trials × sessions × per-task cap ${usd(manifest.budgets.maxUsdPerTask)} × (1 + ${manifest.budgets.headroomPct}% headroom)); per arm: ${plan.configurations.map((c) => `${c.id} ${usd(c.worstCaseUsd)}`).join(', ')}; per task (both arms, all repeats): ${usd(perTask)}`,
    ...(plan.configurations.some((c) => c.sessionsPerTrial > 1)
      ? ['  (a trial\'s sessions share the per-task cap whenever their cost is known — a priced snapshot — so the expected ceiling is closer to trials × cap; the worst case counts every session at the cap because a runner that reports no cost cannot be held to a shared cap from outside)']
      : []),
    '',
    problems.length > 0 ? `Problems to fix before \`run --confirm-spend\` accepts the manifest (${problems.length}):` : 'No blocking problems.',
    ...problems.map((p) => `- ${p}`),
    ...(notes.length > 0 ? ['', 'Notes:', ...notes.map((n) => `- ${n}`)] : []),
    '',
    'When funded (owner-approved budget, per-run credentials):',
    `  pnpm eval:cli ablation plan ${definition.name} --holdout HOLDOUT_DIR${options.name === 'project-knowledge' ? ' --knowledge NAME --knowledge-dir DIR' : ''} --write ablation-${definition.name}.json`,
    '  # resolve and freeze: model snapshot, runner version (+ sha256 for release), a dated price, the holdout revision',
    `  pnpm eval:cli validate-manifest ablation-${definition.name}.json`,
    `  pnpm eval:cli run --manifest ablation-${definition.name}.json --holdout HOLDOUT_DIR --out runs/ablation-${definition.name} --adapter-module apps/sidecar/src/runners/index.ts --credentials-env ${config?.model.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'}${options.name === 'project-knowledge' ? ' --knowledge-dir DIR' : ''} --confirm-spend`,
    `  pnpm eval:cli replay --manifest runs/ablation-${definition.name}/manifest.json --holdout HOLDOUT_DIR --recordings runs/ablation-${definition.name}`,
  ];
  return { manifest, holdout, sample, plan, problems, notes, text: lines.join('\n') };
}
