import { prisma } from '@openlinear/db';
import { workspaceRestrictionFor } from '../tenancy/context';

/**
 * Team ids the user belongs to. For a workspace-bound PAT principal the list
 * is narrowed to teams whose project is in that workspace.
 */
export async function getUserTeamIds(userId: string): Promise<string[]> {
  const restriction = workspaceRestrictionFor(userId);
  const memberships = await prisma.teamMember.findMany({
    where: {
      userId,
      ...(restriction ? { team: { project: { workspaceId: restriction } } } : {}),
    },
    select: { teamId: true },
  });
  return memberships.map((m) => m.teamId);
}
