import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { describeFailure } from '../src/mcp/errors';
import { OpenLinearApiError } from '../src/openlinear/errors';
import { IDENTIFIER_PAGE_SIZE, MAX_IDENTIFIER_PAGES } from '../src/mcp/tools/issues';
import { envelope, type FakeTask } from './fake-api';
import { connectClient, type Harness, seedBasics, startHarness, type TestClient } from './harness';
import { field, list, ok, str } from './helpers';

/*
 * The MCP follow-ups unlocked by the W14 API contract
 * (docs/reports/revamp-2026-10-26/apicontract.md §8): server-side list
 * filters and keyset pages, parent/sub-issues and exact identifier lookup,
 * direct label attach/detach, team-scoped bulk status, assignees on create,
 * team moves on project create, and the new error codes. Plus PAT tokens with
 * W02b family scopes.
 */

const ids = (value: unknown, ...path: Array<string | number>) => list(value, ...path).map((item) => field(item, 'id'));

describe('API contract follow-ups (apicontract.md §8)', () => {
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

  const taskListCalls = () => harness.api.callsTo('GET', /^\/api\/tasks$/);
  /** Requests a tool call made, without token verification and usage logging. */
  const workSince = (index: number) =>
    harness.api.requests.slice(index).filter((request) => request.path !== '/api/users/me' && request.path !== '/api/mcp/log');

  function freshProject(name: string, key: string) {
    return harness.api.addProject(seed.workspace.id, seed.alice.id, name, key);
  }

  describe('openlinear_list_issues', () => {
    it('sends every filter to the API in one keyset request with compact rows (no client-side scan)', async () => {
      const { api } = harness;
      const { project } = freshProject('Filters', 'FLT');
      const urgent = api.addLabel(project.id, 'urgent', '#ff0000');
      const later = api.addLabel(project.id, 'later', '#00ff00');
      const parent = api.addTask({ title: 'Parent epic', projectId: project.id, creatorId: seed.alice.id });
      const base = { projectId: project.id, creatorId: seed.alice.id, parentId: parent.id, status: 'in_progress' };
      const match = api.addTask({ ...base, title: 'Fix 100% CPU', labelIds: [urgent.id] });
      api.addTask({ ...base, title: 'Fix 100% CPU again', labelIds: [later.id], assigneeId: seed.bob.id });
      api.addTask({ ...base, title: 'Fix 1000 CPU', labelIds: [urgent.id] });
      api.addTask({ ...base, title: 'Fix 100% CPU done', labelIds: [urgent.id], status: 'cancelled' });
      api.addTask({ ...base, title: 'Fix 100% CPU top', labelIds: [urgent.id], parentId: null });

      const before = taskListCalls().length;
      const result = ok(
        await client.call('openlinear_list_issues', {
          projectId: project.id,
          status: ['in_progress', 'done'],
          labelId: [urgent.id, later.id],
          parentId: parent.id,
          assignee: 'none',
          query: '100%',
          limit: 10,
        }),
      );
      expect(ids(result, 'issues')).toEqual([match.id]);
      expect(field(result, 'hasMore')).toBe(false);
      expect(field(result, 'nextCursor')).toBeNull();
      expect(field(result, 'total')).toBeNull();
      const calls = taskListCalls().slice(before);
      expect(calls).toHaveLength(1);
      expect(Object.fromEntries(calls[0]?.query ?? [])).toEqual({
        projectId: project.id,
        assignee: 'none',
        status: 'in_progress,done',
        labelId: `${urgent.id},${later.id}`,
        q: '100%',
        parentId: parent.id,
        pagination: 'cursor',
        view: 'compact',
        pageSize: '10',
      });

      const topLevel = ok(await client.call('openlinear_list_issues', { projectId: project.id, parentId: 'none', query: 'CPU' }));
      expect(list(topLevel, 'issues').map((item) => field(item, 'title'))).toEqual(['Fix 100% CPU top']);
      const oneLabel = ok(await client.call('openlinear_list_issues', { projectId: project.id, labelId: later.id }));
      expect(list(oneLabel, 'issues').map((item) => field(item, 'title'))).toEqual(['Fix 100% CPU again']);
    });

    it('pages with nextCursor: every issue exactly once, newest first, while other issues are created', async () => {
      const { api } = harness;
      const { project } = freshProject('Paging', 'PGN');
      const created = Array.from({ length: 5 }, (_, index) =>
        api.addTask({ title: `Page ${index}`, projectId: project.id, creatorId: seed.alice.id }),
      );
      // A three-way createdAt tie across a page boundary (the API breaks ties by id).
      const tie = created[2]?.createdAt ?? '';
      for (const task of created.slice(1, 4)) task.createdAt = tie;
      const expected = [...created]
        .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1))
        .map((task) => task.id);

      const seen: unknown[] = [];
      let cursor: string | undefined;
      let pages = 0;
      let total: unknown;
      do {
        const page = ok(
          await client.call('openlinear_list_issues', {
            projectId: project.id,
            limit: 2,
            ...(cursor ? { cursor } : { includeTotal: true }),
          }),
        );
        if (!cursor) total = field(page, 'total');
        seen.push(...ids(page, 'issues'));
        const next = field(page, 'nextCursor');
        expect(field(page, 'hasMore')).toBe(next !== null);
        cursor = typeof next === 'string' ? next : undefined;
        pages += 1;
        // Another client creates an issue mid-way: it sorts first and never shifts later pages.
        if (pages === 1) api.addTask({ title: 'Inserted while paging', projectId: project.id, creatorId: seed.bob.id });
      } while (cursor && pages < 10);
      expect(total).toBe(5);
      expect(pages).toBe(3);
      expect(seen).toEqual(expected);
      expect(taskListCalls().at(-1)?.query.get('cursor')).toBeTruthy();
    });

    it('refuses an API that predates the contract (offset page, filters ignored) instead of returning wrong issues', async () => {
      harness.api.fail({
        method: 'GET',
        path: /^\/api\/tasks$/,
        status: 200,
        body: { items: [], total: 0, page: 1, pageSize: 25, hasMore: false },
      });
      const result = await client.call('openlinear_list_issues', { status: ['todo'] });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('the API predates server-side filters');
    });

    it('refuses an invalid cursor with restart advice (INVALID_CURSOR)', async () => {
      const result = await client.call('openlinear_list_issues', { cursor: 'not-a-cursor' });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('INVALID_CURSOR');
      expect(result.text).toContain('without cursor');
    });

    it('combines assignee and creator with AND and keeps the API cursor exact', async () => {
      const { api } = harness;
      const { project, team } = freshProject('Both filters', 'BTH');
      team.members.set(seed.bob.id, 'member');
      const add = (title: string, creatorId: string) =>
        api.addTask({ title, projectId: project.id, creatorId, assigneeId: seed.bob.id });
      const a1 = add('A1', seed.alice.id);
      add('B1', seed.bob.id);
      const a2 = add('A2', seed.alice.id);
      add('B2', seed.bob.id);
      const a3 = add('A3', seed.alice.id);
      api.addTask({ title: 'Mine, unassigned', projectId: project.id, creatorId: seed.alice.id });

      const before = taskListCalls().length;
      const args = { projectId: project.id, assignee: seed.bob.id, creator: 'me', limit: 2, includeTotal: true };
      const first = ok(await client.call('openlinear_list_issues', args));
      expect(ids(first, 'issues')).toEqual([a3.id, a2.id]);
      expect(field(first, 'total')).toBeNull();
      const cursor = str(first, 'nextCursor');
      const second = ok(await client.call('openlinear_list_issues', { ...args, cursor }));
      expect(ids(second, 'issues')).toEqual([a1.id]);
      expect(field(second, 'nextCursor')).toBeNull();
      const calls = taskListCalls().slice(before);
      // The API ORs the two, so only assignee is sent; page sizes shrink to what is still missing.
      expect(calls.every((call) => !call.query.has('creator') && call.query.get('assignee') === seed.bob.id)).toBe(true);
      expect(calls.map((call) => call.query.get('pageSize'))).toEqual(['2', '1', '2']);
    });
  });

  describe('openlinear_get_issue', () => {
    it('reads the parent and sub-issues from GET /api/tasks/:id, without listing the project', async () => {
      const { api } = harness;
      const { project } = freshProject('Tree', 'TRE');
      const parent = api.addTask({ title: 'Epic', projectId: project.id, creatorId: seed.alice.id });
      const childA = api.addTask({ title: 'Child A', projectId: project.id, creatorId: seed.alice.id, parentId: parent.id });
      const childB = api.addTask({ title: 'Child B', projectId: project.id, creatorId: seed.alice.id, parentId: parent.id, status: 'done' });
      api.addTask({ title: 'Archived child', projectId: project.id, creatorId: seed.alice.id, parentId: parent.id, archived: true });

      const before = harness.api.requests.length;
      const epic = ok(await client.call('openlinear_get_issue', { taskId: parent.id, includeComments: false }));
      expect(field(epic, 'parent')).toBeNull();
      expect(field(epic, 'subtasks')).toEqual({
        items: [
          { id: childA.id, identifier: childA.identifier, title: 'Child A', status: 'todo' },
          { id: childB.id, identifier: childB.identifier, title: 'Child B', status: 'done' },
        ],
        complete: true,
      });
      expect(field(epic, 'comments')).toBeNull();
      const child = ok(await client.call('openlinear_get_issue', { taskId: childA.id, includeSubtasks: false }));
      expect(field(child, 'parent')).toEqual({ id: parent.id, identifier: parent.identifier, title: 'Epic', status: 'todo' });
      expect(field(child, 'issue', 'parentId')).toBe(parent.id);
      expect(field(child, 'subtasks')).toBeNull();
      expect(workSince(before).filter((request) => request.path === '/api/tasks')).toEqual([]);
    });

    it('resolves an identifier exactly through GET /api/tasks?identifier= (not /api/search)', async () => {
      const { api } = harness;
      const { project, team } = freshProject('Engine', 'ENG');
      const target = api.addTask({ title: 'The first one', projectId: project.id, creatorId: seed.alice.id });
      team.nextIssueNumber = 12;
      api.addTask({ title: 'Twelfth', projectId: project.id, creatorId: seed.alice.id });
      api.addTask({ title: 'Mentions it', description: 'Follow-up of ENG-1', projectId: project.id, creatorId: seed.alice.id });

      const before = harness.api.requests.length;
      const found = ok(await client.call('openlinear_get_issue', { identifier: 'eng-1', includeComments: false }));
      expect(field(found, 'issue', 'id')).toBe(target.id);
      const work = workSince(before);
      expect(work.some((request) => request.path === '/api/search')).toBe(false);
      const lookups = work.filter((request) => request.path === '/api/tasks');
      expect(lookups).toHaveLength(1);
      expect(lookups[0]?.query.get('identifier')).toBe('eng-1');
      // q too, for an API that predates the identifier filter (it ignores unknown parameters).
      expect(lookups[0]?.query.get('q')).toBe('eng-1');
      expect(lookups[0]?.query.get('view')).toBe('compact');
    });
  });

  describe('openlinear_label_issue', () => {
    it('attaches and detaches one label at a time, never rewriting the label set', async () => {
      const { api } = harness;
      const labels = [...api.labels.values()].filter((label) => label.projectId === seed.project.id);
      const bug = labels.find((label) => label.name === 'Bug');
      const feature = labels.find((label) => label.name === 'Feature');
      if (!bug || !feature) throw new Error('seed labels missing');
      const stray = api.addLabel(seed.project.id, 'stray', '#123456');
      const task = api.addTask({ title: 'Label me directly', projectId: seed.project.id, creatorId: seed.alice.id, labelIds: [bug.id] });

      const before = harness.api.requests.length;
      const first = ok(
        await client.call('openlinear_label_issue', { taskId: task.id, add: [feature.id, bug.id], remove: [stray.id] }),
      );
      expect(field(first, 'added')).toEqual([feature.id]);
      expect(field(first, 'removed')).toEqual([]);
      expect(field(first, 'changed')).toBe(true);
      expect(ids(first, 'issue', 'labels').sort()).toEqual([bug.id, feature.id].sort());
      const work = workSince(before);
      // Writes first (no read-modify-write), then one read for the result; no PATCH.
      expect(work.map((request) => `${request.method} ${request.status}`)).toEqual(['POST 201', 'POST 409', 'DELETE 404', 'GET 200']);
      expect(work.every((request) => request.method !== 'PATCH')).toBe(true);
      expect(work[0]?.path).toBe(`/api/labels/tasks/${task.id}/labels`);

      const second = ok(await client.call('openlinear_label_issue', { taskId: task.id, remove: [bug.id] }));
      expect(field(second, 'removed')).toEqual([bug.id]);
      expect(task.labelIds).toEqual([feature.id]);
      const again = ok(await client.call('openlinear_label_issue', { taskId: task.id, remove: [bug.id] }));
      expect(field(again, 'changed')).toBe(false);
    });

    it('explains that an issue without a project takes no labels', async () => {
      const teamOnly = harness.api.addTask({ title: 'No project', teamId: seed.team.id, creatorId: seed.alice.id });
      const bug = [...harness.api.labels.values()].find((label) => label.projectId === seed.project.id);
      const result = await client.call('openlinear_label_issue', { taskId: teamOnly.id, add: [bug?.id ?? randomUUID()] });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('LABEL_NOT_IN_TASK_PROJECT');
      expect(result.text).toContain('the issue has no project');
    });
  });

  describe('openlinear_find_similar_issues (FE-11)', () => {
    it('returns likely duplicates in the project, best first', async () => {
      const { project } = freshProject('Dupes', 'DUP');
      const login = harness.api.addTask({ title: 'Fix login form validation', projectId: project.id, creatorId: seed.alice.id });
      harness.api.addTask({ title: 'Add billing page', projectId: project.id, creatorId: seed.alice.id });
      const result = ok(await client.call('openlinear_find_similar_issues', { projectId: project.id, title: 'login form validation broken' }));
      expect(list(result, 'matches').map((match) => field(match, 'id'))).toEqual([login.id]);
      expect(typeof field(result, 'matches', 0, 'score')).toBe('number');
    });
  });

  describe('openlinear_set_blockers (W17a)', () => {
    it('adds and removes blockers one at a time, refuses loops, and get_issue shows both directions', async () => {
      const { api } = harness;
      const { project } = freshProject('Deps', 'DEP');
      const schema = api.addTask({ title: 'Schema', projectId: project.id, creatorId: seed.alice.id });
      const apiTask = api.addTask({ title: 'API', projectId: project.id, creatorId: seed.alice.id });
      const ui = api.addTask({ title: 'UI', projectId: project.id, creatorId: seed.alice.id, status: 'done' });

      const before = harness.api.requests.length;
      const first = ok(await client.call('openlinear_set_blockers', { taskId: apiTask.id, add: [schema.id, ui.id] }));
      expect(field(first, 'added')).toEqual([schema.id, ui.id]);
      expect(field(first, 'changed')).toBe(true);
      expect(list(first, 'blockedBy').map((ref) => field(ref, 'id'))).toEqual([schema.id, ui.id]);
      expect(field(first, 'blockedBy', 1, 'resolved')).toBe(true);
      expect(workSince(before).map((request) => `${request.method} ${request.status}`)).toEqual(['GET 200', 'POST 201', 'POST 201', 'GET 200']);

      const again = ok(await client.call('openlinear_set_blockers', { taskId: apiTask.id, add: [schema.id] }));
      expect(field(again, 'changed')).toBe(false);

      const loop = await client.call('openlinear_set_blockers', { taskId: schema.id, add: [apiTask.id] });
      expect(loop.isError).toBe(true);
      expect(loop.text).toContain('DEPENDENCY_CYCLE');

      const detail = ok(await client.call('openlinear_get_issue', { taskId: schema.id, includeComments: false, includeSubtasks: false, includeVerification: false }));
      expect(field(detail, 'blockedBy')).toEqual([]);
      expect(list(detail, 'blocking').map((ref) => field(ref, 'id'))).toEqual([apiTask.id]);

      const removed = ok(await client.call('openlinear_set_blockers', { taskId: apiTask.id, remove: [ui.id, randomUUID()] }));
      expect(field(removed, 'removed')).toEqual([ui.id]);
      expect(list(removed, 'blockedBy').map((ref) => field(ref, 'id'))).toEqual([schema.id]);
    });

    it('refuses empty, self and contradictory requests before calling the API', async () => {
      const task = harness.api.addTask({ title: 'Lonely', projectId: seed.project.id, creatorId: seed.alice.id });
      const other = randomUUID();
      for (const args of [{ taskId: task.id }, { taskId: task.id, add: [task.id] }, { taskId: task.id, add: [other], remove: [other] }]) {
        const before = harness.api.requests.length;
        const result = await client.call('openlinear_set_blockers', args);
        expect(result.isError).toBe(true);
        expect(workSince(before)).toEqual([]);
      }
    });
  });

  describe('reviewable plans (W17b)', () => {
    it('proposes a draft (nothing created), revises from the latest, and creates issues only on approval', async () => {
      const { api } = harness;
      const { project } = freshProject('Reviewed', 'RVW');
      const before = api.tasks.size;
      const tasks = [
        { key: 'schema', title: 'Schema', acceptance: ['Migrates'], estimate: 's' },
        { key: 'api', title: 'API', blockedBy: ['schema'] },
      ];
      const proposed = ok(await client.call('openlinear_propose_plan', { projectId: project.id, title: 'Login', tasks }));
      const planId = str(proposed, 'plan', 'id');
      expect(field(proposed, 'plan', 'status')).toBe('draft');
      expect(field(proposed, 'plan', 'revision', 'order')).toEqual(['schema', 'api']);
      expect(field(proposed, 'plan', 'revision', 'warnings', 0, 'keys')).toEqual(['api']);
      expect(api.tasks.size).toBe(before);
      // Retry-safe.
      const again = ok(await client.call('openlinear_propose_plan', { projectId: project.id, title: 'Login', tasks }));
      expect(field(again, 'plan', 'id')).toBe(planId);
      expect(field(again, 'idempotency', 'replayed')).toBe(true);

      const stale = await client.call('openlinear_revise_plan', { planId, baseRevision: 7, tasks });
      expect(stale.isError).toBe(true);
      expect(stale.text).toContain('PLAN_REVISION_CONFLICT');
      const revised = ok(await client.call('openlinear_revise_plan', { planId, baseRevision: 1, tasks: [...tasks, { key: 'ui', title: 'UI', blockedBy: ['api'], acceptance: ['Renders'] }] }));
      expect(field(revised, 'unchanged')).toBe(false);
      expect(field(revised, 'plan', 'revision', 'diff', 'added')).toEqual(['ui']);

      const read = ok(await client.call('openlinear_get_plan', { planId, revision: 1 }));
      expect(list(read, 'plan', 'revision', 'tasks')).toHaveLength(2);

      const approved = ok(await client.call('openlinear_approve_plan', { planId, revision: 2 }));
      expect(field(approved, 'alreadyApproved')).toBe(false);
      expect(list(approved, 'created').map((row) => field(row, 'key'))).toEqual(['schema', 'api', 'ui']);
      expect(field(approved, 'blockers')).toEqual({ added: 2, removed: 0 });
      expect(api.tasks.size).toBe(before + 3);
      const apiIssue = list(approved, 'created').find((row) => field(row, 'key') === 'api');
      const issue = ok(await client.call('openlinear_get_issue', { taskId: str(apiIssue, 'issueId'), includeComments: false, includeSubtasks: false, includeVerification: false }));
      expect(field(issue, 'plan')).toEqual({ id: planId, key: 'api', title: 'Login', status: 'approved' });
      const listed = ok(await client.call('openlinear_list_plans', { projectId: project.id }));
      expect(field(listed, 'plans', 0)).toMatchObject({ id: planId, status: 'approved', approvedRevision: 2, awaitingReview: false, taskCount: 3, createdIssues: 3, doneIssues: 0 });
      const repeat = ok(await client.call('openlinear_approve_plan', { planId, revision: 2 }));
      expect(field(repeat, 'alreadyApproved')).toBe(true);
      expect(api.tasks.size).toBe(before + 3);
    });

    it('surfaces the checks that block a plan (loops) as a tool error', async () => {
      const { project } = freshProject('Looped', 'LPD');
      const result = await client.call('openlinear_propose_plan', {
        projectId: project.id,
        title: 'Loop',
        tasks: [{ key: 'a', title: 'A', blockedBy: ['b'] }, { key: 'b', title: 'B', blockedBy: ['a'] }],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('PLAN_INVALID');
      expect([...harness.api.plans.values()].some((plan) => plan.projectId === project.id)).toBe(false);
    });
  });

  describe('recurring issues (W20)', () => {
    it('creates a schedule (keyed, retry-safe) that creates no issue, lists it, and surfaces API refusals', async () => {
      const { api } = harness;
      const { project } = freshProject('Recurring', 'RCR');
      const before = api.tasks.size;
      const args = { projectId: project.id, title: 'Triage {date}', cadence: 'weekly', weekday: 1, time: '09:30', timezone: 'Europe/Berlin', priority: 'high' };
      const created = ok(await client.call('openlinear_create_schedule', args));
      expect(field(created, 'schedule')).toMatchObject({ projectId: project.id, title: 'Triage {date}', cadence: 'weekly', weekday: 1, dayOfMonth: null, time: '09:30', timezone: 'Europe/Berlin', paused: false });
      expect(api.callsTo('POST', /\/schedules$/).at(-1)?.body).toEqual({ title: 'Triage {date}', priority: 'high', cadence: 'weekly', weekday: 1, hour: 9, minute: 30, timezone: 'Europe/Berlin' });
      const again = ok(await client.call('openlinear_create_schedule', args));
      expect(field(again, 'schedule', 'id')).toBe(field(created, 'schedule', 'id'));
      expect(field(again, 'idempotency', 'replayed')).toBe(true);
      expect(api.tasks.size).toBe(before);

      const listed = ok(await client.call('openlinear_list_schedules', { projectId: project.id }));
      expect(list(listed, 'schedules').map((row) => field(row, 'id'))).toEqual([field(created, 'schedule', 'id')]);

      const refused = await client.call('openlinear_create_schedule', { ...args, title: 'No day', weekday: undefined });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('weekday');
      const badTime = await client.call('openlinear_create_schedule', { ...args, time: '24:00' });
      expect(badTime.isError).toBe(true);
    });
  });

  describe('project knowledge (W19b)', () => {
    it('proposes knowledge (keyed, retry-safe; always a proposal) and lists it', async () => {
      const { api } = harness;
      const { project } = freshProject('Knowledge', 'KNW');
      const args = { projectId: project.id, kind: 'convention', title: 'Use pnpm', body: 'Never npm or yarn.' };
      const proposed = ok(await client.call('openlinear_propose_knowledge', args));
      expect(field(proposed, 'entry')).toMatchObject({ kind: 'convention', title: 'Use pnpm', status: 'proposed', source: 'agent', version: 1 });
      expect(api.callsTo('POST', /\/knowledge$/).at(-1)?.body).toEqual({ kind: 'convention', title: 'Use pnpm', body: 'Never npm or yarn.' });
      const again = ok(await client.call('openlinear_propose_knowledge', args));
      expect(field(again, 'entry', 'id')).toBe(field(proposed, 'entry', 'id'));
      expect(field(again, 'idempotency', 'replayed')).toBe(true);

      const listed = ok(await client.call('openlinear_list_knowledge', { projectId: project.id }));
      expect(list(listed, 'entries').map((row) => field(row, 'title'))).toEqual(['Use pnpm']);
      const tooLong = await client.call('openlinear_propose_knowledge', { ...args, title: 'x'.repeat(121) });
      expect(tooLong.isError).toBe(true);
    });
  });

  describe('insights (W15b)', () => {
    it('reads one project or workspace document, keeps unknown cost explicit, and adds daily points only when asked', async () => {
      const { api } = harness;
      const { project } = freshProject('Insights', 'INS');
      const blocker = api.addTask({ title: 'Blocker', projectId: project.id, creatorId: seed.alice.id });
      const waiting = api.addTask({ title: 'Waiting', projectId: project.id, creatorId: seed.alice.id });
      api.addTask({ title: 'Shipped', projectId: project.id, creatorId: seed.alice.id, status: 'done' });
      api.dependencies.push({ taskId: waiting.id, dependsOnTaskId: blocker.id });
      api.insightsRuns = { total: 5, succeeded: 2, failed: 2, knownUsd: 0.4, unknownCostRuns: 1 };
      try {
        const result = ok(await client.call('openlinear_get_insights', { projectId: project.id, range: '7d' }));
        expect(api.callsTo('GET', /\/insights$/).at(-1)?.path).toBe(`/api/projects/${project.id}/insights`);
        expect(api.callsTo('GET', /\/insights$/).at(-1)?.query.get('range')).toBe('7d');
        expect(field(result, 'scope')).toEqual({ kind: 'project', id: project.id, projects: 1 });
        expect(field(result, 'runs', 'cost')).toEqual({ knownUsd: 0.4, runsWithCost: 3, unknownCostRuns: 1, coverage: 'partial' });
        expect(field(result, 'runs', 'byRunner')).toEqual([expect.objectContaining({ key: 'opencode', costUsd: 0.4, unknownCostRuns: 1 })]);
        expect(field(result, 'runs', 'successRate')).toBe(0.5);
        expect(field(result, 'delivery')).toMatchObject({ created: 3, completed: 1, openNow: 2, blockedNow: 1 });
        expect(field(result, 'runs', 'daily')).toBeUndefined();
        expect(field(result, 'notes', 'unknownCostRuns')).toContain('Never counted as $0');

        const daily = ok(await client.call('openlinear_get_insights', { workspaceId: seed.workspace.id, includeDaily: true }));
        expect(api.callsTo('GET', /\/insights$/).at(-1)?.path).toBe(`/api/workspaces/${seed.workspace.id}/insights`);
        expect(api.callsTo('GET', /\/insights$/).at(-1)?.query.get('range')).toBe('30d');
        expect(list(daily, 'runs', 'daily')).toHaveLength(30);
        expect(list(daily, 'delivery', 'daily')).toHaveLength(30);
        // A day with no recorded price is unknown (null), never $0.
        expect(list(daily, 'runs', 'daily')[0]).toMatchObject({ runs: 0, costUsd: null });

        // No run recorded a price: per-row cost is null (unknown), not 0.
        api.insightsRuns = { total: 2, succeeded: 1, failed: 1, knownUsd: 0, unknownCostRuns: 2 };
        const unpriced = ok(await client.call('openlinear_get_insights', { projectId: project.id, range: '7d', includeDaily: true }));
        expect(field(unpriced, 'runs', 'cost')).toEqual({ knownUsd: 0, runsWithCost: 0, unknownCostRuns: 2, coverage: 'none' });
        expect(field(unpriced, 'runs', 'byRunner')).toEqual([expect.objectContaining({ key: 'opencode', costUsd: null, unknownCostRuns: 2 })]);
        expect(list(unpriced, 'runs', 'daily').at(-1)).toMatchObject({ runs: 2, costUsd: null, unknownCostRuns: 2 });
      } finally {
        api.insightsRuns = { total: 0, succeeded: 0, failed: 0, knownUsd: 0, unknownCostRuns: 0 };
      }

      const both = await client.call('openlinear_get_insights', { projectId: project.id, workspaceId: seed.workspace.id });
      expect(both.isError).toBe(true);
      expect(both.text).toContain('exactly one of projectId or workspaceId');
      const neither = await client.call('openlinear_get_insights', {});
      expect(neither.isError).toBe(true);
      const badRange = await client.call('openlinear_get_insights', { projectId: project.id, range: '365d' });
      expect(badRange.isError).toBe(true);
    });
  });

  describe('openlinear_bulk_update_status', () => {
    it('moves project-less issues of a team with teamId and reports issues outside that scope', async () => {
      const { api } = harness;
      const t1 = api.addTask({ title: 'Team only 1', teamId: seed.team.id, creatorId: seed.alice.id });
      const t2 = api.addTask({ title: 'Team only 2', teamId: seed.team.id, creatorId: seed.alice.id });
      const inProject = api.addTask({ title: 'In project', projectId: seed.project.id, creatorId: seed.alice.id });
      const result = ok(
        await client.call('openlinear_bulk_update_status', {
          teamId: seed.team.id,
          taskIds: [t1.id, t2.id, inProject.id],
          status: 'done',
        }),
      );
      expect(ids(result, 'updated').sort()).toEqual([t1.id, t2.id].sort());
      expect(field(result, 'failed')).toEqual([
        { taskId: inProject.id, error: "Issue was not found among the team's issues without a project" },
      ]);
      expect(inProject.status).toBe('todo');
      expect(harness.api.callsTo('PATCH', /bulk-status$/).at(-1)?.body).toEqual({
        teamId: seed.team.id,
        status: 'done',
        taskIds: [t1.id, t2.id, inProject.id],
      });
    });

    it('needs exactly one of projectId or teamId before calling the API', async () => {
      const before = harness.api.callsTo('PATCH', /bulk-status$/).length;
      const taskIds = [randomUUID()];
      for (const scope of [{}, { projectId: seed.project.id, teamId: seed.team.id }]) {
        const result = await client.call('openlinear_bulk_update_status', { ...scope, taskIds, status: 'done' });
        expect(result.isError).toBe(true);
        expect(result.text).toContain('exactly one of projectId or teamId');
      }
      expect(harness.api.callsTo('PATCH', /bulk-status$/)).toHaveLength(before);
    });

    it('maps TASK_IDS_REQUIRED and BULK_SCOPE_INVALID to actionable messages', async () => {
      for (const [code, expected] of [
        ['TASK_IDS_REQUIRED', 'list the issues to change in taskIds'],
        ['BULK_SCOPE_INVALID', 'pass exactly one of projectId (issues of that project) or teamId'],
      ] as const) {
        harness.api.fail({ method: 'PATCH', path: /bulk-status$/, status: 400, body: envelope(code, 'refused') });
        const result = await client.call('openlinear_bulk_update_status', {
          projectId: seed.project.id,
          taskIds: [randomUUID()],
          status: 'done',
        });
        expect(result.isError).toBe(true);
        expect(result.text).toContain(code);
        expect(result.text).toContain(expected);
      }
    });
  });

  describe('openlinear_create_issue', () => {
    it('passes assigneeIds ("me" resolved, first = primary assignee)', async () => {
      const created = ok(
        await client.call('openlinear_create_issue', {
          projectId: seed.project.id,
          title: 'Pair on this',
          assigneeIds: ['me', seed.bob.id, 'me'],
        }),
      );
      expect(field(created, 'issue', 'assignee', 'username')).toBe('alice');
      expect(harness.api.callsTo('POST', /^\/api\/tasks$/).at(-1)?.body).toMatchObject({
        assigneeIds: [seed.alice.id, seed.bob.id],
      });
      expect(harness.api.tasks.get(str(created, 'issue', 'id'))?.assigneeIds).toEqual([seed.alice.id, seed.bob.id]);

      const stranger = harness.api.addUser('mallory');
      const refused = await client.call('openlinear_create_issue', {
        projectId: seed.project.id,
        title: 'Stranger',
        assigneeIds: [stranger.id],
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain(`Users are not members of this team: ${stranger.id}`);
    });

    it('creates a project-less issue from teamId alone (and refuses labels on it)', async () => {
      const created = ok(await client.call('openlinear_create_issue', { teamId: seed.team.id, title: 'Team chore' }));
      expect(field(created, 'issue', 'projectId')).toBeNull();
      expect(field(created, 'issue', 'teamId')).toBe(seed.team.id);
      expect(str(created, 'issue', 'identifier')).toMatch(/^AUTH-\d+$/);
      const label = [...harness.api.labels.values()].find((item) => item.projectId === seed.project.id);
      const refused = await client.call('openlinear_create_issue', {
        teamId: seed.team.id,
        title: 'Team chore with label',
        labelIds: [label?.id ?? randomUUID()],
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('Cannot attach labels to a task with no project');
    });
  });

  describe('FE-02 / W11a: agent selection and verification evidence', () => {
    it('create_issue and update_issue set the agent runner; unknown runners are refused before the API', async () => {
      const created = ok(await client.call('openlinear_create_issue', { projectId: seed.project.id, title: 'Run me with Codex', agent: 'codex' }));
      expect(field(created, 'issue', 'agent')).toBe('codex');
      expect(harness.api.callsTo('POST', /^\/api\/tasks$/).at(-1)?.body).toMatchObject({ agent: 'codex' });
      const taskId = str(created, 'issue', 'id');
      const updated = ok(await client.call('openlinear_update_issue', { taskId, agent: 'claude-code' }));
      expect(field(updated, 'issue', 'agent')).toBe('claude-code');
      expect(field(ok(await client.call('openlinear_update_issue', { taskId, agent: null })), 'issue', 'agent')).toBeNull();
      expect(harness.api.tasks.get(taskId)?.agent).toBeNull();
      const refused = await client.call('openlinear_update_issue', { taskId, agent: 'devin' });
      expect(refused.isError).toBe(true);
    });

    it('get_issue returns the latest verification evidence; null without any, or on an API that predates it', async () => {
      const task = harness.api.addTask({ title: 'Verified', projectId: seed.project.id, creatorId: seed.alice.id });
      harness.api.verifications.set(task.id, [{
        commitSha: 'a'.repeat(40), status: 'failed', policy: 'require-pass', publication: 'blocked', source: 'project', runner: 'opencode',
        checks: [{ id: 'unit', name: 'Unit tests', status: 'failed', required: true, exitCode: 1 }, { id: 'lint', name: 'Lint', status: 'passed', required: false }],
        warnings: [], detail: null, finishedAt: '2026-10-27T10:00:00.000Z', createdAt: '2026-10-27T10:00:01.000Z',
      }]);
      const withEvidence = ok(await client.call('openlinear_get_issue', { taskId: task.id, includeComments: false, includeSubtasks: false }));
      expect(field(withEvidence, 'verification')).toEqual({
        commitSha: 'a'.repeat(40), status: 'failed', policy: 'require-pass', publication: 'blocked',
        checks: [{ name: 'Unit tests', status: 'failed', required: true }, { name: 'Lint', status: 'passed', required: false }],
        detail: null, finishedAt: '2026-10-27T10:00:00.000Z',
      });

      const before = harness.api.requests.length;
      const skipped = ok(await client.call('openlinear_get_issue', { taskId: task.id, includeComments: false, includeVerification: false }));
      expect(field(skipped, 'verification')).toBeNull();
      expect(workSince(before).some((request) => request.path.endsWith('/verifications'))).toBe(false);

      const none = harness.api.addTask({ title: 'Never verified', projectId: seed.project.id, creatorId: seed.alice.id });
      expect(field(ok(await client.call('openlinear_get_issue', { taskId: none.id, includeComments: false })), 'verification')).toBeNull();

      harness.api.verificationRouteMissing = true;
      try {
        expect(field(ok(await client.call('openlinear_get_issue', { taskId: task.id, includeComments: false })), 'verification')).toBeNull();
      } finally {
        harness.api.verificationRouteMissing = false;
      }
    });
  });

  describe('teams moving into new projects', () => {
    it('create_project adopts a movable team instead of creating a default team', async () => {
      const { project: source } = freshProject('Source', 'SRC');
      const mobile = harness.api.addTeam(source.id, 'Mobile', 'MOBL', seed.alice.id);
      const created = ok(await client.call('openlinear_create_project', { name: 'Mobile App', teamIds: [mobile.id] }));
      expect(field(created, 'project', 'teams')).toEqual([{ id: mobile.id, key: 'MOBL', name: 'Mobile' }]);
      expect(harness.api.teams.get(mobile.id)?.projectId).toBe(str(created, 'project', 'id'));
    });

    it('lists every per-team reason of a refused move', async () => {
      const { project: source } = freshProject('Busy source', 'BSY');
      const busy = harness.api.addTeam(source.id, 'Busy', 'BUSY', seed.alice.id);
      harness.api.addTask({ title: 'Keeps the team busy', projectId: source.id, teamId: busy.id, creatorId: seed.alice.id });
      const result = await client.call('openlinear_create_project', { name: 'Never created', teamIds: [busy.id] });
      expect(result.isError).toBe(true);
      expect(result.text).toContain(`team ${busy.id} still has issues in its current project (TEAM_HAS_PROJECT_TASKS)`);
      expect([...harness.api.projects.values()].some((project) => project.name === 'Never created')).toBe(false);
    });

    it('bulk_create_plan with teamId numbers the plan with the moved team', async () => {
      const { project: source } = freshProject('Plan source', 'PLS');
      const growth = harness.api.addTeam(source.id, 'Growth', 'GRW', seed.alice.id);
      const plan = ok(
        await client.call('openlinear_bulk_create_plan', {
          teamId: growth.id,
          project: { name: 'Growth Plan', key: 'GPL' },
          phases: [{ name: 'Start', tasks: [{ title: 'Kickoff' }] }],
        }),
      );
      expect(field(plan, 'status')).toBe('complete');
      expect(field(plan, 'teamId')).toBe(growth.id);
      const taskId = str(plan, 'phases', 0, 'taskIds', 0);
      expect(harness.api.tasks.get(taskId)?.identifier).toBe('GRW-1');
    });

    it('bulk_create_plan records blockers between plan tasks by key; a re-run adds none twice', async () => {
      const args = {
        project: { name: 'Ordered Plan', key: 'ORD' },
        phases: [
          { name: 'Base', tasks: [{ title: 'Schema', key: 'schema' }, { title: 'Docs' }] },
          { name: 'Build', tasks: [{ title: 'API', key: 'api', blockedBy: ['schema'] }, { title: 'UI', key: 'ui', blockedBy: ['api', 'schema'] }] },
        ],
      };
      const plan = ok(await client.call('openlinear_bulk_create_plan', args));
      expect(field(plan, 'status')).toBe('complete');
      expect(field(plan, 'dependencies')).toEqual({ requested: 3, added: 3, existing: 0, failed: [] });
      expect(str(plan, 'summary')).toContain('and 3 blockers');
      const [schemaId] = list(plan, 'phases', 0, 'taskIds') as string[];
      const [apiId, uiId] = list(plan, 'phases', 1, 'taskIds') as string[];
      expect(harness.api.dependencies.filter((edge) => edge.taskId === uiId).map((edge) => edge.dependsOnTaskId).sort()).toEqual([apiId, schemaId].sort());
      expect(harness.api.dependencies.filter((edge) => edge.taskId === apiId).map((edge) => edge.dependsOnTaskId)).toEqual([schemaId]);

      const again = ok(await client.call('openlinear_bulk_create_plan', args));
      expect(field(again, 'dependencies')).toEqual({ requested: 3, added: 0, existing: 3, failed: [] });
      expect(harness.api.dependencies.filter((edge) => edge.taskId === uiId)).toHaveLength(2);
    });

    it('bulk_create_plan refuses unknown blockers and loops before creating anything', async () => {
      for (const [tasks, message] of [
        [[{ title: 'A', key: 'a', blockedBy: ['nope'] }], 'not a task key in this plan'],
        [[{ title: 'A', key: 'a', blockedBy: ['b'] }, { title: 'B', key: 'b', blockedBy: ['a'] }], 'block each other in a loop'],
        [[{ title: 'A', key: 'a' }, { title: 'B', key: 'a' }], 'used twice'],
        [[{ title: 'A', blockedBy: ['a'] }], 'has no key'],
      ] as const) {
        const before = harness.api.requests.length;
        const result = await client.call('openlinear_bulk_create_plan', { project: { name: 'Never made' }, phases: [{ name: 'Only', tasks }] });
        expect(result.isError).toBe(true);
        expect(result.text).toContain(message);
        expect(workSince(before)).toEqual([]);
      }
    });
  });

  it('explains a per-token rate limit (429 scope principal)', async () => {
    harness.api.fail({
      method: 'GET',
      path: /^\/api\/tasks$/,
      status: 429,
      body: envelope('RATE_LIMITED', 'Too many requests', { scope: 'principal', retryAfterSeconds: 12 }),
      headers: { 'Retry-After': '12' },
    });
    const result = await client.call('openlinear_list_issues', {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain('rate limit reached for this personal access token');
    expect(result.text).toContain('Wait 12 seconds');
  });
});

describe('tokens with W02b family scopes', () => {
  let harness: Harness;
  let seed: ReturnType<typeof seedBasics>;
  let client: TestClient;

  beforeAll(async () => {
    harness = await startHarness();
    seed = seedBasics(harness.api);
    const narrow = harness.api.addPat(seed.alice.id, { scopes: ['tasks:write', 'projects:read'] });
    client = await connectClient('v2-modern', harness.mcpUrl, narrow);
  });
  afterAll(async () => {
    await client.close();
    await harness.stop();
  });

  it('serves a token that cannot read its owner; "me" goes to the API where it can', async () => {
    const task = harness.api.addTask({ title: 'Mine', projectId: seed.project.id, creatorId: seed.alice.id, assigneeId: seed.alice.id });
    const mine = ok(await client.call('openlinear_list_issues', { assignee: 'me' }));
    expect(ids(mine, 'issues')).toEqual([task.id]);
    expect(harness.api.callsTo('GET', /^\/api\/tasks$/).at(-1)?.query.get('assignee')).toBe('me');

    const before = harness.api.callsTo('PATCH', /^\/api\/tasks\//).length;
    const assign = await client.call('openlinear_assign_issue', { taskId: task.id, assignee: 'me' });
    expect(assign.isError).toBe(true);
    expect(assign.text).toContain('"me" cannot be used in assignee with this token');
    expect(harness.api.callsTo('PATCH', /^\/api\/tasks\//)).toHaveLength(before);
    ok(await client.call('openlinear_assign_issue', { taskId: task.id, assignee: seed.alice.id }));
  });

  it('names both the tool scopes and the scope the API asked for', async () => {
    const result = await client.call('openlinear_create_project', { name: 'Out of scope' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('lacks the scope openlinear_create_project needs (write or projects:write)');
    expect(result.text).toContain('this step asked for projects:write');
  });
});

/*
 * Identifier lookup safety: a team key is unique per workspace only, so
 * SHR-1 can exist twice. An answer that was not read to the end (more pages
 * than the lookup reads, or hasMore without a cursor) can hide the other
 * SHR-1, so even a single match is refused there; acting on it could update
 * the wrong issue.
 */
describe('openlinear_get_issue identifier lookup', () => {
  let harness: Harness;
  let seed: ReturnType<typeof seedBasics>;
  let client: TestClient;
  /** The newest SHR-1, in the seed workspace. */
  let newest: FakeTask;
  /** An older SHR-1 in another workspace, behind every filler. */
  let older: FakeTask;
  let unique: FakeTask;

  beforeAll(async () => {
    harness = await startHarness();
    seed = seedBasics(harness.api);
    client = await connectClient('v1-legacy', harness.mcpUrl, seed.token);
    const { api } = harness;
    const elsewhere = api.addWorkspace('Elsewhere', { [seed.alice.id]: 'owner' });
    older = api.addTask({ title: 'Older SHR-1', projectId: api.addProject(elsewhere.id, seed.alice.id, 'Twin', 'SHR').project.id, creatorId: seed.alice.id });
    // More issues mentioning both identifiers than the lookup reads by substring.
    const fillers = api.addProject(seed.workspace.id, seed.alice.id, 'Fillers', 'FIL').project;
    for (let index = 0; index < MAX_IDENTIFIER_PAGES * IDENTIFIER_PAGE_SIZE; index += 1) {
      api.addTask({ title: `Filler ${index}`, description: 'Follow-up of SHR-1 and UNQ-1', projectId: fillers.id, creatorId: seed.alice.id });
    }
    unique = api.addTask({ title: 'Only UNQ-1', projectId: api.addProject(seed.workspace.id, seed.alice.id, 'Unique', 'UNQ').project.id, creatorId: seed.alice.id });
    newest = api.addTask({ title: 'Newest SHR-1', projectId: api.addProject(seed.workspace.id, seed.alice.id, 'Shared', 'SHR').project.id, creatorId: seed.alice.id });
    expect([older.identifier, unique.identifier, newest.identifier]).toEqual(['SHR-1', 'UNQ-1', 'SHR-1']);
  });
  afterAll(async () => {
    await client.close();
    await harness.stop();
  });
  afterEach(() => {
    harness.api.identifierFilterMissing = false;
    harness.api.failures.splice(0);
  });

  const lookupsSince = (index: number) => harness.api.requests.slice(index).filter((request) => request.path === '/api/tasks');
  const fetchesSince = (index: number) => harness.api.requests.slice(index).filter((request) => /^\/api\/tasks\/[^/]+$/.test(request.path));

  it('finds an exact match with the identifier filter in one request, however many issues mention it', async () => {
    const before = harness.api.requests.length;
    const found = ok(await client.call('openlinear_get_issue', { identifier: 'unq-1', includeComments: false }));
    expect(field(found, 'issue', 'id')).toBe(unique.id);
    const lookups = lookupsSince(before);
    expect(lookups).toHaveLength(1);
    expect(lookups[0]?.query.get('identifier')).toBe('unq-1');
  });

  it('sees the twin on another workspace through the identifier filter and refuses the ambiguity', async () => {
    const before = harness.api.requests.length;
    const result = await client.call('openlinear_get_issue', { identifier: 'SHR-1' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('matches several issues');
    expect(result.text).toContain(newest.id);
    expect(result.text).toContain(older.id);
    expect(fetchesSince(before)).toEqual([]);
  });

  it('refuses a single match when the pages were not exhausted (an API without the identifier filter)', async () => {
    harness.api.identifierFilterMissing = true;
    const before = harness.api.requests.length;
    const result = await client.call('openlinear_get_issue', { identifier: 'SHR-1' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('cannot be resolved safely');
    expect(result.text).toContain('Call again with taskId');
    expect(result.text).toContain(newest.id);
    expect(result.text).not.toContain(older.id);
    expect(lookupsSince(before)).toHaveLength(MAX_IDENTIFIER_PAGES);
    expect(fetchesSince(before)).toEqual([]);
  });

  it('treats hasMore without nextCursor as not exhausted', async () => {
    const { labelIds: _labels, assigneeIds: _assignees, ...row } = unique;
    harness.api.fail({
      method: 'GET',
      path: /^\/api\/tasks$/,
      status: 200,
      body: { items: [row], pageSize: IDENTIFIER_PAGE_SIZE, hasMore: true, nextCursor: null },
    });
    const before = harness.api.requests.length;
    const result = await client.call('openlinear_get_issue', { identifier: 'UNQ-1' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('cannot be resolved safely');
    expect(result.text).toContain(unique.id);
    expect(lookupsSince(before)).toHaveLength(1);
    expect(fetchesSince(before)).toEqual([]);
  });

  it('refuses an identifier the API filter would reject before calling it', async () => {
    const before = harness.api.requests.length;
    const result = await client.call('openlinear_get_issue', { identifier: 'ABCDEFGHIJK-1' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/identifier/);
    expect(lookupsSince(before)).toEqual([]);
  });
});

describe('describeFailure for the W14 codes', () => {
  const context = { tool: 'openlinear_list_issues', scopes: ['read'], safeToRetry: true };
  const failure = (status: number, code: string, details?: unknown, message = 'refused') =>
    describeFailure(new OpenLinearApiError(status, 'GET', '/api/tasks', { code, message, details }), context);

  it('explains PAGINATION_CONFLICT and the default (per-IP) rate-limit scope', () => {
    expect(failure(400, 'PAGINATION_CONFLICT', undefined, 'page cannot be combined with cursor pagination').message).toContain(
      'page cannot be combined with cursor pagination',
    );
    const limited = describeFailure(
      new OpenLinearApiError(429, 'GET', '/api/tasks', { code: 'RATE_LIMITED', details: { scope: 'default' }, retryAfterSeconds: 3 }),
      context,
    );
    expect(limited.code).toBe('RATE_LIMITED');
    expect(limited.message).toContain('for this network address (default)');
  });

  it('keeps a readable TEAM_PROJECT_CONFLICT message when the API sends no reasons', () => {
    expect(failure(409, 'TEAM_PROJECT_CONFLICT').message).toContain('Omit teamId/teamIds');
    expect(
      failure(409, 'TEAM_PROJECT_CONFLICT', { teams: [{ teamId: 't1', reason: 'OTHER_WORKSPACE' }, { teamId: 't2', reason: 'NEW_REASON' }] })
        .message,
    ).toContain('team t1 is in another workspace than the project (OTHER_WORKSPACE); team t2 cannot move (NEW_REASON)');
  });
});
