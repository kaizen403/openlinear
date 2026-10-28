import { prisma, type Prisma, type ProjectPermission, type ProjectStatus } from '@openlinear/db';
import { lockProjectDependencies } from './task-dependencies';
import { PRISMA_TX_OPTIONS } from '../lib/constants';
import { HttpError } from '../errors';
import { transactionWithEvents } from '../events/outbox';
import { appendToTarget, projectTarget, userTarget, workspaceTarget } from '../events/targets';
import { logActivity } from './activity';
import { runCommand, runCommandWithStatus, type IdempotentCommand } from './idempotency';
import { getUserTeamIds } from './team-scope';
import { assertProjectAccess, assertTeamRole, OwnershipError } from './ownership';
import {
  buildProjectAccessWhere,
  ensureDefaultWorkspaceForUser,
  generateProjectKey,
  assertWorkspaceRole,
} from './workspaces';
import { addRepositoryByUrl, addRepositoryFromCloneUrl } from './github';
import { invalidateTenancyCache, workspaceRestrictionFor } from '../tenancy/context';
import { principalProjectScope } from '../tenancy/scopes';

const userSelect = { id: true, username: true, email: true, avatarUrl: true } as const;

export const projectInclude = {
  teams: true,
  repository: {
    select: { id: true, name: true, fullName: true, cloneUrl: true, defaultBranch: true },
  },
  workspace: {
    select: { id: true, name: true, slug: true, plan: true },
  },
  _count: { select: { tasks: true } },
} satisfies Prisma.ProjectInclude;

export const projectAccessInclude = { user: { select: userSelect } } satisfies Prisma.ProjectAccessInclude;

export type ProjectWithInclude = Prisma.ProjectGetPayload<{ include: typeof projectInclude }>;

function teamKeyFromProjectKey(key: string | null): string {
  const cleaned = (key ?? 'TEAM').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 12);
  return cleaned || 'TEAM';
}

async function assertWorkspaceCanWrite(workspaceId: string, userId: string): Promise<void> {
  await assertWorkspaceRole(workspaceId, userId, ['owner', 'admin', 'member']);
}

// ─── Moving teams between projects (`teamIds` on create/update) ──────────────

/**
 * `Team.projectId` is required, so every existing team already belongs to a
 * project. The old `teamIds` check ("team belongs to a different project")
 * therefore refused every existing team: POST /api/projects with `teamIds`
 * always answered 409 (after creating and deleting the project, before W04b).
 *
 * `teamIds` now means "move these teams into the project", allowed only when
 * the move leaves nothing inconsistent:
 *   - the caller is owner/admin of the team and has full access to its
 *     current project (the move changes that project);
 *   - both projects are in the same workspace (members and grants are
 *     workspace-scoped);
 *   - the current project keeps at least one team (new tasks there need one);
 *   - the team has no tasks in its current project (their team and project
 *     would disagree); project-less tasks of the team move with it;
 *   - its key is free in the target project.
 * Anything else is 409 `TEAM_PROJECT_CONFLICT` with a per-team `reason`.
 */
export type TeamMoveConflictReason =
  | 'OTHER_WORKSPACE'
  | 'LAST_TEAM_OF_PROJECT'
  | 'TEAM_HAS_PROJECT_TASKS'
  | 'TEAM_KEY_TAKEN';

/** Authorization for moving teams (runs before any idempotent replay). */
async function authorizeTeamMoves(teamIds: readonly string[], userId: string, targetProjectId: string | null): Promise<void> {
  for (const teamId of new Set(teamIds)) {
    await assertTeamRole(teamId, userId, ['owner', 'admin']);
    const team = await prisma.team.findUnique({ where: { id: teamId }, select: { projectId: true } });
    if (!team) throw new OwnershipError('team', teamId, 'not_found');
    if (team.projectId !== targetProjectId) {
      await assertProjectAccess(team.projectId, userId, 'full');
    }
  }
}

interface TeamMoveResult {
  /** Projects that lost a team (for `project:updated`). */
  sourceProjectIds: string[];
  /** Members of the moved teams (their tenancy snapshot changed). */
  memberUserIds: string[];
}

