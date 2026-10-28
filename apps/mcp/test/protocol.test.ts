import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOOLS } from '../src/mcp/server';
import { SERVER_VERSION } from '../src/version';
import { CLIENT_KINDS, connectClient, type Harness, seedBasics, startHarness, type TestClient } from './harness';
import { field, initializeMessage, isObject, list, ok, rpc, str } from './helpers';

const EXPECTED_TOOLS = [
  'openlinear_list_workspaces',
  'openlinear_list_projects',
  'openlinear_get_project',
  'openlinear_create_project',
  'openlinear_list_teams',
  'openlinear_create_team',
  'openlinear_list_labels',
  'openlinear_create_label',
  'openlinear_create_phase',
  'openlinear_search',
  'openlinear_list_issues',
  'openlinear_get_issue',
  'openlinear_find_similar_issues',
  'openlinear_create_issue',
  'openlinear_update_issue',
  'openlinear_assign_issue',
  'openlinear_label_issue',
  'openlinear_set_blockers',
  'openlinear_bulk_update_status',
  'openlinear_add_comment',
  'openlinear_bulk_create_plan',
  'openlinear_list_plans',
  'openlinear_propose_plan',
  'openlinear_get_plan',
  'openlinear_revise_plan',
  'openlinear_approve_plan',
  'openlinear_list_schedules',
  'openlinear_create_schedule',
  'openlinear_list_knowledge',
  'openlinear_propose_knowledge',
  'openlinear_get_insights',
];

const READ_ONLY_TOOLS = new Set([
  'openlinear_list_workspaces',
  'openlinear_list_projects',
  'openlinear_get_project',
  'openlinear_list_teams',
  'openlinear_list_labels',
  'openlinear_search',
  'openlinear_list_issues',
  'openlinear_get_issue',
  'openlinear_find_similar_issues',
  'openlinear_list_plans',
  'openlinear_get_plan',
  'openlinear_list_schedules',
  'openlinear_list_knowledge',
  'openlinear_get_insights',
]);
const DESTRUCTIVE_TOOLS = new Set([
  'openlinear_update_issue',
  'openlinear_assign_issue',
  'openlinear_label_issue',
  'openlinear_set_blockers',
  'openlinear_bulk_update_status',
]);
const NOT_IDEMPOTENT_TOOLS = new Set(['openlinear_add_comment']);

