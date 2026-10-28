import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectClient, type Harness, seedBasics, startHarness, type TestClient } from './harness';
import { field, ok } from './helpers';

describe.each(['v1-legacy', 'v2-modern'] as const)('tool input validation (%s)', (kind) => {
  let harness: Harness;
  let seed: ReturnType<typeof seedBasics>;
  let client: TestClient;

  beforeAll(async () => {
    harness = await startHarness();
    seed = seedBasics(harness.api);
    client = await connectClient(kind, harness.mcpUrl, seed.token);
  });
  afterAll(async () => {
    await client.close();
    await harness.stop();
  });

  /** API calls other than token verification and usage logging. */
  const apiWork = () =>
    harness.api.requests.filter((request) => request.path !== '/api/users/me' && request.path !== '/api/mcp/log').length;

  async function rejected(name: string, args: Record<string, unknown>, expected: string | RegExp): Promise<void> {
    const before = apiWork();
    const result = await client.call(name, args);
    expect(result.isError, `${name} ${JSON.stringify(args).slice(0, 80)}`).toBe(true);
    if (typeof expected === 'string') expect(result.text).toContain(expected);
    else expect(result.text).toMatch(expected);
    expect(apiWork(), `${name} must not reach the API`).toBe(before);
  }

  it('rejects unknown argument names instead of silently ignoring them', async () => {
    await rejected('openlinear_create_issue', { projectId: seed.project.id, title: 'x', labels: ['a'] }, /labels/);
    await rejected(
      'openlinear_bulk_create_plan',
      { project: { name: 'P' }, phases: [{ name: 'One', tasks: [{ title: 'a', status: 'done' }] }] },
      /status/,
    );
  });

  it('enforces cross-field rules that JSON Schema cannot express', async () => {
    await rejected('openlinear_create_issue', { title: 'Orphan' }, 'Either projectId or teamId is required');
    await rejected('openlinear_update_issue', { taskId: randomUUID() }, 'Nothing to update');
    await rejected('openlinear_label_issue', { taskId: randomUUID() }, 'Pass at least one label id');
    const both = randomUUID();
    await rejected('openlinear_label_issue', { taskId: randomUUID(), add: [both], remove: [both] }, 'both add and remove');
    await rejected('openlinear_get_issue', {}, 'Pass taskId');
  });

  it('validates ids, enums, sizes and formats', async () => {
    await rejected('openlinear_get_project', { projectId: 'not-a-uuid' }, /projectId/);
    await rejected('openlinear_update_issue', { taskId: randomUUID(), status: 'blocked' }, /status/);
    await rejected('openlinear_list_issues', { limit: 101 }, /limit/);
    await rejected('openlinear_list_issues', { cursor: '' }, /cursor/);
    await rejected('openlinear_list_issues', { parentId: 'top' }, /parentId/);
    await rejected('openlinear_list_issues', { labelId: Array.from({ length: 21 }, () => randomUUID()) }, /labelId/);
    await rejected('openlinear_create_issue', { projectId: seed.project.id, title: 'x', assigneeIds: [] }, /assigneeIds/);
    await rejected('openlinear_create_issue', { projectId: seed.project.id, title: 'x', assigneeIds: ['you'] }, /assigneeIds/);
    await rejected('openlinear_create_issue', { projectId: seed.project.id, title: 'x', dueDate: '2026-11-01 10:00' }, /dueDate/);
    await rejected('openlinear_create_phase', { projectId: seed.project.id, phaseNumber: 0, name: 'Zero' }, /phaseNumber/);
    await rejected('openlinear_search', { query: 'x' }, /query/);
    await rejected(
      'openlinear_bulk_create_plan',
      { project: { name: 'P' }, phases: Array.from({ length: 11 }, (_, i) => ({ name: `P${i}`, tasks: [{ title: 't' }] })) },
      /phases/,
    );
  });

  it('never sends bulk-status without explicit taskIds (the API would update the whole project)', async () => {
    await rejected('openlinear_bulk_update_status', { projectId: seed.project.id, status: 'done' }, /taskIds/);
    await rejected('openlinear_bulk_update_status', { projectId: seed.project.id, status: 'done', taskIds: [] }, /taskIds/);
    expect(harness.api.callsTo('PATCH', /bulk-status/)).toHaveLength(0);
  });

  it('caps the size of tool arguments', async () => {
    const taskIds = Array.from({ length: 6_000 }, () => randomUUID());
    await rejected('openlinear_bulk_update_status', { projectId: seed.project.id, status: 'done', taskIds }, /maximum|taskIds/);
  });

  it('resolves identifiers exactly and refuses ambiguous ones', async () => {
    const other = harness.api.addProject(seed.workspace.id, seed.alice.id, 'Twin A', 'DUP');
    const twin = harness.api.addProject(seed.workspace.id, seed.alice.id, 'Twin B', 'DUP2');
    twin.team.key = 'DUP';
    harness.api.addTask({ title: 'First dup', projectId: other.project.id, creatorId: seed.alice.id });
    harness.api.addTask({ title: 'Second dup', projectId: twin.project.id, creatorId: seed.alice.id });
    const ambiguous = await client.call('openlinear_get_issue', { identifier: 'DUP-1' });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toContain('matches several issues');
    const missing = await client.call('openlinear_get_issue', { identifier: 'NOPE-404' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('No visible issue has identifier NOPE-404');
    const exact = harness.api.addTask({ title: 'Exact', projectId: seed.project.id, creatorId: seed.alice.id });
    const found = ok(await client.call('openlinear_get_issue', { identifier: exact.identifier ?? '' }));
    expect(field(found, 'issue', 'id')).toBe(exact.id);
  });
});