/** Integrity checks and the move itself, inside the caller's transaction. */
async function moveTeamsIntoProject(
  tx: Prisma.TransactionClient,
  teamIds: readonly string[],
  target: { id: string; workspaceId: string | null },
): Promise<TeamMoveResult> {
  const teams = await tx.team.findMany({
    where: { id: { in: [...new Set(teamIds)] }, projectId: { not: target.id } },
    select: { id: true, key: true, projectId: true, project: { select: { workspaceId: true } } },
  });
  if (teams.length === 0) return { sourceProjectIds: [], memberUserIds: [] };

  const movingIds = teams.map((team) => team.id);
  const conflicts: Array<{ teamId: string; reason: TeamMoveConflictReason }> = [];
  for (const team of teams) {
    if (team.project.workspaceId !== target.workspaceId) {
      conflicts.push({ teamId: team.id, reason: 'OTHER_WORKSPACE' });
      continue;
    }
    const remaining = await tx.team.count({
      where: { projectId: team.projectId, id: { notIn: movingIds } },
    });
    if (remaining === 0) {
      conflicts.push({ teamId: team.id, reason: 'LAST_TEAM_OF_PROJECT' });
      continue;
    }
    const projectTasks = await tx.task.count({
      where: { teamId: team.id, projectId: { not: null }, NOT: { projectId: target.id } },
    });
    if (projectTasks > 0) {
      conflicts.push({ teamId: team.id, reason: 'TEAM_HAS_PROJECT_TASKS' });
      continue;
    }
    const keyTaken = await tx.team.findFirst({
      where: { projectId: target.id, key: team.key, id: { notIn: movingIds } },
      select: { id: true },
    });
    if (keyTaken || teams.some((other) => other.id !== team.id && other.key === team.key)) {
      conflicts.push({ teamId: team.id, reason: 'TEAM_KEY_TAKEN' });
    }
  }
  if (conflicts.length > 0) {
    throw new HttpError(
      409,
      'TEAM_PROJECT_CONFLICT',
      'One or more teams cannot move to this project (see details.teams)',
      { teams: conflicts },
    );
  }

  await tx.team.updateMany({ where: { id: { in: movingIds } }, data: { projectId: target.id } });
  const members = await tx.teamMember.findMany({
    where: { teamId: { in: movingIds } },
    select: { userId: true },
  });
  return {
    sourceProjectIds: [...new Set(teams.map((team) => team.projectId))],
    memberUserIds: [...new Set(members.map((member) => member.userId))],
  };
}

/** `project:updated` for every project that lost a team, in the same transaction. */
async function appendSourceProjectUpdates(
  tx: Prisma.TransactionClient,
  projectIds: readonly string[],
  userId: string,
): Promise<void> {
  for (const projectId of projectIds) {
    const project = await tx.project.findUnique({ where: { id: projectId }, include: projectInclude });
    if (project) await appendToTarget(tx, await projectTarget(tx, projectId), 'project:updated', project, userId);
  }
}

function isSshRepoUrl(url: string): boolean {
  const trimmed = url.trim();
  return trimmed.startsWith('git@') || trimmed.startsWith('ssh://');
}

// ─── List Projects (route-facing, with field selection support) ───────────────

export async function buildAccessibleProjectsWhere(
  userId: string,
  filters: { teamId?: string; workspaceId?: string },
): Promise<Prisma.ProjectWhereInput> {
  const and: Prisma.ProjectWhereInput[] = [];
  if (filters.workspaceId) {
    and.push(
      { workspaceId: filters.workspaceId },
      { workspace: { members: { some: { userId } } } },
      { NOT: { access: { some: { userId, permission: 'deny' } } } },
      principalProjectScope(userId),
    );
  } else {
    const teamIds = await getUserTeamIds(userId);
    and.push(buildProjectAccessWhere(userId, teamIds));
  }
  if (filters.teamId) {
    and.push({ teams: { some: { id: filters.teamId } } });
  }
  return { AND: and };
}

// ─── Chat-tool-facing list (paginated) ───────────────────────────────────────

export async function listProjects(input: {
  userId: string;
  workspaceId?: string;
  teamId?: string;
  limit?: number;
  cursor?: string;
}) {
  const and: Prisma.ProjectWhereInput[] = [];
  if (input.workspaceId) {
    and.push(
      { workspaceId: input.workspaceId },
      { workspace: { members: { some: { userId: input.userId } } } },
      { NOT: { access: { some: { userId: input.userId, permission: 'deny' } } } },
      principalProjectScope(input.userId),
    );
  } else {
    const teamIds = await getUserTeamIds(input.userId);
    and.push(buildProjectAccessWhere(input.userId, teamIds));
  }
  if (input.teamId) and.push({ teams: { some: { id: input.teamId } } });

  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const projects = await prisma.project.findMany({
    where: { AND: and },
    include: projectInclude,
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });
  const page = projects.slice(0, limit);
  return { data: page, nextCursor: projects.length > limit ? page.at(-1)?.id ?? null : null };
}

// ─── Get Project ─────────────────────────────────────────────────────────────

