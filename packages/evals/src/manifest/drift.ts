import { arch, cpus, platform, release, totalmem } from 'node:os';
import { gitVersion } from '../util/git';
import type { DriftNotice, EvalManifest } from './schema';

/** What the harness actually observed on this host / in these trials. */
export interface ObservedEnvironment {
  node: string;
  git: string | null;
  os: string;
  arch: string;
  cpus: number;
  memoryMb: number;
}

/** Per-trial facts reported by runners, compared against the frozen configuration. */
export interface TrialObservation {
  configurationId: string;
  trialId: string;
  /** Model id the runner reported (null when the runner does not report one). */
  model: string | null;
  runnerVersion: string | null;
}

export async function observeEnvironment(): Promise<ObservedEnvironment> {
  return {
    node: process.versions.node,
    git: await gitVersion(),
    os: `${platform()} ${release()}`,
    arch: arch() === 'arm64' ? 'arm64' : arch() === 'x64' ? 'x64' : arch(),
    cpus: cpus().length,
    memoryMb: Math.round(totalmem() / (1024 * 1024)),
  };
}

function notice(field: string, expected: string, observed: string, severity: DriftNotice['severity'], at: string, note = ''): DriftNotice {
  return { field, expected, observed, severity, detectedAt: at, note };
}

export interface DriftInput {
  manifest: EvalManifest;
  environment: ObservedEnvironment;
  trials?: TrialObservation[];
  /** Task id → checksum recomputed from the task files at run time. */
  taskChecksums?: Map<string, string>;
  now?: Date;
}

/**
 * Compares the frozen manifest with what was observed. `blocking` drift
 * (task content, runner version, model snapshot) invalidates comparison with
 * results produced under the original manifest; `warning` drift (toolchain,
 * hardware) must be disclosed; `info` is advisory (stale prices).
 */
export function detectDrift(input: DriftInput): DriftNotice[] {
  const { manifest, environment } = input;
  const at = (input.now ?? new Date()).toISOString();
  const out: DriftNotice[] = [];

  const majorMinor = (v: string) => v.replace(/^v/, '').split('.').slice(0, 2).join('.');
  if (majorMinor(manifest.toolchain.node) !== majorMinor(environment.node)) {
    out.push(notice('/toolchain/node', manifest.toolchain.node, environment.node, 'warning', at));
  }
  if (environment.git !== null && manifest.toolchain.git !== environment.git) {
    out.push(notice('/toolchain/git', manifest.toolchain.git, environment.git, 'warning', at));
  }
  if (manifest.hardware.arch !== environment.arch) {
    out.push(notice('/hardware/arch', manifest.hardware.arch, environment.arch, 'warning', at, 'architecture changes timing and can change task behaviour (emulation)'));
  }
  if (manifest.hardware.resourcePolicy === 'none') {
    if (manifest.hardware.cpus !== environment.cpus) out.push(notice('/hardware/cpus', String(manifest.hardware.cpus), String(environment.cpus), 'warning', at));
    const ratio = environment.memoryMb / manifest.hardware.memoryMb;
    if (ratio < 0.9 || ratio > 1.1) out.push(notice('/hardware/memoryMb', String(manifest.hardware.memoryMb), String(environment.memoryMb), 'warning', at));
  }

  if (input.taskChecksums) {
    for (const suite of manifest.suites) {
      for (const task of suite.tasks) {
        const observed = input.taskChecksums.get(task.id);
        if (observed === undefined) {
          out.push(notice(`/suites/${suite.id}/tasks/${task.id}/checksum`, task.checksum, '(missing)', 'blocking', at, 'task not found'));
        } else if (observed !== task.checksum) {
          out.push(notice(`/suites/${suite.id}/tasks/${task.id}/checksum`, task.checksum, observed, 'blocking', at, 'task definition changed after the manifest was frozen'));
        }
      }
    }
  }

  const configs = new Map(manifest.configurations.map((config) => [config.id, config]));
  const seen = new Set<string>();
  for (const trial of input.trials ?? []) {
    const config = configs.get(trial.configurationId);
    if (!config) continue;
    if (trial.model !== null && trial.model !== config.model.snapshot && config.model.routing === 'fixed') {
      const key = `${config.id}/model/${trial.model}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(notice(`/configurations/${config.id}/model/snapshot`, config.model.snapshot, trial.model, 'blocking', at, `runner reported a different model (first seen in ${trial.trialId})`));
      }
    }
    if (trial.runnerVersion !== null && trial.runnerVersion !== config.runner.binaryVersion) {
      const key = `${config.id}/runner/${trial.runnerVersion}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(notice(`/configurations/${config.id}/runner/binaryVersion`, config.runner.binaryVersion, trial.runnerVersion, 'blocking', at, `first seen in ${trial.trialId}`));
      }
    }
  }
  for (const config of manifest.configurations) {
    const reports = (input.trials ?? []).filter((trial) => trial.configurationId === config.id);
    if (reports.length > 0 && reports.every((trial) => trial.model === null)) {
      out.push(notice(`/configurations/${config.id}/model/snapshot`, config.model.snapshot, '(not reported)', 'info', at, 'runner does not report the model it used; snapshot is unverifiable from the trajectory'));
    }
  }

  const nowMs = (input.now ?? new Date()).getTime();
  for (const price of manifest.prices) {
    const ageDays = (nowMs - Date.parse(`${price.asOf}T00:00:00Z`)) / 86_400_000;
    if (ageDays > 30) {
      out.push(notice(`/prices/${price.provider}/${price.model}`, price.asOf, `${Math.floor(ageDays)} days old`, 'info', at, 're-check list prices before reporting cost'));
    }
  }
  return out;
}

/** Retains previously recorded notices and appends new, distinct ones. */
export function mergeDrift(existing: readonly DriftNotice[], next: readonly DriftNotice[]): DriftNotice[] {
  const key = (n: DriftNotice) => `${n.field}\u0000${n.expected}\u0000${n.observed}`;
  const known = new Set(existing.map(key));
  return [...existing, ...next.filter((n) => !known.has(key(n)))];
}
