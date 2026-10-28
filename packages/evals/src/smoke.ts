import { cpus } from 'node:os';
import { join } from 'node:path';
import { type BehaviourKind, chooseBehaviour, synthesizeRecording } from './fakes/recordings';
import { runEvaluation, type RunEvaluationResult } from './harness';
import { type ObservedEnvironment, observeEnvironment } from './manifest/drift';
import { type Configuration, type EvalManifest, EvalManifestSchema, type EvalManifestInput } from './manifest/schema';
import { NATIVE_FORMATS, type NativeRunnerId } from './runners/native/commands';
import { NativeCliRunner } from './runners/native/native-runner';
import { OpenLinearAdapterRunner } from './runners/openlinear-adapter';
import { ReplayAgentRunner } from './runners/replay-agent-runner';
import type { HarnessRunner } from './runners/types';
import { type LoadedHoldout, loadHoldout } from './tasks/holdout';
import { graderCanary, SAMPLE_TASKS, type SampleTaskSource, writeSampleHoldout } from './tasks/samples';
import { sha256Hex } from './util/hash';

/**
 * `pnpm eval:smoke`: the whole pipeline, offline, with FAKE runners.
 * Five synthetic tasks × four configurations (OpenLinear adapter + OpenCode,
 * native OpenCode, native Claude Code, native Codex) × N repeats; recordings
 * cover every outcome class, one forced infra failure exercises the rerun
 * rule, and the run asserts its own invariants before printing the report.
 */

export const EVAL_SYSTEM_CONTRACT = [
  'You are working in a git checkout of the project. Complete the task the user describes.',
  'There is no human available: do not ask questions. Make the smallest correct change.',
  'Verify the change by running the relevant tests before you finish.',
].join('\n');

export const FAKE_MODEL = 'fake-model';
export const FAKE_SNAPSHOT = 'fake-model-2026-10-26';
const SMOKE_DATE = '2026-10-26';

interface SmokeConfiguration {
  id: string;
  label: string;
  harness: 'openlinear' | 'native';
  runner: NativeRunnerId;
  propensity: number;
}

export const SMOKE_CONFIGURATIONS: readonly SmokeConfiguration[] = [
  { id: 'ol-opencode', label: 'OpenLinear (adapter) + OpenCode — replay', harness: 'openlinear', runner: 'opencode', propensity: 0.74 },
  { id: 'native-opencode', label: 'OpenCode CLI (native) — replay', harness: 'native', runner: 'opencode', propensity: 0.6 },
  { id: 'native-claude-code', label: 'Claude Code CLI (native) — replay', harness: 'native', runner: 'claude-code', propensity: 0.68 },
  { id: 'native-codex', label: 'Codex CLI (native) — replay', harness: 'native', runner: 'codex', propensity: 0.56 },
];

/** Forced behaviours (config/task/repeat/attempt) so every outcome class and the rerun rule are exercised. */
export const SMOKE_FORCED: ReadonlyMap<string, BehaviourKind> = new Map<string, BehaviourKind>([
  ['ol-opencode/lru-refresh-on-get/3/1', 'infra'],
  ['ol-opencode/slugify-collapse/2/1', 'timeout'],
  ['native-opencode/parse-duration-compound/2/1', 'timeout'],
  ['native-codex/slugify-collapse/4/1', 'refusal'],
  ['native-claude-code/semver-numeric-compare/1/1', 'safety'],
  ['native-codex/sum-range-inclusive/5/1', 'infra'],
  ['native-claude-code/parse-duration-compound/3/1', 'refusal'],
]);

const NONE = sha256Hex('none');

function configuration(smoke: SmokeConfiguration): Configuration {
  return {
    id: smoke.id,
    label: smoke.label,
    harness: smoke.harness,
    transport: smoke.harness === 'openlinear' ? 'adapter' : 'cli',
    runner: { id: smoke.runner, binaryVersion: smoke.harness === 'openlinear' ? 'replay-1' : 'replay-cli-1', binarySha256: null, sdkVersion: null, mode: 'fake' },
    model: {
      requested: FAKE_MODEL,
      snapshot: FAKE_SNAPSHOT,
      provider: 'fake',
      endpoint: null,
      region: null,
      effort: null,
      sampling: { temperature: null, topP: null, seed: null },
      maxOutputTokens: null,
      contextPolicy: null,
      routing: 'fixed',
    },
    assets: { systemContract: sha256Hex(EVAL_SYSTEM_CONTRACT), promptTemplate: sha256Hex('instruction.md verbatim'), tools: NONE, skills: NONE, mcpConfig: NONE },
    enhancements: smoke.harness === 'openlinear' ? { systemContract: true } : {},
  };
}