export async function getProject(input: { projectId: string; userId: string; includeTasks?: boolean }) {
  await assertProjectAccess(input.projectId, input.userId, 'view');
  const project = await prisma.project.findUnique({ where: { id: input.projectId }, include: projectInclude });
  if (!project) throw new OwnershipError('project', input.projectId, 'not_found');
  if (!input.includeTasks) return project;
  const tasks = await prisma.task.findMany({
    where: { projectId: input.projectId, archived: false },
    select: { id: true, identifier: true, title: true, status: true, priority: true, assigneeId: true, teamId: true },
    orderBy: [{ updatedAt: 'desc' }],
    take: 200,
  });
  return { ...project, tasks };
}

// ─── List Project Access ─────────────────────────────────────────────────────

export async function listProjectAccess(input: { projectId: string; userId: string }) {
  await assertProjectAccess(input.projectId, input.userId, 'full');
  return prisma.projectAccess.findMany({
    where: { projectId: input.projectId },
    include: projectAccessInclude,
    orderBy: { grantedAt: 'asc' },
  });
}

// ─── Create Project (chat-tool simple version) ───────────────────────────────

export async function createProject(input: {
  userId: string;
  workspaceId?: string;
  key?: string;
  name: string;
  description?: string | null;
  status?: ProjectStatus;
  color?: string;
  icon?: string | null;
  leadId?: string | null;
  createDefaultTeam?: boolean;
}) {
  let workspaceId = input.workspaceId;
  if (!workspaceId) {
    const workspace = await ensureDefaultWorkspaceForUser(input.userId);
    if (!workspace) throw new OwnershipError('user', input.userId, 'not_found');
    workspaceId = workspace.id;
  }
  await assertWorkspaceCanWrite(workspaceId, input.userId);

  const resolvedKey = input.key ?? await generateProjectKey(workspaceId, input.name);
  const createDefaultTeam = input.createDefaultTeam ?? true;

  const project = await transactionWithEvents(async (tx) => {
    const created = await tx.project.create({
      data: {
        workspaceId,
        key: resolvedKey,
        name: input.name,
        description: input.description ?? undefined,
        status: input.status ?? 'planned',
        color: input.color ?? undefined,
        icon: input.icon ?? undefined,
        leadId: input.leadId ?? undefined,
      },
    });

    await tx.projectAccess.upsert({
      where: { projectId_userId: { projectId: created.id, userId: input.userId } },
      update: { permission: 'full' },
      create: { projectId: created.id, userId: input.userId, permission: 'full' },
    });

    if (createDefaultTeam) {
      await tx.team.create({
        data: {
          projectId: created.id,
          name: `${input.name} Team`,
          key: teamKeyFromProjectKey(resolvedKey),
          members: { create: { userId: input.userId, role: 'owner' } },
        },
      });
    }

    await tx.label.createMany({
      data: [
        { name: 'Bug', color: '#ef4444', priority: 5, projectId: created.id },
        { name: 'Feature', color: '#3b82f6', priority: 4, projectId: created.id },
        { name: 'Frontend', color: '#8b5cf6', priority: 3, projectId: created.id },
        { name: 'Backend', color: '#22c55e', priority: 3, projectId: created.id },
        { name: 'Docs', color: '#eab308', priority: 2, projectId: created.id },
        { name: 'Urgent', color: '#f97316', priority: 6, projectId: created.id },
      ],
      skipDuplicates: true,
    });

    const full = await tx.project.findUniqueOrThrow({ where: { id: created.id }, include: projectInclude });
    await appendToTarget(tx, await projectTarget(tx, full.id), 'project:created', full, input.userId);
    return full;
  }, PRISMA_TX_OPTIONS);

  await logActivity({
    projectId: project.id,
    teamId: project.teams[0]?.id ?? null,
    userId: input.userId,
    action: 'project_created',
    payload: { name: project.name, key: project.key, source: 'chat' },
  });
  return project;
}

// ─── Create Project (full route version) ─────────────────────────────────────

export interface CreateProjectFullInput {
  userId: string;
  isDesktopClient: boolean;
  workspaceId?: string;
  key?: string;
  teamIds?: string[];
  startDate?: string | null;
  targetDate?: string | null;
  repoUrl?: string | null;
  repositoryId?: string;
  defaultBranch?: string;
  localPath?: string | null;
  name: string;
  description?: string | null;
  status?: ProjectStatus;
  color?: string;
  icon?: string | null;
  leadId?: string | null;
}

interface PreparedProjectCreate {
  key: string;
  repositoryId?: string;
  repoUrl?: string;
}

