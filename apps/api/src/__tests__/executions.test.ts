/**
 * W03a execution control plane: start/claim, capability authentication,
 * (attempt, seq) idempotent events, the W01 fences moved server-side
 * (terminal, logs, publication), run finalization rules, cancellation
 * acknowledgement, git credential issue and capability revocation.
 *
 * Runs against real PostgreSQL (TEST_DATABASE_URL). Fixtures delete only the
 * rows they create.
 */
import { createHash, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { encryptToken, prisma } from '@openlinear/db';
import { createApp } from '../app';
import { generatePersonalAccessToken, hashPersonalAccessToken } from '../services/pats';
import { testJwtSecret } from './test-env';
import { useTestServer } from './http';

const RUN = randomUUID().slice(0, 8);
const app = createApp();
const http = useTestServer(() => app);
const REPO_FULL_NAME = `acme-${RUN}/w03a`;
const PR_URL = `https://github.com/${REPO_FULL_NAME}/pull/7`;

function sign(userId: string, username: string): string {
  return jwt.sign({ userId, username }, testJwtSecret(), { expiresIn: '1h' });
}

function code(body: unknown): string | undefined {
  return typeof body === 'object' && body !== null && typeof (body as { code?: unknown }).code === 'string'
    ? (body as { code: string }).code
    : undefined;
}

const ids = {
  users: [] as string[],
  workspaces: [] as string[],
  projects: [] as string[],
  repositories: [] as string[],
};

const actors = {
  owner: { id: '', jwt: '' },
  viewer: { id: '', jwt: '' },
  denied: { id: '', jwt: '' },
  outsider: { id: '', jwt: '' },
};
let workspaceA = '';
let workspaceB = '';
let projectA = '';
let projectOther = '';
let teamA = '';
let readOnlyPat = '';
let boundToOtherPat = '';
let boundToTaskWorkspacePat = '';
let ownerWritePat = '';
let ownerWritePatId = '';

async function makeUser(label: string, withGithub = false) {
  const user = await prisma.user.create({
    data: {
      username: `w03a-${label}-${RUN}`,
      email: `w03a-${label}-${RUN}@example.com`,
      ...(withGithub ? { accessToken: encryptToken(`gho_w03a_${label}_token_value_0123456789`) } : {}),
    },
  });
  ids.users.push(user.id);
  return user;
}

async function makePat(userId: string, scopes: string[], workspaceId: string | null = null) {
  const token = generatePersonalAccessToken();
  const row = await prisma.personalAccessToken.create({
    data: {
      userId,
      name: `w03a-${RUN}`,
      tokenHash: hashPersonalAccessToken(token),
      tokenPrefix: token.slice(0, 15),
      scopes,
      workspaceId,
    },
  });
  return { token, id: row.id };
}

async function makeTask(overrides: { title?: string; status?: 'todo' | 'in_progress' | 'done' | 'cancelled'; archived?: boolean; sessionId?: string } = {}) {
  return prisma.task.create({
    data: {
      title: overrides.title ?? `w03a task ${randomUUID().slice(0, 6)}`,
      description: 'W03a fixture',
      model: 'stub/model',
      status: overrides.status ?? 'todo',
      sessionId: overrides.sessionId ?? null,
      archived: overrides.archived ?? false,
      projectId: projectA,
      teamId: teamA,
      workspaceId: workspaceA,
      creatorId: actors.owner.id,
      batchId: 'legacy-batch-link',
    },
  });
}

async function start(taskId: string, bearer = actors.owner.jwt) {
  return http().post('/api/executions/attempts').set('Authorization', `Bearer ${bearer}`).send({ taskId });
}

interface Started {
  attemptId: string;
  token: string;
}

async function startOk(taskId: string, bearer = actors.owner.jwt): Promise<Started> {
  const res = await start(taskId, bearer);
  expect(res.status).toBe(201);
  return { attemptId: res.body.attempt.id as string, token: res.body.capability.token as string };
}

function callback(started: Started, action: string, body: unknown = {}, token = started.token) {
  return http()
    .post(`/api/executions/attempts/${started.attemptId}/${action}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body as object);
}

async function claimOk(started: Started, sessionId = `ses_${randomUUID().slice(0, 8)}`) {
  const res = await callback(started, 'claim', { sessionId, runner: 'opencode', model: 'stub/model' });
  expect(res.status).toBe(200);
  return { sessionId, agentRunId: res.body.agentRunId as string };
}

beforeAll(async () => {
  const owner = await makeUser('owner', true);
  const viewer = await makeUser('viewer');
  const denied = await makeUser('denied');
  const outsider = await makeUser('outsider');
  actors.owner = { id: owner.id, jwt: sign(owner.id, owner.username) };
  actors.viewer = { id: viewer.id, jwt: sign(viewer.id, viewer.username) };
  actors.denied = { id: denied.id, jwt: sign(denied.id, denied.username) };
  actors.outsider = { id: outsider.id, jwt: sign(outsider.id, outsider.username) };

  const wsA = await prisma.workspace.create({ data: { name: `W03a A ${RUN}`, slug: `w03a-a-${RUN}` } });
  const wsB = await prisma.workspace.create({ data: { name: `W03a B ${RUN}`, slug: `w03a-b-${RUN}` } });
  workspaceA = wsA.id;
  workspaceB = wsB.id;
  ids.workspaces.push(wsA.id, wsB.id);
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: wsA.id, userId: owner.id, role: 'owner' },
      { workspaceId: wsA.id, userId: viewer.id, role: 'member' },
      { workspaceId: wsA.id, userId: denied.id, role: 'member' },
      { workspaceId: wsB.id, userId: owner.id, role: 'owner' },
      { workspaceId: wsB.id, userId: outsider.id, role: 'owner' },
    ],
  });
  const repository = await prisma.repository.create({
    data: {
      userId: owner.id,
      githubRepoId: 700_000 + Math.floor(Math.random() * 99_999),
      name: 'w03a',
      fullName: REPO_FULL_NAME,
      cloneUrl: `https://github.com/${REPO_FULL_NAME}.git`,
      defaultBranch: 'main',
    },
  });
  ids.repositories.push(repository.id);
  const project = await prisma.project.create({
    data: { name: `W03a project ${RUN}`, workspaceId: wsA.id, key: `WA${RUN.slice(0, 3).toUpperCase()}`, repositoryId: repository.id },
  });
  projectA = project.id;
  const other = await prisma.project.create({ data: { name: `W03a other ${RUN}`, workspaceId: wsA.id } });
  projectOther = other.id;
  ids.projects.push(project.id, other.id);
  await prisma.projectAccess.createMany({
    data: [
      { projectId: project.id, userId: viewer.id, permission: 'view' },
      { projectId: project.id, userId: denied.id, permission: 'deny' },
    ],
  });
  const team = await prisma.team.create({ data: { name: `W03a team ${RUN}`, key: `W3${RUN.slice(0, 2).toUpperCase()}`, projectId: project.id } });
  teamA = team.id;
  await prisma.teamMember.createMany({
    data: [
      { teamId: team.id, userId: owner.id, role: 'owner' },
      { teamId: team.id, userId: viewer.id, role: 'member' },
      { teamId: team.id, userId: denied.id, role: 'member' },
    ],
  });
  readOnlyPat = (await makePat(owner.id, ['read'])).token;
  boundToOtherPat = (await makePat(owner.id, ['tasks:write'], wsB.id)).token;
  boundToTaskWorkspacePat = (await makePat(owner.id, ['tasks:write'], wsA.id)).token;
  const writePat = await makePat(owner.id, ['tasks:write']);
  ownerWritePat = writePat.token;
  ownerWritePatId = writePat.id;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await prisma.domainEvent.deleteMany({ where: { OR: [{ userIds: { hasSome: ids.users } }, { workspaceIds: { hasSome: ids.workspaces } }] } });
  await prisma.task.deleteMany({ where: { workspaceId: { in: ids.workspaces } } });
  await prisma.project.deleteMany({ where: { id: { in: ids.projects } } });
  await prisma.workspace.deleteMany({ where: { id: { in: ids.workspaces } } });
  await prisma.repository.deleteMany({ where: { id: { in: ids.repositories } } });
  await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
});

