import * as z from 'zod';
import { deriveIdempotencyKey } from '../idempotency';
import { id, ProjectKey, ProjectStatus, WorkspaceId } from '../inputs';
import { IdempotencyShape, LabelShape, ProjectShape, toLabel, toProject } from '../shapes';
import { defineTool, READ_ONLY } from '../tool';

export const listProjects = defineTool({
  name: 'openlinear_list_projects',
  title: 'List projects',
  description:
    'List projects you can access, newest first. Filter by workspace or team, or by a case-insensitive match on name/key.',
  input: z.strictObject({
    workspaceId: WorkspaceId.optional(),
    teamId: id('Team').optional(),
    query: z.string().trim().min(1).max(100).optional().describe('Case-insensitive match on project name or key'),
    limit: z.number().int().min(1).max(200).default(50).describe('Maximum projects to return'),
  }),
  output: z.object({
    projects: z.array(ProjectShape),
    total: z.number().int().describe('Projects matching the filters'),
    truncated: z.boolean().describe('true when more than `limit` projects matched'),
  }),
  annotations: READ_ONLY,
  scopes: ['read', 'projects:read'],
  async run({ workspaceId, teamId, query, limit }, { api, signal }) {
    const projects = await api.listProjects({ workspaceId, teamId }, signal);
    const needle = query?.toLowerCase();
    const matching = needle
      ? projects.filter(
          (project) =>
            project.name.toLowerCase().includes(needle) || (project.key ?? '').toLowerCase().includes(needle),
        )
      : projects;
    return {
      projects: matching.slice(0, limit).map(toProject),
      total: matching.length,
      truncated: matching.length > limit,
    };
  },
});

export const getProject = defineTool({
  name: 'openlinear_get_project',
  title: 'Get project',
  description:
    "Get one project with its teams, repository and labels (phase labels are parsed into `phase`). List the project's issues with openlinear_list_issues.",
  input: z.strictObject({ projectId: id('Project') }),
  output: z.object({
    project: ProjectShape.extend({
      repository: z
        .object({ id: z.string(), fullName: z.string().nullable(), defaultBranch: z.string().nullable() })
        .nullable(),
      workspace: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
    }),
    labels: z.array(LabelShape),
  }),
  annotations: READ_ONLY,
  scopes: ['read', 'projects:read'],
  async run({ projectId }, { api, signal }) {
    const [project, labels] = await Promise.all([
      api.getProject(projectId, signal),
      api.listLabels(projectId, signal),
    ]);
    return {
      project: {
        ...toProject(project),
        repository: project.repository
          ? {
              id: project.repository.id,
              fullName: project.repository.fullName ?? project.repository.name ?? null,
              defaultBranch: project.repository.defaultBranch ?? null,
            }
          : null,
        workspace: project.workspace ? { id: project.workspace.id, name: project.workspace.name ?? null } : null,
      },
      labels: labels.map(toLabel),
    };
  },
});

const createProjectInput = z.strictObject({
  name: z.string().trim().min(1).max(100).describe('Project name'),
  description: z.string().max(1000).optional().describe('Short project description'),
  key: ProjectKey.optional().describe('Issue key prefix (e.g. "AUTH" gives AUTH-1); generated from the name if omitted'),
  workspaceId: WorkspaceId.optional().describe("Defaults to your default workspace (or the token's bound workspace)"),
  status: ProjectStatus.optional().describe('Defaults to planned'),
  teamIds: z
    .array(id('Team'))
    .min(1)
    .max(1)
    .optional()
    .describe(
      'Optional: move this one existing team (and its issue numbering) into the new project instead of creating a default team. Needs owner/admin on the team; it must be in the same workspace, not the last team of its project and have no issues there (else TEAM_PROJECT_CONFLICT with per-team reasons, nothing created)',
    ),
});

export const createProject = defineTool({
  name: 'openlinear_create_project',
  title: 'Create project',
  description:
    'Create a project with default labels and its own team (issue numbering), or adopt one existing team via teamIds. To create a project together with phases and issues, use openlinear_bulk_create_plan instead. Identical calls within 24 hours return the same project.',
  input: createProjectInput,
  output: z.object({ project: ProjectShape, idempotency: IdempotencyShape }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  scopes: ['write', 'projects:write'],
  async run(args, { api, signal, toolName }) {
    const key = await deriveIdempotencyKey(toolName, 'project', args);
    const created = await api.createProject({ ...args }, key, signal);
    return { project: toProject(created.value), idempotency: { key, replayed: created.replayed } };
  },
});