describe.each(CLIENT_KINDS)('%s client', (kind) => {
  let harness: Harness;
  let client: TestClient;
  let seed: ReturnType<typeof seedBasics>;

  beforeAll(async () => {
    harness = await startHarness();
    seed = seedBasics(harness.api);
    client = await connectClient(kind, harness.mcpUrl, seed.token);
  });
  afterAll(async () => {
    await client.close();
    await harness.stop();
  });

  it('negotiates the expected protocol revision and identifies the server', () => {
    expect(client.protocolVersion).toBe(kind === 'v2-modern' ? '2026-07-28' : '2025-11-25');
    expect(client.serverName).toBe('openlinear');
    expect(client.instructions).toContain('openlinear_bulk_create_plan');
  });

  it('lists every tool in a fixed order with complete annotations and schemas', async () => {
    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(EXPECTED_TOOLS);
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.description?.length ?? 0, tool.name).toBeGreaterThan(30);
      expect(tool.description?.length ?? 0, tool.name).toBeLessThan(450);
      expect(tool.annotations, tool.name).toMatchObject({
        readOnlyHint: READ_ONLY_TOOLS.has(tool.name),
        destructiveHint: DESTRUCTIVE_TOOLS.has(tool.name),
        idempotentHint: !NOT_IDEMPOTENT_TOOLS.has(tool.name),
        openWorldHint: false,
      });
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(tool.outputSchema?.type, tool.name).toBe('object');
    }
    // Every top-level input field carries a description for the model.
    const undescribed = tools.flatMap((tool) => {
      const properties = isObject(tool.inputSchema.properties) ? tool.inputSchema.properties : {};
      return Object.entries(properties)
        .filter(([, schema]) => !isObject(schema) || typeof schema.description !== 'string')
        .map(([name]) => `${tool.name}.${name}`);
    });
    expect(undescribed).toEqual([]);
    expect(TOOLS.map((tool) => tool.name)).toEqual(EXPECTED_TOOLS);
  });

  it('runs every tool end to end against the API', async () => {
    const workspaces = ok(await client.call('openlinear_list_workspaces', {}));
    expect(list(workspaces, 'workspaces')).toHaveLength(1);
    expect(field(workspaces, 'workspaces', 0, 'role')).toBe('owner');

    const projects = ok(await client.call('openlinear_list_projects', { query: 'auth' }));
    expect(field(projects, 'projects', 0, 'key')).toBe('AUTH');
    expect(field(projects, 'total')).toBe(1);

    const created = ok(await client.call('openlinear_create_project', { name: 'Billing', key: 'bill' }));
    const projectId = str(created, 'project', 'id');
    expect(field(created, 'project', 'key')).toBe('BILL');
    expect(list(created, 'project', 'teams')).toHaveLength(1);
    expect(field(created, 'idempotency', 'replayed')).toBe(false);

    const detail = ok(await client.call('openlinear_get_project', { projectId }));
    expect(list(detail, 'labels').map((label) => field(label, 'name'))).toEqual(['Bug', 'Feature']);
    expect(field(detail, 'project', 'workspace', 'name')).toBe('Acme');

    const teams = ok(await client.call('openlinear_list_teams', { projectId }));
    expect(field(teams, 'teams', 0, 'members', 0, 'username')).toBe('alice');

    const team = ok(await client.call('openlinear_create_team', { projectId, name: 'Platform', key: 'plt' }));
    expect(field(team, 'team', 'key')).toBe('PLT');

    const phase = ok(await client.call('openlinear_create_phase', { projectId, phaseNumber: 1, name: 'Foundation' }));
    const phaseLabelId = str(phase, 'label', 'id');
    expect(field(phase, 'label', 'name')).toBe('phase:1 — Foundation');
    expect(field(phase, 'label', 'phase')).toEqual({ number: 1, name: 'Foundation' });
    expect(field(phase, 'created')).toBe(true);
    const again = ok(await client.call('openlinear_create_phase', { projectId, phaseNumber: 1, name: 'Foundation' }));
    expect(field(again, 'label', 'id')).toBe(phaseLabelId);
    expect(field(again, 'created')).toBe(false);

    const blocked = ok(await client.call('openlinear_create_label', { projectId, name: 'blocked', color: '#E11D48' }));
    const blockedId = str(blocked, 'label', 'id');

    const phases = ok(await client.call('openlinear_list_labels', { projectId, phasesOnly: true }));
    expect(list(phases, 'labels').map((label) => field(label, 'id'))).toEqual([phaseLabelId]);

    const issue = ok(
      await client.call('openlinear_create_issue', {
        projectId,
        title: 'Add webhook handler',
        description: 'Handle checkout.session.completed',
        labelIds: [phaseLabelId],
      }),
    );
    const taskId = str(issue, 'issue', 'id');
    expect(field(issue, 'issue', 'identifier')).toBe('BILL-1');
    expect(field(issue, 'issue', 'phase')).toEqual({ number: 1, name: 'Foundation' });
    expect(field(issue, 'issue', 'executionLogs')).toBeUndefined();
    expect(field(issue, 'idempotency', 'replayed')).toBe(false);

    const listed = ok(await client.call('openlinear_list_issues', { projectId }));
    expect(list(listed, 'issues').map((item) => field(item, 'id'))).toEqual([taskId]);
    expect(field(listed, 'hasMore')).toBe(false);
    expect(field(listed, 'nextCursor')).toBeNull();
    expect(field(listed, 'total')).toBeNull();
    const filtered = ok(
      await client.call('openlinear_list_issues', {
        projectId,
        status: ['todo'],
        labelId: phaseLabelId,
        query: 'webhook',
        includeTotal: true,
      }),
    );
    expect(list(filtered, 'issues').map((item) => field(item, 'id'))).toEqual([taskId]);
    expect(field(filtered, 'total')).toBe(1);

    const found = ok(await client.call('openlinear_search', { query: 'webhook', types: ['issues'] }));
    expect(field(found, 'issues', 0, 'identifier')).toBe('BILL-1');
    expect(field(found, 'issues', 0, 'status')).toBe('todo');
    expect(field(found, 'issues', 0, 'projectId')).toBe(projectId);

    const comment = ok(await client.call('openlinear_add_comment', { taskId, body: 'Started on this.' }));
    expect(field(comment, 'comment', 'author', 'username')).toBe('alice');
    expect(field(comment, 'comment', 'taskId')).toBe(taskId);

    const fetched = ok(await client.call('openlinear_get_issue', { identifier: 'bill-1' }));
    expect(field(fetched, 'issue', 'id')).toBe(taskId);
    expect(field(fetched, 'issue', 'description')).toBe('Handle checkout.session.completed');
    expect(field(fetched, 'comments', 'total')).toBe(1);
    expect(field(fetched, 'comments', 'items', 0, 'body')).toBe('Started on this.');
    expect(field(fetched, 'subtasks')).toEqual({ items: [], complete: true });
    expect(field(fetched, 'parent')).toBeNull();

    const updated = ok(await client.call('openlinear_update_issue', { taskId, priority: 'high' }));
    expect(field(updated, 'issue', 'priority')).toBe('high');

    const assigned = ok(await client.call('openlinear_assign_issue', { taskId, assignee: 'me' }));
    expect(field(assigned, 'issue', 'assignee', 'username')).toBe('alice');

    const relabelled = ok(
      await client.call('openlinear_label_issue', { taskId, add: [blockedId], remove: [phaseLabelId] }),
    );
    expect(list(relabelled, 'issue', 'labels').map((label) => field(label, 'id'))).toEqual([blockedId]);
    expect(field(relabelled, 'changed')).toBe(true);

    const moved = ok(await client.call('openlinear_bulk_update_status', { projectId, taskIds: [taskId], status: 'done' }));
    expect(list(moved, 'updated')).toHaveLength(1);
    const unchanged = ok(
      await client.call('openlinear_bulk_update_status', { projectId, taskIds: [taskId], status: 'done' }),
    );
    expect(list(unchanged, 'unchanged')).toHaveLength(1);

    const plan = ok(
      await client.call('openlinear_bulk_create_plan', {
        project: { name: 'Mobile Launch', key: 'MOB' },
        phases: [
          { name: 'Foundation', tasks: [{ title: 'Set up monorepo' }, { title: 'CI pipeline', priority: 'high' }] },
          { name: 'Onboarding', tasks: [{ title: 'Sign-in screen' }] },
        ],
      }),
    );
    expect(field(plan, 'status')).toBe('complete');
    expect(field(plan, 'totalTasks')).toBe(3);
    expect(list(plan, 'phases').map((item) => field(item, 'labelName'))).toEqual([
      'phase:1 — Foundation',
      'phase:2 — Onboarding',
    ]);
    expect(str(plan, 'summary')).toContain('MOB');
  });

  it('records one usage row per tool call, named after the MCP tool', async () => {
    await harness.settle();
    const names = harness.api.mcpLog.map((entry) => entry.toolName);
    expect(names).toContain('openlinear_bulk_create_plan');
    expect(names.every((name) => name.startsWith('openlinear_'))).toBe(true);
  });
});