describe('W03a start: authorization and snapshot', () => {
  it('starts an attempt for a full-access principal without touching the task row', async () => {
    const task = await makeTask();
    const before = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    const res = await start(task.id);
    expect(res.status).toBe(201);
    expect(res.body.attempt).toMatchObject({ taskId: task.id, status: 'preparing' });
    expect(res.body.capability.token).toMatch(/^olx_[A-Za-z0-9_-]{43}$/);
    expect(res.body.capability.scopes).toEqual(expect.arrayContaining([
      'execution:status', 'execution:progress', 'execution:logs', 'execution:terminal', 'execution:git-credential',
    ]));
    expect(res.body.snapshot).toMatchObject({
      schemaVersion: 1,
      task: {
        id: task.id,
        projectId: projectA,
        teamId: teamA,
        creatorId: actors.owner.id,
        project: { id: projectA, repository: { fullName: REPO_FULL_NAME, defaultBranch: 'main' } },
      },
      authority: { id: task.id, projectId: projectA, teamId: teamA, creatorId: actors.owner.id, archived: false, status: 'todo' },
      settings: { parallelLimit: 3 },
    });
    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toEqual(before);

    const capability = await prisma.executionCapability.findFirstOrThrow({ where: { attemptId: res.body.attempt.id } });
    expect(capability.tokenHash).toBe(createHash('sha256').update(res.body.capability.token).digest('hex'));
    expect(capability.tokenHash).not.toContain(res.body.capability.token);
    expect(capability.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(2 * 60 * 60 * 1000);
    const attempt = await prisma.executionAttempt.findUniqueOrThrow({ where: { id: res.body.attempt.id } });
    expect(JSON.stringify(attempt)).not.toContain(res.body.capability.token);
  });

  it('denies foreign, view-only, explicitly denied and wrong-workspace principals with no attempt created', async () => {
    const task = await makeTask();
    const cases: Array<[string, string, number[]]> = [
      ['viewer', actors.viewer.jwt, [403]],
      ['denied', actors.denied.jwt, [403, 404]],
      ['outsider', actors.outsider.jwt, [403, 404]],
      ['bound-to-other-workspace PAT', boundToOtherPat, [403, 404]],
    ];
    for (const [label, bearer, statuses] of cases) {
      const res = await start(task.id, bearer);
      expect(statuses, `${label} -> ${res.status} ${code(res.body)}`).toContain(res.status);
    }
    const readOnly = await start(task.id, readOnlyPat);
    expect(readOnly.status).toBe(403);
    expect(code(readOnly.body)).toBe('INSUFFICIENT_SCOPE');
    expect(await prisma.executionAttempt.count({ where: { taskId: task.id } })).toBe(0);
  });

  it('refuses archived and already-running tasks', async () => {
    const archived = await makeTask({ archived: true });
    const running = await makeTask({ status: 'in_progress', sessionId: 'ses_other_execution' });
    expect(code((await start(archived.id)).body)).toBe('TASK_ARCHIVED');
    expect(code((await start(running.id)).body)).toBe('TASK_ALREADY_RUNNING');
  });

  it('starts and claims a task the user moved to In Progress (the column is not a running execution)', async () => {
    // The board's flow: Move → status in_progress (no session) → Execute.
    const staged = await makeTask({ status: 'in_progress' });
    const started = await startOk(staged.id);
    const { sessionId } = await claimOk(started);
    expect(await prisma.task.findUniqueOrThrow({ where: { id: staged.id } })).toMatchObject({ status: 'in_progress', sessionId });
    // Now it is held: a second start is refused.
    expect(code((await start(staged.id)).body)).toBe('TASK_ALREADY_RUNNING');
  });
});

describe('W03a capability authentication', () => {
  it('accepts only the attempt capability on attempt callbacks', async () => {
    const task = await makeTask();
    const started = await startOk(task.id);
    const otherTask = await makeTask();
    const other = await startOk(otherTask.id);
    const body = { events: [{ seq: 1, type: 'execution:progress', payload: { status: 'cloning', message: 'x' } }] };

    const none = await http().post(`/api/executions/attempts/${started.attemptId}/events`).send(body);
    expect([none.status, code(none.body)]).toEqual([401, 'CAPABILITY_REQUIRED']);
    for (const bearer of [actors.owner.jwt, ownerWritePat]) {
      const res = await callback(started, 'events', body, bearer);
      expect([res.status, code(res.body)]).toEqual([401, 'CAPABILITY_REQUIRED']);
    }
    const unknown = await callback(started, 'events', body, `olx_${'A'.repeat(43)}`);
    expect([unknown.status, code(unknown.body)]).toEqual([401, 'CAPABILITY_INVALID']);
    // A valid capability presented for a different attempt (foreign principal path).
    const foreign = await callback(started, 'events', body, other.token);
    expect([foreign.status, code(foreign.body)]).toEqual([403, 'CAPABILITY_ATTEMPT_MISMATCH']);

    await prisma.executionCapability.updateMany({ where: { attemptId: other.attemptId }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    const expired = await callback(other, 'events', body);
    expect([expired.status, code(expired.body)]).toEqual([401, 'CAPABILITY_EXPIRED']);

    await prisma.executionCapability.updateMany({ where: { attemptId: started.attemptId }, data: { scopes: ['execution:status'] } });
    const scoped = await callback(started, 'events', body);
    expect([scoped.status, code(scoped.body)]).toEqual([403, 'CAPABILITY_SCOPE_DENIED']);
  });

  it('never accepts a capability as a user credential', async () => {
    const task = await makeTask();
    const started = await startOk(task.id);
    const res = await http().get('/api/tasks').set('Authorization', `Bearer ${started.token}`);
    expect(res.status).toBe(401);
    const principal = await http().get('/api/executions/principal').set('Authorization', `Bearer ${started.token}`);
    expect(principal.status).toBe(401);
  });
});

describe('W03a claim: the fenced in_progress transition', () => {
  it('binds the provider session, clears the batch link and creates the agent run atomically', async () => {
    const task = await makeTask();
    const started = await startOk(task.id);
    const { sessionId, agentRunId } = await claimOk(started);
    const row = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(row).toMatchObject({ status: 'in_progress', sessionId, batchId: null, executionProgress: 0, executionElapsedMs: 0 });
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: agentRunId } })).toMatchObject({
      taskId: task.id, userId: actors.owner.id, runner: 'opencode', agent: 'opencode', model: 'stub/model',
      externalSessionId: sessionId, status: 'running',
    });
    const again = await callback(started, 'claim', { sessionId: 'ses_again', runner: 'opencode', model: 'stub/model' });
    expect([again.status, code(again.body)]).toEqual([409, 'ATTEMPT_STATE_CONFLICT']);
  });

  it('lets exactly one of two concurrent attempts claim a task', async () => {
    const task = await makeTask();
    const first = await startOk(task.id);
    const second = await startOk(task.id);
    const results = await Promise.all([first, second].map((started, index) =>
      callback(started, 'claim', { sessionId: `ses_race_${index}`, runner: 'opencode', model: 'stub/model' })));
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    const loser = results.find((res) => res.status === 409)!;
    expect(code(loser.body)).toBe('TASK_ALREADY_RUNNING');
    expect(await prisma.agentRun.count({ where: { taskId: task.id } })).toBe(1);
    const released = await prisma.executionAttempt.findFirstOrThrow({ where: { taskId: task.id, status: 'released' } });
    expect(released.closeReason).toBe('claim_rejected');
    expect(await prisma.executionCapability.count({ where: { attemptId: released.id, revokedAt: null } })).toBe(0);
  });

  it('rejects a claim after the binding changed and revokes that capability', async () => {
    const task = await makeTask();
    const started = await startOk(task.id);
    await prisma.task.update({ where: { id: task.id }, data: { creatorId: actors.viewer.id } });
    const before = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    const res = await callback(started, 'claim', { sessionId: 'ses_changed', runner: 'opencode', model: 'stub/model' });
    expect(res.status).toBe(409);
    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toEqual(before);
    const stale = await callback(started, 'heartbeat');
    expect([stale.status, code(stale.body)]).toEqual([401, 'CAPABILITY_REVOKED']);
  });

  it('re-authorizes the initiator: a revoked PAT or a new project deny stops the claim', async () => {
    const task = await makeTask();
    const pat = await makePat(actors.owner.id, ['tasks:write']);
    const viaPat = await startOk(task.id, pat.token);
    await prisma.personalAccessToken.update({ where: { id: pat.id }, data: { revokedAt: new Date() } });
    const revoked = await callback(viaPat, 'claim', { sessionId: 'ses_pat', runner: 'opencode', model: 'stub/model' });
    expect([revoked.status, code(revoked.body)]).toEqual([403, 'EXECUTION_ACCESS_REVOKED']);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('todo');
    expect((await prisma.executionAttempt.findUniqueOrThrow({ where: { id: viaPat.attemptId } })).status).toBe('released');

    // Member with an explicit full grant that becomes an explicit deny after start.
    const member = await makeUser('late-deny');
    await prisma.workspaceMember.create({ data: { workspaceId: workspaceA, userId: member.id, role: 'member' } });
    await prisma.teamMember.create({ data: { teamId: teamA, userId: member.id, role: 'member' } });
    await prisma.projectAccess.create({ data: { projectId: projectA, userId: member.id, permission: 'full' } });
    const memberTask = await makeTask();
    const memberJwt = sign(member.id, member.username);
    const memberStart = await startOk(memberTask.id, memberJwt);
    await prisma.projectAccess.updateMany({ where: { projectId: projectA, userId: member.id }, data: { permission: 'deny' } });
    const denied = await callback(memberStart, 'claim', { sessionId: 'ses_member', runner: 'opencode', model: 'stub/model' });
    expect([denied.status, code(denied.body)]).toEqual([403, 'EXECUTION_ACCESS_REVOKED']);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: memberTask.id } })).status).toBe('todo');
    await prisma.projectAccess.deleteMany({ where: { projectId: projectA, userId: member.id } });
  });
});

