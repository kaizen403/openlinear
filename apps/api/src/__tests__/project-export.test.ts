/**
 * FE-16: project export — one project only, for users who can view it;
 * credentials, logs and audit excluded; pasted secrets in free text
 * redacted. Plus the redaction patterns themselves.
 *
 * Real PostgreSQL (TEST_DATABASE_URL); fixtures delete only what they create.
 */
import { randomUUID } from 'node:crypto';
import http, { type Server } from 'node:http';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptToken, prisma } from '@openlinear/db';
import { createApp } from '../app';
import { redactText } from '../lib/redact-text';
import { generatePersonalAccessToken, hashPersonalAccessToken } from '../services/pats';
import { testJwtSecret } from './test-env';

const RUN = randomUUID().slice(0, 8);
const GH = `ghp_${'A'.repeat(36)}`;
const PAT = `ol_pat_${'0123456789abcdef'.repeat(2)}`;
const ids = { users: [] as string[], workspaces: [] as string[] };
let server: Server | undefined;
let baseUrl = '';
const tokens = { owner: '', stranger: '' };
let projectId = '';
let otherProjectId = '';
let taskId = '';

async function get(path: string, bearer: string) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${bearer}` } });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

describe('redactText', () => {
  it('redacts common credential shapes and keeps the surrounding text readable', () => {
    const text = [
      `push failed with ${GH}`,
      `token ${PAT} leaked`,
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
      'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz',
      'password: "hunter22"',
      'clone https://user:s3cret@github.com/acme/app.git',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ4In0.c2lnbmF0dXJlLXZhbHVl',
    ].join('\n');
    const out = redactText(text);
    for (const secret of [GH, PAT, 'abcdefghijklmnopqrstuvwxyz012345', 'sk-proj-abcdefghijklmnopqrstuvwxyz', 'hunter22', 's3cret', 'MIIEow', 'eyJhbGciOiJIUzI1NiJ9']) {
      expect(out, secret).not.toContain(secret);
    }
    expect(out).toContain('push failed with [redacted]');
    expect(out).toContain('Authorization: [redacted]');
    expect(out).toContain('OPENAI_API_KEY=[redacted]');
    expect(out).toContain('https://[redacted]@github.com/acme/app.git');
    expect(redactText('Fix the login form (ENG-12); run pnpm test')).toBe('Fix the login form (ENG-12); run pnpm test');
  });
});

beforeAll(async () => {
  const owner = await prisma.user.create({ data: { username: `fe16-${RUN}`, email: `fe16-${RUN}@example.com`, accessToken: encryptToken(`gho_${RUN}_secret_oauth_value_000000`) } });
  const stranger = await prisma.user.create({ data: { username: `fe16-x-${RUN}`, email: `fe16-x-${RUN}@example.com` } });
  ids.users.push(owner.id, stranger.id);
  tokens.owner = jwt.sign({ userId: owner.id, username: owner.username }, testJwtSecret(), { expiresIn: '1h' });
  tokens.stranger = jwt.sign({ userId: stranger.id, username: stranger.username }, testJwtSecret(), { expiresIn: '1h' });
  const workspace = await prisma.workspace.create({ data: { name: `FE16 ${RUN}`, slug: `fe16-${RUN}` } });
  ids.workspaces.push(workspace.id);
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' } });
  const project = await prisma.project.create({ data: { name: `Export me ${RUN}`, workspaceId: workspace.id, key: `EX${RUN.slice(0, 3).toUpperCase()}`, description: `desc with ${PAT}` } });
  projectId = project.id;
  const other = await prisma.project.create({ data: { name: `Other ${RUN}`, workspaceId: workspace.id, key: `OT${RUN.slice(0, 3).toUpperCase()}` } });
  otherProjectId = other.id;
  const team = await prisma.team.create({ data: { name: `FE16 team ${RUN}`, key: `TE${RUN.slice(0, 2).toUpperCase()}`, projectId } });
  await prisma.teamMember.create({ data: { teamId: team.id, userId: owner.id, role: 'owner' } });
  const label = await prisma.label.create({ data: { name: 'bug', color: '#ff0000', projectId } });
  const task = await prisma.task.create({
    data: {
      title: 'Fix login', description: `steps: export GITHUB_TOKEN=${GH}`, projectId, teamId: team.id, workspaceId: workspace.id,
      creatorId: owner.id, agent: 'codex', outcome: 'Done', executionLogs: [{ type: 'agent', message: `leaked ${GH}` }],
      labels: { create: [{ labelId: label.id }] },
    },
  });
  taskId = task.id;
  await prisma.comment.create({ data: { taskId, userId: owner.id, body: `here is my token ${PAT}` } });
  await prisma.agentRun.create({ data: { taskId, userId: owner.id, agent: 'codex', runner: 'codex', model: 'gpt-5', status: 'failed', errorMessage: `git push: remote rejected with ${GH}`, costUsd: 0.12 } });
  await prisma.task.create({ data: { title: 'Not exported', projectId: otherProjectId, workspaceId: workspace.id, creatorId: owner.id } });
  // W17a/W17b: a blocker edge and a plan whose spec carries a pasted secret.
  const followUp = await prisma.task.create({ data: { title: 'Ship login', projectId, teamId: team.id, workspaceId: workspace.id, creatorId: owner.id } });
  await prisma.taskDependency.create({ data: { taskId: followUp.id, dependsOnTaskId: taskId, createdById: owner.id } });
  const plan = await prisma.plan.create({
    data: {
      projectId, title: 'Login plan', createdById: owner.id, status: 'approved', approvedRevision: 1,
      revisions: { create: { number: 1, specHash: 'b'.repeat(64), note: 'first', approvedAt: new Date(), approvedById: owner.id, spec: { tasks: [{ key: 'fix', title: 'Fix login', description: `use ${GH}`, acceptance: ['works'], blockedBy: [] }] } } },
    },
  });
  await prisma.planTask.create({ data: { planId: plan.id, key: 'fix', taskId } });
  // W20: a recurring-issue schedule (description with a pasted secret) and one occurrence.
  await prisma.issueSchedule.create({
    data: {
      projectId, title: 'Weekly triage', description: `token ${PAT}`, cadence: 'weekly', weekday: 1, hour: 9, minute: 0, timezone: 'Europe/Berlin',
      nextRunAt: new Date('2026-11-02T08:00:00Z'), ownerId: owner.id, createdById: owner.id,
      occurrences: { create: { slotAt: new Date('2026-10-26T08:00:00Z'), outcome: 'created', taskId } },
    },
  });

  // FE-14: a webhook whose path carries a receiver token, with more deliveries than the export keeps.
  const hook = await prisma.webhookEndpoint.create({
    data: {
      scope: 'project', projectId, url: `https://hooks.example.com/t/${RUN}-path-token?key=${RUN}-query-token`, description: `CI bridge ${PAT}`,
      eventTypes: ['issue.created', 'digest.daily'], format: 'slack', digestHour: 9, digestTimezone: 'Europe/Berlin',
      secretEncrypted: encryptToken(`whsec_${RUN}_secret_signing_value`), secretPrefix: 'whsec_AbCd', ownerId: owner.id, createdById: owner.id,
      consecutiveFailures: 2, lastFailureAt: new Date('2026-10-27T09:00:00Z'),
    },
  });
  await prisma.webhookDelivery.createMany({
    data: Array.from({ length: 22 }, (_, index) => ({
      endpointId: hook.id, eventId: `evt_${index}:issue.created`, eventType: 'issue.created', payload: `{"marker":"${RUN}-delivery-body"}`,
      status: index === 21 ? 'failed' : 'succeeded', attempts: index === 21 ? 6 : 1, lastStatusCode: index === 21 ? 500 : 200,
      lastResponseExcerpt: `${RUN}-response-body`, lastError: index === 21 ? `${RUN}-error-text` : null,
      deliveredAt: index === 21 ? null : new Date(Date.UTC(2026, 9, 27, 0, index)), createdAt: new Date(Date.UTC(2026, 9, 27, 0, index)),
    })),
  });

  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
  await prisma.domainEventOutbox.deleteMany({ where: { OR: [{ userIds: { hasSome: ids.users } }, { workspaceIds: { hasSome: ids.workspaces } }] } });
  await prisma.domainEvent.deleteMany({ where: { OR: [{ userIds: { hasSome: ids.users } }, { workspaceIds: { hasSome: ids.workspaces } }] } });
  await prisma.task.deleteMany({ where: { workspaceId: { in: ids.workspaces } } });
  await prisma.workspace.deleteMany({ where: { id: { in: ids.workspaces } } });
  await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
});

