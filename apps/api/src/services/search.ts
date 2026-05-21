import { prisma, type Prisma } from '@openlinear/db';
import { getUserTeamIds } from './team-scope';
import { buildProjectAccessWhere } from './workspaces';

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
  const teamIds = await getUserTeamIds(input.userId);
  const projectWhere: Prisma.ProjectWhereInput = input.workspaceId
    ? {
        workspaceId: input.workspaceId,
        workspace: { members: { some: { userId: input.userId } } },
        NOT: { access: { some: { userId: input.userId, permission: 'deny' } } },
      }
    : buildProjectAccessWhere(input.userId, teamIds);

  const accessibleProjects = await prisma.project.findMany({ where: projectWhere, select: { id: true } });
  const projectIds = accessibleProjects.map((project) => project.id);

  const [tasks, projects, teams] = await Promise.all([
    types.includes('tasks')
      ? prisma.task.findMany({
          where: {
            archived: false,
            OR: [
              ...(projectIds.length > 0 ? [{ projectId: { in: projectIds } }] : []),
              ...(teamIds.length > 0 ? [{ projectId: null, teamId: { in: teamIds } }] : []),
            ],
            AND: [{
              OR: [
                { title: { contains: input.query, mode: 'insensitive' } },
                { description: { contains: input.query, mode: 'insensitive' } },
                { identifier: { contains: input.query, mode: 'insensitive' } },
              ],
            }],
          },
          select: { id: true, title: true, identifier: true, status: true, priority: true, projectId: true, teamId: true },
          orderBy: { updatedAt: 'desc' },
          take: perType,
        })
      : Promise.resolve([]),
    types.includes('projects')
      ? prisma.project.findMany({
          where: {
            AND: [projectWhere],
            OR: [
              { name: { contains: input.query, mode: 'insensitive' } },
              { description: { contains: input.query, mode: 'insensitive' } },
              { key: { contains: input.query, mode: 'insensitive' } },
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
            members: { some: { userId: input.userId } },
            ...(input.workspaceId ? { project: { workspaceId: input.workspaceId } } : {}),
            OR: [
              { name: { contains: input.query, mode: 'insensitive' } },
              { key: { contains: input.query, mode: 'insensitive' } },
              { description: { contains: input.query, mode: 'insensitive' } },
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