describe('W03a events: (attempt, sequence) idempotency and resource binding', () => {
  it('delivers each sequence once with the task binding and the attempt task id', async () => {
    const task = await makeTask();
    const foreignTask = await makeTask();
    const started = await startOk(task.id);
    const first = await callback(started, 'events', {
      events: [
        { seq: 1, type: 'execution:progress', payload: { taskId: foreignTask.id, status: 'cloning', message: `clone-${RUN}` } },
        { seq: 2, type: 'execution:log', payload: { entry: { timestamp: new Date().toISOString(), type: 'info', message: `log-${RUN}` } } },
      ],
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ accepted: 2, duplicates: 0, lastSeq: 2, cancelRequested: false });
    const retry = await callback(started, 'events', {
      events: [
        { seq: 2, type: 'execution:log', payload: { entry: { timestamp: new Date().toISOString(), type: 'info', message: `log-${RUN}` } } },
        { seq: 3, type: 'execution:progress', payload: { status: 'executing', message: `exec-${RUN}` } },
      ],
    });
    expect(retry.body).toMatchObject({ accepted: 1, duplicates: 1, lastSeq: 3 });

    const rows = await prisma.domainEvent.findMany({ where: { actorId: actors.owner.id, type: { in: ['execution:progress', 'execution:log'] } } });
    const mine = rows.filter((row) => JSON.stringify(row.payload).includes(RUN) && (row.payload as { taskId?: string }).taskId === task.id);
    expect(mine).toHaveLength(3);
    for (const row of mine) {
      expect(row).toMatchObject({ resourceType: 'project', projectId: projectA, workspaceId: workspaceA });
    }
    expect(rows.some((row) => (row.payload as { taskId?: string }).taskId === foreignTask.id)).toBe(false);
  });

  it('rejects malformed events and oversized batches', async () => {
    const task = await makeTask();
    const started = await startOk(task.id);
    const bad = await callback(started, 'events', { events: [{ seq: 1, type: 'task:updated', payload: {} }] });
    expect(bad.status).toBe(400);
    const tooMany = await callback(started, 'events', {
      events: Array.from({ length: 51 }, (_, index) => ({ seq: index + 1, type: 'execution:progress', payload: { status: 's', message: 'm' } })),
    });
    expect(tooMany.status).toBe(400);
  });
});

