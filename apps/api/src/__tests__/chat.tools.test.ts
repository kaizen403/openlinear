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

  it('registers exactly 31 OpenAI-compatible tools', () => {
    expect(getOpenAIFunctionSpecs()).toHaveLength(31);
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
