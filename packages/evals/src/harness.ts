import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { classifyOutcome } from './grading/outcome';
import { patchPaths, scanSafety } from './grading/safety';
import { checkTaskGates, gradePatch, type TaskGateResult } from './grading/verifier';
import { detectDrift, mergeDrift, observeEnvironment, type TrialObservation } from './manifest/drift';
import { assertRunnable } from './manifest/resolve';
import { assertFeaturesApplicable, type FeatureEnvironment, runWithFeatures } from './features/pipeline';
import { enabledFeatures } from './features/types';
import { type EvalManifest, manifestDigest, type Suite, type TaskRef } from './manifest/schema';
import { TRIAL_SCHEMA_VERSION, type TrialRecord } from './records';
import { buildReport, type EvalReport, renderMarkdown } from './report/report';
import type { HarnessRunner, RunnerResult, TrialContext } from './runners/types';
import { capturePatch, effectsFromWorktree } from './runners/workspace';
import { type BaseRepo, cloneForTrial, isInside, materializeBaseRepo, TaskIntegrityError } from './tasks/holdout';
import type { LoadedTask } from './tasks/types';
import { toAtif } from './trajectory/atif';
import { type NativeStep, type RecordedTrajectory, TRAJECTORY_SCHEMA_VERSION } from './trajectory/types';
import { finalizeTrialUsage, UNKNOWN_USAGE } from './usage/cost';
import { sha256Hex } from './util/hash';
import { mulberry32, shuffle } from './util/random';

/**
 * The evaluation loop: freeze checks → task gates → randomized interleaved
 * schedule of fresh independent trials → identical artifact capture →
 * independent grading in a pristine checkout → predeclared infra reruns →
 * drift report → statistics → JSON + Markdown report.
 */

export interface RunEvaluationInput {
  manifest: EvalManifest;
  tasks: readonly LoadedTask[];
  /** Configuration id → harness runner. */
  runners: ReadonlyMap<string, HarnessRunner>;
  outDir: string;
  /** Scratch for base repos, worktrees and pristine checkouts (default `<outDir>/work`). */
  workRoot?: string;
  systemContract: string;
  /** Extra canaries (e.g. per-task grader canaries) beyond `manifest.contamination.canaries`. */
  canaries?: readonly string[];
  keepWorktrees?: boolean;
  onProgress?: (line: string) => void;
  /**
   * W21: how configurations with `features` get them — the loaded sidecar code
   * and knowledge fixtures (`prepareFeatureEnvironment`), or `recorded` for an
   * offline replay whose trajectories already contain every session. Without
   * it, a manifest that enables features is refused (never run as the baseline).
   */
  features?: FeatureEnvironment | 'recorded';
}

export interface RunEvaluationResult {
  outDir: string;
  report: EvalReport;
  records: TrialRecord[];
  reportJsonPath: string;
  reportMarkdownPath: string;
}

interface Slot {
  suite: Suite;
  ref: TaskRef;
  task: LoadedTask;
  base: BaseRepo;
  configurationId: string;
  repeat: number;
  order: number;
}

async function pool<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await worker(items[index] as T);
    }
  });
  await Promise.all(lanes);
}

function memoryPromotionAllowed(suite: Suite, task: LoadedTask): boolean {
  // Only development tasks of our own corpora may be mined for general improvements;
  // validation/sealed tasks and public benchmarks never feed memory (PRD §10).
  return !task.sealed && task.spec.split === 'development' && (suite.kind === 'private-holdout' || suite.kind === 'synthetic-smoke');
}

/**
 * Converts what a runner observed into a replayable trajectory: replaying it
 * (ReplayAgentRunner for adapter runs, replay-cli for native runs) reproduces
 * the same edits and the same termination class, including timeouts (the
 * stream hangs at the point it was stopped), start failures and exit codes.
 */