describe('W03a terminal and log fences (W01 semantics server-side)', () => {
  async function claimedTask() {
    const task = await makeTask();
    const started = await startOk(task.id);
    const claim = await claimOk(started);
    return { task, started, ...claim };
  }

  it.each([
    ['done', 'cancelled'], ['done', 'new-session'], ['done', 'project-moved'], ['done', 'team-moved'], ['done', 'creator-changed'],
    ['cancelled', 'cancelled'], ['cancelled', 'new-session'], ['cancelled', 'project-moved'], ['cancelled', 'team-moved'], ['cancelled', 'creator-changed'],
  ] as const)('rejects a %s projection after %s replaced the binding', async (status, replacement) => {
    const { task, started } = await claimedTask();
    const data = replacement === 'cancelled' ? { status: 'cancelled' as const, sessionId: null }
      : replacement === 'new-session' ? { sessionId: 'ses_replacement' }
        : replacement === 'project-moved' ? { projectId: projectOther }
          : replacement === 'team-moved' ? { teamId: null }
            : { creatorId: actors.viewer.id };
    await prisma.task.update({ where: { id: task.id }, data: { ...data, executionLogs: [{ message: 'replacement logs' }] } });
    const before = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    const res = await callback(started, 'terminal', { status, prUrl: PR_URL, outcome: 'stale terminal write' });
    expect([res.status, code(res.body)]).toEqual([409, 'TASK_FENCE_REJECTED']);
    const logs = await callback(started, 'logs', { logs: [{ timestamp: new Date().toISOString(), type: 'agent', message: 'stale' }] });
    expect(logs.body).toEqual({ persisted: false });
    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toEqual(before);
  });

  it('requires a confirmed pull request on the attempt repository for done', async () => {
    const { task, started } = await claimedTask();
    for (const prUrl of [
      null,
      `https://github.com/${REPO_FULL_NAME}/compare/main...openlinear/x`,
      'https://github.com/someone-else/repo/pull/1',
      `http://github.com/${REPO_FULL_NAME}/pull/1`,
    ]) {
      const res = await callback(started, 'terminal', { status: 'done', prUrl });
      expect([res.status, code(res.body)]).toEqual([422, 'PUBLICATION_UNVERIFIED']);
    }
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('in_progress');
  });

  it('persists logs before and after a confirmed terminal write and never rewrites the projection', async () => {
    const { task, started, agentRunId } = await claimedTask();
    const entry = (message: string) => ({ timestamp: new Date().toISOString(), type: 'agent' as const, message });
    expect((await callback(started, 'logs', { logs: [entry('during')] })).body).toEqual({ persisted: true });
    const done = await callback(started, 'terminal', {
      status: 'done', prUrl: PR_URL, outcome: '1 file changed', executionElapsedMs: 1234, executionProgress: 100,
    });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'finishing', terminalStatus: 'done', repeated: false });
    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
      status: 'done', sessionId: null, prUrl: PR_URL, outcome: '1 file changed', executionElapsedMs: 1234, executionProgress: 100,
    });
    expect((await callback(started, 'logs', { logs: [entry('during'), entry('after')] })).body).toEqual({ persisted: true });
    const afterLogs = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(afterLogs.executionLogs).toHaveLength(2);

    const repeat = await callback(started, 'terminal', { status: 'done', prUrl: PR_URL, outcome: 'must not rewrite' });
    expect(repeat.body).toMatchObject({ repeated: true });
    const conflicting = await callback(started, 'terminal', { status: 'cancelled', outcome: 'must not rewrite' });
    expect([conflicting.status, code(conflicting.body)]).toEqual([409, 'ATTEMPT_TERMINAL_CONFLICT']);
    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toEqual(afterLogs);

    const run = await callback(started, 'run', {
      status: 'succeeded', prUrl: PR_URL,
      usage: { costUsd: 0.25, inputTokens: 10, outputTokens: 5, cachedInputTokens: 1, cacheWriteTokens: 2, reasoningTokens: 3, costBasis: 'opencode.message.updated' },
    });
    expect(run.body).toEqual({ agentRunId, finalized: true });
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: agentRunId } })).toMatchObject({
      status: 'succeeded', prUrl: PR_URL, inputTokens: 10, outputTokens: 5, cachedInputTokens: 1, cacheWriteTokens: 2, reasoningTokens: 3,
    });
    const again = await callback(started, 'run', { status: 'failed', errorMessage: 'late' });
    expect(again.body).toEqual({ agentRunId, finalized: false });
  });

  it('does not let logs land after a replacement took over a terminal row', async () => {
    const { task, started } = await claimedTask();
    await callback(started, 'terminal', { status: 'cancelled', outcome: 'old cancellation' });
    await prisma.task.update({ where: { id: task.id }, data: { status: 'in_progress', sessionId: 'ses_new_owner', executionLogs: [{ message: 'new owner' }] } });
    const before = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    const res = await callback(started, 'logs', { logs: [{ timestamp: new Date().toISOString(), type: 'info', message: 'old' }] });
    expect(res.body).toEqual({ persisted: false });
    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toEqual(before);
  });
});

