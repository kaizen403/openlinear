import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runEvaluation, type RunEvaluationResult } from './harness';
import { type EvalManifest, EvalManifestSchema } from './manifest/schema';
import type { TrialRecord } from './records';
import { NativeCliRunner } from './runners/native/native-runner';
import { OpenLinearAdapterRunner } from './runners/openlinear-adapter';
import { ReplayAgentRunner } from './runners/replay-agent-runner';
import type { HarnessRunner } from './runners/types';
import type { LoadedTask } from './tasks/types';
import { parseTrajectory, type RecordedTrajectory } from './trajectory/types';

/**
 * Offline replay of a finished run: every trial's recorded trajectory is
 * replayed through the same harness (fresh checkout → runner → capture →
 * pristine-checkout grading → statistics). Replaying a funded run costs
 * nothing and must reproduce its outcome classes; a difference means the
 * harness, grader or task changed. API-transport trials carry no event
 * stream, so their replay reproduces the patch but not the termination.
 */

export function deriveReplayManifest(manifest: EvalManifest): EvalManifest {
  return EvalManifestSchema.parse({
    ...manifest,
    id: `${manifest.id}.replay`,
    title: `${manifest.title} (offline replay)`,
    purpose: 'smoke',
    track: 'deterministic-smoke',
    // Replays carry no real-time delays; a recorded timeout hangs until the watchdog, so keep it short.
    budgets: { ...manifest.budgets, agentTimeoutMs: Math.min(manifest.budgets.agentTimeoutMs, 3000) },
    configurations: manifest.configurations.map((config) => ({
      ...config,
      transport: config.transport === 'api' ? 'adapter' : config.transport,
      runner: { ...config.runner, mode: 'fake' },
    })),
    drift: [],
  });
}

const key = (configurationId: string, taskId: string, repeat: number, attempt: number) => `${configurationId}--${taskId}--r${repeat}--a${attempt}`;

/** Reads `<dir>/trials/<trial>/{record,trajectory}.json` (as written by `runEvaluation`). */
export async function loadRecordings(dir: string): Promise<Map<string, RecordedTrajectory>> {
  const trialsDir = existsSync(join(dir, 'trials')) ? join(dir, 'trials') : dir;
  const out = new Map<string, RecordedTrajectory>();
  for (const entry of await readdir(trialsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const recordPath = join(trialsDir, entry.name, 'record.json');
    const trajectoryPath = join(trialsDir, entry.name, 'trajectory.json');
    if (!existsSync(recordPath) || !existsSync(trajectoryPath)) continue;
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as Pick<TrialRecord, 'configurationId' | 'taskId' | 'repeat' | 'attempt'>;
    out.set(key(record.configurationId, record.taskId, record.repeat, record.attempt), parseTrajectory(JSON.parse(await readFile(trajectoryPath, 'utf8'))));
  }
  return out;
}

function recordingFor(recordings: Map<string, RecordedTrajectory>, trialId: string): RecordedTrajectory {
  const recording = recordings.get(trialId);
  if (!recording) throw new Error(`no recording for ${trialId}`);
  return recording;
}

export function replayRunners(manifest: EvalManifest, recordings: Map<string, RecordedTrajectory>): Map<string, HarnessRunner> {
  const runners = new Map<string, HarnessRunner>();
  for (const config of manifest.configurations) {
    const runnerId = config.runner.id;
    if (config.harness === 'native') {
      if (runnerId !== 'claude-code' && runnerId !== 'codex' && runnerId !== 'opencode') throw new Error(`${config.id}: no native replay for ${runnerId}`);
      runners.set(config.id, new NativeCliRunner({ runner: runnerId, mode: 'fake', killGraceMs: 500, pickRecording: (ctx) => recordingFor(recordings, ctx.trialId) }));
    } else {
      if (runnerId !== 'claude-code' && runnerId !== 'codex' && runnerId !== 'opencode') throw new Error(`${config.id}: no adapter replay for ${runnerId}`);
      const replay = new ReplayAgentRunner({ id: runnerId, version: config.runner.binaryVersion, pick: (start) => recordingFor(recordings, start.runId) });
      runners.set(config.id, new OpenLinearAdapterRunner({ runner: replay, fake: true, stopGraceMs: 500 }));
    }
  }
  return runners;
}

export async function replayEvaluation(input: {
  manifest: EvalManifest;
  tasks: readonly LoadedTask[];
  recordingsDir: string;
  outDir: string;
  systemContract: string;
  canaries?: readonly string[];
  onProgress?: (line: string) => void;
}): Promise<RunEvaluationResult & { manifest: EvalManifest }> {
  const manifest = deriveReplayManifest(input.manifest);
  const recordings = await loadRecordings(input.recordingsDir);
  const result = await runEvaluation({
    manifest,
    tasks: input.tasks,
    runners: replayRunners(manifest, recordings),
    outDir: input.outDir,
    systemContract: input.systemContract,
    canaries: input.canaries,
    onProgress: input.onProgress,
    // W21: a recorded trial already holds every session (run, reviewer, follow-up) and the prompt it was given.
    features: 'recorded',
  });
  return { ...result, manifest };
}