/**
 * POST /api/projects as a command (W04b): authorization (team roles, target
 * workspace) runs before any idempotent replay; key generation and the
 * repository connection (GitHub call, repository row) run in `prepare`, once,
 * and never on replay; the project, its default team, labels, team moves,
 * the creator's grant and the `project:created` event commit together. A
 * team that already belongs to another project rolls everything back (409)
 * instead of creating and then deleting the project.
 */
export async function authorizeCreateProjectFull(
  input: CreateProjectFullInput,
): Promise<IdempotentCommand<PreparedProjectCreate, ProjectWithInclude>> {
  const { userId, isDesktopClient, teamIds, startDate, targetDate, repoUrl, repositoryId, defaultBranch, localPath } = input;

  if (localPath && !isDesktopClient) {
    throw new HttpError(403, 'DESKTOP_REQUIRED', 'localPath can only be set from the desktop app');
  }

  if (teamIds?.length) {
    await authorizeTeamMoves(teamIds, userId, null);
  }

  // A workspace-bound PAT creates projects in its own workspace by default.
  let resolvedWorkspaceId = input.workspaceId ?? workspaceRestrictionFor(userId) ?? undefined;
  if (!resolvedWorkspaceId) {
    const workspace = await ensureDefaultWorkspaceForUser(userId);
    if (!workspace) throw new OwnershipError('user', userId, 'not_found');
    resolvedWorkspaceId = workspace.id;
  }
  await assertWorkspaceCanWrite(resolvedWorkspaceId, userId);
  const workspaceId = resolvedWorkspaceId;

  return {
    resolveWorkspaceId: async () => workspaceId,
    prepare: async () => {
      const key = input.key ?? await generateProjectKey(workspaceId, input.name);
      let resolvedRepositoryId: string | undefined;
      let resolvedRepoUrl = repoUrl || undefined;

      if (repositoryId) {
        const repo = await prisma.repository.findFirst({
          where: { id: repositoryId, userId },
        });
        if (!repo) throw new HttpError(404, 'REPOSITORY_NOT_FOUND', 'Repository not found');
        resolvedRepositoryId = repo.id;
        resolvedRepoUrl = resolvedRepoUrl || `https://github.com/${repo.fullName}`;
        if (defaultBranch && defaultBranch !== repo.defaultBranch) {
          await prisma.repository.update({ where: { id: repo.id }, data: { defaultBranch } });
        }
      } else if (repoUrl) {
        if (isSshRepoUrl(repoUrl)) {
          try {
            const repo = await addRepositoryFromCloneUrl(userId, repoUrl, defaultBranch || 'main');
            resolvedRepositoryId = repo.id;
            resolvedRepoUrl = repoUrl;
          } catch (err) {
            throw new HttpError(400, 'REPOSITORY_CONNECT_FAILED', `Failed to connect repository: ${(err as Error).message}`);
          }
        } else {
          try {
            const repo = await addRepositoryByUrl(userId, repoUrl, { activate: false });
            resolvedRepositoryId = repo.id;
            if (defaultBranch && defaultBranch !== repo.defaultBranch) {
              await prisma.repository.update({ where: { id: repo.id }, data: { defaultBranch } });
            }
          } catch (err) {
            throw new HttpError(400, 'REPOSITORY_CONNECT_FAILED', `Failed to connect repository: ${(err as Error).message}`);
          }
        }
      }
      return { key, repositoryId: resolvedRepositoryId, repoUrl: resolvedRepoUrl };
    },
    mutate: async (tx, prepared) => {
      const created = await tx.project.create({
        data: {
          workspaceId,
          key: prepared.key,
          name: input.name,
          description: input.description,
          status: input.status,
          color: input.color,
          icon: input.icon,
          leadId: input.leadId,
          startDate: startDate ? new Date(startDate) : undefined,
          targetDate: targetDate ? new Date(targetDate) : undefined,
          localPath: localPath || undefined,
          repoUrl: prepared.repoUrl,
          repositoryId: prepared.repositoryId,
        },
        select: { id: true },
      });

      let moved: TeamMoveResult = { sourceProjectIds: [], memberUserIds: [] };
      if (teamIds?.length) {
        // The project adopts these teams (and their numbering) instead of a
        // default team; any conflict rolls the whole create back.
        moved = await moveTeamsIntoProject(tx, teamIds, { id: created.id, workspaceId });
      } else {
        await tx.team.create({
          data: {
            projectId: created.id,
            name: `${input.name} Team`,
            key: teamKeyFromProjectKey(prepared.key),
            members: { create: { userId, role: 'owner' } },
          },
        });
      }

      await tx.label.createMany({
        data: [
          { name: 'Bug', color: '#ef4444', priority: 5, projectId: created.id },
          { name: 'Feature', color: '#3b82f6', priority: 4, projectId: created.id },
          { name: 'Frontend', color: '#8b5cf6', priority: 3, projectId: created.id },
          { name: 'Backend', color: '#22c55e', priority: 3, projectId: created.id },
          { name: 'Docs', color: '#eab308', priority: 2, projectId: created.id },
          { name: 'Urgent', color: '#f97316', priority: 6, projectId: created.id },
        ],
        skipDuplicates: true,
      });

      await tx.projectAccess.upsert({
        where: { projectId_userId: { projectId: created.id, userId } },
        update: { permission: 'full' },
        create: { projectId: created.id, userId, permission: 'full' },
      });

      const project = await tx.project.findUniqueOrThrow({ where: { id: created.id }, include: projectInclude });
      await appendToTarget(tx, await projectTarget(tx, project.id), 'project:created', project, userId);
      await appendSourceProjectUpdates(tx, moved.sourceProjectIds, userId);
      return {
        status: 201,
        body: project,
        // The creator gained a team membership (default team) and a grant;
        // members of moved teams now reach a different project.
        afterCommit: async () => {
          invalidateTenancyCache(userId);
          for (const memberId of moved.memberUserIds) invalidateTenancyCache(memberId);
        },
      };
    },
  };
}