export function trajectoryFromResult(input: {
  trialId: string;
  taskId: string;
  runnerId: string;
  fake: boolean;
  result: RunnerResult;
  effects: RecordedTrajectory['effects'];
  format: 'claude-stream-json' | 'codex-jsonl' | 'opencode-json' | null;
}): RecordedTrajectory {
  const { result, effects, format } = input;
  const timedOut = result.termination === 'timeout';
  let events = result.events.map((timed) => ({ atMs: timed.atMs, event: timed.event }));
  if (timedOut) {
    // Drop the harness-induced stop so the replay hangs where the original was stopped.
    while (events.length > 0) {
      const last = events[events.length - 1]?.event;
      if (last && (last.t === 'cancel.receipt' || (last.t === 'turn.finished' && last.reason === 'interrupted'))) events = events.slice(0, -1);
      else break;
    }
  }
  // Effects (final file contents) are applied after the last non-terminal event: consumers stop
  // reading at the terminal event, so anything scheduled after it would never be applied.
  let effectsAfter = events.length - 1;
  while (effectsAfter >= 0) {
    const t = events[effectsAfter]?.event.t;
    if (t === 'turn.finished' || t === 'cancel.receipt') effectsAfter -= 1;
    else break;
  }
  const lastEvent = events.length - 1;
  const steps: NativeStep[] = [];
  for (const line of result.nativeLines) {
    try {
      steps.push({ line: JSON.parse(line) });
    } catch {
      // unparseable lines are kept in logs only
    }
  }
  steps.push(...effects.map((_, i) => ({ effect: i })));
  if (timedOut) steps.push({ hang: true });
  else if (typeof result.exitCode === 'number' && result.exitCode !== 0) steps.push({ exit: result.exitCode });
  return {
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    id: input.trialId,
    taskId: input.taskId,
    runner: input.runnerId,
    source: input.fake ? 'synthetic' : 'recorded',
    agentEvents: events,
    native: format ? { format, steps } : null,
    effects: effects.map((effect) => ({ ...effect, afterEvent: effectsAfter })),
    behavior: {
      startError: result.startErrorCode ? { code: result.startErrorCode, message: result.terminationDetail } : null,
      hangAfterEvent: timedOut ? Math.max(0, lastEvent) : null,
    },
    note: `${result.termination}: ${result.terminationDetail}`,
  };
}

const NATIVE_FORMAT: Record<string, 'claude-stream-json' | 'codex-jsonl' | 'opencode-json'> = {
  'claude-code': 'claude-stream-json',
  codex: 'codex-jsonl',
  opencode: 'opencode-json',
};

