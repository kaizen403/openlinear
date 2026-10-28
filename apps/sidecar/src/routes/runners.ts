import { Router, type NextFunction, type Request, type Response } from 'express';
import type { RunnerId } from '@openlinear/execution-core';
import { requireSidecarAuth } from '../auth/principal';
import { getRunnerCatalogueSnapshot } from '../runners/index';
import type { RunnerCatalogue, RunnerCatalogueEntry } from '../runners/catalogue';

/**
 * FE-02: `GET /api/runners` — the runner picker's source of truth on this
 * device: which agent runners are installed and signed in, their versions,
 * what they support, and whether the current execution engine can run them
 * (with the reason when not). Health checks are local and non-inference but
 * spawn processes, so the result is cached briefly; `?refresh=1` re-checks
 * (at most every few seconds).
 */

export const RUNNER_LABELS: Readonly<Record<RunnerId, string>> = {
  opencode: 'OpenCode',
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

const CACHE_MS = 30_000;
const MIN_REFRESH_MS = 5_000;

export interface RunnerPickerEntry {
  id: RunnerId;
  label: string;
  /** Installed and authenticated for the current sandbox mode. */
  available: boolean;
  /** The current engine can run it now. */
  executable: boolean;
  /** Why it can't run (shown next to the disabled option); null when executable. */
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

export interface RunnerPickerResponse {
  engine: 'v2' | 'legacy';
  defaultRunner: RunnerId;
  sandbox: RunnerCatalogue['sandbox'];
  runners: RunnerPickerEntry[];
  checkedAt: string;
}

function reasonFor(entry: RunnerCatalogueEntry, label: string, engine: 'v2' | 'legacy'): string | null {
  if (engine === 'legacy' && entry.id !== 'opencode') return 'The legacy execution engine runs OpenCode only';
  if (entry.available) return null;
  const auth = entry.health.auth?.status;
  if (auth === 'missing') return `Not signed in to ${label} on this device`;
  if (auth === 'unreachable-in-sandbox') return `Signed in, but the sandbox can't reach the ${label} login; add an API key or a trusted-host grant`;
  return entry.health.detail ?? `${label} isn't installed on this device`;
}

export function toPickerResponse(catalogue: RunnerCatalogue, engine: 'v2' | 'legacy', checkedAt: number): RunnerPickerResponse {
  return {
    engine,
    defaultRunner: 'opencode',
    sandbox: catalogue.sandbox,
    checkedAt: new Date(checkedAt).toISOString(),
    runners: catalogue.runners.map((entry) => {
      const label = RUNNER_LABELS[entry.id];
      const reason = reasonFor(entry, label, engine);
      return {
        id: entry.id,
        label,
        available: entry.available,
        executable: reason === null,
        reason,
        version: entry.health.version ?? null,
        auth: entry.health.auth?.status ?? null,
        features: entry.features
          ? { resume: entry.features.resume, approvals: entry.features.approvals, interrupt: entry.features.interrupt, modelDiscovery: entry.features.models.discovery }
          : null,
      };
    }),
  };
}

export function createRunnersRouter(deps: {
  catalogue?: () => Promise<RunnerCatalogue>;
  engine?: () => Promise<'v2' | 'legacy'>;
  now?: () => number;
} = {}): Router {
  const load = deps.catalogue ?? (() => getRunnerCatalogueSnapshot());
  // The v2 engine only runs with API persistence (`runEngineActive`), whatever the env selects.
  const engine = deps.engine ?? (async () => ((await import('../run/index')).runEngineActive() ? 'v2' as const : 'legacy' as const));
  const now = deps.now ?? Date.now;
  let cached: { at: number; value: RunnerCatalogue } | null = null;
  let inFlight: Promise<{ at: number; value: RunnerCatalogue }> | null = null;

  const fetchCatalogue = (force: boolean) => {
    const age = cached ? now() - cached.at : Number.POSITIVE_INFINITY;
    if (cached && (age < CACHE_MS && !force || age < MIN_REFRESH_MS)) return Promise.resolve(cached);
    if (!inFlight) {
      inFlight = load()
        .then((value) => {
          cached = { at: now(), value };
          return cached;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  };

  const router = Router();
  router.use(requireSidecarAuth);
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { at, value } = await fetchCatalogue(req.query.refresh === '1');
      res.setHeader('Cache-Control', 'no-store');
      res.json(toPickerResponse(value, await engine(), at));
    } catch (error) {
      next(error);
    }
  });
  return router;
}
