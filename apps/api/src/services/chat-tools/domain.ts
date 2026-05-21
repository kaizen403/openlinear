import { type Priority, type ProjectPermission, type ProjectStatus, type Status, type TeamRole, type WorkspaceRole } from '@openlinear/db';
import { ValidationError } from '../../errors';
import { createLabel, listLabels, updateLabel } from '../labels';
import { resolveUserByHandle, inviteWorkspaceMember, listWorkspaceMembers, changeWorkspaceMemberRole } from '../members';
import { createProject, getProject, grantProjectAccess, listProjectAccess, listProjects, updateProject } from '../projects';
import { searchWorkspaceData } from '../search';
import { addComment, bulkCreateTasks, createTask, getTask, listComments, listTasks, updateTask } from '../tasks';
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
  type ChatTool,
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

const idProp = { type: 'string', description: 'OpenLinear UUID/id from a previous tool result.' };
const limitProp = { type: 'number', minimum: 1, maximum: 200, default: 50 };
const cursorProp = { type: 'string', description: 'Pagination cursor returned by a previous list call.' };
const projectIdProp = { ...idProp, description: 'Project id. Defaults to the session project scope when omitted.' };
const workspaceIdProp = { ...idProp, description: 'Workspace id. Defaults to the session workspace scope when omitted.' };