export async function createProjectFull(input: CreateProjectFullInput): Promise<ProjectWithInclude> {
  return runCommand(await authorizeCreateProjectFull(input));
}

// ─── Update Project (chat-tool simple version) ───────────────────────────────

export async function updateProject(input: {
  userId: string;
  projectId: string;
  name?: string;
  description?: string | null;
  status?: ProjectStatus;
  color?: string;
  icon?: string | null;
  leadId?: string | null;
  startDate?: string | null;
  targetDate?: string | null;
}) {
  const owned = await assertProjectAccess(input.projectId, input.userId, 'full');
  if (owned.source === 'legacy_team') {
    for (const teamId of owned.teamIds) {
      await assertTeamRole(teamId, input.userId, ['owner', 'admin', 'member']);
    }
  }

  const data: Prisma.ProjectUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.description !== undefined) data.description = input.description;
  if (input.status !== undefined) data.status = input.status;
  if (input.color !== undefined) data.color = input.color;
  if (input.icon !== undefined) data.icon = input.icon;
  if (input.leadId !== undefined) data.lead = input.leadId ? { connect: { id: input.leadId } } : { disconnect: true };
  if (input.startDate !== undefined) data.startDate = input.startDate ? new Date(input.startDate) : null;
  if (input.targetDate !== undefined) data.targetDate = input.targetDate ? new Date(input.targetDate) : null;

  // W04b: `project:updated` commits with the update.
  const project = await transactionWithEvents(async (tx) => {
    const updated = await tx.project.update({ where: { id: input.projectId }, data, include: projectInclude });
    await appendToTarget(tx, await projectTarget(tx, input.projectId), 'project:updated', updated, input.userId);
    return updated;
  });
  await logActivity({
    projectId: input.projectId,
    teamId: project.teams[0]?.id ?? owned.teamIds[0] ?? null,
    userId: input.userId,
    action: 'project_updated',
    payload: { fields: Object.keys(data), source: 'chat' },
  });
  return project;
}

// ─── Update Project (full route version) ─────────────────────────────────────

