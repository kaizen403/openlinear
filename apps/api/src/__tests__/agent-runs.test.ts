import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../app';
import { prisma } from '@openlinear/db';
import { testJwtSecret } from './test-env';

const JWT_SECRET = testJwtSecret();

function generateToken(userId: string, username = 'agent-run-tester') {
  return jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '1h' });
}

describe('Agent run progress ingest', () => {
  const app = createApp();
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
    const res = await request(app).post('/api/agent-runs/progress').send({
      runId: '00000000-0000-4000-8000-000000000000',
      events: [{ seq: 1, type: 'heartbeat' }],
    });
    expect(res.status).toBe(401);
  });

  it('creates a run, ingests batched events with run: sse ids, and lists usage columns', async () => {
    const created = await request(app)
      .post('/api/agent-runs')
      .set('Authorization', `Bearer ${token}`)
      .send({ taskId, agent: 'opencode', model: 'test/model', runner: 'opencode' });
    expect(created.status).toBe(201);
    runId = created.body.id as string;

    const progress = await request(app)
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

    const patched = await request(app)
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

    const listed = await request(app)
      .get('/api/agent-runs')
      .query({ taskId })
      .set('Authorization', `Bearer ${token}`);
    expect(listed.status).toBe(200);
    expect(listed.body.items[0].runner).toBe('opencode');
    expect(listed.body.items[0].cachedInputTokens).toBe(1);
  });
});
