import { apiFetch } from './fetch';

/**
 * FE-02: the sidecar's runner catalogue (`GET /api/runners`): which agent
 * runners this device can run, their versions and features, and why one
 * can't. Shapes mirror `apps/sidecar/src/routes/runners.ts`.
 */

export type RunnerId = 'opencode' | 'claude-code' | 'codex';

export const RUNNER_IDS: readonly RunnerId[] = ['opencode', 'claude-code', 'codex'];

export const RUNNER_LABELS: Readonly<Record<RunnerId, string>> = {
  opencode: 'OpenCode',
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

export interface RunnerPickerEntry {
  id: RunnerId;
  label: string;
  available: boolean;
  executable: boolean;
  reason: string | null;
  version: string | null;
  auth: 'ok' | 'missing' | 'unreachable-in-sandbox' | 'unknown' | null;
  features: {
    resume: 'native-session' | 'none';
    approvals: 'interactive' | 'policy-only';
    interrupt: 'graceful-ack' | 'server-abort' | 'process-abort';
    modelDiscovery: 'live' | 'none';
  } | null;
}

export interface RunnerCatalogueResponse {
  engine: 'v2' | 'legacy';
  defaultRunner: RunnerId;
  sandbox: { mode: 'enforce' | 'trusted-host' | 'invalid'; verified: boolean | null; provider: string | null; blockers: string[] };
  runners: RunnerPickerEntry[];
  checkedAt: string;
}

export function isRunnerId(value: unknown): value is RunnerId {
  return typeof value === 'string' && (RUNNER_IDS as readonly string[]).includes(value);
}

export function fetchRunnerCatalogue(options: { refresh?: boolean } = {}): Promise<RunnerCatalogueResponse> {
  return apiFetch<RunnerCatalogueResponse>(`/api/runners${options.refresh ? '?refresh=1' : ''}`, { sidecar: true });
}