export async function updateProjectFull(input: {
  userId: string;
  projectId: string;
  isDesktopClient: boolean;
  bodyFields: string[];
  teamIds?: string[];
  startDate?: string | null;
  targetDate?: string | null;
  repoUrl?: string | null;
  localPath?: string | null;
  workspaceId?: string | null;
  key?: string | null;
  name?: string;
  description?: string | null;
  status?: ProjectStatus;
  color?: string;
  icon?: string | null;
  leadId?: string | null;
  defaultAgent?: string | null;
}): Promise<ProjectWithInclude> {
  const { userId, projectId, isDesktopClient, teamIds, startDate, targetDate, repoUrl, localPath, workspaceId, key } = input;

  const owned = await assertProjectAccess(projectId, userId, 'full');
  if (owned.source === 'legacy_team') {
    for (const tid of owned.teamIds) {
      await assertTeamRole(tid, userId, ['owner', 'admin', 'member']);
    }
  }

  const existingProject = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true, workspaceId: true, key: true },
  });
  if (!existingProject) throw new OwnershipError('project', projectId, 'not_found');

  if (teamIds !== undefined && teamIds.length > 0) {
    await authorizeTeamMoves(teamIds, userId, projectId);
  }

  let nextWorkspaceId = existingProject.workspaceId;
  if (workspaceId !== undefined) {
    if (workspaceId) {
      await assertWorkspaceCanWrite(workspaceId, userId);
      nextWorkspaceId = workspaceId;
    } else {
      nextWorkspaceId = null;
    }
  }
  const workspaceChanged = workspaceId !== undefined && nextWorkspaceId !== existingProject.workspaceId;

  let nextKey: string | null | undefined;
  if (key !== undefined) {
    nextKey = key;
  } else if (workspaceChanged && existingProject.key) {
    const keyConflict = await prisma.project.findFirst({
      where: { workspaceId: nextWorkspaceId, key: existingProject.key, NOT: { id: projectId } },
      select: { id: true },
    });
    if (keyConflict) {
      nextKey = await generateProjectKey(nextWorkspaceId, input.name ?? existingProject.name, projectId);
    }
  } else if (workspaceChanged && !existingProject.key) {
    nextKey = await generateProjectKey(nextWorkspaceId, input.name ?? existingProject.name, projectId);
  }

  if (localPath !== undefined && !isDesktopClient) {
    throw new HttpError(403, 'DESKTOP_REQUIRED', 'localPath can only be updated from the desktop app');
  }

  const dateFields: Record<string, Date | null | undefined> = {};
  if (startDate !== undefined) dateFields.startDate = startDate ? new Date(startDate) : null;
  if (targetDate !== undefined) dateFields.targetDate = targetDate ? new Date(targetDate) : null;

  let repositoryId: string | null | undefined;
  if (repoUrl !== undefined) {
    if (repoUrl) {
      try {
        const repo = await addRepositoryByUrl(userId, repoUrl, { activate: false });
        repositoryId = repo.id;
      } catch (err) {
        throw new HttpError(400, 'REPOSITORY_CONNECT_FAILED', `Failed to connect repository: ${(err as Error).message}`);
      }
    } else {
      repositoryId = null;
    }
  }

  const updateData: Record<string, unknown> = {};
  if (input.name !== undefined) updateData.name = input.name;
  if (input.description !== undefined) updateData.description = input.description;
  if (input.status !== undefined) updateData.status = input.status;
  if (input.color !== undefined) updateData.color = input.color;
  if (input.icon !== undefined) updateData.icon = input.icon;
  if (input.leadId !== undefined) updateData.leadId = input.leadId;
  if (input.defaultAgent !== undefined) updateData.defaultAgent = input.defaultAgent;

  // W04b: the update, any team moves and the `project:updated` events commit
  // together (the event used to be broadcast after commit).
  const { project, moved } = await transactionWithEvents(async (tx) => {
    let teamMoves: TeamMoveResult = { sourceProjectIds: [], memberUserIds: [] };
    if (workspaceChanged) {
      await tx.projectAccess.deleteMany({ where: { projectId } });
    }
    const updated = await tx.project.update({
      where: { id: projectId },
      data: {
        ...updateData,
        ...dateFields,
        ...(workspaceId !== undefined ? { workspaceId: nextWorkspaceId } : {}),
        ...(nextKey !== undefined ? { key: nextKey } : {}),
        ...(repoUrl !== undefined ? { repoUrl } : {}),
        ...(localPath !== undefined ? { localPath } : {}),
        ...(repositoryId !== undefined ? { repositoryId } : {}),
      },
      select: { id: true },
    });
    if (teamIds !== undefined && teamIds.length > 0) {
      // Teams cannot leave a project (Team.projectId is required), so
      // `teamIds` only adds teams; listed teams already here are no-ops.
      teamMoves = await moveTeamsIntoProject(tx, teamIds, { id: updated.id, workspaceId: nextWorkspaceId });
    }
    const full = await tx.project.findUniqueOrThrow({ where: { id: projectId }, include: projectInclude });
    await appendToTarget(tx, await projectTarget(tx, projectId), 'project:updated', full, userId);
    await appendSourceProjectUpdates(tx, teamMoves.sourceProjectIds, userId);
    return { project: full, moved: teamMoves };
  }, PRISMA_TX_OPTIONS);

  for (const memberId of moved.memberUserIds) invalidateTenancyCache(memberId);

  const broadcastTeamIds = project.teams.map((t) => t.id);
  const activityTeamIds = broadcastTeamIds.length > 0 ? broadcastTeamIds : owned.teamIds;
  for (const tid of activityTeamIds) {
    await logActivity({
      projectId,
      teamId: tid,
      userId,
      action: 'project_updated',
      payload: { fields: input.bodyFields },
    });
  }

  return project;
}

// ─── Delete Project ──────────────────────────────────────────────────────────

