import type { AgentRunner, RunnerCapabilities, RunnerFeatures, RunnerHealth, RunnerId } from '@openlinear/execution-core';
import { resolveSandboxMode } from '../sandbox/mode';
import { getLastCapabilityReport } from '../sandbox/provider';

/**
 * W07: read-only runner catalogue for a future UI picker. No route is added
 * here (W03a owns sidecar routes); a route only has to return this value.
 * Health checks are local and non-inference (binary, version, login status).
 */
export interface RunnerCatalogueEntry {
  id: RunnerId;
  capabilities: RunnerCapabilities;
  features: RunnerFeatures | null;
  health: RunnerHealth;
  /** The runtime is installed and authenticated for this sandbox mode (health.ok). */
  available: boolean;
  /**
   * Whether the legacy execute route can run it today. Only OpenCode: native
   * routing through the run service is W05/W07 integration.
   */
  legacyExecuteSupported: boolean;
}

export interface SandboxSummary {
  mode: 'enforce' | 'trusted-host' | 'invalid';
  /** From the last cached preflight; null when none ran yet in this process. */
  verified: boolean | null;
  provider: string | null;
  blockers: string[];
}

export interface RunnerCatalogue {
  /** Every runner needs this: enforce mode fails closed without a verified provider. */
  sandbox: SandboxSummary;
  runners: RunnerCatalogueEntry[];
}

const HEALTH_TIMEOUT_MS = 20_000;

async function boundedHealth(runner: AgentRunner, timeoutMs: number): Promise<RunnerHealth> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      runner.healthCheck(),
      new Promise<RunnerHealth>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, detail: `health check timed out after ${timeoutMs}ms` }), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : 'health check failed' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function sandboxSummary(env: NodeJS.ProcessEnv = process.env): SandboxSummary {
  let mode: SandboxSummary['mode'];
  const blockers: string[] = [];
  try {
    mode = resolveSandboxMode(env).mode;
  } catch (err) {
    mode = 'invalid';
    blockers.push(err instanceof Error ? err.message : 'invalid sandbox mode');
  }
  const report = getLastCapabilityReport();
  return {
    mode,
    verified: report ? report.available : null,
    provider: report && report.provider !== 'none' ? report.provider : null,
    blockers: [...blockers, ...(report?.blockers ?? [])],
  };
}

export async function getRunnerCatalogue(
  runners: Iterable<AgentRunner>,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RunnerCatalogue> {
  const list = [...runners];
  const health = await Promise.all(list.map((runner) => boundedHealth(runner, options.timeoutMs ?? HEALTH_TIMEOUT_MS)));
  return {
    sandbox: sandboxSummary(options.env),
    runners: list.map((runner, index) => ({
      id: runner.id,
      capabilities: runner.capabilities,
      features: runner.features ?? null,
      health: health[index],
      available: health[index].ok,
      legacyExecuteSupported: runner.id === 'opencode',
    })),
  };
}