export async function runEvaluation(input: RunEvaluationInput): Promise<RunEvaluationResult> {
  const startedAt = Date.now();
  const { manifest } = input;
  const log = input.onProgress ?? (() => undefined);
  assertRunnable(manifest);
  for (const config of manifest.configurations) {
    if (!input.runners.has(config.id)) throw new Error(`no harness runner for configuration ${config.id}`);
  }
  const canaries = [...manifest.contamination.canaries, ...(input.canaries ?? [])];
  if (manifest.configurations.some((config) => enabledFeatures(config).length > 0)) {
    assertFeaturesApplicable({ manifest, runners: input.runners, features: input.features, tasks: input.tasks, canaries });
  }
  await mkdir(input.outDir, { recursive: true });
  const outDir = await realpath(input.outDir);
  const workRoot = input.workRoot ?? join(outDir, 'work');
  await mkdir(workRoot, { recursive: true });
  const digest = manifestDigest(manifest);

  // Resolve manifest tasks against the loaded definitions; checksums must match exactly.
  const byId = new Map(input.tasks.map((task) => [task.spec.id, task]));
  const taskChecksums = new Map(input.tasks.map((task) => [task.spec.id, task.checksum]));
  const planned: Array<{ suite: Suite; ref: TaskRef; task: LoadedTask }> = [];
  for (const suite of manifest.suites) {
    for (const ref of suite.tasks) {
      const task = byId.get(ref.id);
      if (!task) throw new TaskIntegrityError(`manifest task ${ref.id} was not loaded`);
      if (task.checksum !== ref.checksum) throw new TaskIntegrityError(`${ref.id}: task checksum ${task.checksum} differs from the manifest's ${ref.checksum}`);
      if (task.sealed !== ref.sealed) throw new TaskIntegrityError(`${ref.id}: sealed flag differs between the task and the manifest`);
      if (await isInside(workRoot, task.graderDir)) throw new TaskIntegrityError(`${ref.id}: grader assets must live outside the evaluation work root`);
      planned.push({ suite, ref, task });
    }
  }

  // Base repositories and task gates (reference passes, empty patch fails).
  const bases = new Map<string, BaseRepo>();
  const gates: TaskGateResult[] = [];
  await pool(planned, manifest.concurrency.maxConcurrentTrials, async ({ task }) => {
    const base = await materializeBaseRepo(task, workRoot);
    bases.set(task.spec.id, base);
    const gate = await checkTaskGates(task, base, join(workRoot, 'gates'));
    gates.push(gate);
    log(`gate ${task.spec.id}: reference ${gate.referencePasses ? 'passes' : 'FAILS'}, empty patch ${gate.emptyPatchFails ? 'fails' : 'PASSES'}`);
  });
  gates.sort((a, b) => a.taskId.localeCompare(b.taskId));
  const usable = planned.filter(({ task }) => gates.find((g) => g.taskId === task.spec.id)?.ok);

  // Fresh independent first attempts, randomized and interleaved across configurations.
  const slots: Slot[] = [];
  for (let repeat = 1; repeat <= manifest.repeats; repeat += 1) {
    for (const { suite, ref, task } of usable) {
      for (const config of manifest.configurations) {
        slots.push({ suite, ref, task, base: bases.get(task.spec.id) as BaseRepo, configurationId: config.id, repeat, order: 0 });
      }
    }
  }
  const ordered = manifest.concurrency.order === 'randomized-interleaved' ? shuffle(slots, mulberry32(manifest.concurrency.seed)) : slots;
  ordered.forEach((slot, index) => {
    slot.order = index;
  });

  const records: TrialRecord[] = [];
  const observations: TrialObservation[] = [];
  let finished = 0;

  const runTrial = async (slot: Slot, attempt: number): Promise<TrialRecord> => {
    const config = manifest.configurations.find((c) => c.id === slot.configurationId);
    if (!config) throw new Error(`unknown configuration ${slot.configurationId}`);
    const runner = input.runners.get(config.id) as HarnessRunner;
    const slotId = `${config.id}--${slot.task.spec.id}--r${slot.repeat}`;
    const trialId = `${slotId}--a${attempt}`;
    const trialOut = join(outDir, 'trials', trialId);
    const scratch = join(workRoot, 'trials', trialId);
    const worktree = join(scratch, 'worktree');
    await mkdir(trialOut, { recursive: true });
    await mkdir(scratch, { recursive: true });
    const started = Date.now();
    const startedIso = new Date(started).toISOString();
    await cloneForTrial(slot.base, worktree);
    const setupMs = Date.now() - started;
    const controller = new AbortController();
    const ctx: TrialContext = {
      trialId,
      attempt,
      repeat: slot.repeat,
      task: slot.task,
      configuration: config,
      manifest,
      worktree,
      baseSha: slot.base.baseSha,
      scratchDir: scratch,
      prompt: slot.task.instruction,
      systemContract: input.systemContract,
      sealed: slot.task.sealed,
      signal: controller.signal,
    };
    const featureEnv = input.features;
    let result: RunnerResult;
    try {
      result = featureEnv && featureEnv !== 'recorded' && enabledFeatures(config).length > 0 ? await runWithFeatures({ runner, ctx, env: featureEnv }) : await runner.run(ctx);
    } catch (error) {
      result = {
        termination: 'infra',
        terminationDetail: `harness runner threw: ${error instanceof Error ? error.message : String(error)}`,
        events: [],
        nativeLines: [],
        usage: UNKNOWN_USAGE,
        agentMs: Date.now() - started - setupMs,
        firstActionMs: null,
        observedModel: null,
        observedRunnerVersion: null,
        invocation: null,
        logs: [],
      };
    }
    const captureStart = Date.now();
    let patch = '';
    let effects: RecordedTrajectory['effects'] = [];
    try {
      patch = await capturePatch(worktree, slot.base.baseSha);
      effects = await effectsFromWorktree(worktree, slot.base.baseSha, result.events.length - 1);
    } catch (error) {
      result.logs.push(`patch capture failed: ${error instanceof Error ? error.message : String(error)}`);
      if (result.termination !== 'infra') {
        result.termination = 'infra';
        result.terminationDetail = 'patch capture failed';
      }
    }
    const captureMs = Date.now() - captureStart;
    const taskToArtifactMs = Date.now() - started;
    const safety = scanSafety({ patch, events: result.events, protectedPaths: slot.task.spec.protectedPaths, canaries });
    const gradeStart = Date.now();
    const grade =
      result.termination === 'infra' || result.termination === 'cancelled'
        ? null
        : await gradePatch({ task: slot.task, base: slot.base, patch, workRoot: join(workRoot, 'grading'), timeoutMs: Math.min(slot.task.spec.verifier.timeoutMs, manifest.budgets.verifierTimeoutMs) });
    const gradeMs = Date.now() - gradeStart;
    const classification = classifyOutcome({ termination: result.termination, terminationDetail: result.terminationDetail, grade, safety, gradeOnTimeout: manifest.budgets.gradeOnTimeout });
    const usage = finalizeTrialUsage(manifest, config, result.usage);

    const trajectory = trajectoryFromResult({
      trialId,
      taskId: slot.task.spec.id,
      runnerId: config.runner.id,
      fake: config.runner.mode === 'fake',
      result,
      effects,
      format: config.harness === 'native' ? (NATIVE_FORMAT[config.runner.id] ?? null) : null,
    });
    const record: TrialRecord = {
      schemaVersion: TRIAL_SCHEMA_VERSION,
      trialId,
      slotId,
      attempt,
      supersededBy: null,
      order: slot.order,
      manifestId: manifest.id,
      manifestDigest: digest,
      configurationId: config.id,
      harness: config.harness,
      transport: config.transport,
      runnerId: config.runner.id,
      runnerMode: config.runner.mode,
      suiteId: slot.suite.id,
      taskId: slot.task.spec.id,
      taskChecksum: slot.task.checksum,
      category: slot.ref.category ?? slot.task.spec.category,
      cluster: slot.ref.cluster ?? slot.task.spec.cluster,
      sealed: slot.task.sealed,
      memoryPromotionAllowed: memoryPromotionAllowed(slot.suite, slot.task),
      repeat: slot.repeat,
      termination: result.termination,
      terminationDetail: result.terminationDetail,
      grade,
      safety,
      outcome: classification.outcome,
      success: classification.success,
      reason: classification.reason,
      gradeValid: classification.gradeValid,
      usage,
      timings: { setupMs, agentMs: result.agentMs, captureMs, gradeMs, taskToArtifactMs, firstActionMs: result.firstActionMs },
      observedModel: result.observedModel,
      observedRunnerVersion: result.observedRunnerVersion,
      invocation: result.invocation,
      patch: { sha256: sha256Hex(patch), bytes: Buffer.byteLength(patch), changedPaths: patchPaths(patch) },
      artifactsDir: relative(outDir, trialOut),
      startedAt: startedIso,
      finishedAt: new Date().toISOString(),
      features: result.features ?? null,
    };
    await writeFile(join(trialOut, 'trajectory.json'), `${JSON.stringify(trajectory, null, 2)}\n`);
    const atif = toAtif({
      trajectoryId: trialId,
      agentName: config.harness === 'openlinear' ? `openlinear+${config.runner.id}` : config.runner.id,
      agentVersion: result.observedRunnerVersion ?? config.runner.binaryVersion,
      modelName: result.observedModel ?? (config.model.snapshot || config.model.requested),
      startedAt: startedIso,
      systemPrompt: config.harness === 'openlinear' ? input.systemContract : null,
      userPrompt: result.prompt ?? slot.task.instruction,
      events: result.events,
      usage,
      extra: { openlinear: { configurationId: config.id, outcome: classification.outcome, termination: result.termination, sealed: slot.task.sealed, fake: config.runner.mode === 'fake' } },
    });
    await writeFile(join(trialOut, 'trajectory.atif.json'), `${JSON.stringify(atif, null, 2)}\n`);
    await writeFile(join(trialOut, 'patch.diff'), patch);
    await writeFile(join(trialOut, 'logs.txt'), `${result.logs.join('\n')}\n`);
    await writeFile(join(trialOut, 'grade.json'), `${JSON.stringify(grade, null, 2)}\n`);
    await writeFile(join(trialOut, 'record.json'), `${JSON.stringify(record, null, 2)}\n`);
    if (!input.keepWorktrees) await rm(scratch, { recursive: true, force: true });
    observations.push({ configurationId: config.id, trialId, model: result.observedModel, runnerVersion: result.observedRunnerVersion });
    finished += 1;
    log(`[${finished}/${ordered.length}${attempt > 1 ? ` rerun ${attempt}` : ''}] ${config.id} ${slot.task.spec.id} r${slot.repeat} → ${record.outcome} (${taskToArtifactMs} ms)`);
    return record;
  };

  await pool(ordered, manifest.concurrency.maxConcurrentTrials, async (slot) => {
    let record = await runTrial(slot, 1);
    records.push(record);
    for (let attempt = 2; record.outcome === 'infra' && attempt <= manifest.retries.infraRetries + 1; attempt += 1) {
      const rerun = await runTrial(slot, attempt);
      record.supersededBy = rerun.trialId;
      await writeFile(join(outDir, record.artifactsDir, 'record.json'), `${JSON.stringify(record, null, 2)}\n`);
      records.push(rerun);
      record = rerun;
    }
  });
  records.sort((a, b) => a.order - b.order || a.attempt - b.attempt);

  const environment = await observeEnvironment();
  const drift = mergeDrift(manifest.drift, detectDrift({ manifest, environment, trials: observations, taskChecksums }));
  const report = buildReport({ manifest, records, gates, drift, wallClockMs: Date.now() - startedAt, notes: input.features && input.features !== 'recorded' ? input.features.notes : [] });
  const reportJsonPath = join(outDir, 'report.json');
  const reportMarkdownPath = join(outDir, 'report.md');
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify({ ...manifest, drift }, null, 2)}\n`);
  await writeFile(join(outDir, 'trials.jsonl'), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  await writeFile(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(reportMarkdownPath, renderMarkdown(report));
  return { outDir, report, records, reportJsonPath, reportMarkdownPath };
}