export interface SmokeOptions {
  outDir: string;
  repeats?: number;
  seed?: number;
  concurrency?: number;
  onProgress?: (line: string) => void;
}

export interface SmokeResult extends RunEvaluationResult {
  manifest: EvalManifest;
  problems: string[];
}

/** The smoke manifest for a loaded sample holdout on this host (pure; no trials run). */
export function buildSmokeManifest(input: { holdout: LoadedHoldout; environment: ObservedEnvironment; repeats: number; seed: number; concurrency?: number }): EvalManifest {
  const { holdout, environment, repeats, seed } = input;
  const configs = SMOKE_CONFIGURATIONS.map(configuration);
  const draft: EvalManifestInput = {
    schemaVersion: 'openlinear.eval.manifest/v1',
    id: 'smoke-offline',
    title: 'Offline smoke: synthetic tasks, FAKE runners',
    createdAt: new Date().toISOString(),
    purpose: 'smoke',
    track: 'deterministic-smoke',
    repeats,
    suites: [
      {
        id: 'sample-holdout',
        kind: 'synthetic-smoke',
        name: holdout.index.id,
        version: '1',
        source: { repository: 'generated at run time by packages/eval/src/tasks/samples.ts', revision: 'generated', datasetChecksum: null, config: null, split: null },
        official: false,
        tasks: holdout.tasks.map((task) => ({ id: task.spec.id, checksum: task.checksum, category: task.spec.category, cluster: task.spec.cluster, sealed: task.sealed, images: [] })),
      },
    ],
    hardware: {
      provider: 'local-host',
      os: environment.os,
      arch: environment.arch === 'arm64' ? 'arm64' : 'x64',
      cpus: environment.cpus,
      memoryMb: environment.memoryMb,
      diskMb: null,
      resourcePolicy: 'none',
      headroom: null,
    },
    concurrency: { maxConcurrentTrials: input.concurrency ?? Math.max(2, Math.min(6, cpus().length)), order: 'randomized-interleaved', seed },
    toolchain: { node: environment.node, git: environment.git ?? 'unknown', packageManager: 'pnpm@9', python: null, docker: null, harbor: null, extra: {} },
    configurations: configs,
    sandbox: { provider: 'none (replay only; no agent code runs)', agentNetwork: 'no-network', allowedHosts: [], verifierNetwork: 'no-network', envPolicy: 'allowlist', privateHome: true },
    budgets: { agentTimeoutMs: 2500, verifierTimeoutMs: 30_000, maxUsdPerTask: 10, maxTokensPerTask: 1_000_000, maxTurns: null, stopRule: 'first-cap', headroomPct: 10, gradeOnTimeout: true },
    retries: { infraRetries: 1, retryOutcomes: ['infra'], keepOriginal: true },
    prices: [
      {
        provider: 'fake',
        model: FAKE_SNAPSHOT,
        currency: 'USD',
        inputPerMTok: 3,
        outputPerMTok: 15,
        cacheReadPerMTok: 0.3,
        cacheWritePerMTok: 3.75,
        asOf: SMOKE_DATE,
        source: 'synthetic price for the fake model (not a real price list)',
      },
    ],
    verifier: { revision: 'grader assets hashed into each task checksum', graderAssets: sha256Hex(holdout.tasks.map((t) => t.checksum).join('\n')), method: 'pristine-checkout' },
    contamination: {
      sealedHoldoutPresent: holdout.tasks.some((task) => task.sealed),
      crossTaskMemoryReset: true,
      solutionLookup: 'not-applicable',
      historySanitized: true,
      canaries: SAMPLE_TASKS.map((task) => graderCanary(task.id)),
    },
    analysis: {
      primaryMetric: 'single-attempt-success',
      bootstrapResamples: 2000,
      confidence: 0.95,
      clusterBy: 'task',
      practicalThresholdPts: 5,
      nonInferiorityMarginPts: 3,
      comparisons: [
        { treatment: 'ol-opencode', baseline: 'native-opencode' },
        { treatment: 'native-claude-code', baseline: 'native-codex' },
      ],
      categories: [...new Set(holdout.tasks.map((task) => task.spec.category))],
    },
    aliases: [],
    drift: [],
  };
  return EvalManifestSchema.parse(draft);
}

