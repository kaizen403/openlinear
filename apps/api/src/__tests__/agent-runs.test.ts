import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { createApp } from '../app';
import { prisma } from '@openlinear/db';
import { testJwtSecret } from './test-env';
import { useTestServer } from './http';

const JWT_SECRET = testJwtSecret();

function generateToken(userId: string, username = 'agent-run-tester') {
  return jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '1h' });
}

describe('Agent run progress ingest', () => {
  const app = createApp();
  const http = useTestServer(() => app);
  let userId = '';
  let token = '';
  let taskId = '';
  let runId = '';

  beforeAll(async () => {
    const user = await prisma.user.upsert({
      where: { githubId: 'agent-run-progress' },
      update: {},
      create: {
        githubId: 'agent-run-progress',
        username: 'agentrunprogress',
        email: 'agentrunprogress@example.com',
        accessToken: 'fake-token',
      },
    });
    userId = user.id;
    token = generateToken(user.id, user.username);

    const workspace = await prisma.workspace.create({
      data: { name: 'Agent Run WS', slug: `agent-run-ws-${Date.now()}` },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId, role: 'owner' },
    });
    const project = await prisma.project.create({
      data: { name: 'Agent Run Project', workspaceId: workspace.id, key: 'ARP', defaultAgent: 'opencode' },
    });
    await prisma.projectAccess.create({
      data: { projectId: project.id, userId, permission: 'full' },
    });
    const team = await prisma.team.create({
      data: { name: 'Agent Run Team', key: 'ART', projectId: project.id },
    });
    await prisma.teamMember.create({ data: { teamId: team.id, userId, role: 'owner' } });
    const task = await prisma.task.create({
      data: { title: 'Progress task', priority: 'medium', teamId: team.id, projectId: project.id, agent: 'codex' },
    });
    taskId = task.id;
  }, 30_000);

  afterAll(async () => {
    if (taskId) {
      await prisma.agentRunEvent.deleteMany({ where: { run: { taskId } } }).catch(() => undefined);
      await prisma.agentRun.deleteMany({ where: { taskId } });
      await prisma.task.deleteMany({ where: { id: taskId } });
    }
  }, 30_000);

  it('rejects anonymous progress ingest', async () => {
    const res = await http().post('/api/agent-runs/progress').send({
      runId: '00000000-0000-4000-8000-000000000000',
      events: [{ seq: 1, type: 'heartbeat' }],
    });
    expect(res.status).toBe(401);
  });

  it('creates a run, ingests batched events with run: sse ids, and lists usage columns', async () => {
    const created = await http()
      .post('/api/agent-runs')
      .set('Authorization', `Bearer ${token}`)
      .send({ taskId, agent: 'opencode', model: 'test/model', runner: 'opencode' });
    expect(created.status).toBe(201);
    runId = created.body.id as string;

    const progress = await http()
      .post('/api/agent-runs/progress')
      .set('Authorization', `Bearer ${token}`)
      .send({
        runId,
        events: [
          { seq: 1, type: 'session.started', payload: { t: 'session.started' } },
          { seq: 2, type: 'usage', payload: { t: 'usage', usage: { input: 3, output: 4, cacheRead: 1, cacheWrite: 2, reasoning: 5 } } },
        ],
      });
    expect(progress.status).toBe(200);
    expect(progress.body.stored[0].sseId).toBe(`run:${runId}:1`);
    expect(progress.body.stored[1].sseId).toBe(`run:${runId}:2`);

    const patched = await http()
      .patch(`/api/agent-runs/${runId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        status: 'succeeded',
        inputTokens: 3,
        outputTokens: 4,
        cachedInputTokens: 1,
        cacheWriteTokens: 2,
        reasoningTokens: 5,
        costBasis: 'opencode.message.updated',
      });
    expect(patched.status).toBe(200);
    expect(patched.body.cachedInputTokens).toBe(1);
    expect(patched.body.reasoningTokens).toBe(5);

    const listed = await http()
      .get('/api/agent-runs')
      .query({ taskId })
      .set('Authorization', `Bearer ${token}`);
    expect(listed.status).toBe(200);
    expect(listed.body.items[0].runner).toBe('opencode');
    expect(listed.body.items[0].cachedInputTokens).toBe(1);
  });
});

describe('Agent run updates: recorded cost and the run owner', () => {
  const app = createApp();
  const http = useTestServer(() => app);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const created = { users: [] as string[], workspaceId: '', projectId: '', teamId: '', taskId: '' };
  let ownerToken = '';
  let adminToken = '';

  async function startRun(): Promise<string> {
    const res = await http()
      .post('/api/agent-runs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ taskId: created.taskId, agent: 'opencode', model: 'test/model' });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  beforeAll(async () => {
    const owner = await prisma.user.create({ data: { username: `run-owner-${suffix}`, email: `run-owner-${suffix}@example.com` } });
    const admin = await prisma.user.create({ data: { username: `run-admin-${suffix}`, email: `run-admin-${suffix}@example.com` } });
    created.users.push(owner.id, admin.id);
    ownerToken = generateToken(owner.id, owner.username);
    adminToken = generateToken(admin.id, admin.username);

    const workspace = await prisma.workspace.create({ data: { name: 'Run Owner WS', slug: `run-owner-ws-${suffix}` } });
    created.workspaceId = workspace.id;
    await prisma.workspaceMember.createMany({ data: [
      { workspaceId: workspace.id, userId: owner.id, role: 'owner' },
      { workspaceId: workspace.id, userId: admin.id, role: 'admin' },
    ] });
    const project = await prisma.project.create({ data: { name: 'Run Owner Project', workspaceId: workspace.id, key: 'ROP' } });
    created.projectId = project.id;
    await prisma.projectAccess.createMany({ data: [
      { projectId: project.id, userId: owner.id, permission: 'full' },
      { projectId: project.id, userId: admin.id, permission: 'full' },
    ] });
    const team = await prisma.team.create({ data: { name: 'Run Owner Team', key: 'ROT', projectId: project.id } });
    created.teamId = team.id;
    const task = await prisma.task.create({ data: { title: 'Run owner task', teamId: team.id, projectId: project.id, workspaceId: workspace.id } });
    created.taskId = task.id;
  }, 30_000);

  afterAll(async () => {
    if (created.taskId) await prisma.task.deleteMany({ where: { id: created.taskId } });
    if (created.teamId) await prisma.team.deleteMany({ where: { id: created.teamId } });
    if (created.projectId) await prisma.project.deleteMany({ where: { id: created.projectId } });
    if (created.workspaceId) await prisma.workspace.deleteMany({ where: { id: created.workspaceId } });
    await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  }, 30_000);

  it("refuses a co-member with full task access who rewrites another user's run, and insights keep the owner's figures", async () => {
    const runId = await startRun();
    const own = await http()
      .patch(`/api/agent-runs/${runId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ status: 'succeeded', endedAt: new Date().toISOString(), costUsd: 9.5 });
    expect(own.status).toBe(200);

    // The admin has full access to the task (it may report progress) ...
    const progress = await http()
      .post('/api/agent-runs/progress')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ runId, events: [{ seq: 1, type: 'heartbeat' }] });
    expect(progress.status).toBe(200);

    // ... but not rewrite the owner's outcome or cost.
    for (const body of [{ status: 'failed' }, { costUsd: 1 }, { prUrl: 'https://github.com/o/r/pull/9' }]) {
      const res = await http().patch(`/api/agent-runs/${runId}`).set('Authorization', `Bearer ${adminToken}`).send(body);
      expect(res.status, JSON.stringify(body)).toBe(403);
      expect(res.body.code).toBe('AGENT_RUN_NOT_OWNER');
    }
    // The reviewer's repro body is refused before any ownership question.
    const repro = await http().patch(`/api/agent-runs/${runId}`).set('Authorization', `Bearer ${adminToken}`).send({ costUsd: -1000, status: 'failed' });
    expect(repro.status).toBe(400);

    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.status).toBe('succeeded');
    expect(Number(row.costUsd)).toBe(9.5);
    expect(row.prUrl).toBeNull();

    const insights = await http().get(`/api/projects/${created.projectId}/insights?range=7d`).set('Authorization', `Bearer ${adminToken}`);
    expect(insights.status).toBe(200);
    // The reviewer's repro turned these into knownUsd -993 and a 0 success rate.
    expect(insights.body.runs.successRate).toBe(1);
    expect(insights.body.runs.cost).toEqual({ knownUsd: 9.5, runsWithCost: 1, unknownCostRuns: 0, coverage: 'complete' });
  });

  it('refuses a zero, negative, non-numeric or out-of-range cost and negative token counts', async () => {
    const runId = await startRun();
    for (const body of [{ costUsd: 0 }, { costUsd: -1000 }, { costUsd: -0.01 }, { costUsd: 100_001 }, { costUsd: '9.5' }, { inputTokens: -1 }, { reasoningTokens: 1.5 }]) {
      const res = await http().patch(`/api/agent-runs/${runId}`).set('Authorization', `Bearer ${ownerToken}`).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    }
    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.costUsd).toBeNull();
    expect(row.inputTokens).toBeNull();
  });

  it('lets the user who started the run record its outcome and cost', async () => {
    const runId = await startRun();
    const res = await http()
      .patch(`/api/agent-runs/${runId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ status: 'succeeded', endedAt: new Date().toISOString(), costUsd: 9.5, inputTokens: 0 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('succeeded');
    expect(Number(res.body.costUsd)).toBe(9.5);
    const max = await http().patch(`/api/agent-runs/${runId}`).set('Authorization', `Bearer ${ownerToken}`).send({ costUsd: 100_000 });
    expect(max.status).toBe(200);
  });

  it("refuses edits to a run the execution service records (its attempt callbacks own the outcome and cost)", async () => {
    const runId = await startRun();
    const owner = created.users[0] ?? '';
    const attempt = await prisma.executionAttempt.create({ data: {
      taskId: created.taskId, userId: owner, status: 'closed', authSource: 'session', snapshot: {}, projectId: created.projectId, teamId: created.teamId, agentRunId: runId,
    } });
    try {
      const res = await http().patch(`/api/agent-runs/${runId}`).set('Authorization', `Bearer ${ownerToken}`).send({ status: 'succeeded', costUsd: 1 });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('AGENT_RUN_MANAGED');
    } finally {
      await prisma.executionAttempt.delete({ where: { id: attempt.id } });
    }
  });

  it('answers 404 for an unknown run', async () => {
    const res = await http()
      .patch('/api/agent-runs/00000000-0000-4000-8000-000000000000')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ status: 'failed' });
    expect(res.status).toBe(404);
  });
});