describe('HTTP surface', () => {
  let harness: Harness;
  let token: string;
  beforeAll(async () => {
    harness = await startHarness();
    token = seedBasics(harness.api).token;
  });
  afterAll(async () => harness.stop());

  it.each(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'])(
    'serves a 2025-era initialize for protocol %s statelessly',
    async (version) => {
      const answer = await rpc(harness.mcpUrl, initializeMessage(version), { Authorization: `Bearer ${token}` });
      expect(answer.status).toBe(200);
      expect(answer.headers.get('mcp-session-id')).toBeNull();
      expect(field(answer.body, 'result', 'protocolVersion')).toBe(version);
      expect(field(answer.body, 'result', 'serverInfo')).toMatchObject({ name: 'openlinear', version: SERVER_VERSION });
      expect(field(answer.body, 'result', 'capabilities', 'tools')).toEqual({ listChanged: false });
    },
  );

  it('answers GET and DELETE /mcp with 405 (no sessions, no standalone stream)', async () => {
    for (const method of ['GET', 'DELETE']) {
      const response = await fetch(harness.mcpUrl, { method, headers: { Authorization: `Bearer ${token}` } });
      expect(response.status, method).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
    }
  });

  it('rejects non-JSON bodies with 415 and oversized bodies with 413', async () => {
    const wrongType = await fetch(harness.mcpUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain', Accept: 'application/json, text/event-stream' },
      body: 'hello',
    });
    expect(wrongType.status).toBe(415);
    const huge = await rpc(
      harness.mcpUrl,
      { ...initializeMessage('2025-06-18'), padding: 'x'.repeat(2 * 1024 * 1024 + 10) },
      { Authorization: `Bearer ${token}` },
    );
    expect(huge.status).toBe(413);
  });

  it('serves /healthz, a root descriptor and 404 for unknown paths', async () => {
    const health = await fetch(`${harness.origin}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, name: 'openlinear', version: SERVER_VERSION });
    const root = await fetch(`${harness.origin}/`);
    expect(await root.json()).toMatchObject({ endpoint: harness.mcpUrl });
    expect((await fetch(`${harness.origin}/nope`)).status).toBe(404);
  });
});
