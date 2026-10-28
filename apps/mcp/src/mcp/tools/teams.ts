import * as z from 'zod';
import { deriveIdempotencyKey } from '../idempotency';
import { HexColor, id, WorkspaceId } from '../inputs';
import { IdempotencyShape, TeamShape, toTeam } from '../shapes';
import { defineTool, READ_ONLY } from '../tool';

export const listTeams = defineTool({
  name: 'openlinear_list_teams',
  title: 'List teams',
  description:
    'List teams (each belongs to one project and numbers its issues, e.g. ENG-12) with their members. Member user ids are the values assignee fields accept.',
  input: z.strictObject({
    projectId: id('Project').optional(),
    workspaceId: WorkspaceId.optional(),
  }),
  output: z.object({ teams: z.array(TeamShape) }),
  annotations: READ_ONLY,
  scopes: ['read', 'projects:read'],
  async run({ projectId, workspaceId }, { api, signal }) {
    const teams = await api.listTeams({ projectId, workspaceId }, signal);
    return { teams: teams.map(toTeam) };
  },
});

export const createTeam = defineTool({
  name: 'openlinear_create_team',
  title: 'Create team',
  description:
    'Create a team inside a project. Projects already get a default team, so only add one to split issue numbering. Identical calls within 24 hours return the same team.',
  input: z.strictObject({
    projectId: id('Project'),
    name: z.string().trim().min(1).max(50).describe('Team name'),
    key: z
      .string()
      .trim()
      .min(1)
      .max(10)
      .regex(/^[A-Za-z][A-Za-z0-9]*$/)
      .describe('Issue prefix, letters/digits starting with a letter; stored uppercase'),
    description: z.string().max(500).optional().describe('Short team description'),
    color: HexColor.optional(),
    icon: z.string().max(50).optional().describe('Icon name shown in the UI'),
    private: z.boolean().optional().describe('Hide the team from non-members (default false)'),
  }),
  output: z.object({ team: TeamShape, idempotency: IdempotencyShape }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  scopes: ['write', 'projects:write'],
  async run(args, { api, signal, toolName }) {
    const payload = { ...args, key: args.key.toUpperCase() };
    const key = await deriveIdempotencyKey(toolName, 'team', payload);
    const created = await api.createTeam(payload, key, signal);
    return { team: toTeam(created.value), idempotency: { key, replayed: created.replayed } };
  },
});
