/**
 * W15b insights: run outcomes (incl. needs recovery from both the sweeper and
 * a v2 close), verification pass rate from the latest evidence, publication,
 * duration percentiles, known vs unknown cost (only a positive cost of a
 * finished run is a price; a group or day without one is null), runner/model groups with a
 * capped label set, UTC daily series, delivery (created, completed by the
 * last recorded move to done, untracked done, cycle time, blocked now, plan
 * approvals), ranges, permissions (viewer, denied project, stranger, PAT
 * scopes), the empty project, and the per-request statement budget.
 *
 * Real PostgreSQL (TEST_DATABASE_URL); fixtures delete only what they create.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Subscribe Prisma query events (route timing counts statements per request).
vi.hoisted(() => {
  process.env.OPENLINEAR_SLOW_QUERY_MS = '60000';
  delete (globalThis as { prisma?: unknown }).prisma;
});

import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '@openlinear/db';
import { createApp } from '../app';
import { getRouteTimingSnapshot, resetRouteTiming } from '../middleware/route-timing';
import { insightsWindow, type InsightsDocument } from '../services/insights';
import { generatePersonalAccessToken, hashPersonalAccessToken } from '../services/pats';
import { testJwtSecret } from './test-env';
import { useTestServer } from './http';

const RUN = randomUUID().slice(0, 8);
const KEY = RUN.slice(0, 3).toUpperCase();
const http = useTestServer(() => createApp());
const as = (token: string) => ({ Authorization: `Bearer ${token}` });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const now = new Date();
const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
/** Noon UTC `k` days ago (k >= 1): always in the past, on a known UTC day. */
const daysAgo = (k: number) => new Date(todayStart - k * DAY + 12 * HOUR);
const dayKey = (date: Date) => date.toISOString().slice(0, 10);

const ids = { users: [] as string[], workspaces: [] as string[], projects: [] as string[], teams: [] as string[] };
const tokens = { owner: '', viewer: '', denied: '', stranger: '', patRead: '', patProjects: '' };
const p = { main: '', second: '', deniedProject: '', labels: '', empty: '', cost: '', workspace: '', otherWorkspace: '' };

async function insights(path: string, token = tokens.owner) {
  return http().get(path).set(as(token));
}

async function doc(path: string, token = tokens.owner): Promise<InsightsDocument> {
  const res = await insights(path, token);
  expect(res.status).toBe(200);
  return res.body as InsightsDocument;
}

