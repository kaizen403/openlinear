import { mkdtempSync, rmSync } from 'node:fs';
import http, { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type NextFunction, type Response } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthedRequest, SidecarPrincipal } from '../auth/principal';
import { createErrorHandler } from '../lib/errors';
import { setProviderFactoryForTests } from '../sandbox/provider';
import { configureTrustGrants, TrustGrantStore, trustGrantRuntime, type TrustGrantRuntime } from '../sandbox/trust-grants';
import type { CapabilityReport, SandboxProvider } from '../sandbox/types';
import type { SandboxGrantStatus } from './sandbox-grants';

/**
 * FE-03 routes: authenticated like every sidecar route, users only see and
 * revoke their own grants, creation is validated and only possible while
 * the sandbox is unavailable, with a session (not a PAT).
 */

// Bearer `<userId>` or `<userId>:pat` stands in for the control plane's principal lookup.
vi.mock('../auth/principal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth/principal')>();
  return {
    ...actual,
    requireSidecarAuth: (req: AuthedRequest, res: Response, next: NextFunction) => {
      const token = actual.bearerFrom(req);
      if (!token) {
        res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED', message: 'Authentication required' });
        return;
      }
      const [userId, source] = token.split(':');
      const principal: SidecarPrincipal = { userId: userId ?? '', authSource: source === 'pat' ? 'pat' : 'session', scopes: [], workspaceRestriction: null, tokenHash: 'h' };
      req.principal = principal;
      req.credential = { principal, token };
      req.userId = principal.userId;
      next();
    },
  };
});

const { createSandboxGrantsRouter, currentSandboxGrantStatus, defaultTrustGrantDir, installDefaultTrustGrants, toGrantView } = await import('./sandbox-grants');

const T0 = Date.parse('2026-10-27T10:00:00.000Z');
const state: { status: SandboxGrantStatus; now: number } = {
  status: { state: 'unavailable', provider: 'macos-seatbelt', blockers: ['sandbox-exec probe failed'], checkedAt: '2026-10-27T09:59:00.000Z', grantsApply: true },
  now: T0,
};
let root = '';
let runtime: TrustGrantRuntime;
let server: Server | undefined;
let base = '';

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'openlinear-grants-route-'));
  const app = express();
  app.use(express.json());
  app.use('/api/sandbox/grants', createSandboxGrantsRouter({ runtime: () => runtime, sandboxStatus: async () => state.status, now: () => state.now }));
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
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  runtime = {
    store: new TrustGrantStore(join(root, `grants-${Math.random().toString(16).slice(2)}`)),
    scope: () => null,
    runRoots: () => ['/repos/worktrees', '/repos/verify'],
  };
  state.status = { state: 'unavailable', provider: 'macos-seatbelt', blockers: ['sandbox-exec probe failed'], checkedAt: '2026-10-27T09:59:00.000Z', grantsApply: true };
  state.now = T0;
});