describe('W03a run finalization, cancellation and close', () => {
  it('refuses success without done and cancellation without a positive stop receipt', async () => {
    const task = await makeTask();
    const started = await startOk(task.id);
    const { agentRunId } = await claimOk(started);
    expect(code((await callback(started, 'run', { status: 'succeeded' })).body)).toBe('RUN_SUCCESS_UNCONFIRMED');
    expect(code((await callback(started, 'run', { status: 'cancelled' })).body)).toBe('CANCEL_NOT_ACKNOWLEDGED');
    expect((await callback(started, 'cancellation', { stopConfirmed: false })).status).toBe(400);

    const cancelled = await callback(started, 'terminal', { status: 'cancelled', outcome: 'cancelled by user', executionPausedAt: new Date().toISOString() });
    expect(cancelled.status).toBe(200);
    const ack = await callback(started, 'cancellation', { stopConfirmed: true });
    expect(ack.status).toBe(200);
    expect(ack.body.cancelAcknowledgedAt).toEqual(expect.any(String));
    expect((await callback(started, 'run', { status: 'cancelled', errorMessage: 'cancelled by user' })).body).toEqual({ agentRunId, finalized: true });
  });

  it('delivers a cloud cancellation request to the attempt and denies a stale capability after close', async () => {
    const task = await makeTask();
    const started = await startOk(task.id);
    await claimOk(started);
    const requested = await http()
      .post(`/api/executions/tasks/${task.id}/cancellation`)
      .set('Authorization', `Bearer ${actors.owner.jwt}`)
      .send({});
    expect(requested.status).toBe(202);
    expect(requested.body).toMatchObject({ attemptId: started.attemptId });
    expect((await callback(started, 'heartbeat')).body).toMatchObject({ cancelRequested: true, status: 'running' });
    const viewerRequest = await http()
      .post(`/api/executions/tasks/${task.id}/cancellation`)
      .set('Authorization', `Bearer ${actors.viewer.jwt}`)
      .send({});
    expect(viewerRequest.status).toBe(403);

    await callback(started, 'terminal', { status: 'cancelled', outcome: 'cancelled remotely' });
    const closed = await callback(started, 'close', {});
    expect(closed.body).toMatchObject({ status: 'closed', terminalStatus: 'cancelled', closeReason: 'completed' });
    for (const action of ['events', 'logs', 'terminal', 'heartbeat', 'git-credential', 'close']) {
      const body = action === 'events'
        ? { events: [{ seq: 99, type: 'execution:progress', payload: { status: 's', message: 'late' } }] }
        : action === 'logs' ? { logs: [] }
          : action === 'terminal' ? { status: 'cancelled' }
            : action === 'git-credential' ? { purpose: 'publish' } : {};
      const res = await callback(started, action, body);
      expect([res.status, code(res.body)], action).toEqual([401, 'CAPABILITY_REVOKED']);
    }
  });

  it('closes an unfinished claimed attempt as abandoned without touching the task', async () => {
    const task = await makeTask();
    const started = await startOk(task.id);
    const { sessionId } = await claimOk(started);
    const res = await callback(started, 'close', {});
    expect(res.body).toMatchObject({ status: 'closed', closeReason: 'abandoned' });
    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'in_progress', sessionId });
  });

  it('releases a preparing attempt on close', async () => {
    const task = await makeTask();
    const started = await startOk(task.id);
    expect((await callback(started, 'close', { reason: 'setup_failed' })).body).toMatchObject({ status: 'released', closeReason: 'setup_failed' });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('todo');
  });
});