beforeAll(async () => {
  const make = async (label: string) => {
    const user = await prisma.user.create({ data: { username: `w15b-${label}-${RUN}`, email: `w15b-${label}-${RUN}@example.com` } });
    ids.users.push(user.id);
    return user;
  };
  const owner = await make('owner');
  const viewer = await make('viewer');
  const denied = await make('denied');
  const stranger = await make('stranger');
  for (const [key, user] of [['owner', owner], ['viewer', viewer], ['denied', denied], ['stranger', stranger]] as const) {
    tokens[key] = jwt.sign({ userId: user.id, username: user.username }, testJwtSecret(), { expiresIn: '1h' });
  }
  for (const [key, scopes] of [['patRead', ['tasks:read']], ['patProjects', ['projects:read']]] as const) {
    const raw = generatePersonalAccessToken();
    await prisma.personalAccessToken.create({ data: { userId: owner.id, name: `w15b-${key}-${RUN}`, tokenHash: hashPersonalAccessToken(raw), tokenPrefix: raw.slice(0, 15), scopes: [...scopes] } });
    tokens[key] = raw;
  }

  const workspace = await prisma.workspace.create({ data: { name: `W15b ${RUN}`, slug: `w15b-${RUN}` } });
  const otherWorkspace = await prisma.workspace.create({ data: { name: `W15b other ${RUN}`, slug: `w15b-o-${RUN}` } });
  ids.workspaces.push(workspace.id, otherWorkspace.id);
  p.workspace = workspace.id;
  p.otherWorkspace = otherWorkspace.id;
  await prisma.workspaceMember.createMany({ data: [
    { workspaceId: workspace.id, userId: owner.id, role: 'owner' },
    { workspaceId: workspace.id, userId: viewer.id, role: 'viewer' },
    { workspaceId: workspace.id, userId: denied.id, role: 'member' },
    { workspaceId: otherWorkspace.id, userId: owner.id, role: 'owner' },
  ] });
  const project = async (name: string, key: string, workspaceId: string) => {
    const created = await prisma.project.create({ data: { name: `${name} ${RUN}`, key: `${key}${KEY}`, workspaceId } });
    ids.projects.push(created.id);
    const team = await prisma.team.create({ data: { name: `${name} ${RUN}`, key: `${key}${KEY}`, projectId: created.id } });
    ids.teams.push(team.id);
    return { projectId: created.id, teamId: team.id, workspaceId };
  };
  const main = await project('Main', 'M', workspace.id);
  const second = await project('Second', 'S', workspace.id);
  const deniedProject = await project('Denied', 'D', workspace.id);
  const labels = await project('Labels', 'L', otherWorkspace.id);
  const empty = await project('Empty', 'E', otherWorkspace.id);
  const cost = await project('Cost', 'C', otherWorkspace.id);
  p.cost = cost.projectId;
  p.main = main.projectId;
  p.second = second.projectId;
  p.deniedProject = deniedProject.projectId;
  p.labels = labels.projectId;
  p.empty = empty.projectId;
  await prisma.projectAccess.create({ data: { projectId: deniedProject.projectId, userId: denied.id, permission: 'deny' } });

  const task = (scope: { projectId: string; teamId: string; workspaceId: string }, title: string, data: { createdAt: Date; status?: 'todo' | 'in_progress' | 'done' | 'cancelled'; archived?: boolean; parentId?: string }) =>
    prisma.task.create({ data: { title: `${title} ${RUN}`, projectId: scope.projectId, teamId: scope.teamId, workspaceId: scope.workspaceId, creatorId: owner.id, status: data.status ?? 'todo', archived: data.archived ?? false, parentId: data.parentId ?? null, createdAt: data.createdAt } });

  const run = (taskId: string, data: { status: 'running' | 'succeeded' | 'failed' | 'cancelled'; runner: string | null; agent?: string; model: string; startedAt: Date; minutes?: number; costUsd?: number; inputTokens?: number; outputTokens?: number; prUrl?: string }) =>
    prisma.agentRun.create({ data: {
      taskId, userId: owner.id, agent: data.agent ?? data.runner ?? 'opencode', runner: data.runner, model: data.model, status: data.status,
      startedAt: data.startedAt, endedAt: data.minutes === undefined ? null : new Date(data.startedAt.getTime() + data.minutes * MINUTE),
      costUsd: data.costUsd ?? null, inputTokens: data.inputTokens ?? null, outputTokens: data.outputTokens ?? null, prUrl: data.prUrl ?? null,
    } });

  const attempt = (taskId: string, data: { agentRunId?: string; recoveryState?: string; closeReason?: string; terminalStatus?: 'done' | 'cancelled'; finishedAt?: Date }) =>
    prisma.executionAttempt.create({ data: {
      taskId, userId: owner.id, status: 'closed', authSource: 'session', snapshot: {}, projectId: main.projectId, teamId: main.teamId,
      agentRunId: data.agentRunId ?? null, recoveryState: data.recoveryState ?? null, closeReason: data.closeReason ?? null,
      terminalStatus: data.terminalStatus ?? null, finishedAt: data.finishedAt ?? null, claimedAt: data.finishedAt ?? null,
    } });

  let evidence = 0;
  const verification = (attemptId: string, taskId: string, status: 'passed' | 'failed' | 'error' | 'skipped', finishedAt: Date) => {
    evidence += 1;
    return prisma.executionVerification.create({ data: {
      attemptId, taskId, userId: owner.id, projectId: main.projectId, runId: `run-${evidence}`, commitSha: evidence.toString(16).padStart(40, 'a'),
      checksHash: 'c'.repeat(64), policy: 'warn', status, publication: 'allowed', source: 'project', runner: 'opencode',
      environment: {}, checks: [], warnings: [], bodyHash: evidence.toString(16).padStart(64, 'b'), startedAt: new Date(finishedAt.getTime() - MINUTE), finishedAt,
    } });
  };

  const statusChange = (taskId: string, to: string, at: Date) =>
    prisma.activityLog.create({ data: { taskId, projectId: main.projectId, teamId: main.teamId, userId: owner.id, action: 'task_status_changed', payload: { from: 'todo', to }, createdAt: at } });

  // ── Runs (main project) ──
  const host = await task(main, 'host', { createdAt: daysAgo(3) });
  const oldHost = await task(main, 'old host', { createdAt: daysAgo(45) });
  const r1 = await run(host.id, { status: 'succeeded', runner: 'opencode', model: 'anthropic/claude-sonnet', startedAt: daysAgo(2), minutes: 10, costUsd: 0.5, inputTokens: 1000, outputTokens: 200, prUrl: 'https://github.com/o/r/pull/1' });
  const r2 = await run(host.id, { status: 'failed', runner: 'claude-code', model: 'anthropic/claude-opus', startedAt: daysAgo(2), minutes: 20, inputTokens: 500, outputTokens: 100 });
  const r3 = await run(host.id, { status: 'cancelled', runner: null, agent: 'Codex', model: 'openai/gpt-5', startedAt: daysAgo(1), minutes: 30, costUsd: 0.1 });
  const r4 = await run(host.id, { status: 'failed', runner: 'opencode', model: 'anthropic/claude-sonnet', startedAt: daysAgo(1), minutes: 40 });
  const r5 = await run(host.id, { status: 'failed', runner: 'opencode', model: 'anthropic/claude-sonnet', startedAt: daysAgo(1), minutes: 50, costUsd: 0.25 });
  await run(host.id, { status: 'running', runner: 'opencode', model: 'anthropic/claude-sonnet', startedAt: new Date(Math.max(todayStart, now.getTime() - 5 * MINUTE)) });
  await run(oldHost.id, { status: 'succeeded', runner: 'opencode', model: 'anthropic/claude-sonnet', startedAt: daysAgo(40), minutes: 60, costUsd: 1 });

  const a1 = await attempt(host.id, { agentRunId: r1.id, terminalStatus: 'done', finishedAt: daysAgo(2) });
  await verification(a1.id, host.id, 'failed', new Date(daysAgo(2).getTime() + MINUTE));
  await verification(a1.id, host.id, 'passed', new Date(daysAgo(2).getTime() + 5 * MINUTE));
  const a2 = await attempt(host.id, { agentRunId: r2.id });
  await verification(a2.id, host.id, 'error', daysAgo(2));
  const a3 = await attempt(host.id, { agentRunId: r3.id });
  await verification(a3.id, host.id, 'skipped', daysAgo(1));
  await attempt(host.id, { agentRunId: r4.id, recoveryState: 'recovery_required', closeReason: 'sidecar_lost' });
  await attempt(host.id, { agentRunId: r5.id, closeReason: 'recovery_required' });

  // ── Delivery (main project) ──
  const doneByActivity = await task(main, 'done by activity', { createdAt: daysAgo(5), status: 'done' });
  await statusChange(doneByActivity.id, 'done', daysAgo(4));
  await statusChange(doneByActivity.id, 'todo', new Date(daysAgo(4).getTime() + HOUR));
  await statusChange(doneByActivity.id, 'done', daysAgo(2));
  const doneByAgent = await task(main, 'done by agent', { createdAt: daysAgo(6), status: 'done' });
  await attempt(doneByAgent.id, { terminalStatus: 'done', finishedAt: daysAgo(1) });
  await task(main, 'done untracked', { createdAt: daysAgo(2), status: 'done' });
  const doneLongAgo = await task(main, 'done long ago', { createdAt: daysAgo(60), status: 'done' });
  await statusChange(doneLongAgo.id, 'done', daysAgo(50));
  await prisma.$executeRaw`UPDATE "tasks" SET "updatedAt" = ${daysAgo(50).toISOString()}::timestamp(3) WHERE "id" = ${doneLongAgo.id}`;
  const reopened = await task(main, 'reopened', { createdAt: daysAgo(3) });
  await statusChange(reopened.id, 'done', daysAgo(2));
  await task(main, 'archived', { createdAt: daysAgo(1), archived: true });
  await task(main, 'sub-issue', { createdAt: daysAgo(1), parentId: doneByActivity.id });
  const blocked = await task(main, 'blocked', { createdAt: daysAgo(10) });
  const blocker = await task(main, 'blocker', { createdAt: daysAgo(10) });
  const blockedByCancelled = await task(main, 'blocked by cancelled', { createdAt: daysAgo(10), status: 'in_progress' });
  const cancelled = await task(main, 'cancelled', { createdAt: daysAgo(10), status: 'cancelled' });
  const unblocked = await task(main, 'blocker done', { createdAt: daysAgo(10) });
  const archivedBlocked = await task(main, 'archived blocked', { createdAt: daysAgo(10), archived: true });
  await prisma.taskDependency.createMany({ data: [
    { taskId: blocked.id, dependsOnTaskId: blocker.id },
    { taskId: blockedByCancelled.id, dependsOnTaskId: cancelled.id },
    { taskId: unblocked.id, dependsOnTaskId: doneByActivity.id },
    { taskId: archivedBlocked.id, dependsOnTaskId: blocker.id },
  ] });

  const plan = (title: string, data: { status: string; latestRevision: number; approvedRevision: number | null; approvals: Array<Date | null> }) =>
    prisma.plan.create({ data: {
      projectId: main.projectId, title, status: data.status, latestRevision: data.latestRevision, approvedRevision: data.approvedRevision,
      revisions: { create: data.approvals.map((approvedAt, i) => ({ number: i + 1, spec: { tasks: [] }, specHash: 'd'.repeat(64), approvedAt, approvedById: approvedAt ? owner.id : null })) },
    } });
  await plan('approved twice', { status: 'approved', latestRevision: 2, approvedRevision: 2, approvals: [daysAgo(3), daysAgo(1)] });
  await plan('draft', { status: 'draft', latestRevision: 1, approvedRevision: null, approvals: [null] });
  await plan('newer draft', { status: 'approved', latestRevision: 2, approvedRevision: 1, approvals: [daysAgo(40), null] });
  await plan('archived', { status: 'archived', latestRevision: 1, approvedRevision: null, approvals: [null] });

  // ── The rest of the workspace ──
  const secondTask = await task(second, 'second', { createdAt: daysAgo(1) });
  await run(secondTask.id, { status: 'succeeded', runner: 'opencode', model: 'anthropic/claude-sonnet', startedAt: daysAgo(1), minutes: 5, costUsd: 2 });
  const deniedTask = await task(deniedProject, 'denied', { createdAt: daysAgo(1) });
  await run(deniedTask.id, { status: 'failed', runner: 'opencode', model: 'anthropic/claude-sonnet', startedAt: daysAgo(1), minutes: 5, costUsd: 4 });

  // ── Label cap (other workspace): 12 models, 12 runners ──
  const labelTask = await task(labels, 'labels', { createdAt: daysAgo(1) });
  for (let i = 0; i < 12; i += 1) {
    const count = i < 2 ? 3 : 1;
    for (let j = 0; j < count; j += 1) {
      await run(labelTask.id, { status: 'succeeded', runner: `runner-${String(i).padStart(2, '0')}`, model: `vendor/model-${String(i).padStart(2, '0')}${'x'.repeat(i === 0 ? 200 : 0)}`, startedAt: daysAgo(1), minutes: 1 });
    }
  }

  // ── Recorded prices (other workspace): only a positive cost of a finished run counts ──
  const costTask = await task(cost, 'cost', { createdAt: daysAgo(3) });
  await run(costTask.id, { status: 'succeeded', runner: 'opencode', model: 'vendor/priced', startedAt: daysAgo(2), minutes: 5, costUsd: 1.25 });
  // A stored 0 (and a negative value written before the API refused it) is "not recorded".
  await run(costTask.id, { status: 'failed', runner: 'opencode', model: 'vendor/priced', startedAt: daysAgo(2), minutes: 5, costUsd: 0 });
  await run(costTask.id, { status: 'cancelled', runner: 'claude-code', model: 'vendor/unpriced', startedAt: daysAgo(1), minutes: 5, costUsd: -1000 });
  await run(costTask.id, { status: 'succeeded', runner: 'claude-code', model: 'vendor/unpriced', startedAt: daysAgo(1), minutes: 5 });
  // A running run's interim cost is not spend yet.
  await run(costTask.id, { status: 'running', runner: 'codex', model: 'vendor/running', startedAt: new Date(Math.max(todayStart, now.getTime() - 5 * MINUTE)), costUsd: 3 });
});

