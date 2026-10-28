import { featureProblems } from './features/support';
import { sessionsPerTrial } from './features/types';
import type { EvalManifest } from './manifest/schema';
import { findFloatingRefs } from './manifest/resolve';
import { loadRunnerAdapter } from './runners/adapter-loader';
import { NativeCliRunner } from './runners/native/native-runner';
import { OpenLinearAdapterRunner } from './runners/openlinear-adapter';
import { bareOriginHarvester, bareOriginPreparer, OpenLinearApiRunner } from './runners/openlinear-api';
import type { HarnessRunner } from './runners/types';

/**
 * Wiring for a FUNDED run on the private holdout (real runners, real
 * inference). Nothing here runs by default: the CLI refuses without
 * `--confirm-spend`, refuses unfrozen manifests, and real native CLIs need
 * `--allow-real` (they must run inside an external sandbox). Credentials are
 * read from named environment variables at run time and passed per run;
 * they are never written to manifests, records or logs.
 */

export interface FundedRunOptions {
  /** Module exporting `pickRunner`/`createEvalRunner` (e.g. apps/sidecar/src/runners/index.ts) for openlinear/adapter configurations. */
  adapterModule?: string;
  allowRealNative: boolean;
  /** Environment variable names whose values are passed to runners as per-run credentials. */
  credentialEnv: readonly string[];
  api?: { apiUrl: string; sidecarUrl: string; tokenEnv: string; projectId: string; teamId?: string; originPath: string };
}

export interface FundedRunPlan {
  trials: number;
  /** Every session of every trial stopping at the per-task USD cap, plus headroom (null when no cap is set). */
  worstCaseUsd: number | null;
  /** Per configuration: trials, agent sessions per trial (W21 reviewer arms start up to 3) and worst case. */
  configurations: Array<{ id: string; trials: number; sessionsPerTrial: number; worstCaseUsd: number | null }>;
  problems: string[];
}

export function planFundedRun(manifest: EvalManifest): FundedRunPlan {
  const tasks = manifest.suites.reduce((n, suite) => n + suite.tasks.length, 0);
  const perConfiguration = tasks * manifest.repeats;
  const trials = perConfiguration * manifest.configurations.length;
  const cap = manifest.budgets.maxUsdPerTask;
  const headroom = 1 + manifest.budgets.headroomPct / 100;
  // The sessions of a trial share the per-task cap when their cost is reported; a runner that reports
  // no cost cannot be held to a shared cap from outside, so the bound counts every session at the cap.
  const configurations = manifest.configurations.map((config) => {
    const sessions = sessionsPerTrial(config);
    return { id: config.id, trials: perConfiguration, sessionsPerTrial: sessions, worstCaseUsd: cap === null ? null : perConfiguration * sessions * cap * headroom };
  });
  const problems: string[] = [];
  if (manifest.purpose === 'smoke') problems.push('smoke manifests run offline (use `smoke` or `replay`), not as funded runs');
  for (const ref of findFloatingRefs(manifest)) problems.push(`floating reference ${ref.field}: ${ref.reason}`);
  problems.push(...featureProblems(manifest));
  if (cap === null) problems.push('no per-task USD cap (budgets.maxUsdPerTask): the spend ceiling is unbounded');
  for (const config of manifest.configurations) {
    if (!manifest.prices.some((p) => p.provider === config.model.provider && p.model === config.model.snapshot)) {
      problems.push(`${config.id}: no price entry for ${config.model.provider}/${config.model.snapshot}; runs without runner-reported cost will be "unknown"`);
    }
  }
  return { trials, worstCaseUsd: cap === null ? null : configurations.reduce((sum, c) => sum + (c.worstCaseUsd ?? 0), 0), configurations, problems };
}

function credentials(names: readonly string[]): () => Record<string, string> {
  return () => {
    const out: Record<string, string> = {};
    for (const name of names) {
      const value = process.env[name];
      if (value) out[name] = value;
    }
    return out;
  };
}

export async function buildFundedRunners(manifest: EvalManifest, options: FundedRunOptions): Promise<Map<string, HarnessRunner>> {
  const runners = new Map<string, HarnessRunner>();
  for (const config of manifest.configurations) {
    if (config.runner.mode !== 'real') throw new Error(`${config.id}: funded runs use real runners only`);
    const runnerId = config.runner.id;
    if (config.harness === 'native') {
      if (runnerId !== 'claude-code' && runnerId !== 'codex' && runnerId !== 'opencode') throw new Error(`${config.id}: no native CLI driver for ${runnerId} (Devin CLI etc. run through Harbor)`);
      runners.set(config.id, new NativeCliRunner({ runner: runnerId, mode: 'real', allowRealExecution: options.allowRealNative, credentials: credentials(options.credentialEnv) }));
    } else if (config.transport === 'adapter') {
      if (!options.adapterModule) throw new Error(`${config.id}: --adapter-module is required for openlinear/adapter configurations`);
      const adapter = await loadRunnerAdapter(options.adapterModule, runnerId);
      runners.set(config.id, new OpenLinearAdapterRunner({ runner: adapter, fake: false, credentials: credentials(options.credentialEnv) }));
    } else {
      const api = options.api;
      if (!api) throw new Error(`${config.id}: --api-url/--sidecar-url/--token-env/--project-id/--origin are required for openlinear/api configurations`);
      if (manifest.concurrency.maxConcurrentTrials !== 1) throw new Error(`${config.id}: the api transport shares one origin; set concurrency.maxConcurrentTrials to 1`);
      runners.set(
        config.id,
        new OpenLinearApiRunner({
          apiUrl: api.apiUrl,
          sidecarUrl: api.sidecarUrl,
          token: () => {
            const token = process.env[api.tokenEnv];
            if (!token) throw new Error(`${api.tokenEnv} is not set`);
            return token;
          },
          projectId: api.projectId,
          teamId: api.teamId,
          prepareOrigin: bareOriginPreparer(api.originPath),
          harvest: bareOriginHarvester(api.originPath),
        }),
      );
    }
  }
  return runners;
}
