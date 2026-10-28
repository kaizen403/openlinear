import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, deriveIdempotencyKey } from '../src/mcp/idempotency';
import { chunkTasks } from '../src/mcp/tools/plan';
import { envelope } from './fake-api';
import { connectClient, type Harness, seedBasics, startHarness, type TestClient } from './harness';
import { field, list, ok, str } from './helpers';

/** apps/api/src/schemas/idempotency.ts */
const API_KEY_CONTRACT = /^[A-Za-z0-9._:~+/=-]{8,128}$/;

describe('idempotency key derivation', () => {
  it('produces keys that satisfy the API contract and ignore key order', async () => {
    const a = await deriveIdempotencyKey('openlinear_create_issue', 'issue', { title: 'x', projectId: 'p', labelIds: ['b', 'a'] });
    const b = await deriveIdempotencyKey('openlinear_create_issue', 'issue', { labelIds: ['b', 'a'], projectId: 'p', title: 'x' });
    expect(a).toBe(b);
    expect(a).toMatch(API_KEY_CONTRACT);
    expect(a).toMatch(/^mcp1\.issue\.[0-9a-f]{64}$/);
    const longest = await deriveIdempotencyKey('openlinear_bulk_create_plan', 'plan.phase.10.99', {});
    expect(longest).toMatch(API_KEY_CONTRACT);
  });

  it('changes with the arguments, the step and the tool', async () => {
    const base = await deriveIdempotencyKey('t', 'issue', { title: 'x' });
    expect(await deriveIdempotencyKey('t', 'issue', { title: 'y' })).not.toBe(base);
    expect(await deriveIdempotencyKey('t', 'other', { title: 'x' })).not.toBe(base);
    expect(await deriveIdempotencyKey('u', 'issue', { title: 'x' })).not.toBe(base);
    // Array order is meaningful; undefined members are dropped like JSON does.
    expect(await deriveIdempotencyKey('t', 'issue', { title: 'x', description: undefined })).toBe(base);
    expect(canonicalJson({ b: [2, 1], a: { d: 1, c: null } })).toBe('{"a":{"c":null,"d":1},"b":[2,1]}');
    await expect(deriveIdempotencyKey('t', 'Bad Step', {})).rejects.toThrow();
  });

  it('splits large phases into API-sized chunks', () => {
    const tasks = Array.from({ length: 50 }, (_, index) => ({ title: `Task ${index}`, description: 'd'.repeat(9_000) }));
    const chunks = chunkTasks(tasks);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.flat()).toEqual(tasks);
    for (const chunk of chunks) expect(new TextEncoder().encode(JSON.stringify(chunk)).length).toBeLessThan(210_000);
    expect(chunkTasks(tasks.slice(0, 3).map((task) => ({ title: task.title })))).toHaveLength(1);
  });
});