afterAll(async () => {
  await prisma.task.deleteMany({ where: { projectId: { in: ids.projects } } });
  await prisma.activityLog.deleteMany({ where: { userId: { in: ids.users } } });
  await prisma.personalAccessToken.deleteMany({ where: { userId: { in: ids.users } } });
  await prisma.team.deleteMany({ where: { id: { in: ids.teams } } });
  await prisma.project.deleteMany({ where: { id: { in: ids.projects } } });
  await prisma.workspace.deleteMany({ where: { id: { in: ids.workspaces } } });
  await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
});

describe('W15b insights window (pure)', () => {
  it('starts at UTC midnight days-1 days ago and ends now', () => {
    const at = new Date('2026-10-27T15:30:00.000Z');
    expect(insightsWindow('7d', at)).toEqual({ key: '7d', days: 7, since: new Date('2026-10-21T00:00:00.000Z'), until: at });
    expect(insightsWindow('90d', at).since.toISOString()).toBe('2026-07-30T00:00:00.000Z');
  });
});

describe('W15b project insights: runs', () => {
  it('counts outcomes, with needs-recovery separate from failed and in-progress runs out of the rates', async () => {
    const body = await doc(`/api/projects/${p.main}/insights?range=30d`);
    expect(body.scope).toEqual({ kind: 'project', id: p.main, projects: 1 });
    expect(body.range.key).toBe('30d');
    expect(body.range.days).toBe(30);
    expect(body.runs.total).toBe(6);
    expect(body.runs.outcomes).toEqual({ succeeded: 1, failed: 1, cancelled: 1, recoveryRequired: 2, inProgress: 1 });
    expect(body.runs.finished).toBe(5);
    expect(body.runs.successRate).toBe(0.2);
  });

  it('uses the latest evidence per run for the pass rate and counts publications over finished runs', async () => {
    const body = await doc(`/api/projects/${p.main}/insights`);
    expect(body.runs.verification).toEqual({ passed: 1, failed: 1, skipped: 1, unverified: 2, passRate: 0.5 });
    expect(body.runs.publication).toEqual({ published: 1, rate: 0.2 });
  });

  it('reports claim-to-end percentiles of finished runs', async () => {
    const body = await doc(`/api/projects/${p.main}/insights`);
    // 10, 20, 30, 40, 50 minutes: median 30, p90 46 (linear interpolation).
    expect(body.runs.duration).toEqual({ medianMs: 30 * MINUTE, p90Ms: 46 * MINUTE, samples: 5 });
  });

  it('never guesses a price: unknown-cost runs are counted, not summed as $0', async () => {
    const body = await doc(`/api/projects/${p.main}/insights`);
    expect(body.runs.cost).toEqual({ knownUsd: 0.85, runsWithCost: 3, unknownCostRuns: 2, coverage: 'partial' });
    expect(body.runs.tokens).toEqual({ input: 1500, output: 300, cachedInput: 0, cacheWrite: 0, reasoning: 0, runsWithTokens: 2 });
    expect(body.notes.unknownCostRuns).toContain('Never counted as $0');
  });

  it('groups by runner (runner, else the lower-cased agent) and by model', async () => {
    const body = await doc(`/api/projects/${p.main}/insights`);
    expect(body.runs.byRunner.map((group) => [group.key, group.runs])).toEqual([['opencode', 4], ['claude-code', 1], ['codex', 1]]);
    expect(body.runs.byRunner[0]).toMatchObject({ succeeded: 1, recoveryRequired: 2, inProgress: 1, successRate: 0.3333, medianMs: 40 * MINUTE, costUsd: 0.75, unknownCostRuns: 1 });
    // No run of claude-code recorded a price: unknown, not $0.
    expect(body.runs.byRunner[1]).toMatchObject({ key: 'claude-code', costUsd: null, unknownCostRuns: 1 });
    expect(body.runs.byRunner[2]).toMatchObject({ key: 'codex', costUsd: 0.1, unknownCostRuns: 0 });
    expect(body.runs.byModel.map((group) => [group.key, group.runs])).toEqual([['anthropic/claude-sonnet', 4], ['anthropic/claude-opus', 1], ['openai/gpt-5', 1]]);
  });

  it('fills one UTC day per point, today last', async () => {
    const body = await doc(`/api/projects/${p.main}/insights?range=7d`);
    expect(body.runs.daily).toHaveLength(7);
    expect(body.runs.daily[6].date).toBe(dayKey(now));
    const byDate = new Map(body.runs.daily.map((day) => [day.date, day]));
    expect(byDate.get(dayKey(daysAgo(2)))).toEqual({ date: dayKey(daysAgo(2)), runs: 2, succeeded: 1, failed: 1, cancelled: 0, recoveryRequired: 0, costUsd: 0.5, unknownCostRuns: 1 });
    expect(byDate.get(dayKey(daysAgo(1)))).toEqual({ date: dayKey(daysAgo(1)), runs: 3, succeeded: 0, failed: 0, cancelled: 1, recoveryRequired: 2, costUsd: 0.35, unknownCostRuns: 1 });
    expect(byDate.get(dayKey(now))).toMatchObject({ runs: 1, costUsd: null, unknownCostRuns: 0 });
    expect(byDate.get(dayKey(daysAgo(5)))).toMatchObject({ runs: 0, costUsd: null, unknownCostRuns: 0 });
  });

  it('widens with the range', async () => {
    const body = await doc(`/api/projects/${p.main}/insights?range=90d`);
    expect(body.runs.daily).toHaveLength(90);
    expect(body.runs.total).toBe(7);
    expect(body.runs.outcomes.succeeded).toBe(2);
    expect(body.runs.cost.knownUsd).toBe(1.85);
  });

  it('caps runner and model labels at ten plus "(other)", last, and truncates long names', async () => {
    const body = await doc(`/api/projects/${p.labels}/insights`);
    expect(body.runs.total).toBe(16);
    for (const groups of [body.runs.byRunner, body.runs.byModel]) {
      expect(groups).toHaveLength(11);
      expect(groups[10]).toMatchObject({ key: '(other)', runs: 2 });
      expect(groups.slice(0, 2).map((group) => group.runs)).toEqual([3, 3]);
    }
    expect(body.runs.byModel[0].key).toHaveLength(120);
    expect(body.runs.cost).toEqual({ knownUsd: 0, runsWithCost: 0, unknownCostRuns: 16, coverage: 'none' });
    expect(body.runs.byRunner.every((group) => group.costUsd === null)).toBe(true);
  });

  it('counts only a positive cost of a finished run as a price: a stored 0 or negative is unknown, a running run is left out', async () => {
    const body = await doc(`/api/projects/${p.cost}/insights?range=7d`);
    expect(body.runs.total).toBe(5);
    expect(body.runs.outcomes).toEqual({ succeeded: 2, failed: 1, cancelled: 1, recoveryRequired: 0, inProgress: 1 });
    // knownUsd sums exactly the runs runsWithCost counts (not the running run's 3, not the -1000).
    expect(body.runs.cost).toEqual({ knownUsd: 1.25, runsWithCost: 1, unknownCostRuns: 3, coverage: 'partial' });
    const runner = new Map(body.runs.byRunner.map((group) => [group.key, group]));
    expect(runner.get('opencode')).toMatchObject({ runs: 2, costUsd: 1.25, unknownCostRuns: 1 });
    expect(runner.get('claude-code')).toMatchObject({ runs: 2, costUsd: null, unknownCostRuns: 2 });
    expect(runner.get('codex')).toMatchObject({ runs: 1, inProgress: 1, costUsd: null, unknownCostRuns: 0 });
    const model = new Map(body.runs.byModel.map((group) => [group.key, group]));
    expect(model.get('vendor/priced')?.costUsd).toBe(1.25);
    expect(model.get('vendor/unpriced')?.costUsd).toBeNull();
    expect(model.get('vendor/running')?.costUsd).toBeNull();
    const byDate = new Map(body.runs.daily.map((day) => [day.date, day]));
    expect(byDate.get(dayKey(daysAgo(2)))).toMatchObject({ runs: 2, costUsd: 1.25, unknownCostRuns: 1 });
    expect(byDate.get(dayKey(daysAgo(1)))).toMatchObject({ runs: 2, costUsd: null, unknownCostRuns: 2 });
    expect(byDate.get(dayKey(now))).toMatchObject({ runs: 1, costUsd: null, unknownCostRuns: 0 });
  });
});

