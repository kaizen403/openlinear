import { prisma, type Prisma } from '@openlinear/db';
import { likeLiteral } from '../lib/like';
import { resolvePrincipalForUser } from '../tenancy/context';
import { scopedProjectWhere, scopedTaskWhere, scopedTeamWhere } from '../tenancy/scopes';

export async function searchWorkspaceData(input: {
  userId: string;
  workspaceId?: string;
  query: string;
  types?: Array<'tasks' | 'projects' | 'teams'>;
  limit?: number;
}) {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  const types = input.types?.length ? input.types : ['tasks', 'projects', 'teams'];
  const perType = Math.max(1, Math.ceil(limit / types.length));
  // The request principal, so PAT workspace binding narrows every result type.
  const ctx = await resolvePrincipalForUser(input.userId);

  const projectWhere: Prisma.ProjectWhereInput = {
    AND: [
      scopedProjectWhere(ctx),
      ...(input.workspaceId ? [{ workspaceId: input.workspaceId }] : []),
    ],
  };

  const teamWhere: Prisma.TeamWhereInput = {
    AND: [
      scopedTeamWhere(ctx),
      ...(input.workspaceId ? [{ project: { workspaceId: input.workspaceId } }] : []),
    ],
  };

  const [tasks, projects, teams] = await Promise.all([
    types.includes('tasks')
      ? prisma.task.findMany({
          where: scopedTaskWhere(ctx, {
            archived: false,
            // Workspace-scoped searches (chat tools) must not return tasks
            // from the caller's other workspaces; projects/teams already did.
            ...(input.workspaceId ? { project: { workspaceId: input.workspaceId } } : {}),
            OR: [
              { title: { contains: likeLiteral(input.query), mode: 'insensitive' } },
              { description: { contains: likeLiteral(input.query), mode: 'insensitive' } },
              { identifier: { contains: likeLiteral(input.query), mode: 'insensitive' } },
            ],
          }),
          select: { id: true, title: true, identifier: true, status: true, priority: true, projectId: true, teamId: true },
          orderBy: { updatedAt: 'desc' },
          take: perType,
        })
      : Promise.resolve([]),
    types.includes('projects')
      ? prisma.project.findMany({
          where: {
            AND: [
              projectWhere,
              {
                OR: [
                  { name: { contains: likeLiteral(input.query), mode: 'insensitive' } },
                  { description: { contains: likeLiteral(input.query), mode: 'insensitive' } },
                  { key: { contains: likeLiteral(input.query), mode: 'insensitive' } },
                ],
              },
            ],
          },
          select: { id: true, key: true, name: true, status: true, workspaceId: true },
          orderBy: { updatedAt: 'desc' },
          take: perType,
        })
      : Promise.resolve([]),
    types.includes('teams')
      ? prisma.team.findMany({
          where: {
            AND: [
              teamWhere,
              {
                OR: [
                  { name: { contains: likeLiteral(input.query), mode: 'insensitive' } },
                  { key: { contains: likeLiteral(input.query), mode: 'insensitive' } },
                  { description: { contains: likeLiteral(input.query), mode: 'insensitive' } },
                ],
              },
            ],
          },
          select: { id: true, name: true, key: true, projectId: true },
          orderBy: { name: 'asc' },
          take: perType,
        })
      : Promise.resolve([]),
  ]);

  return { tasks, projects, teams };
}