async function call(method: 'GET' | 'POST', path: string, options: { token?: string | null; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = options.token === undefined ? 'user-1' : options.token;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/api/sandbox/grants${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  return { status: res.status, body: await res.json() as Record<string, unknown>, headers: res.headers };
}

const valid = { projectId: 'proj-1', projectName: 'Alpha', reason: 'The sandbox broke after the OS update', hours: 24 };

describe('FE-03 /api/sandbox/grants', () => {
  it('requires authentication on every route', async () => {
    expect((await call('GET', '', { token: null })).status).toBe(401);
    expect((await call('POST', '', { token: null, body: valid })).status).toBe(401);
    expect((await call('POST', '/tg_0000000000000000/revoke', { token: null })).status).toBe(401);
  });

  it('creates a grant scoped to the project and the engine\'s checkout roots, then lists it with its audit', async () => {
    const created = await call('POST', '', { body: valid });
    expect(created.status).toBe(201);
    expect(created.body.grant).toMatchObject({
      id: expect.stringMatching(/^tg_/),
      projectId: 'proj-1',
      projectName: 'Alpha',
      reason: valid.reason,
      paths: ['/repos/verify', '/repos/worktrees'],
      createdAt: '2026-10-27T10:00:00.000Z',
      expiresAt: '2026-10-28T10:00:00.000Z',
      revokedAt: null,
    });
    const listed = await call('GET', '');
    expect(listed.status).toBe(200);
    expect(listed.headers.get('cache-control')).toBe('no-store');
    expect(listed.body).toMatchObject({
      sandbox: { state: 'unavailable', grantsApply: true },
      maxHours: 168,
      durations: [1, 24, 168],
      grants: [created.body.grant],
      audit: [expect.objectContaining({ event: 'created', grantId: (created.body.grant as { id: string }).id, actor: 'user-1' })],
      problem: null,
    });
    expect((listed.body.audit as Array<Record<string, unknown>>)[0]).not.toHaveProperty('owner');
  });

  it('validates the reason, the duration (at most 7 days) and the project', async () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ ...valid, reason: 'too short' }, /at least 10 characters/],
      [{ ...valid, reason: 'x'.repeat(501) }, /under 500 characters/],
      [{ ...valid, hours: 169 }, /at most 7 days/],
      [{ ...valid, hours: 0 }, /greater than or equal to 1/],
      [{ ...valid, hours: '24' }, /number/],
      [{ ...valid, projectId: '../../etc' }, /Choose a project/],
      [{ reason: valid.reason, hours: 1 }, /Required/],
      [{ ...valid, paths: ['/'] }, /Unrecognized key/],
    ];
    for (const [body, message] of cases) {
      const res = await call('POST', '', { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(String(res.body.message), JSON.stringify(body)).toMatch(message);
    }
    expect((await call('GET', '')).body.grants).toEqual([]);
  });

  it('refuses creation with a personal access token', async () => {
    const res = await call('POST', '', { token: 'user-1:pat', body: valid });
    expect(res).toMatchObject({ status: 403, body: { code: 'SESSION_REQUIRED' } });
  });

  it('refuses creation unless the sandbox is unavailable', async () => {
    const expectations: Array<[SandboxGrantStatus['state'], number, string]> = [
      ['verified', 409, 'TRUST_GRANT_NOT_NEEDED'],
      ['unknown', 503, 'SANDBOX_CHECK_PENDING'],
      ['env-grant', 409, 'TRUST_GRANT_NOT_APPLICABLE'],
      ['disabled', 409, 'TRUST_GRANT_NOT_APPLICABLE'],
      ['invalid', 409, 'TRUST_GRANT_NOT_APPLICABLE'],
    ];
    for (const [sandboxState, status, code] of expectations) {
      state.status = { ...state.status, state: sandboxState, grantsApply: false };
      const res = await call('POST', '', { body: valid });
      expect(res.status, sandboxState).toBe(status);
      expect(res.body.code, sandboxState).toBe(code);
    }
    expect(runtime.store.audit()).toEqual([]);
  });

  it('allows one active grant per project', async () => {
    expect((await call('POST', '', { body: valid })).status).toBe(201);
    expect(await call('POST', '', { body: valid })).toMatchObject({ status: 409, body: { code: 'TRUST_GRANT_EXISTS' } });
  });

  it('users only see and revoke their own grants', async () => {
    const mine = (await call('POST', '', { body: valid })).body.grant as { id: string };
    const theirs = (await call('POST', '', { token: 'user-2', body: { ...valid, projectName: 'Theirs' } })).body.grant as { id: string };
    const listed = await call('GET', '');
    expect((listed.body.grants as Array<{ id: string }>).map((grant) => grant.id)).toEqual([mine.id]);
    expect((listed.body.audit as Array<{ grantId: string }>).every((entry) => entry.grantId === mine.id)).toBe(true);
    expect(await call('POST', `/${theirs.id}/revoke`)).toMatchObject({ status: 404, body: { code: 'TRUST_GRANT_NOT_FOUND' } });
    expect(await call('POST', '/not-a-grant/revoke')).toMatchObject({ status: 404, body: { code: 'TRUST_GRANT_NOT_FOUND' } });
    state.now = T0 + 60_000;
    const revoked = await call('POST', `/${mine.id}/revoke`);
    expect(revoked).toMatchObject({ status: 200, body: { grant: { id: mine.id, revokedAt: '2026-10-27T10:01:00.000Z' } } });
    const after = await call('GET', '');
    expect(after.body.grants).toEqual([]);
    expect((after.body.audit as Array<{ event: string }>).map((entry) => entry.event)).toEqual(['revoked', 'created']);
    // Revoking is allowed even with a PAT (it only removes access), and is idempotent.
    expect((await call('POST', `/${mine.id}/revoke`, { token: 'user-1:pat' })).status).toBe(200);
    expect((await call('GET', '', { token: 'user-2' })).body.grants).toEqual([expect.objectContaining({ id: theirs.id })]);
  });

  it('lists only active grants: an expired grant drops out and its expiry shows in the audit', async () => {
    await call('POST', '', { body: { ...valid, hours: 1 } });
    state.now = T0 + 3_600_000;
    const listed = await call('GET', '');
    expect(listed.body.grants).toEqual([]);
    expect((listed.body.audit as Array<{ event: string }>).map((entry) => entry.event)).toEqual(['expired', 'created']);
  });

  it('shapes grants for the client', () => {
    const grant = runtime.store.create({ userId: 'u', projectId: 'p', reason: 'reason long enough', hours: 1, paths: ['/r'] }, T0);
    expect(Object.keys(toGrantView(grant)).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'lastUsedAt', 'paths', 'projectId', 'projectName', 'reason', 'revokedAt', 'useCount']);
  });
});