describe('W15b project insights: delivery', () => {
  it('counts created issues (archived and sub-issues included) per UTC day', async () => {
    const body = await doc(`/api/projects/${p.main}/insights?range=30d`);
    expect(body.delivery.created).toBe(13);
    const byDate = new Map(body.delivery.daily.map((day) => [day.date, day]));
    expect(byDate.get(dayKey(daysAgo(1)))?.created).toBe(2);
    expect(byDate.get(dayKey(daysAgo(10)))?.created).toBe(6);
    expect(body.delivery.daily).toHaveLength(30);
  });

  it('completes issues on their last recorded move to done (status change or agent run), with cycle time', async () => {
    const body = await doc(`/api/projects/${p.main}/insights?range=30d`);
    expect(body.delivery.completed).toBe(2);
    const byDate = new Map(body.delivery.daily.map((day) => [day.date, day]));
    expect(byDate.get(dayKey(daysAgo(2)))?.completed).toBe(1);
    expect(byDate.get(dayKey(daysAgo(1)))?.completed).toBe(1);
    expect(byDate.get(dayKey(daysAgo(4)))?.completed).toBe(0);
    // 3 days and 5 days.
    expect(body.delivery.cycleTime).toEqual({ medianMs: 4 * DAY, p90Ms: Math.round(4.8 * DAY), samples: 2 });
    expect(body.delivery.completedUntracked).toBe(1);
  });

  it('relies on every move to done bumping updatedAt, also through updateMany (the done pre-filter)', async () => {
    const task = await prisma.task.create({ data: { title: `pre-filter ${RUN}`, projectId: p.empty, createdAt: daysAgo(80) } });
    try {
      await prisma.$executeRaw`UPDATE "tasks" SET "updatedAt" = ${daysAgo(80).toISOString()}::timestamp(3) WHERE "id" = ${task.id}`;
      await prisma.task.updateMany({ where: { id: task.id }, data: { status: 'done' } });
      const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id }, select: { updatedAt: true } });
      expect(after.updatedAt.getTime()).toBeGreaterThan(now.getTime() - MINUTE);
    } finally {
      await prisma.task.delete({ where: { id: task.id } });
    }
  });

  it('reports open and blocked issues now (cancelled blockers block, archived issues do not count)', async () => {
    const body = await doc(`/api/projects/${p.main}/insights`);
    expect(body.delivery.openNow).toBe(8);
    expect(body.delivery.blockedNow).toBe(2);
  });

  it('counts plan approvals in the range and plans awaiting review', async () => {
    const recent = await doc(`/api/projects/${p.main}/insights?range=30d`);
    expect(recent.delivery.plans).toEqual({ approvals: 2, plansApproved: 1, awaitingReview: 2 });
    const wide = await doc(`/api/projects/${p.main}/insights?range=90d`);
    expect(wide.delivery.plans).toEqual({ approvals: 3, plansApproved: 2, awaitingReview: 2 });
    expect(wide.delivery.created).toBe(15);
    expect(wide.delivery.completed).toBe(3);
  });

  it('returns zeros, nulls and full series for an empty project', async () => {
    const body = await doc(`/api/projects/${p.empty}/insights?range=7d`);
    expect(body.runs).toMatchObject({
      total: 0, finished: 0, successRate: null, byRunner: [], byModel: [],
      verification: { passed: 0, failed: 0, skipped: 0, unverified: 0, passRate: null },
      publication: { published: 0, rate: null },
      duration: { medianMs: null, p90Ms: null, samples: 0 },
      cost: { knownUsd: 0, runsWithCost: 0, unknownCostRuns: 0, coverage: 'none' },
    });
    expect(body.runs.daily).toHaveLength(7);
    expect(body.runs.daily.every((day) => day.runs === 0 && day.costUsd === null)).toBe(true);
    expect(body.delivery).toMatchObject({
      created: 0, completed: 0, completedUntracked: 0, openNow: 0, blockedNow: 0,
      cycleTime: { medianMs: null, p90Ms: null, samples: 0 },
      plans: { approvals: 0, plansApproved: 0, awaitingReview: 0 },
    });
    expect(body.delivery.daily).toHaveLength(7);
  });
});