describe('W03a git credential', () => {
  it('issues the initiator token for clone and publish only while the attempt owns the task', async () => {
    const task = await makeTask();
    const started = await startOk(task.id);
    const clone = await callback(started, 'git-credential', { purpose: 'clone' });
    expect(clone.status).toBe(200);
    expect(clone.body).toMatchObject({ provider: 'github', purpose: 'clone', token: 'gho_w03a_owner_token_value_0123456789' });
    expect(clone.headers['cache-control']).toBe('no-store');
    expect(code((await callback(started, 'git-credential', { purpose: 'publish' })).body)).toBe('ATTEMPT_STATE_CONFLICT');
    await claimOk(started);
    expect((await callback(started, 'git-credential', { purpose: 'publish' })).status).toBe(200);
    await prisma.task.update({ where: { id: task.id }, data: { sessionId: 'ses_replacement' } });
    const fenced = await callback(started, 'git-credential', { purpose: 'publish' });
    expect([fenced.status, code(fenced.body)]).toEqual([409, 'TASK_FENCE_REJECTED']);
  });

  it('never releases the account-wide token to an attempt started with a workspace-bound PAT', async () => {
    const task = await makeTask();
    const started = await startOk(task.id, boundToTaskWorkspacePat);
    const res = await callback(started, 'git-credential', { purpose: 'clone' });
    expect([res.status, code(res.body)]).toEqual([403, 'PAT_WORKSPACE_RESTRICTED']);
  });

  it('stops issuing after the initiating PAT is revoked', async () => {
    const task = await makeTask();
    const started = await startOk(task.id, ownerWritePat);
    expect((await callback(started, 'git-credential', { purpose: 'clone' })).status).toBe(200);
    await prisma.personalAccessToken.update({ where: { id: ownerWritePatId }, data: { revokedAt: new Date() } });
    const res = await callback(started, 'git-credential', { purpose: 'clone' });
    expect([res.status, code(res.body)]).toEqual([403, 'EXECUTION_ACCESS_REVOKED']);
  });
});

