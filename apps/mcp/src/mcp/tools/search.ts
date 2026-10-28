import * as z from 'zod';
import { defineTool, READ_ONLY } from '../tool';

const SearchType = z.enum(['issues', 'projects', 'teams']);

export const search = defineTool({
  name: 'openlinear_search',
  title: 'Search',
  description:
    'Case-insensitive text search across every issue, project and team you can access (titles, descriptions, keys, identifiers such as ENG-12), most recently updated first. Then use openlinear_get_issue or openlinear_get_project.',
  input: z.strictObject({
    query: z.string().trim().min(2).max(200).describe('Text to look for (at least 2 characters)'),
    types: z.array(SearchType).min(1).max(3).optional().describe('Defaults to all three'),
    limit: z.number().int().min(1).max(50).default(20).describe('Total results, split across the requested types'),
  }),
  output: z.object({
    issues: z.array(
      z.object({
        id: z.string(),
        identifier: z.string().nullable(),
        title: z.string(),
        status: z.string().nullable(),
        priority: z.string().nullable(),
        projectId: z.string().nullable(),
        teamId: z.string().nullable(),
      }),
    ),
    projects: z.array(
      z.object({
        id: z.string(),
        key: z.string().nullable(),
        name: z.string(),
        status: z.string().nullable(),
        workspaceId: z.string().nullable(),
      }),
    ),
    teams: z.array(
      z.object({ id: z.string(), key: z.string().nullable(), name: z.string(), projectId: z.string().nullable() }),
    ),
  }),
  annotations: READ_ONLY,
  scopes: ['read', 'tasks:read + projects:read'],
  async run({ query, types, limit }, { api, signal }) {
    const requested = [...new Set(types ?? SearchType.options)];
    const apiTypes = requested.map((type) => (type === 'issues' ? ('tasks' as const) : type));
    const result = await api.search({ q: query, types: apiTypes, limit }, signal);
    return {
      issues: result.tasks.map((task) => ({
        id: task.id,
        identifier: task.identifier ?? null,
        title: task.title,
        status: task.status ?? null,
        priority: task.priority ?? null,
        projectId: task.projectId ?? null,
        teamId: task.teamId ?? null,
      })),
      projects: result.projects.map((project) => ({
        id: project.id,
        key: project.key ?? null,
        name: project.name,
        status: project.status ?? null,
        workspaceId: project.workspaceId ?? null,
      })),
      teams: result.teams.map((team) => ({
        id: team.id,
        key: team.key ?? null,
        name: team.name,
        projectId: team.projectId ?? null,
      })),
    };
  },
});
