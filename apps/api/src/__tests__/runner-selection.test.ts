/**
 * FE-02: the task agent and the project default agent are one of the
 * runners the execution engine knows; aliases are stored canonical and
 * anything else is refused at write time (not as a failed run later).
 *
 * Real PostgreSQL (TEST_DATABASE_URL); fixtures delete only what they create.
 */
import { randomUUID } from 'node:crypto';
import http, { type Server } from 'node:http';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@openlinear/db';
import { createApp } from '../app';
import { testJwtSecret } from './test-env';

const RUN = randomUUID().slice(0, 8);
const ids = { users: [] as string[], workspaces: [] as string[] };
let server: Server | undefined;
let baseUrl = '';
let token = '';
let projectId = '';

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

beforeAll(async () => {
  const user = await prisma.user.create({ data: { username: `fe02-${RUN}`, email: `fe02-${RUN}@example.com` } });
  ids.users.push(user.id);
  token = jwt.sign({ userId: user.id, username: user.username }, testJwtSecret(), { expiresIn: '1h' });
  const workspace = await prisma.workspace.create({ data: { name: `FE02 ${RUN}`, slug: `fe02-${RUN}` } });
  ids.workspaces.push(workspace.id);
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: 'owner' } });
  const project = await prisma.project.create({ data: { name: `FE02 project ${RUN}`, workspaceId: workspace.id, key: `FE${RUN.slice(0, 3).toUpperCase()}` } });
  projectId = project.id;
  const team = await prisma.team.create({ data: { name: `FE02 team ${RUN}`, key: `FT${RUN.slice(0, 2).toUpperCase()}`, projectId } });
  await prisma.teamMember.create({ data: { teamId: team.id, userId: user.id, role: 'owner' } });

  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
  await prisma.domainEventOutbox.deleteMany({ where: { OR: [{ userIds: { hasSome: ids.users } }, { workspaceIds: { hasSome: ids.workspaces } }] } });
  await prisma.domainEvent.deleteMany({ where: { OR: [{ userIds: { hasSome: ids.users } }, { workspaceIds: { hasSome: ids.workspaces } }] } });
  await prisma.task.deleteMany({ where: { workspaceId: { in: ids.workspaces } } });
  await prisma.task.deleteMany({ where: { projectId } });
  await prisma.workspace.deleteMany({ where: { id: { in: ids.workspaces } } });
  await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
});

describe('FE-02 runner selection', () => {
  it('stores a task agent canonically from create and update, and clears it with null', async () => {
    const created = await api('POST', '/api/tasks', { title: 'Pick a runner', projectId, agent: 'Claude' });
    expect(created.status).toBe(201);
    const taskId = created.body.id as string;
    expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).agent).toBe('claude-code');

    const updated = await api('PATCH', `/api/tasks/${taskId}`, { agent: 'openai' });
    expect(updated.status).toBe(200);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).agent).toBe('codex');

    expect((await api('PATCH', `/api/tasks/${taskId}`, { agent: null })).status).toBe(200);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).agent).toBeNull();
  });

  it('refuses unknown runners at write time', async () => {
    const refused = await api('POST', '/api/tasks', { title: 'Bad runner', projectId, agent: 'gpt-engineer' });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('Agent must be one of opencode, claude-code, codex');
    const created = await api('POST', '/api/tasks', { title: 'Good runner', projectId });
    expect((await api('PATCH', `/api/tasks/${created.body.id as string}`, { agent: 'devin' })).status).toBe(400);
  });

  it('the project default agent follows the same rules', async () => {
    expect((await api('PATCH', `/api/projects/${projectId}`, { defaultAgent: 'CODEX' })).status).toBe(200);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).defaultAgent).toBe('codex');
    expect((await api('PATCH', `/api/projects/${projectId}`, { defaultAgent: 'aider' })).status).toBe(400);
    expect((await api('PATCH', `/api/projects/${projectId}`, { defaultAgent: null })).status).toBe(200);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).defaultAgent).toBeNull();
  });
});
