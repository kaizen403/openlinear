import express from 'express';
import type http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCloudApiConfig } from '../config/cloud-api';
import {
  clearPrincipalCache,
  PRINCIPAL_CACHE_MAX,
  PRINCIPAL_CACHE_TTL_MS,
  principalCacheSize,
  requireSidecarAuth,
  validateBearer,
  type AuthedRequest,
} from './principal';

type Handler = (token: string) => Response | Promise<Response>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const principalBody = (userId: string, extra: Record<string, unknown> = {}) =>
  ({ userId, username: userId, authSource: 'session', scopes: [], workspaceId: null, ...extra });

let handler: Handler;
const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = String(input);
  expect(url).toBe('http://127.0.0.1:4599/api/executions/principal');
  const header = new Headers(init?.headers).get('Authorization') ?? '';
  return handler(header.replace(/^Bearer /, ''));
});

async function call(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = express();
  app.get(path, requireSidecarAuth, (req: AuthedRequest, res) => {
    res.json({ userId: req.userId, authSource: req.principal?.authSource, scopes: req.principal?.scopes, token: req.credential?.token });
  });
  const server = await new Promise<http.Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  try {
    const res = await fetch(`http://127.0.0.1:${address.port}${path}`, { headers });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('sidecar principal validation (W03a)', () => {
  beforeEach(() => {
    clearPrincipalCache();
    fetchMock.mockClear();
    handler = (token) => jsonResponse(200, principalBody(`user-for-${token}`));
    setCloudApiConfig({ baseUrl: 'http://127.0.0.1:4599', fetch: fetchMock as unknown as typeof fetch });
  });

  afterEach(() => {
    vi.useRealTimers();
    setCloudApiConfig(null);
  });

  it('refuses requests without a bearer token before calling the control plane', async () => {
    const res = await call('/probe');
    expect(res).toEqual({ status: 401, body: expect.objectContaining({ code: 'UNAUTHORIZED', error: 'Authentication required' }) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('attaches the control-plane principal and its credential', async () => {
    const res = await call('/probe', { Authorization: 'Bearer token-a' });
    expect(res).toEqual({ status: 200, body: { userId: 'user-for-token-a', authSource: 'session', scopes: [], token: 'token-a' } });
  });

  it('accepts PATs exactly as the control plane validates them (scopes and workspace binding kept)', async () => {
    handler = () => jsonResponse(200, principalBody('pat-user', { authSource: 'pat', scopes: ['tasks:write'], workspaceId: 'ws-1' }));
    const principal = await validateBearer('ol_pat_0123456789abcdef0123456789abcdef');
    expect(principal).toMatchObject({ userId: 'pat-user', authSource: 'pat', scopes: ['tasks:write'], workspaceRestriction: 'ws-1' });
    expect(principal.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('passes a 401 through and never caches a negative answer', async () => {
    handler = () => jsonResponse(401, { error: 'Session has been revoked', code: 'SESSION_REVOKED', message: 'Session has been revoked' });
    const first = await call('/probe', { Authorization: 'Bearer revoked' });
    const second = await call('/probe', { Authorization: 'Bearer revoked' });
    expect(first).toEqual({ status: 401, body: expect.objectContaining({ code: 'SESSION_REVOKED' }) });
    expect(second.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(principalCacheSize()).toBe(0);
  });

  it('fails closed with 503 (not 401) when the control plane is unreachable or failing', async () => {
    handler = () => { throw new TypeError('fetch failed: ECONNREFUSED'); };
    const unreachable = await call('/probe', { Authorization: 'Bearer token-b' });
    expect(unreachable).toEqual({ status: 503, body: expect.objectContaining({ code: 'CLOUD_API_UNREACHABLE' }) });
    handler = () => jsonResponse(502, { error: 'bad gateway' });
    const failing = await call('/probe', { Authorization: 'Bearer token-b' });
    expect(failing).toEqual({ status: 503, body: expect.objectContaining({ code: 'CLOUD_API_UNREACHABLE' }) });
    expect(principalCacheSize()).toBe(0);
  });

  it('refuses everything when no OPENLINEAR_API_URL is configured', async () => {
    setCloudApiConfig(null);
    const res = await call('/probe', { Authorization: 'Bearer token-c' });
    expect(res).toEqual({ status: 503, body: expect.objectContaining({ code: 'CLOUD_API_NOT_CONFIGURED' }) });
  });

  it('caches a positive answer by token hash for at most the TTL (<= 60 s)', async () => {
    expect(PRINCIPAL_CACHE_TTL_MS).toBeLessThanOrEqual(60_000);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-25T00:00:00Z'));
    await validateBearer('cached-token');
    await validateBearer('cached-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(Date.now() + PRINCIPAL_CACHE_TTL_MS + 1));
    await validateBearer('cached-token');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares one control-plane call between concurrent validations of a token', async () => {
    let release: () => void = () => undefined;
    handler = (token) => new Promise((resolve) => { release = () => resolve(jsonResponse(200, principalBody(`u-${token}`))); });
    const pending = Promise.all([validateBearer('same'), validateBearer('same'), validateBearer('same')]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    release();
    const results = await pending;
    expect(results.map((principal) => principal.userId)).toEqual(['u-same', 'u-same', 'u-same']);
  });

  it('bounds the cache', async () => {
    for (let index = 0; index < PRINCIPAL_CACHE_MAX + 5; index += 1) await validateBearer(`token-${index}`);
    expect(principalCacheSize()).toBe(PRINCIPAL_CACHE_MAX);
  });

  it('rejects a malformed principal response as unavailable', async () => {
    handler = () => jsonResponse(200, { nope: true });
    await expect(validateBearer('weird')).rejects.toMatchObject({ statusCode: 503, code: 'CLOUD_API_UNREACHABLE' });
  });
});
