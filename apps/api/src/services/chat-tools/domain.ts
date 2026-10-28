import { prisma, type Prisma, type Priority, type ProjectPermission, type ProjectStatus, type Status, type TeamRole, type WorkspaceRole } from '@openlinear/db';
import { z } from 'zod';
import { ValidationError } from '../../errors';
import { bulkArchiveBodySchema } from '../../schemas/tasks';
import { assertProjectAccess } from '../ownership';
import { createLabel, listLabels, updateLabel } from '../labels';
import { resolveUserByHandle, inviteWorkspaceMember, listWorkspaceMembers, changeWorkspaceMemberRole } from '../members';
import { setupProjectPlan } from '../project-plan';
import { authorizeCreatePlan, getPlan, listPlans, revisePlan } from '../plans';
import { runCommand } from '../idempotency';
import { planSpecSchema } from '../../schemas/plans';
import { createKnowledgeBodySchema } from '../../schemas/knowledge';
import { authorizeCreateKnowledge, listKnowledge } from '../knowledge';
import { createProject, getProject, grantProjectAccess, listProjectAccess, listProjects, updateProject } from '../projects';
import { searchWorkspaceData } from '../search';
import { addComment, bulkArchiveTasks, bulkCreateTasks, bulkUpdateTaskStatus, createTask, getTask, listComments, listTasks, updateTask } from '../tasks';
import { changeTeamMemberRole, createTeam, getTeam, inviteTeamMember, listTeamMembers, listTeams, updateTeam } from '../teams';
import { getWorkspaceForUser, listWorkspacesForUser, updateWorkspace } from '../workspaces';
import {
  boolArg,
  fail,
  JsonObject,
  objectArrayArg,
  objectParameters,
  ok,
  numberArg,
  stringArg,
  stringArrayArg,
  TOOL_EFFECTS,
  type ChatTool,
  type ChatToolName,
  type PreparedAction,
  type ToolContext,
  type ToolResult,
} from './types';

const priorityValues = ['low', 'medium', 'high'] as const;
const statusValues = ['todo', 'in_progress', 'done', 'cancelled'] as const;
const projectStatusValues = ['planned', 'in_progress', 'paused', 'completed', 'cancelled'] as const;
const workspaceRoleValues = ['owner', 'admin', 'member', 'viewer'] as const;
const teamRoleValues = ['owner', 'admin', 'member'] as const;
const projectPermissionValues = ['full', 'view', 'deny'] as const;

function hasValue<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function priorityArg(args: JsonObject, key: string): Priority | undefined {
  const value = args[key];
  return hasValue(priorityValues, value) ? value : undefined;
}

function statusArg(args: JsonObject, key: string): Status | undefined {
  const value = args[key];
  if (value === 'completed') return 'done';
  return hasValue(statusValues, value) ? value : undefined;
}

function projectStatusArg(args: JsonObject, key: string): ProjectStatus | undefined {
  const value = args[key];
  return hasValue(projectStatusValues, value) ? value : undefined;
}

function workspaceRoleArg(args: JsonObject, key: string): WorkspaceRole | undefined {
  const value = args[key];
  return hasValue(workspaceRoleValues, value) ? value : undefined;
}

function teamRoleArg(args: JsonObject, key: string): TeamRole | undefined {
  const value = args[key];
  return hasValue(teamRoleValues, value) ? value : undefined;
}

function projectPermissionArg(args: JsonObject, key: string): ProjectPermission | undefined {
  const value = args[key];
  return hasValue(projectPermissionValues, value) ? value : undefined;
}