export async function deleteProject(input: { projectId: string; userId: string }): Promise<void> {
  const { projectId, userId } = input;

  const owned = await assertProjectAccess(projectId, userId, 'full');
  if (owned.source === 'legacy_team') {
    for (const tid of owned.teamIds) {
      await assertTeamRole(tid, userId, ['owner', 'admin']);
    }
  }

  const recipients = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      workspaceId: true,
      teams: { select: { id: true } },
      access: {
        where: { permission: { in: ['full', 'view'] } },
        select: { userId: true },
      },
    },
  });

  // W04b: the delete and its `project:deleted` events commit together. Same
  // audiences as the former post-commit broadcasts (workspace, each team,
  // each grantee, else the actor), resolved before the rows go.
  const payload = { id: projectId };
  await transactionWithEvents(async (tx) => {
    // W17a: the project's tasks become project-less; their dependency edges go first.
    await lockProjectDependencies(tx, projectId);
    await tx.taskDependency.deleteMany({ where: { OR: [{ task: { projectId } }, { dependsOnTask: { projectId } }] } });
    await tx.task.updateMany({ where: { projectId }, data: { projectId: null } });
    await tx.project.delete({ where: { id: projectId } });
    if (recipients?.workspaceId) {
      await appendToTarget(tx, workspaceTarget(recipients.workspaceId), 'project:deleted', payload, userId);
    }
    for (const team of recipients?.teams ?? []) {
      await appendToTarget(tx, {
        audience: { teamIds: [team.id] },
        // The team row is deleted with the project (cascade): bind to the
        // workspace that owned it, as `teamTarget` would have before.
        resource: { type: 'team', projectId, workspaceId: recipients?.workspaceId ?? null },
      }, 'project:deleted', payload, userId);
    }
    for (const access of recipients?.access ?? []) {
      await appendToTarget(tx, userTarget(access.userId), 'project:deleted', payload, userId);
    }
    if (!recipients?.workspaceId && !recipients?.teams.length && !recipients?.access.length) {
      await appendToTarget(tx, userTarget(userId), 'project:deleted', payload, userId);
    }
  }, PRISMA_TX_OPTIONS);
}

// ─── Grant Project Access (single) ──────────────────────────────────────────

type ProjectAccessWithUser = Prisma.ProjectAccessGetPayload<{ include: typeof projectAccessInclude }>;

async function loadGrantableProject(projectId: string, actorUserId: string): Promise<{ workspaceId: string | null }> {
  await assertProjectAccess(projectId, actorUserId, 'full');
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } });
  if (!project) throw new OwnershipError('project', projectId, 'not_found');
  return project;
}

/**
 * POST /api/projects/:id/access as a command (W04b). Answers 201 for a new
 * grant and 200 for an updated one; the grant and its
 * `project:access-changed` event commit together, and the grantee's cached
 * principal and open streams are refreshed right after commit, before the
 * event can be delivered.
 */
export async function authorizeGrantProjectAccess(input: {
  projectId: string;
  actorUserId: string;
  userId: string;
  permission: ProjectPermission;
}): Promise<IdempotentCommand<void, ProjectAccessWithUser>> {
  const project = await loadGrantableProject(input.projectId, input.actorUserId);
  return {
    resolveWorkspaceId: async () => project.workspaceId,
    prepare: async () => {
      const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { id: true } });
      if (!user) throw new OwnershipError('user', input.userId, 'not_found');
      if (project.workspaceId) {
        const member = await prisma.workspaceMember.findUnique({
          where: { workspaceId_userId: { workspaceId: project.workspaceId, userId: input.userId } },
          select: { id: true },
        });
        if (!member) {
          throw new HttpError(400, 'USER_NOT_WORKSPACE_MEMBER', 'Project access can only be granted to workspace members');
        }
      }
    },
    mutate: async (tx) => {
      const existing = await tx.projectAccess.findUnique({
        where: { projectId_userId: { projectId: input.projectId, userId: input.userId } },
        select: { id: true },
      });
      const access = await tx.projectAccess.upsert({
        where: { projectId_userId: { projectId: input.projectId, userId: input.userId } },
        update: { permission: input.permission },
        create: { projectId: input.projectId, userId: input.userId, permission: input.permission },
        include: projectAccessInclude,
      });
      await appendToTarget(
        tx,
        await projectTarget(tx, input.projectId),
        'project:access-changed',
        { projectId: input.projectId, access },
        input.actorUserId,
      );
      return {
        status: existing ? 200 : 201,
        body: access,
        afterCommit: async () => { invalidateTenancyCache(input.userId); },
      };
    },
  };
}

