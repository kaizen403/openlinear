import express, { type NextFunction, type Request, type Response } from 'express';
import http, { type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createErrorHandler } from '../lib/errors';
import type { RunnerCatalogue } from '../runners/catalogue';

/**
 * FE-02: the runner picker's data — availability with a reason, versions and
 * features, what the current engine can run; health checks cached.
 */
vi.mock('../auth/principal', () => ({
  requireSidecarAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

const { createRunnersRouter } = await import('./runners');

const features = {
  resume: 'native-session' as const,
  interrupt: 'graceful-ack' as const,
  approvals: 'policy-only' as const,
  models: { discovery: 'none' as const, aliases: [], passthrough: true },
  maxContextTokens: null,
  usage: { cost: 'reported' as const, cacheSplit: true, reasoning: true, semantics: 'snapshot-per-message' as const },
  isolation: 'sandbox-provider-process' as const,
};
const capabilities = { streamingDeltas: true, reasoningDeltas: true, permissionReply: false, interrupt: true, compact: false, revert: false, fork: false, cacheSplitUsage: true };

function catalogue(): RunnerCatalogue {
  return {
    sandbox: { mode: 'enforce', verified: true, provider: 'seatbelt', blockers: [] },
    runners: [
      { id: 'opencode', capabilities, features, health: { ok: true, version: '1.2.3', auth: { status: 'ok' } }, available: true, legacyExecuteSupported: true },
      { id: 'claude-code', capabilities, features, health: { ok: false, version: '2.0.1', auth: { status: 'missing' } }, available: false, legacyExecuteSupported: false },
      { id: 'codex', capabilities, features: { ...features, approvals: 'interactive' }, health: { ok: true, version: '0.164.0', auth: { status: 'ok' } }, available: true, legacyExecuteSupported: false },
    ],
  } as RunnerCatalogue;
}

const state = { engine: 'v2' as 'v2' | 'legacy', clock: 1_000_000 };
const load = vi.fn(async () => catalogue());
let server: Server | undefined;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use('/api/runners', createRunnersRouter({ catalogue: load, engine: async () => state.engine, now: () => state.clock }));
  app.use(createErrorHandler());
  server = http.createServer(app);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

beforeEach(() => {
  state.engine = 'v2';
});

async function get(path = '/api/runners') {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe('FE-02 GET /api/runners', () => {
  it('lists every runner with availability, version, features and why one can\'t run', async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toMatchObject({ engine: 'v2', defaultRunner: 'opencode', sandbox: { provider: 'seatbelt', verified: true } });
    expect(body.runners).toEqual([
      expect.objectContaining({ id: 'opencode', label: 'OpenCode', available: true, executable: true, reason: null, version: '1.2.3', auth: 'ok' }),
      expect.objectContaining({ id: 'claude-code', label: 'Claude Code', available: false, executable: false, reason: 'Not signed in to Claude Code on this device', version: '2.0.1' }),
      expect.objectContaining({ id: 'codex', label: 'Codex', executable: true, features: { resume: 'native-session', approvals: 'interactive', interrupt: 'graceful-ack', modelDiscovery: 'none' } }),
    ]);
  });

  it('the legacy engine can only run OpenCode, and says so', async () => {
    state.engine = 'legacy';
    const { body } = await get();
    const runners = body.runners as Array<{ id: string; executable: boolean; reason: string | null }>;
    expect(runners.find((runner) => runner.id === 'codex')).toMatchObject({ executable: false, reason: 'The legacy execution engine runs OpenCode only' });
    expect(runners.find((runner) => runner.id === 'opencode')).toMatchObject({ executable: true });
  });

  it('caches health checks; refresh re-checks, but not more than every few seconds', async () => {
    load.mockClear();
    state.clock += 60_000;
    await get();
    await get();
    expect(load).toHaveBeenCalledTimes(1);
    await get('/api/runners?refresh=1');
    expect(load).toHaveBeenCalledTimes(1);
    state.clock += 6_000;
    await get('/api/runners?refresh=1');
    expect(load).toHaveBeenCalledTimes(2);
    state.clock += 31_000;
    await get();
    expect(load).toHaveBeenCalledTimes(3);
  });
});