describe('safe retries against the API', () => {
  let harness: Harness;
  let seed: ReturnType<typeof seedBasics>;
  let legacy: TestClient;
  let modern: TestClient;

  beforeAll(async () => {
    harness = await startHarness();
    seed = seedBasics(harness.api);
    legacy = await connectClient('v1-legacy', harness.mcpUrl, seed.token);
    modern = await connectClient('v2-modern', harness.mcpUrl, seed.token);
  });
  afterAll(async () => {
    await legacy.close();
    await modern.close();
    await harness.stop();
  });
  afterEach(() => {
    harness.api.failures.splice(0);
  });

  const tasksTitled = (title: string) => [...harness.api.tasks.values()].filter((task) => task.title === title);

  it('a retried create_issue (new connection, new JSON-RPC id, other protocol era) returns the original issue', async () => {
    const args = { projectId: seed.project.id, title: 'Retry me', description: 'Once only', priority: 'high' };
    const first = ok(await legacy.call('openlinear_create_issue', args));
    const second = ok(await modern.call('openlinear_create_issue', { ...args }));
    expect(field(second, 'issue', 'id')).toBe(field(first, 'issue', 'id'));
    expect(field(first, 'idempotency', 'replayed')).toBe(false);
    expect(field(second, 'idempotency', 'replayed')).toBe(true);
    expect(field(second, 'idempotency', 'key')).toBe(field(first, 'idempotency', 'key'));
    expect(tasksTitled('Retry me')).toHaveLength(1);
    const sent = harness.api.callsTo('POST', /^\/api\/tasks$/).map((request) => request.headers['idempotency-key']);
    expect(sent.slice(-2)).toEqual([str(first, 'idempotency', 'key'), str(first, 'idempotency', 'key')]);
  });

  it('different arguments create a different issue', async () => {
    ok(await legacy.call('openlinear_create_issue', { projectId: seed.project.id, title: 'Variant', priority: 'low' }));
    ok(await legacy.call('openlinear_create_issue', { projectId: seed.project.id, title: 'Variant', priority: 'high' }));
    expect(tasksTitled('Variant')).toHaveLength(2);
  });

  it('a new idempotencyKey deliberately creates another identical issue; reusing it replays', async () => {
    const args = { projectId: seed.project.id, title: 'Twin' };
    ok(await legacy.call('openlinear_create_issue', args));
    const twin = ok(await legacy.call('openlinear_create_issue', { ...args, idempotencyKey: 'second-twin' }));
    const again = ok(await legacy.call('openlinear_create_issue', { ...args, idempotencyKey: 'second-twin' }));
    expect(tasksTitled('Twin')).toHaveLength(2);
    expect(field(again, 'issue', 'id')).toBe(field(twin, 'issue', 'id'));
    expect(field(again, 'idempotency', 'replayed')).toBe(true);
  });

  it('create_project and create_team send transactional keys, so retries return the same row', async () => {
    const first = ok(await legacy.call('openlinear_create_project', { name: 'Keyed project' }));
    const second = ok(await modern.call('openlinear_create_project', { name: 'Keyed project' }));
    expect(field(second, 'project', 'id')).toBe(field(first, 'project', 'id'));
    expect(field(second, 'idempotency', 'replayed')).toBe(true);
    expect([...harness.api.projects.values()].filter((p) => p.name === 'Keyed project')).toHaveLength(1);
    const projectId = str(first, 'project', 'id');
    const team = ok(await legacy.call('openlinear_create_team', { projectId, name: 'Keyed team', key: 'KEY' }));
    const teamAgain = ok(await legacy.call('openlinear_create_team', { projectId, name: 'Keyed team', key: 'KEY' }));
    expect(field(teamAgain, 'team', 'id')).toBe(field(team, 'team', 'id'));
    expect(field(teamAgain, 'idempotency', 'replayed')).toBe(true);
  });

  it('retries a keyed project create on a gateway error with the same key (W04b routes are transactional)', async () => {
    harness.api.fail({ method: 'POST', path: /^\/api\/projects$/, status: 503, rawBody: '<html>busy</html>' });
    const before = harness.api.callsTo('POST', /^\/api\/projects$/).length;
    const created = ok(await legacy.call('openlinear_create_project', { name: 'Retried project' }));
    const calls = harness.api.callsTo('POST', /^\/api\/projects$/).slice(before);
    expect(calls.map((call) => call.status)).toEqual([503, 201]);
    expect(calls[0]?.headers['idempotency-key']).toBe(calls[1]?.headers['idempotency-key']);
    expect(field(created, 'idempotency', 'replayed')).toBe(false);
    expect([...harness.api.projects.values()].filter((p) => p.name === 'Retried project')).toHaveLength(1);
  });

  const plan = {
    project: { name: 'Stripe Billing', key: 'BILL' },
    phases: [
      { name: 'Foundation', tasks: [{ title: 'Stripe keys', priority: 'high' }, { title: 'SDK config' }] },
      { name: 'Checkout', tasks: [{ title: 'Pricing page' }, { title: 'Checkout session' }, { title: 'Webhook' }] },
      { name: 'Portal', tasks: [{ title: 'Customer portal' }] },
    ],
  };

  it('bulk_create_plan reports exactly what a partial failure created, and a retry finishes without duplicates', async () => {
    // Phase 1 succeeds, phase 2 fails with 500 (rolled back by the API), phase 3 succeeds.
    harness.api.fail({
      method: 'POST',
      path: /^\/api\/tasks\/bulk$/,
      status: 500,
      after: 1,
      body: envelope('INTERNAL_ERROR', 'Internal server error'),
    });
    const partialRun = legacy.call('openlinear_bulk_create_plan', plan);
    const partial = ok(await partialRun);

    expect(field(partial, 'status')).toBe('partial');
    expect(str(partial, 'summary')).toContain('PARTIAL');
    expect(str(partial, 'summary')).toContain('identical arguments within 24 hours');
    const phases = list(partial, 'phases');
    expect(field(phases, 0, 'taskCount')).toBe(2);
    expect(field(phases, 1, 'taskCount')).toBe(0);
    expect(str(phases, 1, 'error')).toContain('OpenLinear API error 500');
    expect(field(phases, 1, 'labelName')).toBe('phase:2 — Checkout');
    expect(field(phases, 2, 'taskCount')).toBe(1);
    expect(field(partial, 'totalTasks')).toBe(3);

    const projectId = str(partial, 'projectId');
    const tasksInProject = () => [...harness.api.tasks.values()].filter((task) => task.projectId === projectId);
    expect(tasksInProject()).toHaveLength(3);

    const retry = ok(await legacy.call('openlinear_bulk_create_plan', plan));
    expect(field(retry, 'status')).toBe('complete');
    expect(field(retry, 'projectId')).toBe(projectId);
    expect(field(retry, 'idempotency', 'replayed')).toBe(true);
    const retried = list(retry, 'phases');
    expect(field(retried, 0, 'replayed')).toBe(true);
    expect(field(retried, 0, 'labelReused')).toBe(true);
    expect(field(retried, 1, 'replayed')).toBe(false);
    expect(field(retried, 2, 'replayed')).toBe(true);
    expect(field(retry, 'totalTasks')).toBe(6);
    expect(tasksInProject()).toHaveLength(6);
    expect(field(retried, 0, 'taskIds')).toEqual(field(phases, 0, 'taskIds'));

    const once = ok(await legacy.call('openlinear_bulk_create_plan', plan));
    expect(field(once, 'status')).toBe('complete');
    expect(tasksInProject()).toHaveLength(6);
    const labels = [...harness.api.labels.values()].filter((label) => label.projectId === projectId);
    expect(new Set(labels.map((label) => label.name)).size).toBe(labels.length);
    expect([...harness.api.projects.values()].filter((p) => p.key === 'BILL')).toHaveLength(1);
  });

  it('after the 24 h idempotency window, a repeated plan builds a complete new project (no 409s)', async () => {
    const args = {
      project: { name: 'Late retry' },
      phases: [{ name: 'Only', tasks: [{ title: 'late a' }, { title: 'late b' }] }],
    };
    const first = ok(await legacy.call('openlinear_bulk_create_plan', args));
    expect(str(first, 'summary')).not.toContain('PARTIAL');
    harness.api.expireIdempotency();
    const later = ok(await legacy.call('openlinear_bulk_create_plan', args));
    expect(field(later, 'projectId')).not.toBe(field(first, 'projectId'));
    expect(field(later, 'status')).toBe('complete');
    expect(field(later, 'totalTasks')).toBe(2);
  });

  it('bulk_create_plan sends one deterministic key per phase chunk', async () => {
    const result = ok(
      await legacy.call('openlinear_bulk_create_plan', {
        project: { name: 'Chunky', key: 'CHK' },
        phases: [
          {
            name: 'Big',
            tasks: Array.from({ length: 50 }, (_, index) => ({ title: `Big ${index}`, description: 'x'.repeat(9_000) })),
          },
        ],
      }),
    );
    expect(field(result, 'totalTasks')).toBe(50);
    const projectId = str(result, 'projectId');
    const keys = harness.api
      .callsTo('POST', /^\/api\/tasks\/bulk$/)
      .filter((request) => field(request.body, 'projectId') === projectId)
      .map((request) => request.headers['idempotency-key'] ?? '');
    expect(keys.length).toBeGreaterThan(2);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^mcp1\.plan\.phase\.1\.\d+\.[0-9a-f]{64}$/);
  });

  it('bulk_create_plan skips the remaining phases after a rate limit', async () => {
    harness.api.fail({
      method: 'POST',
      path: /^\/api\/tasks\/bulk$/,
      status: 429,
      body: envelope('RATE_LIMITED', 'Too many requests', { scope: 'default', retryAfterSeconds: 60 }),
    });
    const result = ok(
      await legacy.call('openlinear_bulk_create_plan', {
        project: { name: 'Throttled', key: 'THR' },
        phases: [
          { name: 'One', tasks: [{ title: 'a' }] },
          { name: 'Two', tasks: [{ title: 'b' }] },
        ],
      }),
    );
    expect(field(result, 'status')).toBe('partial');
    expect(str(result, 'phases', 0, 'error')).toContain('rate limit');
    expect(str(result, 'phases', 1, 'error')).toMatch(/^Skipped: /);
  });

  it('bulk_create_plan fails as a whole, creating nothing, when the project cannot be created', async () => {
    harness.api.fail({
      method: 'POST',
      path: /^\/api\/projects$/,
      status: 403,
      body: envelope('INSUFFICIENT_SCOPE', 'Personal access token lacks required scope'),
    });
    const before = harness.api.tasks.size;
    const result = await legacy.call('openlinear_bulk_create_plan', {
      project: { name: 'Denied' },
      phases: [{ name: 'One', tasks: [{ title: 'a' }] }],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('lacks the scope');
    expect(harness.api.tasks.size).toBe(before);
  });
});
