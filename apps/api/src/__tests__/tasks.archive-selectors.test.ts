import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { prisma } from '@openlinear/db';
import { createApp } from '../app';
import { bulkArchiveTasks } from '../services/tasks';
import { dispatchTool } from '../services/chat-tools';
import { ValidationError } from '../errors';
import { OwnershipError } from '../services/ownership';
import type { JsonObject } from '../services/chat-tools/types';
import { testJwtSecret } from './test-env';

describe('Archive selector safety', () => {
  const app = createApp();
  const fixtureId = randomUUID();
  let userId: string;
  let deniedUserId: string;
  let workspaceId: string;
  let projectId: string;
  let otherProjectId: string;
  let sessionId: string;
  let targetId: string;
  let untouchedId: string;
  let otherProjectTaskId: string;
  let token: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { githubId: `archive-owner-${fixtureId}`, username: `archive-owner-${fixtureId}` },
    });
    const deniedUser = await prisma.user.create({
      data: { githubId: `archive-denied-${fixtureId}`, username: `archive-denied-${fixtureId}` },
    });
    userId = user.id;
    deniedUserId = deniedUser.id;
    token = jwt.sign({ userId, username: user.username }, testJwtSecret(), { expiresIn: '1h' });
    const workspace = await prisma.workspace.create({
      data: { name: 'Archive regression', slug: `archive-regression-${fixtureId}` },
    });
    workspaceId = workspace.id;
    await prisma.workspaceMember.create({ data: { workspaceId, userId, role: 'owner' } });
    const project = await prisma.project.create({ data: { name: 'Archive targets', key: 'AR', workspaceId } });
    const otherProject = await prisma.project.create({ data: { name: 'Other archive scope', key: 'AO', workspaceId } });
    projectId = project.id;
    otherProjectId = otherProject.id;
    const team = await prisma.team.create({ data: { name: 'Archive team', key: 'AR', projectId } });
    const otherTeam = await prisma.team.create({ data: { name: 'Other archive team', key: 'AO', projectId: otherProjectId } });
    await prisma.teamMember.createMany({
      data: [{ teamId: team.id, userId, role: 'owner' }, { teamId: otherTeam.id, userId, role: 'owner' }],
    });
    const target = await prisma.task.create({
      data: { title: 'Requested issue', identifier: 'AR-1', number: 1, projectId, teamId: team.id, creatorId: userId },
    });
    const untouched = await prisma.task.create({
      data: { title: 'Unrequested issue', identifier: 'AR-2', number: 2, projectId, teamId: team.id, creatorId: userId },
    });
    const otherTask = await prisma.task.create({
      data: { title: 'Other project issue', identifier: 'AO-1', number: 1, projectId: otherProjectId, teamId: otherTeam.id, creatorId: userId },
    });
    targetId = target.id;
    untouchedId = untouched.id;
    otherProjectTaskId = otherTask.id;
    const session = await prisma.chatSession.create({ data: { userId, workspaceId, projectId } });
    sessionId = session.id;
  });

  beforeEach(async () => {
    await prisma.task.updateMany({
      where: { id: { in: [targetId, untouchedId, otherProjectTaskId] } },
      data: { archived: false },
    });
  });

  afterAll(async () => {
    if (workspaceId) {
      await prisma.activityLog.deleteMany({ where: { projectId: { in: [projectId, otherProjectId] } } });
      await prisma.task.deleteMany({ where: { projectId: { in: [projectId, otherProjectId] } } });
      await prisma.workspace.delete({ where: { id: workspaceId } });
    }
    await prisma.user.deleteMany({ where: { id: { in: [userId, deniedUserId].filter(Boolean) } } });
  });

  async function expectAllActive() {
    await expect(prisma.task.count({
      where: { id: { in: [targetId, untouchedId, otherProjectTaskId] }, archived: false },
    })).resolves.toBe(3);
  }

  const invalidSelectors: Array<{ name: string; selectors: JsonObject }> = [
    { name: 'omitted selectors', selectors: {} },
    { name: 'empty arrays', selectors: { taskIds: [], identifiers: [] } },
    { name: 'blank identifier', selectors: { identifiers: ['   '] } },
    { name: 'blank ID', selectors: { taskIds: ['   '] } },
    { name: 'malformed ID', selectors: { taskIds: ['not-a-uuid'] } },
    { name: 'non-string ID', selectors: { taskIds: [42] } },
    { name: 'non-array selector', selectors: { identifiers: 'AR-1' } },
    { name: 'null selector', selectors: { identifiers: null } },
    { name: 'mixed valid and blank identifiers', selectors: { identifiers: ['AR-1', ' '] } },
    { name: 'mixed valid and non-string identifiers', selectors: { identifiers: ['AR-1', 42] } },
  ];

  it.each(invalidSelectors)('rejects $name without changing issues through chat or REST', async ({ selectors }) => {
    const response = await request(app).post('/api/tasks/bulk-archive')
      .set('Authorization', `Bearer ${token}`)
      .send({ projectId, ...selectors });
    expect(response.status).toBe(400);
    await expectAllActive();

    const args: JsonObject = { projectId };
    if ('taskIds' in selectors) args.issueIds = selectors.taskIds;
    if ('identifiers' in selectors) args.issueIdentifiers = selectors.identifiers;
    const result = await dispatchTool('archive_issues', {
      userId, workspaceId, sessionId, projectId, toolCallId: randomUUID(),
    }, args);
    expect(result.ok).toBe(false);
    await expectAllActive();
  });

  it('rejects missing or blank selectors at the service boundary', async () => {
    await expect(bulkArchiveTasks({ userId, projectId })).rejects.toBeInstanceOf(ValidationError);
    await expect(bulkArchiveTasks({ userId, projectId, taskIds: [], identifiers: [] })).rejects.toBeInstanceOf(ValidationError);
    await expect(bulkArchiveTasks({ userId, projectId, identifiers: ['AR-1', ' '] })).rejects.toBeInstanceOf(ValidationError);
    await expectAllActive();
  });

  it('rejects mixed valid and malformed IDs before archiving a valid target', async () => {
    await expect(bulkArchiveTasks({ userId, projectId, taskIds: [targetId, 'not-a-uuid'] }))
      .rejects.toBeInstanceOf(ValidationError);
    const result = await dispatchTool('archive_issues', {
      userId, workspaceId, sessionId, projectId, toolCallId: randomUUID(),
    }, { issueIds: [targetId, 42] });
    expect(result.ok).toBe(false);
    await expectAllActive();
  });

  it('archives only selected IDs in the selected project', async () => {
    const result = await bulkArchiveTasks({ userId, projectId, taskIds: [targetId, targetId, otherProjectTaskId] });
    expect(result.archived.map((task) => task.id)).toEqual([targetId]);
    expect(result.failed).toEqual([{ id: otherProjectTaskId, error: 'Issue was not found in the selected project' }]);
    await expect(prisma.task.count({ where: { id: { in: [untouchedId, otherProjectTaskId] }, archived: false } }))
      .resolves.toBe(2);
  });

  it('preserves trimmed, case-insensitive identifier selection', async () => {
    const result = await bulkArchiveTasks({ userId, projectId, identifiers: [' ar-1 ', 'AR-1'] });
    expect(result.archived.map((task) => task.id)).toEqual([targetId]);
    await expect(prisma.task.findUniqueOrThrow({ where: { id: untouchedId }, select: { archived: true } }))
      .resolves.toEqual({ archived: false });
  });

  it('requires project write access even for explicit target IDs', async () => {
    await expect(bulkArchiveTasks({ userId: deniedUserId, projectId, taskIds: [targetId] }))
      .rejects.toBeInstanceOf(OwnershipError);
    await expectAllActive();
  });
});
