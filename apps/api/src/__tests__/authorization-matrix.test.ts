import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { createApp } from '../app';
import { prisma } from '@openlinear/db';
import { testJwtSecret } from './test-env';
import { ROUTE_REGISTRY, assertRegistryComplete } from '../registry';
import { useTestServer } from './http';

const JWT_SECRET = testJwtSecret();
const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function sign(userId: string, username: string) {
  return jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '1h' });
}

describe('Route registry', () => {
  it('declares scope and PAT scopes for every session_or_pat route', () => {
    expect(() => assertRegistryComplete(ROUTE_REGISTRY)).not.toThrow();
    expect(ROUTE_REGISTRY.length).toBeGreaterThan(40);
  });
});

describe('Authorization matrix (F-020 / F-023 / F-026)', () => {
  const app = createApp();
  const http = useTestServer(() => app);
  const ids = {
    owner: '',
    member: '',
    workspace: '',
    project: '',
    team: '',
    task: '',
  };
  let ownerToken = '';
  let memberToken = '';

  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: {
        githubId: `matrix-owner-${suffix}`,
        username: `matrix-owner-${suffix}`,
        email: `matrix-owner-${suffix}@example.com`,
      },
    });
    const member = await prisma.user.create({
      data: {
        githubId: `matrix-member-${suffix}`,
        username: `matrix-member-${suffix}`,
        email: `matrix-member-${suffix}@example.com`,
      },
    });
    ids.owner = owner.id;
    ids.member = member.id;
    ownerToken = sign(owner.id, owner.username);
    memberToken = sign(member.id, member.username);

    const workspace = await prisma.workspace.create({
      data: { name: `Matrix WS ${suffix}`, slug: `matrix-ws-${suffix}` },
    });
    ids.workspace = workspace.id;
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId: workspace.id, userId: owner.id, role: 'owner' },
        { workspaceId: workspace.id, userId: member.id, role: 'member' },
      ],
    });

    const project = await prisma.project.create({
      data: { name: 'Matrix Project', workspaceId: workspace.id, key: 'MTX' },
    });
    ids.project = project.id;

    const team = await prisma.team.create({
      data: { name: 'Matrix Team', key: 'MTX', projectId: project.id },
    });
    ids.team = team.id;
    await prisma.teamMember.createMany({
      data: [
        { teamId: team.id, userId: owner.id, role: 'owner' },
        { teamId: team.id, userId: member.id, role: 'member' },
      ],
    });

    const task = await prisma.task.create({
      data: {
        title: 'Owner archived',
        status: 'todo',
        priority: 'medium',
        teamId: team.id,
        projectId: project.id,
        creatorId: owner.id,
        archived: true,
        number: 1,
        identifier: 'MTX-1',
      },
    });
    ids.task = task.id;
  });

  afterAll(async () => {
    await prisma.task.deleteMany({ where: { projectId: ids.project } });
    await prisma.label.deleteMany({ where: { projectId: ids.project } });
    await prisma.teamMember.deleteMany({ where: { teamId: ids.team } });
    await prisma.team.deleteMany({ where: { id: ids.team } });
    await prisma.project.deleteMany({ where: { id: ids.project } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: ids.workspace } });
    await prisma.workspace.deleteMany({ where: { id: ids.workspace } });
    await prisma.user.deleteMany({ where: { id: { in: [ids.owner, ids.member] } } });
  });

  it('lets a workspace member read labels but not create them', async () => {
    const list = await http()
      .get(`/api/labels?projectId=${ids.project}`)
      .set('Authorization', `Bearer ${memberToken}`);
    expect(list.status).toBe(200);

    const created = await http()
      .post('/api/labels')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ projectId: ids.project, name: 'Nope', color: '#ff0000' });
    expect(created.status).toBe(403);

    const ownerCreated = await http()
      .post('/api/labels')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ projectId: ids.project, name: 'Phase', color: '#00aa00' });
    expect(ownerCreated.status).toBe(201);
  });

  it('does not let a workspace member wipe archived tasks they cannot write', async () => {
    const wipe = await http()
      .delete('/api/tasks/archived')
      .set('Authorization', `Bearer ${memberToken}`);
    expect(wipe.status).toBe(204);

    const remaining = await prisma.task.findUnique({ where: { id: ids.task } });
    expect(remaining).not.toBeNull();
  });

  it('cascades team membership when a workspace member is removed', async () => {
    const extra = await prisma.user.create({
      data: {
        githubId: `matrix-extra-${suffix}`,
        username: `matrix-extra-${suffix}`,
        email: `matrix-extra-${suffix}@example.com`,
      },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: ids.workspace, userId: extra.id, role: 'member' },
    });
    await prisma.teamMember.create({
      data: { teamId: ids.team, userId: extra.id, role: 'member' },
    });

    const removed = await http()
      .delete(`/api/workspaces/${ids.workspace}/members/${extra.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(removed.status).toBe(204);

    const teamRow = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: ids.team, userId: extra.id } },
    });
    expect(teamRow).toBeNull();
    await prisma.user.delete({ where: { id: extra.id } });
  });
});
