import * as z from 'zod';
import { toWorkspace, WorkspaceShape } from '../shapes';
import { defineTool, READ_ONLY } from '../tool';

export const listWorkspaces = defineTool({
  name: 'openlinear_list_workspaces',
  title: 'List workspaces',
  description:
    'List the workspaces this token can reach, with your role and member/project counts. A workspace-bound token sees only its workspace.',
  input: z.strictObject({}),
  output: z.object({ workspaces: z.array(WorkspaceShape) }),
  annotations: READ_ONLY,
  scopes: ['read', 'workspaces:read'],
  async run(_args, { api, signal }) {
    const workspaces = await api.listWorkspaces(signal);
    return { workspaces: workspaces.map(toWorkspace) };
  },
});