export const CHAT_DOMAIN_TOOLS: ChatTool[] = [
  {
    name: 'list_workspaces',
    description: 'List workspaces the authenticated user belongs to. Use before answering workspace questions.',
    mutating: false,
    parameters: objectParameters({}, []),
    handler: async (ctx) => ok('Workspace list loaded', await listWorkspacesForUser(ctx.userId)),
  },
  {
    name: 'get_workspace',
    description: 'Get details for one workspace, including counts and recent projects.',
    mutating: false,
    parameters: objectParameters({ workspaceId: workspaceIdProp }, []),
    handler: async (ctx, args) => ok('Workspace loaded', await getWorkspaceForUser(scopedWorkspaceId(ctx, args), ctx.userId)),
  },
  {
    name: 'list_workspace_members',
    description: 'List members in a workspace with roles.',
    mutating: false,
    parameters: objectParameters({ workspaceId: workspaceIdProp, limit: limitProp, cursor: cursorProp }, []),
    handler: async (ctx, args) => ok('Workspace members loaded', await listWorkspaceMembers({ workspaceId: scopedWorkspaceId(ctx, args), userId: ctx.userId, limit: numberArg(args, 'limit'), cursor: stringArg(args, 'cursor') })),
  },
  {
    name: 'list_projects',
    description: 'List projects visible to the user in the current workspace.',
    mutating: false,
    parameters: objectParameters({ workspaceId: workspaceIdProp, teamId: idProp, limit: limitProp, cursor: cursorProp }, []),
    handler: async (ctx, args) => ok('Projects loaded', await listProjects({ userId: ctx.userId, workspaceId: scopedWorkspaceId(ctx, args), teamId: stringArg(args, 'teamId'), limit: numberArg(args, 'limit'), cursor: stringArg(args, 'cursor') })),
  },
  {
    name: 'get_project',
    description: 'Get project details and optionally its visible issues.',
    mutating: false,
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
    mutating: false,
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
    mutating: false,
    parameters: objectParameters({ workspaceId: workspaceIdProp, projectId: projectIdProp, limit: limitProp, cursor: cursorProp }, []),
    handler: async (ctx, args) => ok('Teams loaded', await listTeams({ userId: ctx.userId, workspaceId: scopedWorkspaceId(ctx, args), projectId: scopedProjectId(ctx, args), limit: numberArg(args, 'limit'), cursor: stringArg(args, 'cursor') })),
  },
  {
    name: 'get_team',
    description: 'Get details for a team.',
    mutating: false,
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
    mutating: false,
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
    mutating: false,
    parameters: objectParameters({ workspaceId: workspaceIdProp, projectId: projectIdProp, teamId: idProp, assigneeId: idProp, status: { type: 'string', enum: [...statusValues] }, query: { type: 'string' }, limit: limitProp, cursor: cursorProp }, []),
    handler: async (ctx, args) => ok('Issues loaded', await listTasks({ userId: ctx.userId, workspaceId: scopedWorkspaceId(ctx, args), projectId: scopedProjectId(ctx, args), teamId: stringArg(args, 'teamId'), assigneeId: stringArg(args, 'assigneeId'), status: statusArg(args, 'status'), query: stringArg(args, 'query'), limit: numberArg(args, 'limit'), cursor: stringArg(args, 'cursor') })),
  },
  {
    name: 'get_issue',
    description: 'Get a single issue/task by id.',
    mutating: false,
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
    mutating: false,
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
    mutating: false,
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
    mutating: false,
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
    mutating: true,
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
    mutating: true,
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
    mutating: true,
    parameters: objectParameters({ issueId: idProp, taskId: idProp, projectId: projectIdProp, teamId: idProp, status: { type: 'string', enum: [...statusValues] } }, []),
    handler: async (ctx, args) => {
      const taskId = stringArg(args, 'issueId') ?? stringArg(args, 'taskId');
      if (!taskId) return missing('issueId');
      return ok('Issue moved', await updateTask({ userId: ctx.userId, taskId, projectId: nullableStringArg(args, 'projectId') ?? scopedProjectId(ctx, args), teamId: nullableStringArg(args, 'teamId'), status: statusArg(args, 'status') }));
    },
  },
  {
    name: 'comment_on_issue',
    description: 'Add a comment to an issue/task.',
    mutating: true,
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
    description: 'Preview or commit multiple issues. Always preview with dryRun=true before committing brainstormed work.',
    mutating: true,
    parameters: objectParameters({ projectId: projectIdProp, dryRun: { type: 'boolean', default: true }, items: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, description: { type: ['string', 'null'] }, priority: { type: 'string', enum: [...priorityValues] }, status: { type: 'string', enum: [...statusValues] }, labelIds: { type: 'array', items: { type: 'string' } }, parentId: { type: 'string' }, dueDate: { type: ['string', 'null'] } }, required: ['title'], additionalProperties: false } } }, ['items']),
    handler: async (ctx, args) => {
      const projectId = scopedProjectId(ctx, args);
      if (!projectId) return missing('projectId');
      const items = bulkItems(args);
      if (items.length === 0) return missing('items');
      return ok(boolArg(args, 'dryRun') === false ? 'Issues created' : 'Issue preview generated', await bulkCreateTasks({ userId: ctx.userId, projectId, dryRun: boolArg(args, 'dryRun') ?? true, tasks: items }));
    },
  },
  {
    name: 'create_label',
    description: 'Create a label in a project. Use phase:N — Name for phase labels.',
    mutating: true,
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
    mutating: true,
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
    mutating: true,
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
    mutating: true,
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
    mutating: true,
    parameters: objectParameters({ projectId: projectIdProp, userId: idProp, user: { type: 'string' }, permission: { type: 'string', enum: [...projectPermissionValues], default: 'full' } }, []),
    handler: async (ctx, args) => {
      const projectId = scopedProjectId(ctx, args);
      const userId = await resolveOptionalUserId(args, 'userId', 'user');
      if (!projectId) return missing('projectId');
      if (!userId) return missing('userId');
      return ok('Project access updated', await grantProjectAccess({ projectId, actorUserId: ctx.userId, userId, permission: projectPermissionArg(args, 'permission') ?? 'full' }));
    },
  },
  {
    name: 'create_team',
    description: 'Create a team inside a project.',
    mutating: true,
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
    mutating: true,
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
    mutating: true,
    parameters: objectParameters({ workspaceId: workspaceIdProp, user: { type: 'string' }, role: { type: 'string', enum: [...workspaceRoleValues], default: 'member' } }, ['user']),
    handler: async (ctx, args) => {
      const user = stringArg(args, 'user');
      if (!user) return missing('user');
      return ok('Workspace member added', await inviteWorkspaceMember({ workspaceId: scopedWorkspaceId(ctx, args), actorUserId: ctx.userId, handle: user, role: workspaceRoleArg(args, 'role') ?? 'member' }));
    },
  },
  {
    name: 'invite_team_member',
    description: 'Invite/add an existing OpenLinear user to a team.',
    mutating: true,
    parameters: objectParameters({ teamId: idProp, user: { type: 'string' }, role: { type: 'string', enum: [...teamRoleValues], default: 'member' } }, ['teamId', 'user']),
    handler: async (ctx, args) => {
      const teamId = stringArg(args, 'teamId');
      const user = stringArg(args, 'user');
      if (!teamId) return missing('teamId');
      if (!user) return missing('user');
      return ok('Team member added', await inviteTeamMember({ teamId, actorUserId: ctx.userId, handle: user, role: teamRoleArg(args, 'role') ?? 'member' }));
    },
  },
  {
    name: 'change_workspace_member_role',
    description: 'Change a workspace member role. Requires workspace owner for safety.',
    mutating: true,
    parameters: objectParameters({ workspaceId: workspaceIdProp, userId: idProp, user: { type: 'string' }, role: { type: 'string', enum: [...workspaceRoleValues] } }, ['role']),
    handler: async (ctx, args) => {
      const targetUserId = await resolveOptionalUserId(args, 'userId', 'user');
      const role = workspaceRoleArg(args, 'role');
      if (!targetUserId) return missing('userId');
      if (!role) return missing('role');
      return ok('Workspace member role changed', await changeWorkspaceMemberRole({ workspaceId: scopedWorkspaceId(ctx, args), actorUserId: ctx.userId, targetUserId, role }));
    },
  },
  {
    name: 'change_team_member_role',
    description: 'Change a team member role. Owner promotion requires team owner.',
    mutating: true,
    parameters: objectParameters({ teamId: idProp, userId: idProp, user: { type: 'string' }, role: { type: 'string', enum: [...teamRoleValues] } }, ['teamId', 'role']),
    handler: async (ctx, args) => {
      const teamId = stringArg(args, 'teamId');
      const targetUserId = await resolveOptionalUserId(args, 'userId', 'user');
      const role = teamRoleArg(args, 'role');
      if (!teamId) return missing('teamId');
      if (!targetUserId) return missing('userId');
      if (!role) return missing('role');
      return ok('Team member role changed', await changeTeamMemberRole({ teamId, actorUserId: ctx.userId, targetUserId, role }));
    },
  },
  {
    name: 'update_workspace',
    description: 'Update workspace metadata such as name.',
    mutating: true,
    parameters: objectParameters({ workspaceId: workspaceIdProp, name: { type: 'string' } }, ['name']),
    handler: async (ctx, args) => {
      const name = stringArg(args, 'name');
      if (!name) return missing('name');
      return ok('Workspace updated', await updateWorkspace({ workspaceId: scopedWorkspaceId(ctx, args), userId: ctx.userId, name }));
    },
  },
];

export function assertNoToolShapeDrift(): void {
  if (CHAT_DOMAIN_TOOLS.length !== 31) {
    throw new ValidationError(`Expected 31 chat tools, found ${CHAT_DOMAIN_TOOLS.length}`);
  }
}
