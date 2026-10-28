/**
 * P95 Phase 1 (perf1): the SQL aggregates and the one-statement project
 * access check must decide exactly what the Prisma code they replace decided.
 *
 * One multi-tenant fixture (workspace roles, explicit view/full/deny grants,
 * a workspace-less project, legacy team access, team-only and orphan tasks,
 * archived tasks, notifications, agent runs with known/unknown cost across
 * UTC day boundaries) and a set of principals (sessions and workspace-bound
 * PATs). For every principal the test compares:
 *   - `taskVisibleSql` against `scopedTaskWhere` (visible task ids);
 *   - dashboard / inbox / notification counters against the old Prisma reads;
 *   - usage summary and by-task against the old route code (verbatim copy);
 *   - `resolveProjectAccess` against the old nested-select implementation.
 * The database session runs in a non-UTC time zone on purpose.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, prisma } from '@openlinear/db';
import { taskVisibleSql } from '../services/scoped-sql';
import { dashboardTaskStats, inboxCounts, notificationCounts } from '../services/task-aggregates';
import { usageByTask, usageSummary, type UsageSort } from '../services/usage';
import { resolveProjectAccess } from '../services/workspaces';
import { getUserTeamIds } from '../services/team-scope';
import { resolveTenancyContext, runWithPrincipal } from '../tenancy/context';
import { scopedTaskWhere } from '../tenancy/scopes';
import type { AuthContext, TenancyContext } from '../tenancy/types';

const suffix = randomUUID().slice(0, 8);
const DAY = 86_400_000;

// ─── Legacy implementations (verbatim from before perf1) ────────────────────

function legacyDecimalToNumber(d: Prisma.Decimal | null | undefined): number {
  if (d === null || d === undefined) return 0;
  return d.toNumber();
}

function legacyBuildScopeWhere(principal: TenancyContext, teamIds: string[]): Prisma.AgentRunWhereInput {
  const ors: Prisma.AgentRunWhereInput[] = [{ userId: principal.userId }];
  if (teamIds.length > 0) {
    ors.push({ task: { teamId: { in: teamIds } } });
  }
  return { AND: [{ OR: ors }, { task: scopedTaskWhere(principal) }] };
}

async function legacyUsageSummary(principal: TenancyContext) {
  const teamIds = await getUserTeamIds(principal.userId);
  const where = legacyBuildScopeWhere(principal, teamIds);
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 30);
  since.setUTCHours(0, 0, 0, 0);
  const scopedSince: Prisma.AgentRunWhereInput = { AND: [where, { startedAt: { gte: since } }] };
  const [totals, runs] = await Promise.all([
    prisma.agentRun.aggregate({
      where: scopedSince,
      _sum: { costUsd: true, inputTokens: true, outputTokens: true, cachedInputTokens: true, cacheWriteTokens: true, reasoningTokens: true },
      _count: { _all: true, costUsd: true },
    }),
    prisma.agentRun.findMany({ where: scopedSince, select: { startedAt: true, costUsd: true }, orderBy: { startedAt: 'asc' } }),
  ]);
  const totalCostUsd = legacyDecimalToNumber(totals._sum.costUsd);
  const totalRuns = totals._count._all;
  const dailyMap = new Map<string, { costUsd: number; runs: number; unknownCostRuns: number }>();
  for (let i = 0; i < 30; i++) {
    const d = new Date(since);
    d.setUTCDate(d.getUTCDate() + i);
    dailyMap.set(d.toISOString().slice(0, 10), { costUsd: 0, runs: 0, unknownCostRuns: 0 });
  }
  for (const r of runs) {
    const bucket = dailyMap.get(r.startedAt.toISOString().slice(0, 10));
    if (!bucket) continue;
    bucket.costUsd += legacyDecimalToNumber(r.costUsd);
    bucket.runs += 1;
    if (r.costUsd === null) bucket.unknownCostRuns += 1;
  }
  const unknownCostRuns = totalRuns - totals._count.costUsd;
  return {
    totalCostUsd: Number(totalCostUsd.toFixed(6)),
    totalRuns,
    totalInputTokens: totals._sum.inputTokens ?? 0,
    totalOutputTokens: totals._sum.outputTokens ?? 0,
    totalCachedInputTokens: totals._sum.cachedInputTokens ?? 0,
    totalCacheWriteTokens: totals._sum.cacheWriteTokens ?? 0,
    totalReasoningTokens: totals._sum.reasoningTokens ?? 0,
    avgCostPerRun: Number((totalRuns > 0 ? totalCostUsd / totalRuns : 0).toFixed(6)),
    daily: Array.from(dailyMap.entries()).map(([date, v]) => ({
      date,
      costUsd: Number(v.costUsd.toFixed(6)),
      runs: v.runs,
      unknownCostRuns: v.unknownCostRuns,
    })),
    costCoverage: {
      runsWithKnownCost: totals._count.costUsd,
      unknownCostRuns,
      coverage: totalRuns === 0 || totals._count.costUsd === 0 ? 'none' : unknownCostRuns === 0 ? 'complete' : 'partial',
    },
  };
}

async function legacyUsageByTask(principal: TenancyContext, page: number, pageSize: number, sort: UsageSort) {
  const teamIds = await getUserTeamIds(principal.userId);
  const where = legacyBuildScopeWhere(principal, teamIds);
  const orderBy =
    sort === 'cost'
      ? ({ _sum: { costUsd: 'desc' } } as const)
      : sort === 'runs'
        ? ({ _count: { taskId: 'desc' } } as const)
        : ({ _max: { startedAt: 'desc' } } as const);
  const groups = await prisma.agentRun.groupBy({
    by: ['taskId'],
    where,
    _sum: { costUsd: true, inputTokens: true, outputTokens: true, cachedInputTokens: true, cacheWriteTokens: true, reasoningTokens: true },
    _count: { _all: true, costUsd: true },
    _max: { startedAt: true },
    orderBy,
    skip: (page - 1) * pageSize,
    take: pageSize,
  });
  const totalGroupsRaw = await prisma.agentRun.groupBy({ by: ['taskId'], where, _count: { _all: true } });
  const tasks = groups.length
    ? await prisma.task.findMany({ where: { id: { in: groups.map((g) => g.taskId) } }, select: { id: true, title: true, identifier: true } })
    : [];
  const titleMap = new Map(tasks.map((t) => [t.id, t]));
  return {
    total: totalGroupsRaw.length,
    items: groups.map((g) => {
      const t = titleMap.get(g.taskId);
      return {
        taskId: g.taskId,
        taskTitle: t?.title ?? '(deleted task)',
        taskIdentifier: t?.identifier ?? null,
        runs: g._count._all,
        totalCostUsd: Number(legacyDecimalToNumber(g._sum.costUsd).toFixed(6)),
        totalInputTokens: g._sum.inputTokens ?? 0,
        totalOutputTokens: g._sum.outputTokens ?? 0,
        totalCachedInputTokens: g._sum.cachedInputTokens ?? 0,
        totalCacheWriteTokens: g._sum.cacheWriteTokens ?? 0,
        totalReasoningTokens: g._sum.reasoningTokens ?? 0,
        unknownCostRuns: g._count._all - g._count.costUsd,
        lastRunAt: g._max.startedAt,
      };
    }),
  };
}

async function legacyDashboard(ctx: TenancyContext) {
  const where = scopedTaskWhere(ctx, { archived: false });
  const [statusCounts, priorityCounts, overdue, unassigned, total, recent] = await Promise.all([
    prisma.task.groupBy({ by: ['status'], where, _count: { _all: true } }),
    prisma.task.groupBy({ by: ['priority'], where, _count: { _all: true } }),
    prisma.task.count({ where: scopedTaskWhere(ctx, { archived: false, status: { not: 'done' }, dueDate: { lt: new Date() } }) }),
    prisma.task.count({ where: scopedTaskWhere(ctx, { archived: false, status: { not: 'done' }, assigneeId: null }) }),
    prisma.task.count({ where }),
    prisma.task.count({ where: scopedTaskWhere(ctx, { archived: false, createdAt: { gte: new Date(Date.now() - 7 * DAY) } }) }),
  ]);
  const statusMap = Object.fromEntries(statusCounts.map((s) => [s.status, s._count._all]));
  const priorityMap = Object.fromEntries(priorityCounts.map((p) => [p.priority, p._count._all]));
  return {
    total,
    recent,
    overdue,
    unassigned,
    byStatus: { todo: statusMap.todo ?? 0, in_progress: statusMap.in_progress ?? 0, done: statusMap.done ?? 0, cancelled: statusMap.cancelled ?? 0 },
    byPriority: { low: priorityMap.low ?? 0, medium: priorityMap.medium ?? 0, high: priorityMap.high ?? 0 },
  };
}

async function legacyResolveProjectAccess(projectId: string, userId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      workspaceId: true,
      access: { where: { userId }, select: { permission: true }, take: 1 },
      workspace: { select: { members: { where: { userId }, select: { role: true }, take: 1 } } },
      teams: { select: { id: true } },
    },
  });
  if (!project) return { reason: 'not_found' as const };
  const teamIds = project.teams.map((t) => t.id);
  const explicit = project.access[0]?.permission;
  if (explicit === 'deny') return { reason: 'forbidden' as const, id: project.id, workspaceId: project.workspaceId, teamIds };
  const workspaceRole = project.workspace?.members[0]?.role;
  if (project.workspaceId && workspaceRole) {
    if (explicit === 'full' || explicit === 'view') {
      return { id: project.id, workspaceId: project.workspaceId, teamIds, permission: explicit, source: 'project_access' as const };
    }
    return {
      id: project.id,
      workspaceId: project.workspaceId,
      teamIds,
      permission: workspaceRole === 'owner' || workspaceRole === 'admin' ? 'full' : 'view',
      source: 'workspace' as const,
    };
  }
  if (!project.workspaceId && (explicit === 'full' || explicit === 'view')) {
    return { id: project.id, workspaceId: project.workspaceId, teamIds, permission: explicit, source: 'project_access' as const };
  }
  if (teamIds.length > 0) {
    const userTeamIds = await getUserTeamIds(userId);
    if (teamIds.some((teamId) => userTeamIds.includes(teamId))) {
      return { id: project.id, workspaceId: project.workspaceId, teamIds, permission: 'full', source: 'legacy_team' as const };
    }
  }
  return { reason: 'forbidden' as const, id: project.id, workspaceId: project.workspaceId, teamIds };
}

// ─── Fixture ────────────────────────────────────────────────────────────────

describe('perf1: SQL aggregates and project access match the Prisma code they replace', () => {
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  const projectIds: string[] = [];
  const taskIds: string[] = [];
  const principals: Array<{ label: string; ctx: TenancyContext }> = [];
  let missingProjectId = '';

  beforeAll(async () => {
    const mkUser = async (label: string) => {
      const user = await prisma.user.create({
        data: { githubId: `p1-${label}-${suffix}`, username: `p1-${label}-${suffix}`, email: `p1-${label}-${suffix}@example.com` },
      });
      userIds.push(user.id);
      return user;
    };
    const owner = await mkUser('owner');
    const member = await mkUser('member');
    const viewer = await mkUser('viewer');
    const denied = await mkUser('denied');
    const legacy = await mkUser('legacy');
    const granted = await mkUser('granted');
    const outsider = await mkUser('outsider');

    const w1 = await prisma.workspace.create({ data: { name: `P1 W1 ${suffix}`, slug: `p1-w1-${suffix}` } });
    const w2 = await prisma.workspace.create({ data: { name: `P1 W2 ${suffix}`, slug: `p1-w2-${suffix}` } });
    workspaceIds.push(w1.id, w2.id);
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId: w1.id, userId: owner.id, role: 'owner' },
        { workspaceId: w1.id, userId: member.id, role: 'member' },
        { workspaceId: w1.id, userId: viewer.id, role: 'viewer' },
        { workspaceId: w1.id, userId: denied.id, role: 'admin' },
        { workspaceId: w2.id, userId: owner.id, role: 'owner' },
        { workspaceId: w2.id, userId: member.id, role: 'admin' },
      ],
    });

    const mkProject = async (key: string, workspaceId: string | null) => {
      const project = await prisma.project.create({ data: { name: `p1-${key}-${suffix}`, key, workspaceId } });
      projectIds.push(project.id);
      return project;
    };
    const p1 = await mkProject('PA', w1.id);
    const p2 = await mkProject('PB', w1.id);
    const p3 = await mkProject('PC', w2.id);
    const q = await mkProject('PQ', null);
    const r = await mkProject('PR', null);

    const t1 = await prisma.team.create({ data: { name: 'p1 t1', key: 'PT1', projectId: p1.id } });
    const t1b = await prisma.team.create({ data: { name: 'p1 t1b', key: 'PT1B', projectId: p1.id } });
    const t2 = await prisma.team.create({ data: { name: 'p1 t2', key: 'PT2', projectId: p2.id } });
    const t3 = await prisma.team.create({ data: { name: 'p1 t3', key: 'PT3', projectId: p3.id } });
    const tq = await prisma.team.create({ data: { name: 'p1 tq', key: 'PTQ', projectId: q.id } });
    const tr = await prisma.team.create({ data: { name: 'p1 tr', key: 'PTR', projectId: r.id } });
    await prisma.teamMember.createMany({
      data: [
        { teamId: t1.id, userId: member.id, role: 'member' },
        { teamId: t1.id, userId: denied.id, role: 'owner' },
        { teamId: t3.id, userId: legacy.id, role: 'member' },
        { teamId: tr.id, userId: legacy.id, role: 'member' },
        { teamId: tq.id, userId: outsider.id, role: 'member' },
        { teamId: t2.id, userId: viewer.id, role: 'member' },
      ],
    });
    await prisma.projectAccess.createMany({
      data: [
        { projectId: p1.id, userId: denied.id, permission: 'deny' },
        { projectId: p2.id, userId: member.id, permission: 'view' },
        { projectId: p2.id, userId: viewer.id, permission: 'full' },
        { projectId: q.id, userId: granted.id, permission: 'view' },
        { projectId: r.id, userId: granted.id, permission: 'full' },
        { projectId: q.id, userId: outsider.id, permission: 'deny' },
        { projectId: p3.id, userId: legacy.id, permission: 'view' },
      ],
    });

    const now = Date.now();
    const statuses = ['todo', 'in_progress', 'done', 'cancelled'] as const;
    const priorities = ['low', 'medium', 'high'] as const;
    let n = 0;
    const mkTask = async (data: { projectId: string | null; teamId: string | null; creatorId: string }) => {
      n += 1;
      const task = await prisma.task.create({
        data: {
          ...data,
          title: `p1 task ${n} ${suffix}`,
          identifier: `P1-${n}`,
          status: statuses[n % 4],
          priority: priorities[n % 3],
          archived: n % 7 === 0,
          inboxRead: n % 3 === 0,
          assigneeId: n % 2 === 0 ? member.id : null,
          dueDate: n % 5 === 0 ? null : new Date(now + (n % 2 === 0 ? -1 : 1) * (n % 9 + 1) * DAY),
          createdAt: new Date(now - (n % 12) * DAY),
        },
      });
      taskIds.push(task.id);
      return task;
    };
    const tasks = [];
    for (const [projectId, teamId] of [
      [p1.id, t1.id], [p1.id, t1b.id], [p1.id, null], [p2.id, t2.id], [p3.id, t3.id], [q.id, tq.id], [r.id, tr.id],
    ] as const) {
      for (let i = 0; i < 4; i += 1) tasks.push(await mkTask({ projectId, teamId, creatorId: owner.id }));
    }
    // Team-only tasks (no project) on teams of denied / foreign / legacy projects.
    for (const teamId of [t1.id, t3.id, tq.id, tr.id]) {
      for (let i = 0; i < 3; i += 1) tasks.push(await mkTask({ projectId: null, teamId, creatorId: owner.id }));
    }
    // Orphans: visible to their creator only when unbound.
    for (const creatorId of [member.id, outsider.id, granted.id]) {
      for (let i = 0; i < 2; i += 1) tasks.push(await mkTask({ projectId: null, teamId: null, creatorId }));
    }

    // Notifications for several recipients, about visible/hidden tasks and none.
    for (const recipient of [member, denied, legacy, granted, outsider, owner]) {
      for (let i = 0; i < tasks.length; i += 3) {
        await prisma.notification.create({
          data: {
            userId: recipient.id,
            type: 'mention',
            taskId: tasks[i].id,
            body: `p1 ${i}`,
            readAt: i % 2 === 0 ? new Date(now - DAY) : null,
          },
        });
      }
      await prisma.notification.create({ data: { userId: recipient.id, type: 'comment', taskId: null, body: 'p1 none' } });
    }

    // Agent runs: started by various users, known/unknown cost, token nulls,
    // spread over 40 days with some on exact UTC midnights and one today.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const runners = [owner.id, member.id, denied.id, legacy.id, granted.id, outsider.id, null];
    let k = 0;
    for (const task of tasks) {
      const runCount = (k % 4) + 1;
      for (let j = 0; j < runCount; j += 1) {
        k += 1;
        const midnight = k % 5 === 0;
        const startedAt = midnight
          ? new Date(today.getTime() - (k % 35) * DAY)
          : new Date(today.getTime() - (k % 40) * DAY + ((k * 7919) % DAY));
        await prisma.agentRun.create({
          data: {
            taskId: task.id,
            userId: runners[k % runners.length],
            agent: 'opencode',
            model: 'm',
            startedAt,
            costUsd: k % 6 === 0 ? null : new Prisma.Decimal(((k * 37) % 1000) / 997 + j / 1000),
            inputTokens: k % 4 === 0 ? null : k * 13,
            outputTokens: k * 3,
            cachedInputTokens: k % 3 === 0 ? null : k,
            cacheWriteTokens: k % 2 === 0 ? k * 2 : null,
            reasoningTokens: k % 5 === 0 ? k : null,
          },
        });
      }
    }
    // One task whose runs all lack a cost (leads the cost sort, as before).
    const nullCostTask = tasks[0];
    await prisma.agentRun.create({ data: { taskId: nullCostTask.id, userId: member.id, agent: 'opencode', model: 'm', costUsd: null } });

    // Principals: sessions for everyone, PATs bound to a workspace for some.
    const mkCtx = async (label: string, auth: AuthContext) => {
      principals.push({ label, ctx: await resolveTenancyContext(auth) });
    };
    for (const [label, user] of Object.entries({ owner, member, viewer, denied, legacy, granted, outsider })) {
      await mkCtx(`${label}:jwt`, { userId: user.id, authSource: 'jwt', scopes: [] });
    }
    await mkCtx('member:pat@w1', { userId: member.id, authSource: 'pat', scopes: ['read'], credentialId: randomUUID(), workspaceRestriction: w1.id });
    await mkCtx('member:pat@w2', { userId: member.id, authSource: 'pat', scopes: ['read'], credentialId: randomUUID(), workspaceRestriction: w2.id });
    await mkCtx('legacy:pat@w2', { userId: legacy.id, authSource: 'pat', scopes: ['read'], credentialId: randomUUID(), workspaceRestriction: w2.id });
    await mkCtx('owner:pat@w2', { userId: owner.id, authSource: 'pat', scopes: ['read'], credentialId: randomUUID(), workspaceRestriction: w2.id });
    missingProjectId = randomUUID();
  });

  afterAll(async () => {
    await prisma.agentRun.deleteMany({ where: { taskId: { in: taskIds } } });
    await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    await prisma.projectAccess.deleteMany({ where: { projectId: { in: projectIds } } });
    await prisma.teamMember.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.team.deleteMany({ where: { projectId: { in: projectIds } } });
    await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  const inFixture = (ids: string[]) => ids.filter((id) => taskIds.includes(id)).sort();

  it('the fixture exercises visible and hidden tasks for every principal kind', async () => {
    const sizes = new Set<number>();
    for (const { ctx } of principals) {
      const visible = await prisma.task.findMany({ where: scopedTaskWhere(ctx, { id: { in: taskIds } }), select: { id: true } });
      sizes.add(visible.length);
    }
    expect(principals.length).toBe(11);
    expect(sizes.size).toBeGreaterThan(5);
  });

  it('taskVisibleSql selects exactly the tasks scopedTaskWhere selects', async () => {
    for (const { label, ctx } of principals) {
      const viaPrisma = await runWithPrincipal(ctx, () =>
        prisma.task.findMany({ where: scopedTaskWhere(ctx, { id: { in: taskIds } }), select: { id: true } }),
      );
      const viaSql = await runWithPrincipal(ctx, () =>
        prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT t."id" FROM "tasks" t WHERE t."id" = ANY(${taskIds}::text[]) AND ${taskVisibleSql(ctx, 't')}`),
      );
      expect({ label, ids: inFixture(viaSql.map((row) => row.id)) }).toEqual({ label, ids: inFixture(viaPrisma.map((row) => row.id)) });
    }
  });

  it('dashboard, inbox and notification counters match the Prisma counts', async () => {
    for (const { label, ctx } of principals) {
      await runWithPrincipal(ctx, async () => {
        expect({ label, stats: await dashboardTaskStats(ctx) }).toEqual({ label, stats: await legacyDashboard(ctx) });

        const inboxWhere = (extra: Prisma.TaskWhereInput) =>
          scopedTaskWhere(ctx, { OR: [{ status: 'done' }, { status: 'cancelled' }], archived: false, ...extra });
        expect({ label, inbox: await inboxCounts(ctx) }).toEqual({
          label,
          inbox: {
            total: await prisma.task.count({ where: inboxWhere({}) }),
            unread: await prisma.task.count({ where: inboxWhere({ inboxRead: false }) }),
          },
        });

        const visible: Prisma.NotificationWhereInput = { userId: ctx.userId, OR: [{ taskId: null }, { task: scopedTaskWhere(ctx) }] };
        for (const unreadOnly of [false, true]) {
          expect({ label, unreadOnly, counts: await notificationCounts(ctx, { unreadOnly }) }).toEqual({
            label,
            unreadOnly,
            counts: {
              total: await prisma.notification.count({ where: { AND: [visible, unreadOnly ? { readAt: null } : {}] } }),
              unread: await prisma.notification.count({ where: { AND: [visible, { readAt: null }] } }),
            },
          });
        }
      });
    }
  });

  it('usage summary matches the old route (scope, daily UTC buckets, unknown cost)', async () => {
    let nonEmpty = 0;
    for (const { label, ctx } of principals) {
      await runWithPrincipal(ctx, async () => {
        const [next, legacy] = [await usageSummary(ctx), await legacyUsageSummary(ctx)];
        if (legacy.totalRuns > 0) nonEmpty += 1;
        expect({ label, summary: next }).toEqual({ label, summary: legacy });
      });
    }
    expect(nonEmpty).toBeGreaterThan(5);
  });

  it('usage by-task matches the old route for every sort and page', async () => {
    const sortKey: Record<UsageSort, (item: { totalCostUsd: number; unknownCostRuns: number; runs: number; lastRunAt: Date | null }) => string> = {
      // NULL cost sorts first in DESC: a task with only unknown-cost runs.
      cost: (item) => (item.runs === item.unknownCostRuns ? 'null' : item.totalCostUsd.toFixed(6)),
      runs: (item) => String(item.runs),
      recent: (item) => item.lastRunAt?.toISOString() ?? 'null',
    };
    for (const { label, ctx } of principals) {
      await runWithPrincipal(ctx, async () => {
        for (const sort of ['cost', 'runs', 'recent'] as const) {
          const full = await usageByTask(ctx, { page: 1, pageSize: 100, sort });
          const legacyFull = await legacyUsageByTask(ctx, 1, 100, sort);
          expect(full.total).toBe(legacyFull.total);
          const byId = (items: Array<{ taskId: string }>) => [...items].sort((a, b) => a.taskId.localeCompare(b.taskId));
          expect({ label, sort, items: byId(full.items) }).toEqual({ label, sort, items: byId(legacyFull.items) });
          // Same order of sort keys (ties may be broken differently: the old
          // query had no tiebreaker).
          expect({ label, sort, keys: full.items.map(sortKey[sort]) }).toEqual({ label, sort, keys: legacyFull.items.map(sortKey[sort]) });

          // Paging: concatenated pages are the full list; past the end the
          // total is still reported.
          const pages = [];
          for (let page = 1; page <= Math.ceil(full.total / 4) + 1; page += 1) {
            const result = await usageByTask(ctx, { page, pageSize: 4, sort });
            expect(result.total).toBe(full.total);
            pages.push(...result.items);
          }
          expect(pages.map((item) => item.taskId)).toEqual(full.items.map((item) => item.taskId));
        }
      });
    }
  });

  it('resolveProjectAccess (one statement) decides like the nested-select version', async () => {
    let decisions = 0;
    for (const { label, ctx } of principals) {
      await runWithPrincipal(ctx, async () => {
        for (const projectId of [...projectIds, missingProjectId]) {
          const next = await resolveProjectAccess(projectId, ctx.userId);
          const legacy = await legacyResolveProjectAccess(projectId, ctx.userId);
          // Team order is not part of the contract (the old query had no ORDER BY).
          const normalize = (value: typeof next | typeof legacy) =>
            'reason' in value && value.reason === 'not_found'
              ? value
              : { ...value, teamIds: [...(value as { teamIds: string[] }).teamIds].sort() };
          expect({ label, projectId, decision: normalize(next) }).toEqual({ label, projectId, decision: normalize(legacy) });
          decisions += 1;
        }
      });
    }
    expect(decisions).toBe(principals.length * 6);
  });
});
