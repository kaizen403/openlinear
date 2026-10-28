/**
 * W15a: per-run budgets live on the user's settings, are validated (API and
 * DB constraint), and are sealed into each attempt's snapshot at start.
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
let userId = '';
let projectId = '';
let teamId = '';
let workspaceId = '';

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

beforeAll(async () => {
  const user = await prisma.user.create({ data: { username: `w15a-${RUN}`, email: `w15a-${RUN}@example.com` } });
  userId = user.id;
  ids.users.push(user.id);
  token = jwt.sign({ userId: user.id, username: user.username }, testJwtSecret(), { expiresIn: '1h' });
  const workspace = await prisma.workspace.create({ data: { name: `W15a ${RUN}`, slug: `w15a-${RUN}` } });
  workspaceId = workspace.id;
  ids.workspaces.push(workspace.id);
  await prisma.workspaceMember.create({ data: { workspaceId, userId, role: 'owner' } });
  const project = await prisma.project.create({ data: { name: `W15a ${RUN}`, workspaceId, key: `WD${RUN.slice(0, 3).toUpperCase()}` } });
  projectId = project.id;
  const team = await prisma.team.create({ data: { name: `W15a team ${RUN}`, key: `TD${RUN.slice(0, 2).toUpperCase()}`, projectId } });
  teamId = team.id;
  await prisma.teamMember.create({ data: { teamId, userId, role: 'owner' } });

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
  await prisma.workspace.deleteMany({ where: { id: { in: ids.workspaces } } });
  await prisma.settings.deleteMany({ where: { userId: { in: ids.users } } });
  await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
});

describe('W15a run budgets', () => {
  it('validates the limits and clears them with null', async () => {
    expect((await api('PATCH', '/api/settings', { maxRunCostUsd: 2.5, maxRunTokens: 200_000 })).body).toMatchObject({ maxRunCostUsd: 2.5, maxRunTokens: 200_000 });
    for (const bad of [{ maxRunCostUsd: -1 }, { maxRunCostUsd: 0 }, { maxRunCostUsd: 20_000 }, { maxRunTokens: 10 }, { maxRunTokens: 1.5 }]) {
      expect((await api('PATCH', '/api/settings', bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await api('PATCH', '/api/settings', { maxRunCostUsd: null })).body).toMatchObject({ maxRunCostUsd: null, maxRunTokens: 200_000 });
  });

  it('the database refuses out-of-range values written around the API', async () => {
    await expect(prisma.settings.update({ where: { userId }, data: { maxRunTokens: 5 } })).rejects.toThrow();
  });

  it('a started attempt carries the budgets in its snapshot', async () => {
    await api('PATCH', '/api/settings', { maxRunCostUsd: 1.25, maxRunTokens: 300_000 });
    const task = await prisma.task.create({ data: { title: 'Budgeted', model: 'stub/model', projectId, teamId, workspaceId, creatorId: userId } });
    const started = await api('POST', '/api/executions/attempts', { taskId: task.id });
    expect(started.status).toBe(201);
    expect((started.body.snapshot as { settings: Record<string, unknown> }).settings).toMatchObject({ maxRunCostUsd: 1.25, maxRunTokens: 300_000 });
  });
});