function fakeProvider(available: boolean | 'never'): SandboxProvider {
  const report = (ok: boolean): CapabilityReport => ({
    provider: 'linux-bubblewrap', providerVersion: '0.9', platform: 'linux', available: ok, checkedAt: '2026-10-27T10:00:00.000Z', durationMs: 1,
    enforced: { filesystem: ok, env: ok, network: ok, process: ok }, probes: [], blockers: ok ? [] : ['bwrap: setting up uid map: Permission denied'], warnings: [], unsupported: [],
  });
  return {
    id: 'linux-bubblewrap',
    proxyTransport: 'unix',
    unsupportedLimits: [],
    detect: async () => ({ ok: true, version: '0.9', blockers: [], warnings: [] }),
    preflight: () => (available === 'never' ? new Promise<CapabilityReport>(() => undefined) : Promise.resolve(report(available))),
    wrap: async () => {
      throw new Error('unused');
    },
  };
}

describe('sandbox state for the grants UI', () => {
  it('runs the preflight and reports verified / unavailable / turned off', async () => {
    setProviderFactoryForTests(() => fakeProvider(true));
    expect(await currentSandboxGrantStatus({})).toEqual({ state: 'verified', provider: 'linux-bubblewrap', blockers: [], checkedAt: '2026-10-27T10:00:00.000Z', grantsApply: false });
    setProviderFactoryForTests(() => fakeProvider(false));
    expect(await currentSandboxGrantStatus({})).toMatchObject({ state: 'unavailable', grantsApply: true, blockers: ['bwrap: setting up uid map: Permission denied'] });
    expect(await currentSandboxGrantStatus({ OPENLINEAR_SANDBOX_USER_GRANTS: '0' })).toMatchObject({ state: 'disabled', grantsApply: false });
    setProviderFactoryForTests(() => fakeProvider('never'));
    expect(await currentSandboxGrantStatus({}, 5)).toEqual({ state: 'unknown', provider: null, blockers: [], checkedAt: null, grantsApply: false });
    setProviderFactoryForTests(null);
  });

  it('reports an environment grant or an invalid mode without running the preflight', async () => {
    const grant = JSON.stringify({ actor: 'ops', reason: 'host mode for this box', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(await currentSandboxGrantStatus({ OPENLINEAR_SANDBOX_MODE: 'trusted-host', OPENLINEAR_SANDBOX_TRUSTED_HOST_GRANT: grant })).toMatchObject({ state: 'env-grant', grantsApply: false });
    expect(await currentSandboxGrantStatus({ OPENLINEAR_SANDBOX_MODE: 'off' })).toMatchObject({ state: 'invalid', blockers: [expect.stringMatching(/Unknown OPENLINEAR_SANDBOX_MODE/)] });
  });

  it('installs the device store once, under the sidecar app data directory', () => {
    const env = { OPENLINEAR_APP_DATA: join(root, 'app-data') };
    expect(defaultTrustGrantDir(env)).toBe(join(root, 'app-data', 'trust-grants'));
    configureTrustGrants(null);
    const installed = installDefaultTrustGrants(env);
    expect(installed.store.dir).toBe(join(root, 'app-data', 'trust-grants'));
    expect(trustGrantRuntime()).toBe(installed);
    expect(installDefaultTrustGrants({ OPENLINEAR_APP_DATA: join(root, 'other') })).toBe(installed);
    expect(installed.runRoots()).toHaveLength(2);
    expect(installed.scope(join(root, 'not-a-run'))).toBeNull();
    configureTrustGrants(null);
  });
});
