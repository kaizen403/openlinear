import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { describeFailure } from '../src/mcp/errors';
import { OpenLinearApiError } from '../src/openlinear/errors';
import { envelope } from './fake-api';
import { connectClient, type Harness, seedBasics, startHarness, type TestClient } from './harness';
import { ok, str } from './helpers';

describe('API error mapping', () => {
  let harness: Harness;
  let seed: ReturnType<typeof seedBasics>;
  let client: TestClient;

  beforeAll(async () => {
    harness = await startHarness();
    seed = seedBasics(harness.api);
    client = await connectClient('v1-legacy', harness.mcpUrl, seed.token);
  });
  afterAll(async () => {
    await client.close();
    await harness.stop();
  });
  afterEach(() => {
    harness.api.failures.splice(0);
  });

  it('explains 403 PAT_WORKSPACE_RESTRICTED', async () => {
    harness.api.fail({
      method: 'POST',
      path: /^\/api\/projects$/,
      status: 403,
      body: envelope('PAT_WORKSPACE_RESTRICTED', 'This personal access token is bound to a single workspace', {
        workspaceId: seed.workspace.id,
      }),
    });
    const result = await client.call('openlinear_create_project', { name: 'Elsewhere' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('PAT_WORKSPACE_RESTRICTED');
    expect(result.text).toContain(seed.workspace.id);
    expect(result.text).toContain('openlinear_list_workspaces');
    expect(result.structured).toBeUndefined();
  });

  it('confines a workspace-bound token (403 OWNERSHIP_REQUIRED outside its workspace)', async () => {
    const other = harness.api.addWorkspace('Other', { [seed.alice.id]: 'owner' });
    const { project: foreign } = harness.api.addProject(other.id, seed.alice.id, 'Foreign', 'FRN');
    const bound = harness.api.addPat(seed.alice.id, { workspaceId: seed.workspace.id });
    const boundClient = await connectClient('v1-legacy', harness.mcpUrl, bound);
    try {
      const workspaces = ok(await boundClient.call('openlinear_list_workspaces', {}));
      expect(workspaces.workspaces).toHaveLength(1);
      const denied = await boundClient.call('openlinear_get_project', { projectId: foreign.id });
      expect(denied.isError).toBe(true);
      expect(denied.text).toContain(`Access denied to project ${foreign.id}`);
      expect(denied.text).toContain('bound to another workspace');
      expect(denied.text).toMatch(/OpenLinear request id [0-9a-f-]{36}/);
    } finally {
      await boundClient.close();
    }
  });

  it('explains 409 IDEMPOTENCY_CONFLICT', async () => {
    harness.api.fail({
      method: 'POST',
      path: /^\/api\/tasks$/,
      status: 409,
      body: envelope('IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used with a different request'),
    });
    const result = await client.call('openlinear_create_issue', { projectId: seed.project.id, title: 'Conflicting' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('already used this idempotency key for different arguments');
  });

  it('retries 409 IDEMPOTENCY_IN_PROGRESS with the same key and returns the result', async () => {
    harness.api.fail({
      method: 'POST',
      path: /^\/api\/tasks$/,
      status: 409,
      body: envelope('IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed', {
        retryAfterSeconds: 1,
      }),
      headers: { 'Retry-After': '1' },
    });
    const before = harness.api.callsTo('POST', /^\/api\/tasks$/).length;
    const result = ok(await client.call('openlinear_create_issue', { projectId: seed.project.id, title: 'Busy key' }));
    const calls = harness.api.callsTo('POST', /^\/api\/tasks$/).slice(before);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers['idempotency-key']).toBe(calls[1]?.headers['idempotency-key']);
    expect(str(result, 'issue', 'title')).toBe('Busy key');
  });

  it('gives up on a persistent IDEMPOTENCY_IN_PROGRESS with retry advice', async () => {
    harness.api.fail({
      method: 'POST',
      path: /^\/api\/tasks$/,
      status: 409,
      times: 3,
      body: envelope('IDEMPOTENCY_IN_PROGRESS', 'still processing', { retryAfterSeconds: 1 }),
    });
    const result = await client.call('openlinear_create_issue', { projectId: seed.project.id, title: 'Stuck key' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('still being processed');
    expect(result.text).toContain('not a duplicate');
  });

  it('explains 404', async () => {
    const missing = randomUUID();
    const result = await client.call('openlinear_get_issue', { taskId: missing });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`Not found: task ${missing}`);
  });

  it('summarises 400 validation errors field by field', async () => {
    harness.api.fail({
      method: 'PATCH',
      path: /^\/api\/tasks\//,
      status: 400,
      body: envelope('VALIDATION_ERROR', 'Validation failed', {
        formErrors: [],
        fieldErrors: { dueDate: ['Invalid datetime'] },
      }),
    });
    const task = harness.api.addTask({ title: 'Validate me', projectId: seed.project.id, creatorId: seed.alice.id });
    const result = await client.call('openlinear_update_issue', { taskId: task.id, priority: 'low' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('VALIDATION_ERROR');
    expect(result.text).toContain('dueDate: Invalid datetime');
  });

  it('explains a label from another project (400 LABEL_NOT_IN_TASK_PROJECT from the attach endpoint)', async () => {
    const other = harness.api.addProject(seed.workspace.id, seed.alice.id, 'Other', 'OTH');
    const foreignLabel = harness.api.addLabel(other.project.id, 'foreign', '#000000');
    const task = harness.api.addTask({ title: 'Label me', projectId: seed.project.id, creatorId: seed.alice.id });
    const result = await client.call('openlinear_label_issue', { taskId: task.id, add: [foreignLabel.id] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`Label ${foreignLabel.id} cannot be attached to issue ${task.id} (LABEL_NOT_IN_TASK_PROJECT)`);
    expect(result.text).toContain("labels must belong to the issue's project");
    expect(task.labelIds).toEqual([]);
  });

  it('explains 429 with the server-provided wait', async () => {
    harness.api.fail({
      method: 'GET',
      path: /^\/api\/search$/,
      status: 429,
      body: envelope('RATE_LIMITED', 'Too many requests', { scope: 'search', retryAfterSeconds: 42 }),
    });
    const result = await client.call('openlinear_search', { query: 'anything' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('rate limit reached (search)');
    expect(result.text).toContain('Wait 42 seconds');
  });

  it('does not retry a 500 and tailors the retry advice to the tool', async () => {
    harness.api.fail({ method: 'POST', path: /^\/api\/tasks$/, status: 500, body: envelope('INTERNAL_ERROR', 'Internal server error') });
    const before = harness.api.callsTo('POST', /^\/api\/tasks$/).length;
    const create = await client.call('openlinear_create_issue', { projectId: seed.project.id, title: 'Five hundred' });
    expect(create.isError).toBe(true);
    expect(create.text).toContain('again with identical arguments is safe');
    expect(harness.api.callsTo('POST', /^\/api\/tasks$/).length - before).toBe(1);

    const task = harness.api.addTask({ title: 'Comment me', projectId: seed.project.id, creatorId: seed.alice.id });
    harness.api.fail({ method: 'POST', path: /\/comments$/, status: 500, body: envelope('INTERNAL_ERROR', 'Internal server error') });
    const comment = await client.call('openlinear_add_comment', { taskId: task.id, body: 'hello' });
    expect(comment.isError).toBe(true);
    expect(comment.text).toContain('may or may not have been applied');
  });

  it('retries transient gateway errors and dropped connections on reads only', async () => {
    harness.api.fail({ method: 'GET', path: /^\/api\/projects$/, status: 502, rawBody: '<html>Bad gateway</html>' });
    ok(await client.call('openlinear_list_projects', {}));
    harness.api.fail({ method: 'GET', path: /^\/api\/workspaces$/, status: 0, dropConnection: true });
    ok(await client.call('openlinear_list_workspaces', {}));

    const task = harness.api.addTask({ title: 'Patch me', projectId: seed.project.id, creatorId: seed.alice.id });
    harness.api.fail({ method: 'PATCH', path: /^\/api\/tasks\//, status: 0, dropConnection: true });
    const before = harness.api.callsTo('PATCH', /^\/api\/tasks\//).length;
    const patched = await client.call('openlinear_update_issue', { taskId: task.id, title: 'Patched' });
    expect(patched.isError).toBe(true);
    expect(patched.text).toContain('Could not reach the OpenLinear API');
    expect(harness.api.callsTo('PATCH', /^\/api\/tasks\//).length - before).toBe(1);
  });

  it('never forwards an HTML error page and honours a long Retry-After by not waiting', async () => {
    harness.api.fail({ method: 'GET', path: /^\/api\/projects$/, status: 503, times: 1, rawBody: '<html>down</html>', headers: { 'Retry-After': '30' } });
    const before = harness.api.callsTo('GET', /^\/api\/projects$/).length;
    const result = await client.call('openlinear_list_projects', {});
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain('<html>');
    expect(result.text).toContain('OpenLinear API error 503');
    expect(harness.api.callsTo('GET', /^\/api\/projects$/).length - before).toBe(1);
  });

  it('explains a missing scope and stops usage logging for read-only tokens', async () => {
    const readOnly = harness.api.addPat(seed.alice.id, { scopes: ['read'] });
    const readClient = await connectClient('v1-legacy', harness.mcpUrl, readOnly);
    try {
      const result = await readClient.call('openlinear_bulk_update_status', {
        projectId: seed.project.id,
        taskIds: [randomUUID()],
        status: 'done',
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('lacks the scope openlinear_bulk_update_status needs (write or tasks:write)');
      await harness.settle();
      const logsBefore = harness.api.callsTo('POST', /^\/api\/mcp\/log$/).length;
      ok(await readClient.call('openlinear_list_workspaces', {}));
      await harness.settle();
      expect(harness.api.callsTo('POST', /^\/api\/mcp\/log$/).length).toBe(logsBefore);
    } finally {
      await readClient.close();
    }
  });

  it('explains TEAM_PROJECT_CONFLICT with per-team reasons, and unique-key conflicts', async () => {
    const projectsBefore = harness.api.projects.size;
    const withTeam = await client.call('openlinear_create_project', { name: 'Team clash', teamIds: [seed.team.id] });
    expect(withTeam.isError).toBe(true);
    expect(withTeam.text).toContain('cannot move the team into the project (TEAM_PROJECT_CONFLICT)');
    expect(withTeam.text).toContain(`team ${seed.team.id} is the only team of its current project`);
    expect(withTeam.text).toContain('(LAST_TEAM_OF_PROJECT)');
    expect(withTeam.text).toContain('Nothing was created');
    expect(harness.api.projects.size).toBe(projectsBefore);
    expect(harness.api.teams.get(seed.team.id)?.projectId).toBe(seed.project.id);
    const duplicateKey = await client.call('openlinear_create_project', { name: 'Second auth', key: 'AUTH' });
    expect(duplicateKey.isError).toBe(true);
    expect(duplicateKey.text).toContain('unique workspaceId, key');
  });

  it('reports an API response with an unexpected shape', async () => {
    harness.api.fail({ method: 'GET', path: /^\/api\/workspaces$/, status: 200, body: { unexpected: true } });
    const result = await client.call('openlinear_list_workspaces', {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain('unexpected response');
  });

  it('records failures in usage telemetry by code, not by message', async () => {
    await harness.settle();
    const failures = harness.api.mcpLog.filter((entry) => !entry.success);
    expect(failures.map((entry) => entry.error)).toContain('PAT_WORKSPACE_RESTRICTED');
    for (const entry of failures) expect(entry.error ?? '').toMatch(/^[A-Z0-9_]+$/);
  });
});

describe('describeFailure', () => {
  const context = { tool: 'openlinear_create_issue', scopes: ['write'], safeToRetry: true };
  const apiError = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new OpenLinearApiError(status, 'POST', '/api/tasks', {
      ...(typeof body === 'object' && body !== null && 'code' in body && typeof body.code === 'string' ? { code: body.code } : {}),
      ...(typeof body === 'object' && body !== null && 'details' in body ? { details: body.details } : {}),
      ...(headers['retry-after'] ? { retryAfterSeconds: Number(headers['retry-after']) } : {}),
    });

  it('maps 401 to re-authentication advice', () => {
    expect(describeFailure(apiError(401, envelope('UNAUTHORIZED', 'Invalid token')), context)).toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('maps 413 and 422 IDEMPOTENCY_RESPONSE_TOO_LARGE to split-the-work advice', () => {
    expect(describeFailure(apiError(413, {}), context).message).toContain('256 KB');
    expect(
      describeFailure(apiError(422, envelope('IDEMPOTENCY_RESPONSE_TOO_LARGE', 'too large')), context).message,
    ).toContain('Split the work');
  });

  it('never exposes internal error details', () => {
    const failure = describeFailure(new Error('secret stack detail'), context);
    expect(failure.code).toBe('INTERNAL');
    expect(failure.message).not.toContain('secret');
  });
});
