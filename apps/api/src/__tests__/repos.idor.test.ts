import { afterEach, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { prisma } from '@openlinear/db';
import { createApp } from '../app';
import { testJwtSecret } from './test-env';
import { useTestServer } from './http';

const JWT_SECRET = testJwtSecret();
const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function sign(userId: string, username: string) {
  return jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '1h' });
}

describe('Repository IDOR (F-011 / F-012 / F-018)', () => {
  const app = createApp();
  const http = useTestServer(() => app);

  afterEach(async () => {
    await prisma.repository.deleteMany({
      where: { fullName: { contains: `idor-${suffix}` } },
    });
  });

  it('refuses to activate another user\'s repository', async () => {
    const owner = await prisma.user.create({
      data: {
        githubId: `idor-owner-${suffix}`,
        username: `idor-owner-${suffix}`,
        email: `idor-owner-${suffix}@example.com`,
      },
    });
    const attacker = await prisma.user.create({
      data: {
        githubId: `idor-atk-${suffix}`,
        username: `idor-atk-${suffix}`,
        email: `idor-atk-${suffix}@example.com`,
      },
    });
    const repo = await prisma.repository.create({
      data: {
        githubRepoId: 424242,
        name: 'secret',
        fullName: `idor-${suffix}/secret`,
        cloneUrl: 'https://github.com/idor/secret.git',
        defaultBranch: 'main',
        userId: owner.id,
        isActive: false,
      },
    });

    const res = await http()
      .post(`/api/repos/${repo.id}/activate`)
      .set('Authorization', `Bearer ${sign(attacker.id, attacker.username)}`);

    expect(res.status).toBe(404);

    const publicActivate = await http()
      .post(`/api/repos/${repo.id}/activate/public`)
      .set('Authorization', `Bearer ${sign(attacker.id, attacker.username)}`);
    expect(publicActivate.status).toBe(404);

    const stored = await prisma.repository.findUnique({ where: { id: repo.id } });
    expect(stored?.isActive).toBe(false);

    await prisma.repository.delete({ where: { id: repo.id } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, attacker.id] } } });
  });
});
