import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@openlinear/db';
import { dispatchTool, getOpenAIFunctionSpecs, WITHHELD_PRIVILEGE_TOOLS } from '../services/chat-tools';
import type { JsonObject, ToolContext, ToolResult } from '../services/chat-tools/types';

function confirmationCode(result: ToolResult): string {
  const details = result.details as { confirmation?: { code?: unknown } } | undefined;
  const code = details?.confirmation?.code;
  if (typeof code !== 'string') throw new Error(`expected a confirmation code, got ${JSON.stringify(result)}`);
  return code;
}

async function cleanup() {
  await prisma.chatToolConfirmation.deleteMany({});
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

  it('exposes every tool except the withheld privilege tools', () => {
    const specs = getOpenAIFunctionSpecs();
    // 40 tools are defined; the 5 access-granting ones are withheld from the
    // model until human approval exists, so a prompt injection cannot reach them.
    expect(specs).toHaveLength(40 - WITHHELD_PRIVILEGE_TOOLS.size);

    const exposed = new Set<string>(specs.map((spec) => spec.function.name));
    for (const withheld of WITHHELD_PRIVILEGE_TOOLS) {
      expect(exposed.has(withheld), `${withheld} must not be offered to the model`).toBe(false);
    }
  });

  it('refuses a withheld privilege tool even if the model calls it anyway', async () => {
    const result = await dispatchTool('grant_project_access', ctx('withheld'), {} satisfies JsonObject);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('TOOL_REQUIRES_APPROVAL');
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

  it('W17b: proposes a plan for review without creating issues; refuses loops', async () => {
    const project = await prisma.project.findFirstOrThrow({ where: { name: 'Tool Created Project' } });
    const before = await prisma.task.count({ where: { projectId: project.id } });
    const result = await dispatchTool('propose_plan', ctx('propose-plan', project.id), {
      projectId: project.id,
      title: 'Chat plan',
      tasks: [
        { key: 'api', title: 'Chat plan API', acceptance: ['returns 200'], estimate: 's' },
        { key: 'ui', title: 'Chat plan UI', blockedBy: ['api'] },
      ],
    } satisfies JsonObject);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ title: 'Chat plan', revision: 1, order: ['api', 'ui'] });
    await expect(prisma.task.count({ where: { projectId: project.id } })).resolves.toBe(before);
    await expect(prisma.plan.count({ where: { projectId: project.id, title: 'Chat plan' } })).resolves.toBe(1);

    // Reading and revising the plan from chat; the board changes only on approval.
    const planId = (result.data as { planId: string }).planId;
    const listed = await dispatchTool('list_plans', ctx('list-plans', project.id), { projectId: project.id } satisfies JsonObject);
    expect(listed.ok).toBe(true);
    expect((listed.data as { items: Array<{ id: string }> }).items.map((plan) => plan.id)).toContain(planId);
    const read = await dispatchTool('get_plan', ctx('get-plan', project.id), { planId } satisfies JsonObject);
    expect(read.data).toMatchObject({ id: planId, latestRevision: 1, revision: { order: ['api', 'ui'] } });
    const revised = await dispatchTool('revise_plan', ctx('revise-plan', project.id), {
      planId,
      baseRevision: 1,
      note: 'Add docs',
      tasks: [
        { key: 'api', title: 'Chat plan API', acceptance: ['returns 200'], estimate: 's' },
        { key: 'ui', title: 'Chat plan UI', blockedBy: ['api'] },
        { key: 'docs', title: 'Chat plan docs', blockedBy: ['api'] },
      ],
    } satisfies JsonObject);
    expect(revised.ok).toBe(true);
    expect(revised.data).toMatchObject({ planId, revision: 2, unchanged: false, diff: { added: ['docs'] } });
    const stale = await dispatchTool('revise_plan', ctx('revise-plan-stale', project.id), { planId, baseRevision: 1, tasks: [{ key: 'api', title: 'x' }] } satisfies JsonObject);
    expect(stale.ok).toBe(false);
    expect(stale.code).toBe('PLAN_REVISION_CONFLICT');
    await expect(prisma.task.count({ where: { projectId: project.id } })).resolves.toBe(before);

    const loop = await dispatchTool('propose_plan', ctx('propose-plan-loop', project.id), {
      projectId: project.id,
      title: 'Loop plan',
      tasks: [{ key: 'a', title: 'A', blockedBy: ['b'] }, { key: 'b', title: 'B', blockedBy: ['a'] }],
    } satisfies JsonObject);
    expect(loop.ok).toBe(false);
    expect(loop.code).toBe('PLAN_INVALID');
  });

  it('W19b: proposes project knowledge (never active from chat) and lists it', async () => {
    const project = await prisma.project.findFirstOrThrow({ where: { name: 'Tool Created Project' } });
    const proposed = await dispatchTool('propose_knowledge', ctx('propose-knowledge', project.id), {
      projectId: project.id,
      kind: 'convention',
      title: 'Use pnpm',
      body: 'Never npm or yarn in this repository.',
    } satisfies JsonObject);
    expect(proposed.ok).toBe(true);
    expect(proposed.data).toMatchObject({ status: 'proposed', title: 'Use pnpm' });
    const row = await prisma.knowledgeEntry.findUniqueOrThrow({ where: { id: (proposed.data as { id: string }).id } });
    expect(row).toMatchObject({ status: 'proposed', source: 'agent', approvedById: null, sourceRef: { chatSessionId: sessionId } });
    const listed = await dispatchTool('list_knowledge', ctx('list-knowledge', project.id), { projectId: project.id } satisfies JsonObject);
    expect(listed.ok).toBe(true);
    expect(listed.data).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Use pnpm', status: 'proposed', kind: 'convention' })]));
    const invalid = await dispatchTool('propose_knowledge', ctx('propose-knowledge-invalid', project.id), { projectId: project.id, title: '', body: 'x' } satisfies JsonObject);
    expect(invalid.ok).toBe(false);
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

    // Omitting issueIds selects every active issue, but only as a preview:
    // nothing changes until the user sends the server-issued code back.
    const preview = await dispatchTool('bulk_update_issues', ctx('bulk-status', project.id), {
      projectId: project.id,
      status: 'completed',
    } satisfies JsonObject);
    expect(preview.ok).toBe(false);
    expect(preview.code).toBe('CONFIRMATION_REQUIRED');
    await expect(prisma.task.count({ where: { projectId: project.id, status: { not: 'done' } } })).resolves.toBeGreaterThan(0);

    const code = confirmationCode(preview);
    const result = await dispatchTool('bulk_update_issues', {
      ...ctx('bulk-status-confirmed', project.id),
      turnId: 'next-turn',
      userConfirmations: new Set([code]),
    }, {
      projectId: project.id,
      status: 'completed',
      confirmationToken: code,
    } satisfies JsonObject);

    expect(result.ok).toBe(true);
    await expect(prisma.task.count({ where: { projectId: project.id, status: { not: 'done' } } })).resolves.toBe(0);
  });

  it('refuses to archive a whole project and archives only the issues named', async () => {
    const project = await prisma.project.findFirstOrThrow({ where: { name: 'Tool Created Project' }, include: { teams: true } });
    const teamId = project.teams[0]?.id;
    expect(teamId).toBeTruthy();

    // Unique per run: a fixed identifier would already be archived by an earlier
    // run of this suite against the same database, making the test order-dependent.
    const suffix = Date.now() % 100000;
    const targetIdentifier = `TOOL-A${suffix}`;
    await prisma.task.createMany({
      data: [
        { title: 'Archive candidate one', identifier: targetIdentifier, number: 900000 + suffix, priority: 'medium', status: 'todo', projectId: project.id, teamId },
        { title: 'Archive candidate two', identifier: `TOOL-B${suffix}`, number: 800000 + suffix, priority: 'medium', status: 'in_progress', projectId: project.id, teamId },
      ],
    });
    const before = await prisma.task.count({ where: { projectId: project.id, archived: false } });
    expect(before).toBeGreaterThanOrEqual(2);

    // Omitting ids used to archive every active issue in the project, so one
    // malformed tool call (arguments degrade to `{}`) emptied a board.
    const unscoped = await dispatchTool('archive_issues', ctx('bulk-archive', project.id), {
      projectId: project.id,
    } satisfies JsonObject);
    expect(unscoped.ok).toBe(false);
    expect(unscoped.code).toBe('EXPLICIT_IDS_REQUIRED');
    await expect(
      prisma.task.count({ where: { projectId: project.id, archived: false } }),
    ).resolves.toBe(before);

    // Named issues are previewed first; archiving needs the user's code.
    const scopedPreview = await dispatchTool('archive_issues', ctx('bulk-archive-scoped', project.id), {
      projectId: project.id,
      issueIdentifiers: [targetIdentifier],
    } satisfies JsonObject);
    expect(scopedPreview.code).toBe('CONFIRMATION_REQUIRED');
    await expect(
      prisma.task.count({ where: { projectId: project.id, archived: false } }),
    ).resolves.toBe(before);

    const code = confirmationCode(scopedPreview);
    const scoped = await dispatchTool('archive_issues', {
      ...ctx('bulk-archive-scoped-confirmed', project.id),
      turnId: 'next-turn',
      userConfirmations: new Set([code]),
    }, {
      projectId: project.id,
      issueIdentifiers: [targetIdentifier],
      confirmationToken: code,
    } satisfies JsonObject);
    expect(scoped.ok).toBe(true);
    await expect(
      prisma.task.count({ where: { projectId: project.id, archived: false } }),
    ).resolves.toBe(before - 1);
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