function nullableStringArg(args: JsonObject, key: string): string | null | undefined {
  const value = args[key];
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function scopedWorkspaceId(ctx: ToolContext, args: JsonObject): string {
  return stringArg(args, 'workspaceId') ?? ctx.workspaceId;
}

function scopedProjectId(ctx: ToolContext, args: JsonObject): string | undefined {
  return stringArg(args, 'projectId') ?? ctx.projectId ?? undefined;
}

function missing(name: string): ToolResult {
  return fail('VALIDATION_ERROR', `${name} is required`, { field: name });
}

async function resolveOptionalUserId(args: JsonObject, idKey: string, handleKey: string): Promise<string | undefined> {
  const direct = stringArg(args, idKey);
  if (direct) return direct;
  const handle = stringArg(args, handleKey);
  if (!handle) return undefined;
  const user = await resolveUserByHandle(handle);
  return user.id;
}

function bulkItems(args: JsonObject) {
  return (objectArrayArg(args, 'items') ?? []).map((item) => ({
    title: stringArg(item, 'title') ?? '',
    description: nullableStringArg(item, 'description'),
    priority: priorityArg(item, 'priority'),
    status: statusArg(item, 'status'),
    labelIds: stringArrayArg(item, 'labelIds') ?? [],
    parentId: stringArg(item, 'parentId'),
    dueDate: nullableStringArg(item, 'dueDate'),
  })).filter((item) => item.title.trim().length > 0);
}

function planLabels(args: JsonObject) {
  return (objectArrayArg(args, 'labels') ?? [])
    .map((item) => ({
      name: stringArg(item, 'name') ?? '',
      color: stringArg(item, 'color'),
      priority: numberArg(item, 'priority'),
    }))
    .filter((item) => item.name.trim().length > 0);
}

function planTasks(args: JsonObject) {
  return (objectArrayArg(args, 'tasks') ?? [])
    .map((item) => ({
      title: stringArg(item, 'title') ?? '',
      description: nullableStringArg(item, 'description'),
      priority: priorityArg(item, 'priority'),
      status: statusArg(item, 'status'),
      labelNames: stringArrayArg(item, 'labelNames') ?? stringArrayArg(item, 'labels') ?? [],
      parentId: stringArg(item, 'parentId'),
      dueDate: nullableStringArg(item, 'dueDate'),
    }))
    .filter((item) => item.title.trim().length > 0);
}

/** Largest selection a destructive bulk tool will preview or change. */
const MAX_BULK_SELECTION = 100;
const issueIdsSchema = z.array(z.string().uuid()).min(1).max(MAX_BULK_SELECTION);

function asResult(result: ToolResult): PreparedAction {
  return { kind: 'result', result };
}

function compactIssue(task: { id: string; identifier: string | null; title: string; status: Status }): JsonObject {
  return { id: task.id, identifier: task.identifier, title: task.title, status: task.status };
}

/** Any edit bumps `updatedAt`, so a confirmed selection is invalidated by a concurrent change. */
function issueRevision(task: { status: Status; updatedAt: Date }): string {
  return `${task.status}@${task.updatedAt.toISOString()}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * bulk_update_issues: resolve the exact selection read-only. With no
 * `issueIds` the selection is every active issue in the project (bounded); a
 * malformed or empty `issueIds` is rejected and never widens to "all issues".
 */
async function prepareBulkStatusUpdate(ctx: ToolContext, args: JsonObject): Promise<PreparedAction> {
  const projectId = scopedProjectId(ctx, args);
  if (!projectId) return asResult(missing('projectId'));
  const status = statusArg(args, 'status');
  if (!status) return asResult(missing('status'));

  let explicitIds: string[] | null = null;
  if (args.issueIds !== undefined) {
    const parsed = issueIdsSchema.safeParse(args.issueIds);
    if (!parsed.success) {
      return asResult(fail(
        'VALIDATION_ERROR',
        `issueIds must be a non-empty list of up to ${MAX_BULK_SELECTION} issue UUIDs. Omit issueIds only to select every active issue in the project.`,
        parsed.error.flatten(),
      ));
    }
    explicitIds = [...new Set(parsed.data)];
  }

  await assertProjectAccess(projectId, ctx.userId, 'full');
  const tasks = await prisma.task.findMany({
    where: { projectId, archived: false, ...(explicitIds ? { id: { in: explicitIds } } : {}) },
    select: { id: true, identifier: true, title: true, status: true, updatedAt: true },
    orderBy: [{ number: 'asc' }, { createdAt: 'asc' }],
    take: MAX_BULK_SELECTION + 1,
  });
  if (tasks.length > MAX_BULK_SELECTION) {
    return asResult(fail(
      'SELECTION_TOO_LARGE',
      `The project has more than ${MAX_BULK_SELECTION} active issues. Pass explicit issueIds (at most ${MAX_BULK_SELECTION}) for the issues to change.`,
      { limit: MAX_BULK_SELECTION },
    ));
  }

  const found = new Set(tasks.map((task) => task.id));
  const failed = (explicitIds ?? [])
    .filter((id) => !found.has(id))
    .map((id) => ({ id, error: 'Issue was not found in the selected project' }));
  const toChange = tasks.filter((task) => task.status !== status);
  if (toChange.length === 0) {
    return asResult(ok(
      tasks.length === 0 ? 'No matching active issues; nothing to change' : 'Every selected issue already has that status; nothing to change',
      { updated: [], already: tasks.map(compactIssue), failed, status },
    ));
  }

  return {
    kind: 'action',
    binding: {
      toolName: 'bulk_update_issues',
      projectId,
      change: { status },
      targets: tasks.map((task) => ({ id: task.id, revision: issueRevision(task) })),
    },
    summary: `Set status to ${status} on ${plural(toChange.length, 'issue')}`,
    preview: {
      projectId,
      status,
      selection: explicitIds ? 'explicit_issue_ids' : 'all_active_issues_in_project',
      willChange: toChange.map(compactIssue),
      alreadyInStatus: tasks.length - toChange.length,
      notFound: failed.map((item) => item.id),
    },
    execute: async () => {
      // Exactly the bound selection; never an empty list (which the service
      // would read as "every issue in the project").
      const result = await bulkUpdateTaskStatus({ userId: ctx.userId, projectId, status, taskIds: tasks.map((task) => task.id) });
      return ok('Issues updated', { ...result, failed: [...result.failed, ...failed] });
    },
  };
}

/** archive_issues: explicit ids/identifiers only, resolved to exact tasks before confirmation. */
async function prepareArchive(ctx: ToolContext, args: JsonObject): Promise<PreparedAction> {
  const projectId = scopedProjectId(ctx, args);
  if (!projectId) return asResult(missing('projectId'));

  const parsed = bulkArchiveBodySchema.safeParse({
    projectId,
    taskIds: args.issueIds,
    identifiers: args.issueIdentifiers,
  });
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  const ids = (parsed.data.taskIds ?? []).map((id) => id.trim());
  const identifiers = (parsed.data.identifiers ?? []).map((identifier) => identifier.trim());
  if (ids.some((id) => !id) || identifiers.some((identifier) => !identifier)) {
    throw new ValidationError('Archive selectors must not be blank');
  }
  const requestedIds = [...new Set(ids)];
  const requestedIdentifiers = [...new Set(identifiers)];

  // Omitting both used to archive EVERY active issue in the project. With
  // malformed tool arguments degrading to `{}`, a single mis-parse — or an
  // injected instruction — emptied a board. Archiving now requires an
  // explicit list.
  if (requestedIds.length === 0 && requestedIdentifiers.length === 0) {
    return asResult(fail(
      'EXPLICIT_IDS_REQUIRED',
      'Specify which issues to archive via issueIds or issueIdentifiers. Bulk-archiving an entire project from chat is not supported.',
    ));
  }

  await assertProjectAccess(projectId, ctx.userId, 'full');
  const selectors: Prisma.TaskWhereInput[] = [];
  if (requestedIds.length > 0) selectors.push({ id: { in: requestedIds } });
  if (requestedIdentifiers.length > 0) {
    selectors.push({ identifier: { in: requestedIdentifiers.map((identifier) => identifier.toLowerCase()), mode: 'insensitive' } });
  }
  const tasks = await prisma.task.findMany({
    where: { projectId, archived: false, OR: selectors },
    select: { id: true, identifier: true, title: true, status: true, updatedAt: true },
    orderBy: [{ number: 'asc' }, { createdAt: 'asc' }],
  });

  const foundIds = new Set(tasks.map((task) => task.id));
  const foundIdentifiers = new Set(tasks.map((task) => task.identifier?.toLowerCase()).filter((value): value is string => Boolean(value)));
  const failed: JsonObject[] = [
    ...requestedIds.filter((id) => !foundIds.has(id)).map((id) => ({ id, error: 'Issue was not found in the selected project' })),
    ...requestedIdentifiers
      .filter((identifier) => !foundIdentifiers.has(identifier.toLowerCase()))
      .map((identifier) => ({ identifier, error: 'Issue was not found in the selected project' })),
  ];
  if (tasks.length === 0) {
    return asResult(ok('No matching active issues; nothing archived', { archived: [], failed, count: 0 }));
  }

  return {
    kind: 'action',
    binding: {
      toolName: 'archive_issues',
      projectId,
      change: { archived: true },
      targets: tasks.map((task) => ({ id: task.id, revision: issueRevision(task) })),
    },
    summary: `Archive ${plural(tasks.length, 'issue')}`,
    preview: { projectId, willArchive: tasks.map(compactIssue), notFound: failed },
    execute: async () => {
      const result = await bulkArchiveTasks({ userId: ctx.userId, projectId, taskIds: tasks.map((task) => task.id) });
      return ok('Issues archived', { ...result, failed: [...result.failed, ...failed] });
    },
  };
}

/**
 * Generic confirmation for destructive tools without a target preview (the
 * withheld access/role tools, if an operator re-enables them): the code is
 * bound to the exact arguments.
 */
function confirmArguments(
  name: ChatToolName,
  handler: (ctx: ToolContext, args: JsonObject) => Promise<ToolResult>,
): (ctx: ToolContext, args: JsonObject) => Promise<PreparedAction> {
  return async (ctx, args) => ({
    kind: 'action',
    binding: { toolName: name, projectId: scopedProjectId(ctx, args) ?? null, change: args, targets: [] },
    summary: `Run ${name} with ${JSON.stringify(args).slice(0, 300)}`,
    preview: { tool: name, arguments: args },
    execute: () => handler(ctx, args),
  });
}

const idProp = { type: 'string', description: 'OpenLinear UUID/id from a previous tool result.' };
const limitProp = { type: 'number', minimum: 1, maximum: 200, default: 50 };
const cursorProp = { type: 'string', description: 'Pagination cursor returned by a previous list call.' };
const projectIdProp = { ...idProp, description: 'Project id. Defaults to the session project scope when omitted.' };

/** W17b: one task of a plan spec (propose_plan / revise_plan). */
const planTaskItems = {
  type: 'object',
  properties: {
    key: { type: 'string', description: 'Short unique handle such as "schema" (letters, digits, . _ -)' },
    title: { type: 'string' },
    description: { type: 'string' },
    priority: { type: 'string', enum: [...priorityValues] },
    acceptance: { type: 'array', items: { type: 'string' }, description: 'How to tell it is done' },
    estimate: { type: 'string', enum: ['xs', 's', 'm', 'l', 'xl'] },
    risk: { type: 'string', enum: ['low', 'medium', 'high'], description: 'How likely it is to go wrong or need a human' },
    blockedBy: { type: 'array', items: { type: 'string' }, description: 'Keys of tasks that must be done first' },
  },
  required: ['key', 'title'],
  additionalProperties: false,
};
const workspaceIdProp = { ...idProp, description: 'Workspace id. Defaults to the session workspace scope when omitted.' };

export const CHAT_DOMAIN_TOOLS: ChatTool[] = [
  {
    name: 'list_workspaces',
    description: 'List workspaces the authenticated user belongs to. Use before answering workspace questions.',
    effect: 'read',
    parameters: objectParameters({}, []),
    handler: async (ctx) => ok('Workspace list loaded', await listWorkspacesForUser(ctx.userId)),
  },
  {
    name: 'get_workspace',
    description: 'Get details for one workspace, including counts and recent projects.',
    effect: 'read',
    parameters: objectParameters({ workspaceId: workspaceIdProp }, []),
    handler: async (ctx, args) => ok('Workspace loaded', await getWorkspaceForUser(scopedWorkspaceId(ctx, args), ctx.userId)),
  },
  {
    name: 'list_workspace_members',
    description: 'List members in a workspace with roles.',
    effect: 'read',
    parameters: objectParameters({ workspaceId: workspaceIdProp, limit: limitProp, cursor: cursorProp }, []),
    handler: async (ctx, args) => ok('Workspace members loaded', await listWorkspaceMembers({ workspaceId: scopedWorkspaceId(ctx, args), userId: ctx.userId, limit: numberArg(args, 'limit'), cursor: stringArg(args, 'cursor') })),
  },
  {
    name: 'list_projects',
    description: 'List projects visible to the user in the current workspace.',
    effect: 'read',
    parameters: objectParameters({ workspaceId: workspaceIdProp, teamId: idProp, limit: limitProp, cursor: cursorProp }, []),
    handler: async (ctx, args) => ok('Projects loaded', await listProjects({ userId: ctx.userId, workspaceId: scopedWorkspaceId(ctx, args), teamId: stringArg(args, 'teamId'), limit: numberArg(args, 'limit'), cursor: stringArg(args, 'cursor') })),
  },
  {
    name: 'get_project',
    description: 'Get project details and optionally its visible issues.',
    effect: 'read',
    parameters: objectParameters({ projectId: projectIdProp, includeTasks: { type: 'boolean', default: true } }, []),
    handler: async (ctx, args) => {
      const projectId = scopedProjectId(ctx, args);
      if (!projectId) return missing('projectId');
      return ok('Project loaded', await getProject({ projectId, userId: ctx.userId, includeTasks: boolArg(args, 'includeTasks') ?? true }));
    },
  },
  {
    name: 'list_project_access',
    description: 'List explicit project access grants. Requires full project access.',
    effect: 'read',
    parameters: objectParameters({ projectId: projectIdProp }, []),
    handler: async (ctx, args) => {
      const projectId = scopedProjectId(ctx, args);
      if (!projectId) return missing('projectId');
      return ok('Project access loaded', await listProjectAccess({ projectId, userId: ctx.userId }));
    },
  },
  {
    name: 'list_teams',
    description: 'List teams visible to the user.',
    effect: 'read',
    parameters: objectParameters({ workspaceId: workspaceIdProp, projectId: projectIdProp, limit: limitProp, cursor: cursorProp }, []),
    handler: async (ctx, args) => ok('Teams loaded', await listTeams({ userId: ctx.userId, workspaceId: scopedWorkspaceId(ctx, args), projectId: scopedProjectId(ctx, args), limit: numberArg(args, 'limit'), cursor: stringArg(args, 'cursor') })),
  },
  {
    name: 'get_team',
    description: 'Get details for a team.',
    effect: 'read',
    parameters: objectParameters({ teamId: idProp }, ['teamId']),
    handler: async (ctx, args) => {
      const teamId = stringArg(args, 'teamId');
      if (!teamId) return missing('teamId');
      return ok('Team loaded', await getTeam({ teamId, userId: ctx.userId }));
    },
  },
  {
    name: 'list_team_members',
    description: 'List members in a team.',
    effect: 'read',
    parameters: objectParameters({ teamId: idProp, limit: limitProp, cursor: cursorProp }, ['teamId']),
    handler: async (ctx, args) => {
      const teamId = stringArg(args, 'teamId');
      if (!teamId) return missing('teamId');
      return ok('Team members loaded', await listTeamMembers({ teamId, userId: ctx.userId, limit: numberArg(args, 'limit'), cursor: stringArg(args, 'cursor') }));
    },
  },
  {
    name: 'list_issues',
    description: 'List issues/tasks using live OpenLinear filters. Use for counts and task status questions.',
    effect: 'read',
    parameters: objectParameters({ workspaceId: workspaceIdProp, projectId: projectIdProp, teamId: idProp, assigneeId: idProp, status: { type: 'string', enum: [...statusValues] }, query: { type: 'string' }, limit: limitProp, cursor: cursorProp }, []),
    handler: async (ctx, args) => ok('Issues loaded', await listTasks({ userId: ctx.userId, workspaceId: scopedWorkspaceId(ctx, args), projectId: scopedProjectId(ctx, args), teamId: stringArg(args, 'teamId'), assigneeId: stringArg(args, 'assigneeId'), status: statusArg(args, 'status'), query: stringArg(args, 'query'), limit: numberArg(args, 'limit'), cursor: stringArg(args, 'cursor') })),
  },
  {
    name: 'get_issue',
    description: 'Get a single issue/task by id.',
    effect: 'read',
    parameters: objectParameters({ issueId: idProp, taskId: idProp }, []),
    handler: async (ctx, args) => {
      const taskId = stringArg(args, 'issueId') ?? stringArg(args, 'taskId');
      if (!taskId) return missing('issueId');
      return ok('Issue loaded', await getTask({ taskId, userId: ctx.userId }));
    },
  },
  {
    name: 'list_comments',
    description: 'List comments on an issue/task.',
    effect: 'read',
    parameters: objectParameters({ issueId: idProp, taskId: idProp, limit: limitProp, cursor: cursorProp }, []),
    handler: async (ctx, args) => {
      const taskId = stringArg(args, 'issueId') ?? stringArg(args, 'taskId');
      if (!taskId) return missing('issueId');
      return ok('Comments loaded', await listComments({ taskId, userId: ctx.userId, limit: numberArg(args, 'limit'), cursor: stringArg(args, 'cursor') }));
    },
  },
  {
    name: 'list_labels',
    description: 'List labels for a project. Phases are labels named like "phase:N — Name".',
    effect: 'read',
    parameters: objectParameters({ projectId: projectIdProp }, []),
    handler: async (ctx, args) => {
      const projectId = scopedProjectId(ctx, args);
      if (!projectId) return missing('projectId');
      return ok('Labels loaded', await listLabels({ projectId, userId: ctx.userId }));
    },
  },
  {
    name: 'search',
    description: 'Search accessible issues, projects, and teams by text. Use before acting on fuzzy names.',
    effect: 'read',
    parameters: objectParameters({ workspaceId: workspaceIdProp, query: { type: 'string' }, types: { type: 'array', items: { type: 'string', enum: ['tasks', 'projects', 'teams'] } }, limit: { type: 'number', minimum: 1, maximum: 50, default: 20 } }, ['query']),
    handler: async (ctx, args) => {
      const query = stringArg(args, 'query');
      if (!query) return missing('query');
      const rawTypes = stringArrayArg(args, 'types');
      const types = rawTypes?.filter((type): type is 'tasks' | 'projects' | 'teams' => ['tasks', 'projects', 'teams'].includes(type));
      return ok('Search complete', await searchWorkspaceData({ userId: ctx.userId, workspaceId: scopedWorkspaceId(ctx, args), query, types, limit: numberArg(args, 'limit') }));
    },
  },
  {
    name: 'create_issue',
    description: 'Create one issue/task. Requires project/team write permission.',
    effect: 'write',
    parameters: objectParameters({ title: { type: 'string' }, description: { type: ['string', 'null'] }, priority: { type: 'string', enum: [...priorityValues] }, status: { type: 'string', enum: [...statusValues] }, projectId: projectIdProp, teamId: idProp, labelIds: { type: 'array', items: { type: 'string' } }, dueDate: { type: ['string', 'null'] }, assigneeId: idProp, assignee: { type: 'string', description: '@username, email, or user id to assign.' } }, ['title']),
    handler: async (ctx, args) => {
      const title = stringArg(args, 'title');
      if (!title) return missing('title');
      return ok('Issue created', await createTask({ userId: ctx.userId, title, description: nullableStringArg(args, 'description'), priority: priorityArg(args, 'priority'), status: statusArg(args, 'status'), projectId: scopedProjectId(ctx, args), teamId: stringArg(args, 'teamId'), labelIds: stringArrayArg(args, 'labelIds'), dueDate: nullableStringArg(args, 'dueDate'), assigneeId: await resolveOptionalUserId(args, 'assigneeId', 'assignee') }));
    },
  },
  {
    name: 'update_issue',
    description: 'Update issue fields such as title, status, priority, labels, due date, or assignee.',
    effect: 'write',
    parameters: objectParameters({ issueId: idProp, taskId: idProp, title: { type: 'string' }, description: { type: ['string', 'null'] }, priority: { type: 'string', enum: [...priorityValues] }, status: { type: 'string', enum: [...statusValues] }, labelIds: { type: 'array', items: { type: 'string' } }, dueDate: { type: ['string', 'null'] }, assigneeId: { type: ['string', 'null'] }, assignee: { type: 'string' } }, []),
    handler: async (ctx, args) => {
      const taskId = stringArg(args, 'issueId') ?? stringArg(args, 'taskId');
      if (!taskId) return missing('issueId');
      const assigneeId = args.assigneeId === null ? null : await resolveOptionalUserId(args, 'assigneeId', 'assignee');
      return ok('Issue updated', await updateTask({ userId: ctx.userId, taskId, title: stringArg(args, 'title'), description: nullableStringArg(args, 'description'), priority: priorityArg(args, 'priority'), status: statusArg(args, 'status'), labelIds: stringArrayArg(args, 'labelIds'), dueDate: nullableStringArg(args, 'dueDate'), assigneeId }));
    },
  },
  {
    name: 'move_issue',
    description: 'Move an issue to a project/team and/or status.',
    effect: 'write',
    parameters: objectParameters({ issueId: idProp, taskId: idProp, projectId: projectIdProp, teamId: idProp, status: { type: 'string', enum: [...statusValues] } }, []),
    handler: async (ctx, args) => {
      const taskId = stringArg(args, 'issueId') ?? stringArg(args, 'taskId');
      if (!taskId) return missing('issueId');
      return ok('Issue moved', await updateTask({ userId: ctx.userId, taskId, projectId: nullableStringArg(args, 'projectId') ?? scopedProjectId(ctx, args), teamId: nullableStringArg(args, 'teamId'), status: statusArg(args, 'status') }));
    },
  },
  {
    name: 'bulk_update_issues',
    description: 'Change the status of many issues in one project. Pass the exact issueIds, or omit issueIds to select every active issue in the project. The first call never changes anything: it returns a preview and a confirmation code; the change happens only when called again with the code after the user sends it. For one or a few issues use update_issue. Completed means status=done.',
    effect: 'destructive',
    parameters: objectParameters({ projectId: projectIdProp, status: { type: 'string', enum: [...statusValues] }, issueIds: { type: 'array', items: { type: 'string' }, description: 'Exact issue/task UUIDs to change (1-100). Omit only to select every active issue in the project.' } }, ['status']),
    prepare: prepareBulkStatusUpdate,
  },
  {
    name: 'archive_issues',
    description: 'Archive specific issues. In OpenLinear, deleting active issues means archiving them; this is not a permanent purge. You MUST list the exact issues to archive. The first call never archives anything: it returns a preview and a confirmation code; issues are archived only when called again with the code after the user sends it.',
    effect: 'destructive',
    parameters: objectParameters({
      projectId: projectIdProp,
      issueIds: { type: 'array', items: { type: 'string' }, description: 'Issue/task UUIDs to archive.' },
      issueIdentifiers: { type: 'array', items: { type: 'string' }, description: 'Human issue identifiers such as TEAM1-12.' },
    }, []),
    prepare: prepareArchive,
  },
  {
    name: 'comment_on_issue',
    description: 'Add a comment to an issue/task.',
    effect: 'write',
    parameters: objectParameters({ issueId: idProp, taskId: idProp, body: { type: 'string' } }, ['body']),
    handler: async (ctx, args) => {
      const taskId = stringArg(args, 'issueId') ?? stringArg(args, 'taskId');
      const body = stringArg(args, 'body');
      if (!taskId) return missing('issueId');
      if (!body) return missing('body');
      return ok('Comment added', await addComment({ taskId, userId: ctx.userId, body }));
    },
  },
  {
    name: 'bulk_create_issues',
    description: 'Create multiple issues at once. Set dryRun=true only when the user explicitly asks for a preview.',
    effect: 'write',
    parameters: objectParameters({ projectId: projectIdProp, dryRun: { type: 'boolean', default: false }, items: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, description: { type: ['string', 'null'] }, priority: { type: 'string', enum: [...priorityValues] }, status: { type: 'string', enum: [...statusValues] }, labelIds: { type: 'array', items: { type: 'string' } }, parentId: { type: 'string' }, dueDate: { type: ['string', 'null'] } }, required: ['title'], additionalProperties: false } } }, ['items']),
    handler: async (ctx, args) => {
      const projectId = scopedProjectId(ctx, args);
      if (!projectId) return missing('projectId');
      const items = bulkItems(args);
      if (items.length === 0) return missing('items');
      return ok(boolArg(args, 'dryRun') === true ? 'Issue preview generated' : 'Issues created', await bulkCreateTasks({ userId: ctx.userId, projectId, dryRun: boolArg(args, 'dryRun') ?? false, tasks: items }));
    },
  },
  {
    name: 'setup_project_plan',
    description: 'One-shot project setup operation. Use this instead of separate label/project/bulk-create calls when a user asks to create many issues/tasks and also mentions labels, label colors, or a deadline. It can create/update labels, set project targetDate, and create issues with labels by label name in one operation.',
    effect: 'write',
    parameters: objectParameters({
      projectId: projectIdProp,
      dryRun: { type: 'boolean', default: false, description: 'Use true only when the user asks for a preview. Use false when the user explicitly asks to create/add the issues.' },
      targetDate: { type: ['string', 'null'], description: 'Optional project deadline as an ISO datetime. For relative dates, compute the exact ISO datetime before calling.' },
      labels: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            color: { type: 'string', description: 'Hex color such as #3b82f6.' },
            priority: { type: 'number', default: 0 },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: ['string', 'null'], description: 'Proper description with implementation steps and acceptance checks.' },
            priority: { type: 'string', enum: [...priorityValues] },
            status: { type: 'string', enum: [...statusValues] },
            labelNames: { type: 'array', items: { type: 'string' }, description: 'Names of labels to attach, resolved after labels are created/updated.' },
            dueDate: { type: ['string', 'null'] },
            parentId: { type: 'string' },
          },
          required: ['title'],
          additionalProperties: false,
        },
      },
    }, ['tasks']),
    handler: async (ctx, args) => {
      const projectId = scopedProjectId(ctx, args);
      if (!projectId) return missing('projectId');
      const tasks = planTasks(args);
      if (tasks.length === 0) return missing('tasks');
      return ok(boolArg(args, 'dryRun') ? 'Project plan preview generated' : 'Project plan created', await setupProjectPlan({
        userId: ctx.userId,
        projectId,
        labels: planLabels(args),
        targetDate: nullableStringArg(args, 'targetDate'),
        tasks,
        dryRun: boolArg(args, 'dryRun') ?? false,
      }));
    },
  },
  {
    name: 'propose_plan',
    description: 'Propose a plan for review instead of creating issues: tasks with stable keys, acceptance checks, estimates and blockers (by key). It is checked (duplicate keys, unknown blockers, loops are refused; tasks without acceptance checks are flagged) and saved as a draft the user reviews and approves under the project\'s Plans. Nothing is created until they approve. Prefer this for multi-step work the user wants to review first.',
    effect: 'write',
    parameters: objectParameters({
      projectId: projectIdProp,
      title: { type: 'string', description: 'Plan title' },
      summary: { type: 'string', description: 'What the plan achieves' },
      tasks: {
        type: 'array',
        items: planTaskItems,
      },
    }, ['title', 'tasks']),
    handler: async (ctx, args) => {
      const projectId = scopedProjectId(ctx, args);
      if (!projectId) return missing('projectId');
      const title = stringArg(args, 'title');
      if (!title) return missing('title');
      const summary = stringArg(args, 'summary');
      const spec = planSpecSchema.safeParse({ ...(summary ? { summary } : {}), tasks: objectArrayArg(args, 'tasks') ?? [] });
      if (!spec.success) return fail('VALIDATION_ERROR', 'The plan tasks are not valid', spec.error.flatten());
      const plan = await runCommand(await authorizeCreatePlan({ projectId, userId: ctx.userId, title, spec: spec.data }));
      return ok('Plan saved for review; nothing was created yet. The user approves it under the project\'s Plans.', {
        planId: plan.id,
        projectId: plan.projectId,
        title: plan.title,
        revision: plan.revision.number,
        order: plan.revision.order,
        warnings: plan.revision.warnings.map((issue) => issue.message),
      });
    },
  },
  {
    name: 'list_plans',
    description: "List a project's reviewable plans (status, revisions, progress). Check before proposing a plan that may already exist.",
    effect: 'read',
    parameters: objectParameters({ projectId: projectIdProp }, []),
    handler: async (ctx, args) => {
      const projectId = scopedProjectId(ctx, args);
      if (!projectId) return missing('projectId');
      return ok('Plans loaded', await listPlans({ projectId, userId: ctx.userId }));
    },
  },
  {
    name: 'list_knowledge',
    description: "List the project's knowledge: conventions, procedures and notes the team wrote or approved (every agent run in the project gets the active ones), plus proposals waiting for approval. Check before proposing something that already exists.",
    effect: 'read',
    parameters: objectParameters({ projectId: projectIdProp }, []),
    handler: async (ctx, args) => {
      const projectId = scopedProjectId(ctx, args);
      if (!projectId) return missing('projectId');
      const entries = await listKnowledge({ projectId, userId: ctx.userId, status: 'all' });
      return ok('Knowledge loaded', entries
        .filter((entry) => entry.status !== 'retracted')
        .map((entry) => ({ id: entry.id, kind: entry.kind, title: entry.title, body: entry.body, status: entry.status, expired: entry.expired, version: entry.version })));
    },
  },
  {
    name: 'propose_knowledge',
    description: 'Propose project knowledge: a convention, procedure or note every future agent run in the project should know (e.g. "Use pnpm, never npm"). It is saved as a proposal; nothing changes for agents until the user approves it under the project\'s Knowledge. Write it as a general, lasting rule, not a one-off task. Only when the user asks you to remember something.',
    effect: 'write',
    parameters: objectParameters({
      projectId: projectIdProp,
      kind: { type: 'string', enum: ['convention', 'procedure', 'note'] },
      title: { type: 'string', description: 'Short rule, at most 120 characters' },
      body: { type: 'string', description: 'What agents should know, at most 4000 characters' },
    }, ['title', 'body']),
    handler: async (ctx, args) => {
      const projectId = scopedProjectId(ctx, args);
      if (!projectId) return missing('projectId');
      const parsed = createKnowledgeBodySchema.safeParse({
        kind: stringArg(args, 'kind') ?? 'note',
        title: stringArg(args, 'title') ?? '',
        body: stringArg(args, 'body') ?? '',
        sourceRef: { chatSessionId: ctx.sessionId },
      });
      if (!parsed.success) return fail('VALIDATION_ERROR', 'The knowledge entry is not valid', parsed.error.flatten());
      // An assistant only proposes (like a PAT client): a person approves it.
      const entry = await runCommand(await authorizeCreateKnowledge({ projectId, actor: { userId: ctx.userId, authSource: 'pat' }, body: parsed.data }));
      return ok("Proposed; nothing changes for agents until the user approves it under the project's Knowledge.", { id: entry.id, projectId: entry.projectId, status: entry.status, title: entry.title });
    },
  },
  {
    name: 'get_plan',
    description: 'Get a plan: its latest revision (or the given one) with tasks, checks, changes against the previous revision and the issues approvals created.',
    effect: 'read',
    parameters: objectParameters({ planId: idProp, revision: { type: 'number', description: 'Revision number; defaults to the latest' } }, ['planId']),
    handler: async (ctx, args) => {
      const planId = stringArg(args, 'planId');
      if (!planId) return missing('planId');
      return ok('Plan loaded', await getPlan({ planId, userId: ctx.userId, revision: numberArg(args, 'revision') }));
    },
  },
  {
    name: 'revise_plan',
    description: 'Save a new revision of a plan: the whole task list (keep existing keys so approved issues are updated, not duplicated). baseRevision must be the latest revision from get_plan. Nothing changes on the board until the user approves the new revision under Plans.',
    effect: 'write',
    parameters: objectParameters({
      planId: idProp,
      baseRevision: { type: 'number', description: 'The latest revision number you read' },
      summary: { type: 'string' },
      note: { type: 'string', description: 'What changed and why' },
      tasks: {
        type: 'array',
        items: planTaskItems,
      },
    }, ['planId', 'baseRevision', 'tasks']),
    handler: async (ctx, args) => {
      const planId = stringArg(args, 'planId');
      if (!planId) return missing('planId');
      const baseRevision = numberArg(args, 'baseRevision');
      if (baseRevision === undefined) return missing('baseRevision');
      const summary = stringArg(args, 'summary');
      const spec = planSpecSchema.safeParse({ ...(summary ? { summary } : {}), tasks: objectArrayArg(args, 'tasks') ?? [] });
      if (!spec.success) return fail('VALIDATION_ERROR', 'The plan tasks are not valid', spec.error.flatten());
      const note = stringArg(args, 'note');
      const result = await revisePlan({ planId, userId: ctx.userId, baseRevision, spec: spec.data, ...(note ? { note } : {}) });
      return ok(result.unchanged ? 'Nothing changed: the plan is the same as its latest revision' : `Saved revision ${result.plan.revision.number}; the user reviews and approves it under the project's Plans`, {
        planId: result.plan.id,
        revision: result.plan.revision.number,
        unchanged: result.unchanged,
        diff: result.plan.revision.diff,
        warnings: result.plan.revision.warnings.map((issue) => issue.message),
      });
    },
  },
  {
    name: 'create_label',
    description: 'Create a label in a project. Use phase:N — Name for phase labels.',
    effect: 'write',
    parameters: objectParameters({ projectId: projectIdProp, name: { type: 'string' }, color: { type: 'string', default: '#6366f1' }, priority: { type: 'number', default: 0 } }, ['name']),
    handler: async (ctx, args) => {
      const projectId = scopedProjectId(ctx, args);
      const name = stringArg(args, 'name');
      if (!projectId) return missing('projectId');
      if (!name) return missing('name');
      return ok('Label created', await createLabel({ projectId, userId: ctx.userId, name, color: stringArg(args, 'color') ?? '#6366f1', priority: numberArg(args, 'priority') }));
    },
  },
  {
    name: 'update_label',
    description: 'Update a project label.',
    effect: 'write',
    parameters: objectParameters({ labelId: idProp, name: { type: 'string' }, color: { type: 'string' }, priority: { type: 'number' } }, ['labelId']),
    handler: async (ctx, args) => {
      const labelId = stringArg(args, 'labelId');
      if (!labelId) return missing('labelId');
      return ok('Label updated', await updateLabel({ labelId, userId: ctx.userId, name: stringArg(args, 'name'), color: stringArg(args, 'color'), priority: numberArg(args, 'priority') }));
    },
  },
  {
    name: 'create_project',
    description: 'Create a project in the current workspace. Also creates a default team unless createDefaultTeam=false.',
    effect: 'write',
    parameters: objectParameters({ workspaceId: workspaceIdProp, key: { type: 'string' }, name: { type: 'string' }, description: { type: ['string', 'null'] }, status: { type: 'string', enum: [...projectStatusValues] }, color: { type: 'string' }, icon: { type: ['string', 'null'] }, createDefaultTeam: { type: 'boolean', default: true } }, ['name']),
    handler: async (ctx, args) => {
      const name = stringArg(args, 'name');
      if (!name) return missing('name');
      return ok('Project created', await createProject({ userId: ctx.userId, workspaceId: scopedWorkspaceId(ctx, args), key: stringArg(args, 'key'), name, description: nullableStringArg(args, 'description'), status: projectStatusArg(args, 'status'), color: stringArg(args, 'color'), icon: nullableStringArg(args, 'icon'), createDefaultTeam: boolArg(args, 'createDefaultTeam') }));
    },
  },
  {
    name: 'update_project',
    description: 'Update project metadata and status.',
    effect: 'write',
    parameters: objectParameters({ projectId: projectIdProp, name: { type: 'string' }, description: { type: ['string', 'null'] }, status: { type: 'string', enum: [...projectStatusValues] }, color: { type: 'string' }, icon: { type: ['string', 'null'] }, leadId: { type: ['string', 'null'] }, startDate: { type: ['string', 'null'] }, targetDate: { type: ['string', 'null'] } }, []),
    handler: async (ctx, args) => {
      const projectId = scopedProjectId(ctx, args);
      if (!projectId) return missing('projectId');
      return ok('Project updated', await updateProject({ userId: ctx.userId, projectId, name: stringArg(args, 'name'), description: nullableStringArg(args, 'description'), status: projectStatusArg(args, 'status'), color: stringArg(args, 'color'), icon: nullableStringArg(args, 'icon'), leadId: nullableStringArg(args, 'leadId'), startDate: nullableStringArg(args, 'startDate'), targetDate: nullableStringArg(args, 'targetDate') }));
    },
  },
  {
    name: 'grant_project_access',
    description: 'Grant or change explicit project access for a workspace member.',
    effect: 'destructive',
    parameters: objectParameters({ projectId: projectIdProp, userId: idProp, user: { type: 'string' }, permission: { type: 'string', enum: [...projectPermissionValues], default: 'full' } }, []),
    prepare: confirmArguments('grant_project_access', async (ctx, args) => {
      const projectId = scopedProjectId(ctx, args);
      const userId = await resolveOptionalUserId(args, 'userId', 'user');
      if (!projectId) return missing('projectId');
      if (!userId) return missing('userId');
      return ok('Project access updated', await grantProjectAccess({ projectId, actorUserId: ctx.userId, userId, permission: projectPermissionArg(args, 'permission') ?? 'full' }));
    }),
  },
  {
    name: 'create_team',
    description: 'Create a team inside a project.',
    effect: 'write',
    parameters: objectParameters({ projectId: projectIdProp, name: { type: 'string' }, key: { type: 'string' }, description: { type: ['string', 'null'] }, color: { type: 'string' }, icon: { type: ['string', 'null'] }, private: { type: 'boolean' } }, ['name', 'key']),
    handler: async (ctx, args) => {
      const projectId = scopedProjectId(ctx, args);
      const name = stringArg(args, 'name');
      const key = stringArg(args, 'key');
      if (!projectId) return missing('projectId');
      if (!name) return missing('name');
      if (!key) return missing('key');
      return ok('Team created', await createTeam({ userId: ctx.userId, projectId, name, key, description: nullableStringArg(args, 'description'), color: stringArg(args, 'color'), icon: nullableStringArg(args, 'icon'), private: boolArg(args, 'private') }));
    },
  },
  {
    name: 'update_team',
    description: 'Update team metadata.',
    effect: 'write',
    parameters: objectParameters({ teamId: idProp, name: { type: 'string' }, key: { type: 'string' }, description: { type: ['string', 'null'] }, color: { type: 'string' }, icon: { type: ['string', 'null'] }, private: { type: 'boolean' } }, ['teamId']),
    handler: async (ctx, args) => {
      const teamId = stringArg(args, 'teamId');
      if (!teamId) return missing('teamId');
      return ok('Team updated', await updateTeam({ userId: ctx.userId, teamId, name: stringArg(args, 'name'), key: stringArg(args, 'key'), description: nullableStringArg(args, 'description'), color: stringArg(args, 'color'), icon: nullableStringArg(args, 'icon'), private: boolArg(args, 'private') }));
    },
  },
  {
    name: 'invite_workspace_member',
    description: 'Invite/add an existing OpenLinear user to a workspace by @username, email, or user id.',
    effect: 'destructive',
    parameters: objectParameters({ workspaceId: workspaceIdProp, user: { type: 'string' }, role: { type: 'string', enum: [...workspaceRoleValues], default: 'member' } }, ['user']),
    prepare: confirmArguments('invite_workspace_member', async (ctx, args) => {
      const user = stringArg(args, 'user');
      if (!user) return missing('user');
      return ok('Workspace member added', await inviteWorkspaceMember({ workspaceId: scopedWorkspaceId(ctx, args), actorUserId: ctx.userId, handle: user, role: workspaceRoleArg(args, 'role') ?? 'member' }));
    }),
  },
  {
    name: 'invite_team_member',
    description: 'Invite/add an existing OpenLinear user to a team.',
    effect: 'destructive',
    parameters: objectParameters({ teamId: idProp, user: { type: 'string' }, role: { type: 'string', enum: [...teamRoleValues], default: 'member' } }, ['teamId', 'user']),
    prepare: confirmArguments('invite_team_member', async (ctx, args) => {
      const teamId = stringArg(args, 'teamId');
      const user = stringArg(args, 'user');
      if (!teamId) return missing('teamId');
      if (!user) return missing('user');
      return ok('Team member added', await inviteTeamMember({ teamId, actorUserId: ctx.userId, handle: user, role: teamRoleArg(args, 'role') ?? 'member' }));
    }),
  },
  {
    name: 'change_workspace_member_role',
    description: 'Change a workspace member role. Requires workspace owner for safety.',
    effect: 'destructive',
    parameters: objectParameters({ workspaceId: workspaceIdProp, userId: idProp, user: { type: 'string' }, role: { type: 'string', enum: [...workspaceRoleValues] } }, ['role']),
    prepare: confirmArguments('change_workspace_member_role', async (ctx, args) => {
      const targetUserId = await resolveOptionalUserId(args, 'userId', 'user');
      const role = workspaceRoleArg(args, 'role');
      if (!targetUserId) return missing('userId');
      if (!role) return missing('role');
      return ok('Workspace member role changed', await changeWorkspaceMemberRole({ workspaceId: scopedWorkspaceId(ctx, args), actorUserId: ctx.userId, targetUserId, role }));
    }),
  },
  {
    name: 'change_team_member_role',
    description: 'Change a team member role. Owner promotion requires team owner.',
    effect: 'destructive',
    parameters: objectParameters({ teamId: idProp, userId: idProp, user: { type: 'string' }, role: { type: 'string', enum: [...teamRoleValues] } }, ['teamId', 'role']),
    prepare: confirmArguments('change_team_member_role', async (ctx, args) => {
      const teamId = stringArg(args, 'teamId');
      const targetUserId = await resolveOptionalUserId(args, 'userId', 'user');
      const role = teamRoleArg(args, 'role');
      if (!teamId) return missing('teamId');
      if (!targetUserId) return missing('userId');
      if (!role) return missing('role');
      return ok('Team member role changed', await changeTeamMemberRole({ teamId, actorUserId: ctx.userId, targetUserId, role }));
    }),
  },
  {
    name: 'update_workspace',
    description: 'Update workspace metadata such as name.',
    effect: 'write',
    parameters: objectParameters({ workspaceId: workspaceIdProp, name: { type: 'string' } }, ['name']),
    handler: async (ctx, args) => {
      const name = stringArg(args, 'name');
      if (!name) return missing('name');
      return ok('Workspace updated', await updateWorkspace({ workspaceId: scopedWorkspaceId(ctx, args), userId: ctx.userId, name }));
    },
  },
];

export function assertNoToolShapeDrift(): void {
  if (CHAT_DOMAIN_TOOLS.length !== 40) {
    throw new ValidationError(`Expected 40 chat tools, found ${CHAT_DOMAIN_TOOLS.length}`);
  }
  const names = new Set<string>();
  for (const tool of CHAT_DOMAIN_TOOLS) {
    if (names.has(tool.name)) throw new ValidationError(`Duplicate chat tool ${tool.name}`);
    names.add(tool.name);
    if (!TOOL_EFFECTS.includes(tool.effect)) throw new ValidationError(`Chat tool ${tool.name} has no valid effect`);
  }
}