export async function grantProjectAccess(input: {
  projectId: string;
  actorUserId: string;
  userId: string;
  permission: ProjectPermission;
}): Promise<{ access: ProjectAccessWithUser; isNew: boolean }> {
  const result = await runCommandWithStatus(await authorizeGrantProjectAccess(input));
  return { access: result.body, isNew: result.status === 201 };
}

// ─── Grant Project Access (bulk) ─────────────────────────────────────────────

interface PreparedBulkGrant {
  grantable: Array<{ userId: string; permission: ProjectPermission }>;
  skipped: Array<{ userId: string; reason: string }>;
}

export interface BulkProjectAccessResult {
  granted: ProjectAccessWithUser[];
  skipped: Array<{ userId: string; reason: string }>;
}

/** POST /api/projects/:id/access/bulk as a command (W04b); see the single grant. */
export async function authorizeGrantProjectAccessBulk(input: {
  projectId: string;
  actorUserId: string;
  grants: Array<{ userId: string; permission: ProjectPermission }>;
}): Promise<IdempotentCommand<PreparedBulkGrant, BulkProjectAccessResult>> {
  const project = await loadGrantableProject(input.projectId, input.actorUserId);
  return {
    resolveWorkspaceId: async () => project.workspaceId,
    prepare: async () => {
      const grantsByUser = new Map<string, { userId: string; permission: ProjectPermission }>();
      for (const grant of input.grants) {
        grantsByUser.set(grant.userId, grant);
      }
      const grants = Array.from(grantsByUser.values());
      const userIds = grants.map((g) => g.userId);

      const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true } });
      const foundUserIds = new Set(users.map((u) => u.id));
      const skipped: Array<{ userId: string; reason: string }> = grants
        .filter((g) => !foundUserIds.has(g.userId))
        .map((g) => ({ userId: g.userId, reason: 'USER_NOT_FOUND' }));

      let allowedUserIds = foundUserIds;
      if (project.workspaceId) {
        const memberships = await prisma.workspaceMember.findMany({
          where: { workspaceId: project.workspaceId, userId: { in: Array.from(foundUserIds) } },
          select: { userId: true },
        });
        allowedUserIds = new Set(memberships.map((m) => m.userId));
        for (const uid of foundUserIds) {
          if (!allowedUserIds.has(uid)) {
            skipped.push({ userId: uid, reason: 'USER_NOT_WORKSPACE_MEMBER' });
          }
        }
      }
      return { grantable: grants.filter((g) => allowedUserIds.has(g.userId)), skipped };
    },
    mutate: async (tx, { grantable, skipped }) => {
      const granted: ProjectAccessWithUser[] = [];
      for (const grant of grantable) {
        granted.push(await tx.projectAccess.upsert({
          where: { projectId_userId: { projectId: input.projectId, userId: grant.userId } },
          update: { permission: grant.permission },
          create: { projectId: input.projectId, userId: grant.userId, permission: grant.permission },
          include: projectAccessInclude,
        }));
      }
      await appendToTarget(
        tx,
        await projectTarget(tx, input.projectId),
        'project:access-changed',
        { projectId: input.projectId, access: granted, skipped },
        input.actorUserId,
      );
      return {
        status: 200,
        body: { granted, skipped },
        // Bulk grants may include `deny`; re-authorize cached principals and
        // open streams of every affected user, as the single grant does.
        afterCommit: async () => {
          for (const grant of granted) invalidateTenancyCache(grant.userId);
        },
      };
    },
  };
}

export async function grantProjectAccessBulk(input: {
  projectId: string;
  actorUserId: string;
  grants: Array<{ userId: string; permission: ProjectPermission }>;
}): Promise<BulkProjectAccessResult> {
  return runCommand(await authorizeGrantProjectAccessBulk(input));
}

// ─── Revoke Project Access (deny) ────────────────────────────────────────────

export async function revokeProjectAccess(input: {
  projectId: string;
  actorUserId: string;
  targetUserId: string;
}): Promise<void> {
  await assertProjectAccess(input.projectId, input.actorUserId, 'full');

  const payload = { projectId: input.projectId, userId: input.targetUserId, permission: 'deny' };
  await transactionWithEvents(async (tx) => {
    await tx.projectAccess.upsert({
      where: { projectId_userId: { projectId: input.projectId, userId: input.targetUserId } },
      update: { permission: 'deny' },
      create: { projectId: input.projectId, userId: input.targetUserId, permission: 'deny' },
    });
    await appendToTarget(tx, await projectTarget(tx, input.projectId), 'project:access-changed', payload, input.actorUserId);
    await appendToTarget(tx, userTarget(input.targetUserId), 'project:access-changed', payload, input.actorUserId);
  });
  // Synchronously after commit, before the flush can deliver anything.
  invalidateTenancyCache(input.targetUserId);
}