export async function runSmoke(options: SmokeOptions): Promise<SmokeResult> {
  const holdoutRoot = join(options.outDir, 'holdout');
  const sample = await writeSampleHoldout(holdoutRoot);
  const holdout = await loadHoldout(holdoutRoot);
  const repeats = options.repeats ?? 5;
  const manifest = buildSmokeManifest({ holdout, environment: await observeEnvironment(), repeats, seed: options.seed ?? 20261026, concurrency: options.concurrency });

  const sources = sample.sources;
  const sourceFor = (taskId: string): SampleTaskSource => {
    const source = sources.get(taskId);
    if (!source) throw new Error(`no sample source for ${taskId}`);
    return source;
  };
  const runners = new Map<string, HarnessRunner>();
  for (const smoke of SMOKE_CONFIGURATIONS) {
    const behaviour = (taskId: string, repeat: number, attempt: number) =>
      chooseBehaviour({ configurationId: smoke.id, taskId, repeat, attempt, propensity: smoke.propensity, forced: SMOKE_FORCED });
    if (smoke.harness === 'openlinear') {
      const replay = new ReplayAgentRunner({
        id: smoke.runner,
        timeScale: 0.04,
        pick: (start) => {
          // runId is the trial id: <config>--<task>--r<repeat>--a<attempt>
          const [, taskId = '', r = 'r1', a = 'a1'] = start.runId.split('--');
          const repeat = Number(r.slice(1));
          const attempt = Number(a.slice(1));
          return synthesizeRecording({ task: sourceFor(taskId), kind: behaviour(taskId, repeat, attempt), runner: smoke.runner, model: FAKE_SNAPSHOT, format: null, seedLabel: start.runId });
        },
      });
      runners.set(smoke.id, new OpenLinearAdapterRunner({ runner: replay, fake: true, stopGraceMs: 300 }));
    } else {
      runners.set(
        smoke.id,
        new NativeCliRunner({
          runner: smoke.runner,
          mode: 'fake',
          killGraceMs: 500,
          pickRecording: (ctx) =>
            synthesizeRecording({
              task: sourceFor(ctx.task.spec.id),
              kind: behaviour(ctx.task.spec.id, ctx.repeat, ctx.attempt),
              runner: smoke.runner,
              model: FAKE_SNAPSHOT,
              format: NATIVE_FORMATS[smoke.runner],
              seedLabel: ctx.trialId,
              timeScale: 0.04,
            }),
        }),
      );
    }
  }

  const result = await runEvaluation({
    manifest,
    tasks: holdout.tasks,
    runners,
    outDir: options.outDir,
    systemContract: EVAL_SYSTEM_CONTRACT,
    onProgress: options.onProgress,
  });

  // Self-checks: a smoke run that silently degrades is worse than a failing one.
  const problems: string[] = [];
  const failedGates = result.report.gates.filter((gate) => !gate.ok);
  if (failedGates.length > 0) problems.push(`task gates failed: ${failedGates.map((g) => g.taskId).join(', ')}`);
  const expectedSlots = SAMPLE_TASKS.length * SMOKE_CONFIGURATIONS.length * repeats;
  const firstAttempts = result.records.filter((r) => r.attempt === 1);
  if (firstAttempts.length !== expectedSlots) problems.push(`expected ${expectedSlots} first attempts, got ${firstAttempts.length}`);
  for (const record of firstAttempts) {
    const forced = SMOKE_FORCED.get(`${record.configurationId}/${record.taskId}/${record.repeat}/1`);
    const expectedInfra = forced === 'infra';
    if ((record.outcome === 'infra') !== expectedInfra) problems.push(`${record.trialId}: unexpected outcome ${record.outcome} (${record.reason})`);
    const expected: Record<BehaviourKind, string[]> = {
      fix: ['pass'],
      'wrong-fix': ['fail'],
      noop: ['fail'],
      timeout: ['timeout'],
      refusal: ['refusal'],
      infra: ['infra'],
      safety: ['safety'],
      'agent-error': ['fail'],
    };
    const kind = chooseBehaviour({
      configurationId: record.configurationId,
      taskId: record.taskId,
      repeat: record.repeat,
      attempt: 1,
      propensity: SMOKE_CONFIGURATIONS.find((c) => c.id === record.configurationId)?.propensity ?? 0,
      forced: SMOKE_FORCED,
    });
    if (!expected[kind].includes(record.outcome)) problems.push(`${record.trialId}: behaviour ${kind} produced ${record.outcome} (${record.reason})`);
    if (record.usage.costBasis === 'unknown' && record.usage.costUsd !== null) problems.push(`${record.trialId}: unknown cost must be null`);
  }
  if (result.report.infraReruns === 0) problems.push('the predeclared infra rerun rule was never exercised');
  const seen = new Set(firstAttempts.map((r) => r.outcome));
  for (const outcome of ['pass', 'fail', 'timeout', 'infra', 'refusal', 'safety'] as const) if (!seen.has(outcome)) problems.push(`outcome class ${outcome} never occurred`);
  if (firstAttempts.some((r) => r.sealed && r.memoryPromotionAllowed)) problems.push('a sealed trial allows memory promotion');
  return { ...result, manifest, problems };
}