describe('FE-16 GET /api/projects/:id/export', () => {
  it('exports this project as one versioned document, with secrets redacted and logs excluded', async () => {
    const res = await get(`/api/projects/${projectId}/export`, tokens.owner);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="openlinear-ex[a-z0-9]{3}-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body).toMatchObject({
      format: 'openlinear.project-export', version: 1, truncated: false, taskCount: 2, project: { id: projectId },
      truncation: { tasks: false, comments: false, runs: false, verifications: false, planRevisions: false, knowledgeVersions: false },
    });
    expect(res.body.dependencies).toEqual([expect.objectContaining({ taskId: expect.any(String), blockedByTaskId: taskId })]);
    expect(res.body.plans).toEqual([expect.objectContaining({
      title: 'Login plan', status: 'approved', approvedRevision: 1, tasks: [{ key: 'fix', taskId }],
      revisions: [expect.objectContaining({ number: 1, note: 'first', spec: { tasks: [{ key: 'fix', title: 'Fix login', description: 'use [redacted]', acceptance: ['works'], blockedBy: [] }] } })],
    })]);
    expect(res.body.schedules).toEqual([expect.objectContaining({
      title: 'Weekly triage', description: 'token [redacted]', cadence: 'weekly', weekday: 1, hour: 9, minute: 0, timezone: 'Europe/Berlin',
      nextRunAt: '2026-11-02T08:00:00.000Z', pausedAt: null,
      occurrences: [expect.objectContaining({ slotAt: '2026-10-26T08:00:00.000Z', kind: 'scheduled', outcome: 'created', skippedSlots: 0, taskId })],
    })]);
    expect(res.body.omitted).toEqual(expect.arrayContaining(['execution logs and agent transcripts', 'credentials, tokens and encrypted fields']));
    // FE-14: webhooks with the URL origin only, no secret, last 20 deliveries' status without bodies.
    const webhooks = res.body.webhooks as Array<Record<string, unknown>>;
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0]).toMatchObject({
      origin: 'https://hooks.example.com', description: 'CI bridge [redacted]', eventTypes: ['issue.created', 'digest.daily'], format: 'slack',
      digestHour: 9, digestTimezone: 'Europe/Berlin', active: true, consecutiveFailures: 2, lastFailureAt: '2026-10-27T09:00:00.000Z',
    });
    const deliveries = webhooks[0]?.recentDeliveries as Array<Record<string, unknown>>;
    expect(deliveries).toHaveLength(20);
    expect(deliveries[0]).toMatchObject({ eventType: 'issue.created', status: 'failed', attempts: 6, lastStatusCode: 500, deliveredAt: null, createdAt: '2026-10-27T00:21:00.000Z' });
    expect(deliveries.at(-1)).toMatchObject({ status: 'succeeded', createdAt: '2026-10-27T00:02:00.000Z' });
    expect(Object.keys(deliveries[0] ?? {}).sort()).toEqual(['attempts', 'createdAt', 'deliveredAt', 'eventType', 'id', 'lastAttemptAt', 'lastStatusCode', 'redeliveries', 'status']);
    const tasks = res.body.tasks as Array<Record<string, unknown>>;
    expect(tasks.map((task) => task.title)).toEqual(['Fix login', 'Ship login']);
    expect(tasks[0]).toMatchObject({ agent: 'codex', labelIds: [expect.any(String)] });
    const runs = (tasks[0]?.runs ?? []) as Array<Record<string, unknown>>;
    expect(runs[0]).toMatchObject({ status: 'failed', costUsd: 0.12, error: 'git push: remote rejected with [redacted]' });

    const raw = JSON.stringify(res.body);
    for (const secret of [GH, PAT, 'secret_oauth_value', 'secret_signing_value', 'whsec_AbCd', 'enc:v1:', '-path-token', '-query-token', '-delivery-body', '-response-body', '-error-text']) expect(raw, secret).not.toContain(secret);
    expect(raw).not.toContain('executionLogs');
    expect(raw).not.toContain('Not exported');
    expect(raw).toContain('here is my token [redacted]');
  });

  it('a PAT needs the task family too: the bundle carries every task, comment and run', async () => {
    const owner = ids.users[0] ?? '';
    const pat = async (scopes: string[]) => {
      const token = generatePersonalAccessToken();
      await prisma.personalAccessToken.create({ data: { userId: owner, name: `fe16-${RUN}`, tokenHash: hashPersonalAccessToken(token), tokenPrefix: token.slice(0, 15), scopes } });
      return token;
    };
    const projectsOnly = await get(`/api/projects/${projectId}/export`, await pat(['projects:read']));
    expect(projectsOnly.status).toBe(403);
    expect(projectsOnly.body.code).toBe('INSUFFICIENT_SCOPE');
    expect(JSON.stringify(projectsOnly.body)).not.toContain('Fix login');
    expect((await get(`/api/projects/${projectId}/export`, await pat(['projects:write']))).status).toBe(403);
    const both = await get(`/api/projects/${projectId}/export`, await pat(['tasks:read', 'projects:read']));
    expect(both.status).toBe(200);
    expect(both.body.taskCount).toBe(2);
  });

  it('refuses users who cannot view the project', async () => {
    const res = await get(`/api/projects/${projectId}/export`, tokens.stranger);
    expect(res.status).toBeGreaterThanOrEqual(403);
    expect(res.status).toBeLessThan(500);
  });
});
