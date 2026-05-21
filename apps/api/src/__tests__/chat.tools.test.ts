import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@openlinear/db';
import { dispatchTool, getOpenAIFunctionSpecs } from '../services/chat-tools';
import type { JsonObject, ToolContext } from '../services/chat-tools/types';

async function cleanup() {
  await prisma.chatToolCall.deleteMany({});
  await prisma.chatMessage.deleteMany({});
  await prisma.chatSession.deleteMany({});
  await prisma.activityLog.deleteMany({});
  await prisma.notification.deleteMany({});
  await prisma.comment.deleteMany({});
  await prisma.taskLabel.deleteMany({});
  await prisma.task.deleteMany({});
  await prisma.label.deleteMany({});
  await prisma.teamMember.deleteMany({});
  await prisma.team.deleteMany({});
  await prisma.projectAccess.deleteMany({});
  await prisma.project.deleteMany({});
  await prisma.workspaceMember.deleteMany({});
  await prisma.workspace.deleteMany({});
}

describe('Chat tool registry', () => {
  let userId: string;
  let workspaceId: string;
  let sessionId: string;

  function ctx(toolCallId: string, projectId?: string | null): ToolContext {
    return { userId, workspaceId, sessionId, projectId, toolCallId };
  }

  beforeAll(async () => {
    await cleanup();
    const user = await prisma.user.upsert({
      where: { githubId: 'chat-tools-user' },
      update: { username: 'chattoolsuser', email: 'chattools@example.com' },
      create: { githubId: 'chat-tools-user', username: 'chattoolsuser', email: 'chattools@example.com' },
    });
    userId = user.id;
    const workspace = await prisma.workspace.create({ data: { name: 'Tool Workspace', slug: 'tool-workspace' } });
    workspaceId = workspace.id;
    await prisma.workspaceMember.create({ data: { workspaceId, userId, role: 'owner', joinedAt: new Date() } });
    const session = await prisma.chatSession.create({ data: { userId, workspaceId } });
    sessionId = session.id;
  }, 30000);

  afterAll(async () => {
    await cleanup();
  }, 30000);

  it('registers exactly 34 OpenAI-compatible tools', () => {
    expect(getOpenAIFunctionSpecs()).toHaveLength(34);
  });

  it('creates a project with a default team from real database data', async () => {
    const result = await dispatchTool('create_project', ctx('create-project'), {
      workspaceId,
      name: 'Tool Created Project',
    });

    expect(result.ok).toBe(true);
    const project = await prisma.project.findFirst({
      where: { name: 'Tool Created Project', workspaceId },
      include: { teams: true, labels: true },
    });
    expect(project).not.toBeNull();
    expect(project?.teams).toHaveLength(1);
    expect(project?.labels.length).toBeGreaterThanOrEqual(6);
  });

  it('previews bulk issue creation without persisting tasks', async () => {
    const project = await prisma.project.findFirstOrThrow({ where: { name: 'Tool Created Project' }, include: { teams: true } });
    const before = await prisma.task.count({ where: { projectId: project.id } });
    const result = await dispatchTool('bulk_create_issues', ctx('bulk-preview', project.id), {
      projectId: project.id,
      dryRun: true,
      items: [
        { title: 'Preview one', priority: 'high' },
        { title: 'Preview two', status: 'in_progress' },
      ],
    } satisfies JsonObject);

    expect(result.ok).toBe(true);
    await expect(prisma.task.count({ where: { projectId: project.id } })).resolves.toBe(before);
  });

  it('sets up project labels, deadline, and issues in one operation', async () => {
    const project = await prisma.project.findFirstOrThrow({ where: { name: 'Tool Created Project' }, include: { teams: true } });
    const targetDate = '2026-06-01T18:29:59.000Z';

    const result = await dispatchTool('setup_project_plan', ctx('setup-project-plan', project.id), {
      projectId: project.id,
      targetDate,
      labels: [
        { name: 'backend', color: '#3b82f6', priority: 3 },
        { name: 'frontend', color: '#10b981', priority: 2 },
        { name: 'db', color: '#f59e0b', priority: 1 },
      ],
      tasks: [
        {
          title: 'Plan operation backend task',
          description: 'Build the server-side capability.\n\nImplementation steps:\n1. Add the API surface.\n2. Persist changes safely.\n3. Verify with tests.',
          priority: 'high',
          labelNames: ['backend', 'db'],
        },
        {
          title: 'Plan operation frontend task',
          description: 'Expose the workflow in the UI.\n\nImplementation steps:\n1. Add controls.\n2. Render states.\n3. Verify the interaction.',
          priority: 'medium',
          labelNames: ['frontend'],
        },
      ],
    } satisfies JsonObject);

    expect(result.ok).toBe(true);
    const updatedProject = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { targetDate: true } });
    expect(updatedProject.targetDate?.toISOString()).toBe(targetDate);

    const labels = await prisma.label.findMany({ where: { projectId: project.id, name: { in: ['backend', 'frontend', 'db'] } } });
    expect(labels).toHaveLength(3);
    expect(labels.find((label) => label.name === 'backend')?.color).toBe('#3b82f6');

    const created = await prisma.task.findMany({
      where: { projectId: project.id, title: { in: ['Plan operation backend task', 'Plan operation frontend task'] } },
      include: { labels: { include: { label: true } } },
    });
    expect(created).toHaveLength(2);
    expect(created.every((task) => task.dueDate?.toISOString() === targetDate)).toBe(true);
    expect(created.find((task) => task.title === 'Plan operation backend task')?.labels.map((item) => item.label.name).sort()).toEqual(['backend', 'db']);
  });

  it('bulk-updates project issues to completed/done status', async () => {
    const project = await prisma.project.findFirstOrThrow({ where: { name: 'Tool Created Project' }, include: { teams: true } });
    const teamId = project.teams[0]?.id;
    expect(teamId).toBeTruthy();

    await prisma.task.createMany({
      data: [
        { title: 'Bulk todo issue', identifier: 'TOOL-1001', number: 1001, priority: 'medium', status: 'todo', projectId: project.id, teamId },
        { title: 'Bulk active issue', identifier: 'TOOL-1002', number: 1002, priority: 'high', status: 'in_progress', projectId: project.id, teamId },
      ],
    });

    const result = await dispatchTool('bulk_update_issues', ctx('bulk-status', project.id), {
      projectId: project.id,
      status: 'completed',
    } satisfies JsonObject);

    expect(result.ok).toBe(true);
    await expect(prisma.task.count({ where: { projectId: project.id, status: { not: 'done' } } })).resolves.toBe(0);
  });

  it('archives all active project issues when delete/remove is requested', async () => {
    const project = await prisma.project.findFirstOrThrow({ where: { name: 'Tool Created Project' }, include: { teams: true } });
    const teamId = project.teams[0]?.id;
    expect(teamId).toBeTruthy();

    await prisma.task.createMany({
      data: [
        { title: 'Archive candidate one', identifier: 'TOOL-2001', number: 2001, priority: 'medium', status: 'todo', projectId: project.id, teamId },
        { title: 'Archive candidate two', identifier: 'TOOL-2002', number: 2002, priority: 'medium', status: 'in_progress', projectId: project.id, teamId },
      ],
    });

    const result = await dispatchTool('archive_issues', ctx('bulk-archive', project.id), {
      projectId: project.id,
    } satisfies JsonObject);

    expect(result.ok).toBe(true);
    await expect(prisma.task.count({ where: { projectId: project.id, archived: false } })).resolves.toBe(0);
  });

  it('dedupes mutating tool calls by session and toolCallId', async () => {
    const project = await prisma.project.findFirstOrThrow({ where: { name: 'Tool Created Project' }, include: { teams: true } });
    const args = { projectId: project.id, title: 'Idempotent issue' } satisfies JsonObject;
    const first = await dispatchTool('create_issue', ctx('same-create', project.id), args);
    const second = await dispatchTool('create_issue', ctx('same-create', project.id), args);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    await expect(prisma.task.count({ where: { projectId: project.id, title: 'Idempotent issue' } })).resolves.toBe(1);
  });

  it('returns structured permission denial for a viewer write attempt', async () => {
    const viewer = await prisma.user.upsert({
      where: { githubId: 'chat-tools-viewer' },
      update: { username: 'chattoolsviewer', email: 'chattoolsviewer@example.com' },
      create: { githubId: 'chat-tools-viewer', username: 'chattoolsviewer', email: 'chattoolsviewer@example.com' },
    });
    await prisma.workspaceMember.create({ data: { workspaceId, userId: viewer.id, role: 'viewer', joinedAt: new Date() } });
    const viewerSession = await prisma.chatSession.create({ data: { userId: viewer.id, workspaceId } });

    const denied = await dispatchTool('create_project', {
      userId: viewer.id,
      workspaceId,
      sessionId: viewerSession.id,
      toolCallId: 'viewer-create-project',
    }, { workspaceId, name: 'Viewer Project' });

    expect(denied.ok).toBe(false);
    expect(denied.code).toBe('OWNERSHIP_REQUIRED');
  });
});