describe('W03a sidecar read surface', () => {
  it('validates principals for the sidecar', async () => {
    const res = await http().get('/api/executions/principal').set('Authorization', `Bearer ${actors.owner.jwt}`);
    expect(res.body).toEqual({ userId: actors.owner.id, username: `w03a-owner-${RUN}`, authSource: 'session', scopes: [], workspaceId: null });
    const pat = await http().get('/api/executions/principal').set('Authorization', `Bearer ${boundToOtherPat}`);
    expect(pat.body).toMatchObject({ userId: actors.owner.id, authSource: 'pat', scopes: ['tasks:write'], workspaceId: workspaceB });
    expect((await http().get('/api/executions/principal')).status).toBe(401);
  });

  it('describes task access for status, logs and cancellation decisions', async () => {
    const task = await makeTask();
    const access = async (bearer: string) => http()
      .get(`/api/executions/tasks/${task.id}/access`).set('Authorization', `Bearer ${bearer}`);
    expect((await access(actors.owner.jwt)).body).toMatchObject({ permission: 'full', canWrite: true, authority: { id: task.id } });
    expect((await access(readOnlyPat)).body).toMatchObject({ permission: 'full', canWrite: false });
    expect((await access(actors.viewer.jwt)).body).toMatchObject({ permission: 'view', canWrite: false });
    expect([403, 404]).toContain((await access(actors.denied.jwt)).status);
    expect([403, 404]).toContain((await access(actors.outsider.jwt)).status);
  });

  it('serves persisted logs to full-access principals only', async () => {
    const task = await makeTask();
    await prisma.task.update({ where: { id: task.id }, data: { executionLogs: [{ message: 'persisted' }] } });
    const owner = await http().get(`/api/executions/tasks/${task.id}/logs`).set('Authorization', `Bearer ${actors.owner.jwt}`);
    expect(owner.body).toEqual({ logs: [{ message: 'persisted' }] });
    const viewer = await http().get(`/api/executions/tasks/${task.id}/logs`).set('Authorization', `Bearer ${actors.viewer.jwt}`);
    expect(viewer.status).toBe(403);
  });

  it('refreshes a compare link into the confirmed pull request', async () => {
    const task = await makeTask();
    const compare = `https://github.com/${REPO_FULL_NAME}/compare/main...openlinear/w03a`;
    await prisma.task.update({ where: { id: task.id }, data: { prUrl: compare } });
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => new Response(JSON.stringify([{ html_url: PR_URL }]), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const res = await http()
        .post(`/api/executions/tasks/${task.id}/refresh-pr`)
        .set('Authorization', `Bearer ${actors.owner.jwt}`)
        .send({});
      expect(res.body).toEqual({ prUrl: PR_URL, refreshed: true });
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`head=acme-${RUN}%3Aopenlinear%2Fw03a`);
    } finally {
      vi.unstubAllGlobals();
    }
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).prUrl).toBe(PR_URL);
  });
});
