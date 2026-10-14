import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { prisma } from '@openlinear/db';
import { JWT_AUDIENCE, JWT_ISSUER } from '@openlinear/api-core';
import { executionSseId } from '@openlinear/execution-core';
import { createApp } from '../app';
import { clients } from '../events/hub';
import { forgetSessionCache, hashToken } from '../services/sessions';
import { testJwtSecret } from './test-env';

type Actor = 'owner' | 'viewer' | 'denied' | 'outsider';
const actors: Actor[] = ['owner', 'viewer', 'denied', 'outsider'];
const suffix = randomUUID();
const originalPayload = { message: `private-run-payload-${suffix}` };

describe('Agent run replay and progress permissions', () => {
  const app = createApp();
  const userIds: Partial<Record<Actor, string>> = {};
  const tokens: Partial<Record<Actor, string>> = {};
  const workspaceIds: string[] = [];
  let runId = '';
  let server: Server | undefined;
  let baseUrl = '';

  beforeAll(async () => {
    for (const actor of actors) {
      const user = await prisma.user.create({
        data: {
          githubId: `run-access-${actor}-${suffix}`,
          username: `run-access-${actor}-${suffix}`,
          email: `run-access-${actor}-${suffix}@example.com`,
        },
      });
      userIds[actor] = user.id;
      const token = jwt.sign(
        { userId: user.id, username: user.username, typ: 'access' },
        testJwtSecret(),
        { expiresIn: '1h', issuer: JWT_ISSUER, audience: JWT_AUDIENCE, jwtid: randomUUID() },
      );
      tokens[actor] = token;
      await prisma.session.create({
        data: { userId: user.id, tokenHash: hashToken(token) },
      });
    }

    const workspace = await prisma.workspace.create({
      data: { name: 'Run access workspace', slug: `run-access-${suffix}` },
    });
    workspaceIds.push(workspace.id);
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId: workspace.id, userId: userIds.owner!, role: 'owner' },
        { workspaceId: workspace.id, userId: userIds.viewer!, role: 'member' },
        { workspaceId: workspace.id, userId: userIds.denied!, role: 'member' },
      ],
    });
    const project = await prisma.project.create({
      data: { name: 'Private run project', workspaceId: workspace.id, key: 'RAP' },
    });
    await prisma.projectAccess.createMany({
      data: [
        { projectId: project.id, userId: userIds.viewer!, permission: 'view' },
        { projectId: project.id, userId: userIds.denied!, permission: 'deny' },
      ],
    });
    const team = await prisma.team.create({
      data: { name: 'Run access team', key: 'RAT', projectId: project.id },
    });
    await prisma.teamMember.createMany({
      data: [
        { teamId: team.id, userId: userIds.owner!, role: 'owner' },
        { teamId: team.id, userId: userIds.viewer!, role: 'member' },
        { teamId: team.id, userId: userIds.denied!, role: 'member' },
      ],
    });
    const task = await prisma.task.create({
      data: {
        title: 'Private run task',
        projectId: project.id,
        teamId: team.id,
        workspaceId: workspace.id,
        creatorId: userIds.owner!,
      },
    });
    const run = await prisma.agentRun.create({
      data: { taskId: task.id, userId: userIds.owner!, agent: 'opencode', model: 'test/model' },
    });
    runId = run.id;
    await prisma.agentRunEvent.createMany({
      data: [
        { runId, seq: 1, type: 'message', payload: originalPayload },
        { runId, seq: 2, type: 'heartbeat', payload: { marker: 'replay-complete' } },
      ],
    });

    const otherWorkspace = await prisma.workspace.create({
      data: { name: 'Other tenant', slug: `run-access-other-${suffix}` },
    });
    workspaceIds.push(otherWorkspace.id);
    await prisma.workspaceMember.create({
      data: { workspaceId: otherWorkspace.id, userId: userIds.outsider!, role: 'owner' },
    });

    server = await new Promise<Server>((resolve, reject) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
      listening.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server) {
      const closing = new Promise<void>((resolve, reject) => {
        server!.close((error) => error ? reject(error) : resolve());
      });
      server.closeAllConnections();
      await closing;
    }
    const ids = Object.values(userIds);
    await prisma.domainEvent.deleteMany({ where: { userIds: { hasSome: ids } } });
    await prisma.task.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    for (const token of Object.values(tokens)) forgetSessionCache(hashToken(token));
  });

  async function replay(actor: Actor, cursorRunId = runId, queryCursor = false) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const cursor = executionSseId(cursorRunId, 0);
      const path = queryCursor ? `/api/events?lastEventId=${encodeURIComponent(cursor)}` : '/api/events';
      const response = await fetch(`${baseUrl}${path}`, {
        headers: {
          Authorization: `Bearer ${tokens[actor]!}`,
          ...(!queryCursor ? { 'Last-Event-ID': cursor } : {}),
        },
        signal: controller.signal,
      });
      if (!response.headers.get('content-type')?.includes('text/event-stream')) {
        return { status: response.status, body: await response.text() };
      }
      if (!response.body) throw new Error('Expected an SSE response body');
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let body = '';
      while (!body.includes(`id: ${executionSseId(cursorRunId, 2)}\n`)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        body += decoder.decode(chunk.value, { stream: true });
      }
      return { status: response.status, body };
    } finally {
      clearTimeout(timeout);
      await reader?.cancel().catch(() => undefined);
      controller.abort();
    }
  }

  it.each<Actor>(['outsider', 'denied'])('denies run replay to %s before opening a stream', async (actor) => {
    const initialClients = clients.size;
    const response = await replay(actor);
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body).code).toBe('OWNERSHIP_REQUIRED');
    expect(response.body).not.toContain(originalPayload.message);
    expect(response.body).not.toContain('event: connected');
    expect(clients.size).toBe(initialClients);
  });

  it('also checks a query-string execution replay cursor', async () => {
    const response = await replay('outsider', runId, true);
    expect(response.status).toBe(403);
    expect(response.body).not.toContain(originalPayload.message);
  });

  it('rejects a missing run before opening a stream', async () => {
    const initialClients = clients.size;
    const response = await replay('owner', randomUUID());
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body).code).toBe('NOT_FOUND');
    expect(clients.size).toBe(initialClients);
  });

  it.each<Actor>(['owner', 'viewer'])('replays journal records for an authorized %s', async (actor) => {
    const response = await replay(actor);
    expect(response.status).toBe(200);
    expect(response.body).toContain(`id: ${executionSseId(runId, 1)}\n`);
    expect(response.body).toContain(originalPayload.message);
    expect(response.body).toContain(`id: ${executionSseId(runId, 2)}\n`);
  });

  it.each<Actor>(['outsider', 'denied', 'viewer'])('denies progress writes by %s without journal or outbox changes', async (actor) => {
    const before = await prisma.agentRunEvent.findMany({ where: { runId }, orderBy: { seq: 'asc' } });
    const outboxCount = await prisma.domainEvent.count({ where: { userIds: { has: userIds.owner! } } });
    const response = await request(app)
      .post('/api/agent-runs/progress')
      .set('Authorization', `Bearer ${tokens[actor]!}`)
      .send({
        runId,
        events: [
          { seq: 1, type: 'message', payload: { message: 'overwrite-attempt' } },
          { seq: 99, type: 'heartbeat' },
        ],
      });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('OWNERSHIP_REQUIRED');
    expect(await prisma.agentRunEvent.findMany({ where: { runId }, orderBy: { seq: 'asc' } })).toEqual(before);
    expect(await prisma.domainEvent.count({ where: { userIds: { has: userIds.owner! } } })).toBe(outboxCount);
  });

  it('accepts progress from a caller with full task permission', async () => {
    const response = await request(app)
      .post('/api/agent-runs/progress')
      .set('Authorization', `Bearer ${tokens.owner!}`)
      .send({ runId, events: [{ seq: 3, type: 'heartbeat', payload: { allowed: true } }] });
    expect(response.status).toBe(200);
    expect(response.body.stored).toEqual([{ seq: 3, sseId: executionSseId(runId, 3) }]);
    expect(await prisma.agentRunEvent.findUnique({ where: { runId_seq: { runId, seq: 3 } } })).toMatchObject({ payload: { allowed: true } });
  });
});