describe('W15b workspace insights', () => {
  it('aggregates the workspace projects the caller may read', async () => {
    const owner = await doc(`/api/workspaces/${p.workspace}/insights`);
    expect(owner.scope).toEqual({ kind: 'workspace', id: p.workspace, projects: 3 });
    expect(owner.runs.total).toBe(8);
    expect(owner.runs.cost.knownUsd).toBe(6.85);
    expect(owner.delivery.created).toBe(15);

    const viewer = await doc(`/api/workspaces/${p.workspace}/insights`, tokens.viewer);
    expect(viewer.runs.total).toBe(8);
  });

  it('leaves out a project that denies the caller', async () => {
    const body = await doc(`/api/workspaces/${p.workspace}/insights`, tokens.denied);
    expect(body.scope.projects).toBe(2);
    expect(body.runs.total).toBe(7);
    expect(body.runs.cost.knownUsd).toBe(2.85);
    expect(body.delivery.created).toBe(14);
  });
});

describe('W15b insights access', () => {
  it('lets a workspace viewer read a project and refuses a denied project and strangers', async () => {
    expect((await insights(`/api/projects/${p.main}/insights`, tokens.viewer)).status).toBe(200);
    expect((await insights(`/api/projects/${p.main}/insights`, tokens.denied)).status).toBe(200);
    expect([403, 404]).toContain((await insights(`/api/projects/${p.deniedProject}/insights`, tokens.denied)).status);
    expect([403, 404]).toContain((await insights(`/api/projects/${p.main}/insights`, tokens.stranger)).status);
    expect([403, 404]).toContain((await insights(`/api/projects/${p.labels}/insights`, tokens.viewer)).status);
    expect((await insights(`/api/workspaces/${p.workspace}/insights`, tokens.stranger)).status).toBe(404);
    expect((await insights(`/api/workspaces/${p.otherWorkspace}/insights`, tokens.viewer)).status).toBe(404);
  });

  it('needs tasks:read on a PAT', async () => {
    expect((await insights(`/api/projects/${p.main}/insights`, tokens.patRead)).status).toBe(200);
    expect((await insights(`/api/workspaces/${p.workspace}/insights`, tokens.patRead)).status).toBe(200);
    const refused = await insights(`/api/projects/${p.main}/insights`, tokens.patProjects);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('validates the range', async () => {
    const res = await insights(`/api/projects/${p.main}/insights?range=365d`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect((await insights(`/api/projects/${p.main}/insights?days=7`)).status).toBe(400);
  });
});

describe('W15b insights statement budget (route timing, tenancy cache off under NODE_ENV=test)', () => {
  async function statementsFor(path: string, route: string): Promise<number> {
    resetRouteTiming();
    expect((await insights(path)).status).toBe(200);
    const entry = getRouteTimingSnapshot().find((e) => e.method === 'GET' && e.route === route);
    expect(entry).toBeDefined();
    return entry!.maxQueries;
  }

  it('answers with three aggregate statements after authentication and the access check, whatever the range', async () => {
    // Every request: 1 session lookup + 3 principal reads (cache disabled in tests).
    for (const range of ['7d', '90d']) {
      expect(await statementsFor(`/api/projects/${p.main}/insights?range=${range}`, '/api/projects/:id/insights')).toBe(4 + 1 + 3);
      expect(await statementsFor(`/api/workspaces/${p.workspace}/insights?range=${range}`, '/api/workspaces/:id/insights')).toBe(4 + 1 + 3);
    }
  });
});
