import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../app';
import { prisma } from '@openlinear/db';

const JWT_SECRET = 'openlinear-dev-secret-change-in-production';

function generateToken(userId: string, username: string) {
  return jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '1h' });
}

async function cleanup() {
  await prisma.activityLog.deleteMany({});
  await prisma.projectTeam.deleteMany({});
  await prisma.task.updateMany({
    where: { teamId: { not: null } },
    data: { teamId: null },
  });
  await prisma.teamMember.deleteMany({});
  await prisma.team.deleteMany({});
}

async function createUser(githubId: string, username: string) {
  return prisma.user.upsert({
    where: { githubId },
    update: { username, email: `${username}@example.com` },
    create: {
      githubId,
      username,
      email: `${username}@example.com`,
    },
  });
}

async function createTeam(ownerId: string, key: string) {
  const team = await prisma.team.create({
    data: {
      name: `Team ${key}`,
      key,
      members: {
        create: {
          userId: ownerId,
          role: 'owner',
        },
      },
    },
  });
  return team;
}

describe('Team member role management', () => {
  const app = createApp();
  let owner: Awaited<ReturnType<typeof createUser>>;
  let admin: Awaited<ReturnType<typeof createUser>>;
  let member: Awaited<ReturnType<typeof createUser>>;
  let viewer: Awaited<ReturnType<typeof createUser>>;
  let ownerToken: string;
  let adminToken: string;
  let memberToken: string;

  beforeAll(async () => {
    await cleanup();
    owner = await createUser('team-members-owner', 'team_owner');
    admin = await createUser('team-members-admin', 'team_admin');
    member = await createUser('team-members-member', 'team_member');
    viewer = await createUser('team-members-viewer', 'team_viewer');
    ownerToken = generateToken(owner.id, owner.username);
    adminToken = generateToken(admin.id, admin.username);
    memberToken = generateToken(member.id, member.username);
  }, 30000);

  afterAll(async () => {
    await cleanup();
  }, 30000);

  it('lets an owner update a member role', async () => {
    const team = await createTeam(owner.id, 'TMR1');
    await prisma.teamMember.create({
      data: { teamId: team.id, userId: member.id, role: 'member' },
    });

    const res = await request(app)
      .patch(`/api/teams/${team.id}/members/${member.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ role: 'admin' });

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(member.id);
    expect(res.body.role).toBe('admin');
    expect(res.body.user.username).toBe(member.username);
  });

  it('lets an admin update non-owner roles', async () => {
    const team = await createTeam(owner.id, 'TMR2');
    await prisma.teamMember.create({
      data: { teamId: team.id, userId: admin.id, role: 'admin' },
    });
    await prisma.teamMember.create({
      data: { teamId: team.id, userId: member.id, role: 'member' },
    });

    const res = await request(app)
      .patch(`/api/teams/${team.id}/members/${member.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'admin' });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe('admin');
  });

  it('blocks admins from promoting a member to owner', async () => {
    const team = await createTeam(owner.id, 'TMR3');
    await prisma.teamMember.create({
      data: { teamId: team.id, userId: admin.id, role: 'admin' },
    });
    await prisma.teamMember.create({
      data: { teamId: team.id, userId: member.id, role: 'member' },
    });

    const res = await request(app)
      .patch(`/api/teams/${team.id}/members/${member.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'owner' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('OWNERSHIP_REQUIRED');
  });

  it('lets an owner promote a member to owner', async () => {
    const team = await createTeam(owner.id, 'TMR4');
    await prisma.teamMember.create({
      data: { teamId: team.id, userId: member.id, role: 'member' },
    });

    const res = await request(app)
      .patch(`/api/teams/${team.id}/members/${member.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ role: 'owner' });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe('owner');
  });

  it('protects the last team owner from demotion and removal', async () => {
    const team = await createTeam(owner.id, 'TMR5');

    const demote = await request(app)
      .patch(`/api/teams/${team.id}/members/${owner.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ role: 'admin' });

    const remove = await request(app)
      .delete(`/api/teams/${team.id}/members/${owner.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(demote.status).toBe(409);
    expect(demote.body.error.code).toBe('LAST_OWNER');
    expect(remove.status).toBe(409);
    expect(remove.body.error.code).toBe('LAST_OWNER');
  });

  it('blocks non-admin members from changing roles', async () => {
    const team = await createTeam(owner.id, 'TMR6');
    await prisma.teamMember.create({
      data: { teamId: team.id, userId: member.id, role: 'member' },
    });
    await prisma.teamMember.create({
      data: { teamId: team.id, userId: viewer.id, role: 'member' },
    });

    const res = await request(app)
      .patch(`/api/teams/${team.id}/members/${viewer.id}`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ role: 'admin' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('OWNERSHIP_REQUIRED');
  });
});
