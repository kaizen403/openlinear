/**
 * FE-14 follow-up against real PostgreSQL and a local HTTP receiver on
 * 127.0.0.1 (the explicit loopback test hook; nothing leaves the machine,
 * Slack and Discord are never called): per-endpoint body formats (URL rules
 * on create and change, Slack / Discord messages delivered with the usual
 * signed headers, titles only), and the daily digest (settings, numbers,
 * one digest per endpoint and local date under re-runs and racing workers,
 * workspace scope, owner rights, the webhook cycle).
 *
 * Fixtures delete only what they create (TEST_DATABASE_URL).
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import http, { type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@openlinear/db';
import { createApp } from '../app';
import { sequencePendingEvents } from '../events/stream';
import { runWebhookDeliveries } from '../services/webhook-delivery';
import { digestSlot, runDueDigests } from '../services/webhook-digest';
import { fanOutWebhookEvents } from '../services/webhook-events';
import { allowLoopbackWebhooksForTests } from '../services/webhook-network';
import { runWebhookCycle } from '../services/webhooks';
import { useTestServer } from './http';
import { testJwtSecret } from './test-env';

const RUN = randomUUID().slice(0, 8);
const http_ = useTestServer(() => createApp());
const ids = { users: [] as string[], workspaces: [] as string[], projects: [] as string[] };
const users = { owner: '', admin: '' };
const tokens = { owner: '', admin: '' };
let workspaceId = '';
let projectId = '';
let digestProjectId = '';
let deniedProjectId = '';

type Body = Record<string, unknown>;
const as = (token: string) => ({ Authorization: `Bearer ${token}` });

// ── Local receiver ─────────────────────────────────────────────────────────

interface Received { path: string; headers: IncomingHttpHeaders; body: string }
const received: Received[] = [];
let receiver: Server;
let base = '';

function hits(path: string): Received[] {
  return received.filter((entry) => entry.path === path);
}

function verifySignature(entry: Received, secret: string): boolean {
  const timestamp = String(entry.headers['openlinear-timestamp']);
  const expected = createHmac('sha256', secret).update(`${timestamp}.${entry.body}`).digest();
  return String(entry.headers['openlinear-signature']).split(',').map((part) => part.trim())
    .filter((part) => part.startsWith('v1='))
    .some((part) => {
      const given = Buffer.from(part.slice(3), 'hex');
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function createEndpoint(body: Body, options: { token?: string; project?: string; workspace?: string } = {}) {
  const path = options.workspace ? `/api/workspaces/${options.workspace}/webhooks` : `/api/projects/${options.project ?? projectId}/webhooks`;
  return http_().post(path).set(as(options.token ?? tokens.owner)).send(body);
}

async function endpoint(body: Body, options: { token?: string; project?: string; workspace?: string } = {}): Promise<{ id: string; secret: string; body: Body }> {
  const res = await createEndpoint(body, options);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { id: res.body.id as string, secret: res.body.secret as string, body: res.body as Body };
}

/** Sequence committed outbox rows into the stream, then fan out. */
async function pump() {
  for (let round = 0; round < 10; round += 1) {
    await sequencePendingEvents();
    if ((await prisma.domainEventOutbox.count()) === 0) break;
  }
  return fanOutWebhookEvents();
}

async function clearEndpoints(): Promise<void> {
  await prisma.webhookEndpoint.deleteMany({ where: { OR: [{ projectId: { in: ids.projects } }, { workspaceId: { in: ids.workspaces } }] } });
}

/** Make an endpoint's digest due (as if its hour just passed): the due time is always a slot. */
async function makeDue(endpointId: string, slotAt: Date): Promise<void> {
  await prisma.webhookEndpoint.update({ where: { id: endpointId }, data: { digestNextAt: slotAt } });
}

async function digestsOf(endpointId: string) {
  return prisma.webhookDelivery.findMany({ where: { endpointId, eventType: 'digest.daily' }, orderBy: { createdAt: 'asc' } });
}

beforeAll(async () => {
  allowLoopbackWebhooksForTests(true);
  receiver = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ path: (req.url ?? '/').split('?')[0] ?? '/', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

  for (const key of Object.keys(users) as Array<keyof typeof users>) {
    const user = await prisma.user.create({ data: { username: `whi-${key}-${RUN}`, email: `whi-${key}-${RUN}@example.com` } });
    ids.users.push(user.id);
    users[key] = user.id;
    tokens[key] = jwt.sign({ userId: user.id, username: user.username }, testJwtSecret(), { expiresIn: '1h' });
  }
  const workspace = await prisma.workspace.create({ data: { name: `WHI ${RUN}`, slug: `whi-${RUN}` } });
  workspaceId = workspace.id;
  ids.workspaces.push(workspaceId);
  await prisma.workspaceMember.createMany({ data: [
    { workspaceId, userId: users.owner, role: 'owner' },
    { workspaceId, userId: users.admin, role: 'admin' },
  ] });
  const key = RUN.slice(0, 3).toUpperCase();
  const makeProject = async (name: string, prefix: string) => {
    const project = await prisma.project.create({ data: { name: `${name} ${RUN}`, workspaceId, key: `${prefix}${key}` } });
    ids.projects.push(project.id);
    const team = await prisma.team.create({ data: { name: `${name} ${RUN}`, key: `${prefix}${key}`, projectId: project.id } });
    await prisma.teamMember.createMany({ data: [{ teamId: team.id, userId: users.owner, role: 'owner' }, { teamId: team.id, userId: users.admin, role: 'admin' }] });
    return project.id;
  };
  projectId = await makeProject('Hooks', 'H');
  digestProjectId = await makeProject('Digest', 'G');
  deniedProjectId = await makeProject('Denied', 'N');
  await prisma.projectAccess.create({ data: { projectId: deniedProjectId, userId: users.owner, permission: 'deny' } });
  await pump();
});

afterAll(async () => {
  allowLoopbackWebhooksForTests(false);
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
  await prisma.notification.deleteMany({ where: { userId: { in: ids.users } } });
  await prisma.auditLog.deleteMany({ where: { workspaceId: { in: ids.workspaces } } });
  await prisma.activityLog.deleteMany({ where: { userId: { in: ids.users } } });
  await prisma.domainEventOutbox.deleteMany({ where: { OR: [{ userIds: { hasSome: ids.users } }, { workspaceIds: { hasSome: ids.workspaces } }, { actorId: { in: ids.users } }] } });
  await prisma.domainEvent.deleteMany({ where: { OR: [{ userIds: { hasSome: ids.users } }, { workspaceIds: { hasSome: ids.workspaces } }, { actorId: { in: ids.users } }] } });
  await prisma.idempotencyRecord.deleteMany({ where: { workspaceId: { in: ids.workspaces } } });
  await prisma.agentRun.deleteMany({ where: { userId: { in: ids.users } } });
  await prisma.task.deleteMany({ where: { OR: [{ creatorId: { in: ids.users } }, { projectId: { in: ids.projects } }] } });
  await prisma.project.deleteMany({ where: { id: { in: ids.projects } } });
  await prisma.workspace.deleteMany({ where: { id: { in: ids.workspaces } } });
  await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
});

// ── Formats: API rules ─────────────────────────────────────────────────────

describe('FE-14 webhook formats: URL rules and settings', () => {
  beforeEach(clearEndpoints);

  it('gives a Slack or Discord endpoint only its own kind of URL, on create and on change; the SSRF rules still come first', async () => {
    const slackUrl = 'https://hooks.slack.com/services/T000/B000/XXXX';
    const wrong = await createEndpoint({ url: 'https://example.com/hook', format: 'slack', eventTypes: ['plan.approved'] });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toMatchObject({ code: 'WEBHOOK_URL_INVALID', details: { field: 'url', reason: 'slack_url_required', format: 'slack' } });
    const discordWrong = await createEndpoint({ url: slackUrl, format: 'discord', eventTypes: ['plan.approved'] });
    expect(discordWrong.body).toMatchObject({ code: 'WEBHOOK_URL_INVALID', details: { reason: 'discord_url_required' } });
    const ssrf = await createEndpoint({ url: 'https://10.0.0.1/services/T/B/X', format: 'slack', eventTypes: ['plan.approved'] });
    expect(ssrf.body).toMatchObject({ code: 'WEBHOOK_URL_INVALID', details: { reason: 'forbidden_address' } });
    expect((await createEndpoint({ url: slackUrl, format: 'teams', eventTypes: ['plan.approved'] })).body.code).toBe('VALIDATION_ERROR');

    // Never delivered: no event of this project reaches it before it is deleted below.
    const slack = await endpoint({ url: slackUrl, format: 'slack', eventTypes: ['plan.approved'] });
    try {
      expect(slack.body).toMatchObject({ format: 'slack', url: slackUrl });
      const toOther = await http_().patch(`/api/webhooks/${slack.id}`).set(as(tokens.owner)).send({ url: 'https://example.com/x' });
      expect(toOther.body).toMatchObject({ code: 'WEBHOOK_URL_INVALID', details: { reason: 'slack_url_required' } });
      expect((await http_().patch(`/api/webhooks/${slack.id}`).set(as(tokens.owner)).send({ format: 'discord' })).body.details).toMatchObject({ reason: 'discord_url_required' });
      const discord = await http_().patch(`/api/webhooks/${slack.id}`).set(as(tokens.owner)).send({ format: 'discord', url: 'https://discord.com/api/webhooks/1/abc' });
      expect(discord.status, JSON.stringify(discord.body)).toBe(200);
      expect(discord.body).toMatchObject({ format: 'discord' });
      const plain = await http_().patch(`/api/webhooks/${slack.id}`).set(as(tokens.owner)).send({ format: 'openlinear', url: 'https://example.com/x' });
      expect(plain.body).toMatchObject({ format: 'openlinear', url: 'https://example.com/x' });
      const list = await http_().get(`/api/projects/${projectId}/webhooks`).set(as(tokens.owner));
      expect(list.body.formats).toEqual(['openlinear', 'slack', 'discord']);
      expect(list.body.eventTypes).toContain('digest.daily');
      const audit = await prisma.auditLog.findFirst({ where: { workspaceId, action: 'webhook.created', resourceId: slack.id } });
      expect(audit?.metadata).toMatchObject({ format: 'slack' });
    } finally {
      await prisma.webhookEndpoint.deleteMany({ where: { id: slack.id } });
    }
  });

  it('security review fix: someone denied a project in the workspace cannot read or redirect a workspace webhook\'s deliveries', async () => {
    const ws = await endpoint({ url: `${base}/ws/restricted`, eventTypes: ['issue.created'] }, { workspace: workspaceId, token: tokens.admin });
    expect((await http_().get(`/api/webhooks/${ws.id}/deliveries`).set(as(tokens.admin))).status).toBe(200);
    const denied = await http_().get(`/api/webhooks/${ws.id}/deliveries`).set(as(tokens.owner));
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('WEBHOOK_WORKSPACE_RESTRICTED');
    const redirect = await http_().patch(`/api/webhooks/${ws.id}`).set(as(tokens.owner)).send({ url: `${base}/ws/elsewhere` });
    expect(redirect.body.code).toBe('WEBHOOK_WORKSPACE_RESTRICTED');
    expect((await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ws.id } })).url).toBe(`${base}/ws/restricted`);
  });

  it('stores the digest hour and zone (09:00 UTC by default), refuses unknown zones and pauses the digest while off or unsubscribed', async () => {
    const plain = await endpoint({ url: `${base}/digest/defaults`, eventTypes: ['digest.daily'] });
    expect(plain.body).toMatchObject({ digestHour: 9, digestTimezone: 'UTC' });
    const nextAt = new Date(plain.body.digestNextAt as string);
    expect(nextAt.getTime()).toBeGreaterThan(Date.now());
    expect(nextAt.toISOString()).toMatch(/T09:00:00\.000Z$/);

    const berlin = await endpoint({ url: `${base}/digest/berlin`, eventTypes: ['digest.daily', 'issue.done'], digestHour: 18, digestTimezone: 'europe/berlin' });
    expect(berlin.body).toMatchObject({ digestHour: 18, digestTimezone: 'Europe/Berlin' });
    const bad = await createEndpoint({ url: `${base}/digest/bad`, eventTypes: ['digest.daily'], digestTimezone: 'Mars/Olympus_Mons' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: 'VALIDATION_ERROR', details: { field: 'digestTimezone' } });
    expect((await createEndpoint({ url: `${base}/digest/bad`, eventTypes: ['digest.daily'], digestHour: 24 })).status).toBe(400);

    const off = await http_().patch(`/api/webhooks/${berlin.id}`).set(as(tokens.owner)).send({ active: false });
    expect(off.body).toMatchObject({ active: false, digestNextAt: null, digestHour: 18 });
    const on = await http_().patch(`/api/webhooks/${berlin.id}`).set(as(tokens.owner)).send({ active: true });
    expect(new Date(on.body.digestNextAt as string).getTime()).toBeGreaterThan(Date.now());
    const kept = await http_().patch(`/api/webhooks/${berlin.id}`).set(as(tokens.owner)).send({ description: 'Team channel' });
    expect(kept.body.digestNextAt).toBe(on.body.digestNextAt);
    const unsubscribed = await http_().patch(`/api/webhooks/${berlin.id}`).set(as(tokens.owner)).send({ eventTypes: ['issue.done'] });
    expect(unsubscribed.body).toMatchObject({ digestNextAt: null, digestHour: 18, digestTimezone: 'Europe/Berlin' });
  });
});

// ── Formats: delivery ──────────────────────────────────────────────────────

describe('FE-14 webhook formats: delivery', () => {
  beforeEach(clearEndpoints);

  it('delivers Slack and Discord messages with the usual signed headers, titles only', async () => {
    await pump();
    const slack = await endpoint({ url: `${base}/slack/services/T/B/X`, format: 'slack', eventTypes: ['issue.created'] });
    const discord = await endpoint({ url: `${base}/discord/api/webhooks/1/x`, format: 'discord', eventTypes: ['issue.created'] });
    const created = await http_().post('/api/tasks').set(as(tokens.owner)).send({ title: 'Fix <!channel> login @everyone', projectId, description: `private notes ${RUN}` });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await pump();
    await runWebhookDeliveries();

    const [slackHit] = hits('/slack/services/T/B/X');
    if (!slackHit) throw new Error('Slack receiver got nothing');
    const slackBody = JSON.parse(slackHit.body) as { text: string; blocks: Array<{ text?: { text: string } }> };
    expect(Object.keys(slackBody)).toEqual(['text', 'blocks']);
    expect(slackBody.text).toBe(`Issue created: ${created.body.identifier as string} Fix &lt;!channel&gt; login @everyone · Hooks ${RUN}`);
    expect(slackBody.blocks[0]?.text?.text).toContain(`/?task=${created.body.id as string}|Open in OpenLinear>`);
    expect(slackHit.headers['content-type']).toBe('application/json');
    expect(slackHit.headers['openlinear-event']).toBe('issue.created');
    expect(verifySignature(slackHit, slack.secret)).toBe(true);
    const [slackRow] = await prisma.webhookDelivery.findMany({ where: { endpointId: slack.id } });
    expect(slackHit.headers['openlinear-delivery']).toBe(slackRow?.id);
    expect(slackRow).toMatchObject({ status: 'succeeded', payload: slackHit.body });

    const [discordHit] = hits('/discord/api/webhooks/1/x');
    if (!discordHit) throw new Error('Discord receiver got nothing');
    const discordBody = JSON.parse(discordHit.body) as { content: string; embeds: Array<{ title: string; url: string }>; allowed_mentions: unknown };
    expect(discordBody.content).toBe(`Issue created in Hooks ${RUN}`);
    expect(discordBody.embeds[0]?.title).toContain('Fix \\<\\!channel\\> login \\@everyone');
    expect(discordBody.allowed_mentions).toEqual({ parse: [] });
    expect(verifySignature(discordHit, discord.secret)).toBe(true);
    for (const entry of [slackHit, discordHit]) expect(entry.body).not.toContain(`private notes ${RUN}`);

    // Test pings use the format too.
    const ping = await http_().post(`/api/webhooks/${slack.id}/ping`).set(as(tokens.owner));
    expect(ping.status).toBe(201);
    expect(ping.body).toMatchObject({ status: 'succeeded', eventType: 'ping' });
    expect(JSON.parse(ping.body.payload as string)).toMatchObject({ text: `Test message from OpenLinear · Hooks ${RUN}` });
  });
});

// ── Claim limit ────────────────────────────────────────────────────────────

describe('FE-14 delivery claims', () => {
  beforeEach(clearEndpoints);

  it('claims at most `limit` due deliveries per pass, whatever plan PostgreSQL picks', async () => {
    const hook = await endpoint({ url: `${base}/claims/limit`, eventTypes: ['issue.created'] });
    // Statistics of a small table (empty after the cleanup above) make the
    // planner prefer a nested-loop semi join for the claim.
    await prisma.$executeRaw`ANALYZE webhook_deliveries`;
    const due = new Date(Date.now() - 1_000);
    // Same due time, ids ascending in insertion order: a plan that re-runs the
    // `LIMIT … SKIP LOCKED` subquery per row would then claim every row.
    const deliveryIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()].sort();
    for (const [index, id] of deliveryIds.entries()) {
      await prisma.webhookDelivery.create({ data: { id, endpointId: hook.id, eventId: `evt_claim_${RUN}_${index}`, eventType: 'issue.created', payload: '{}', status: 'pending', nextAttemptAt: due } });
    }
    const first = await runWebhookDeliveries({ limit: 1 });
    expect(first.claimed).toBe(1);
    expect(hits('/claims/limit')).toHaveLength(1);
    expect(await prisma.webhookDelivery.count({ where: { endpointId: hook.id, status: 'succeeded' } })).toBe(1);
    const rest = await runWebhookDeliveries({ limit: 2 });
    expect(rest.claimed).toBe(2);
    expect(hits('/claims/limit')).toHaveLength(3);
  });
});

// ── Daily digest ───────────────────────────────────────────────────────────

describe('FE-14 daily digest', () => {
  beforeEach(clearEndpoints);
  const now = new Date();
  const hour = now.getUTCHours();
  const slot = digestSlot(hour, 'UTC', now);
  const inWindow = (msBeforeSlot: number) => new Date(slot.slotAt.getTime() - msBeforeSlot);
  const beforeWindow = new Date(slot.since.getTime() - 3_600_000);

  beforeAll(async () => {
    // Every task gets an explicit creation time, so nothing depends on when the test runs.
    const make = (title: string, createdAt: Date, extra: Record<string, unknown> = {}) =>
      prisma.task.create({ data: { title, projectId: digestProjectId, workspaceId, creatorId: users.owner, createdAt, ...extra } });
    const fresh = await make('Created in the window', inWindow(2 * 3_600_000));
    await make('Created before the window', beforeWindow);
    const done = await make('Done in the window', beforeWindow, { status: 'done' });
    await prisma.activityLog.create({ data: { taskId: done.id, projectId: digestProjectId, userId: users.owner, action: 'task_status_changed', payload: { from: 'todo', to: 'done' }, createdAt: inWindow(3_600_000) } });
    const blocked = await make('Blocked', beforeWindow);
    const blocker = await make('Blocker', beforeWindow);
    await prisma.taskDependency.create({ data: { taskId: blocked.id, dependsOnTaskId: blocker.id, createdById: users.owner } });
    await prisma.agentRun.createMany({ data: [
      { taskId: fresh.id, userId: users.owner, agent: 'codex', model: 'test/model', status: 'succeeded', endedAt: inWindow(30 * 60_000) },
      { taskId: fresh.id, userId: users.owner, agent: 'codex', model: 'test/model', status: 'failed', endedAt: inWindow(20 * 60_000) },
      { taskId: fresh.id, userId: users.owner, agent: 'codex', model: 'test/model', status: 'failed', endedAt: beforeWindow },
    ] });
    await prisma.plan.create({ data: { projectId: digestProjectId, title: 'Waiting plan', createdById: users.owner } });
    await prisma.plan.create({ data: { projectId: digestProjectId, title: 'Approved plan', createdById: users.owner, status: 'approved', approvedRevision: 1 } });
    await prisma.knowledgeEntry.createMany({ data: [
      { projectId: digestProjectId, title: 'Use pnpm', body: 'Always', status: 'proposed', source: 'agent', createdById: users.owner, updatedById: users.owner },
      { projectId: digestProjectId, title: 'Active rule', body: 'Yes', status: 'active', source: 'user', createdById: users.owner, updatedById: users.owner },
    ] });
    // Activity in a project the workspace digest's owner is denied.
    await prisma.task.create({ data: { title: 'Secret project work', projectId: deniedProjectId, workspaceId, creatorId: users.admin, createdAt: inWindow(3_600_000) } });
  });

  it('records one digest per endpoint and local date with the project numbers, and sends it signed', async () => {
    const hook = await endpoint({ url: `${base}/digest/project`, eventTypes: ['digest.daily'], digestHour: hour, digestTimezone: 'UTC' }, { project: digestProjectId });
    expect(new Date(hook.body.digestNextAt as string)).toEqual(slot.nextAt);
    await makeDue(hook.id, slot.slotAt);
    expect((await runDueDigests({ now })).recorded).toBeGreaterThanOrEqual(1);

    const [row] = await digestsOf(hook.id);
    if (!row) throw new Error('no digest recorded');
    expect(row).toMatchObject({ eventId: `digest.daily:${slot.localDate}`, status: 'pending' });
    const body = JSON.parse(row.payload) as { id: string; type: string; createdAt: string; projectId: string; workspaceId: string; data: Body };
    expect(body).toMatchObject({ id: row.id, type: 'digest.daily', createdAt: slot.slotAt.toISOString(), projectId: digestProjectId, workspaceId });
    expect(body.data).toEqual({
      digest: {
        date: slot.localDate, timezone: 'UTC', hour, since: slot.since.toISOString(), until: slot.slotAt.toISOString(),
        issues: { created: 1, completed: 1, blocked: 1 }, runs: { succeeded: 1, failed: 1 }, plansAwaitingReview: 1, knowledgeProposals: 1,
      },
      project: { id: digestProjectId, key: expect.any(String), name: `Digest ${RUN}` },
    });
    expect((await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: hook.id } })).digestNextAt).toEqual(slot.nextAt);

    await runWebhookDeliveries();
    const [hit] = hits('/digest/project');
    if (!hit) throw new Error('digest not delivered');
    expect(hit.headers['openlinear-event']).toBe('digest.daily');
    expect(hit.headers['openlinear-delivery']).toBe(row.id);
    expect(verifySignature(hit, hook.secret)).toBe(true);

    // A re-run for the same day (due time moved back, or a moved hour) records nothing new.
    await makeDue(hook.id, slot.slotAt);
    const again = await runDueDigests({ now });
    expect(again.duplicate).toBeGreaterThanOrEqual(1);
    expect(await digestsOf(hook.id)).toHaveLength(1);

    // The next day gets its own digest.
    const tomorrow = new Date(now.getTime() + 24 * 3_600_000);
    await runDueDigests({ now: tomorrow });
    expect((await digestsOf(hook.id)).map((digest) => digest.eventId)).toEqual([`digest.daily:${slot.localDate}`, `digest.daily:${digestSlot(hour, 'UTC', tomorrow).localDate}`]);
  });

  it('never records two digests for one day when workers race', async () => {
    const hook = await endpoint({ url: `${base}/digest/race`, eventTypes: ['digest.daily'], digestHour: hour, digestTimezone: 'UTC' }, { project: digestProjectId });
    await makeDue(hook.id, slot.slotAt);
    const results = await Promise.all([runDueDigests({ now }), runDueDigests({ now }), runDueDigests({ now })]);
    expect(results.reduce((sum, result) => sum + result.failed, 0)).toBe(0);
    expect(await digestsOf(hook.id)).toHaveLength(1);
    await makeDue(hook.id, slot.slotAt);
    await Promise.all([runDueDigests({ now }), runDueDigests({ now })]);
    expect(await digestsOf(hook.id)).toHaveLength(1);
  });

  it('sends Slack digests as readable text; a workspace digest covers the projects its owner can see', async () => {
    const slack = await endpoint({ url: `${base}/digest/slack`, format: 'slack', eventTypes: ['digest.daily'], digestHour: hour, digestTimezone: 'UTC' }, { project: digestProjectId });
    const workspace = await endpoint({ url: `${base}/digest/workspace`, eventTypes: ['digest.daily'], digestHour: hour, digestTimezone: 'UTC' }, { workspace: workspaceId });
    await makeDue(slack.id, slot.slotAt);
    await makeDue(workspace.id, slot.slotAt);
    const cycle = await runWebhookCycle();
    expect(cycle?.digests.recorded).toBeGreaterThanOrEqual(2);

    const [slackHit] = hits('/digest/slack');
    if (!slackHit) throw new Error('Slack digest not delivered');
    const message = JSON.parse(slackHit.body) as { text: string; blocks: Array<{ fields?: Array<{ text: string }> }> };
    expect(message.text).toBe(`Daily digest for Digest ${RUN}, ${slot.localDate}: 1 issue created, 1 completed, 1 blocked; 1 run succeeded, 1 failed; 1 plan and 1 knowledge proposal waiting for review`);
    expect(message.blocks[1]?.fields?.map((field) => field.text)).toEqual([
      '*Issues created*\n1', '*Issues completed*\n1', '*Blocked now*\n1', '*Runs succeeded*\n1', '*Runs failed*\n1', '*Plans awaiting review*\n1', '*Knowledge proposals*\n1',
    ]);

    const [workspaceHit] = hits('/digest/workspace');
    if (!workspaceHit) throw new Error('workspace digest not delivered');
    const body = JSON.parse(workspaceHit.body) as { projectId: string | null; workspaceId: string; data: { digest: Body; workspace: Body; projects: Array<{ id: string }> } };
    expect(body).toMatchObject({ projectId: null, workspaceId, data: { workspace: { id: workspaceId, name: `WHI ${RUN}` } } });
    const visible = await prisma.project.count({ where: { workspaceId, id: { not: deniedProjectId } } });
    expect(body.data.digest).toMatchObject({ projectCount: visible, issues: { created: 1, completed: 1, blocked: 1 } });
    expect(body.data.projects.map((project) => project.id)).toEqual([digestProjectId]);
    expect(workspaceHit.body).not.toContain('Secret project work');
    expect(workspaceHit.body).not.toContain(deniedProjectId);
  });

  it('turns a digest endpoint off when its owner can no longer manage webhooks', async () => {
    const hook = await endpoint({ url: `${base}/digest/owner`, eventTypes: ['digest.daily'], digestHour: hour, digestTimezone: 'UTC' }, { project: digestProjectId, token: tokens.admin });
    await makeDue(hook.id, slot.slotAt);
    await prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId: users.admin } }, data: { role: 'member' } });
    try {
      expect((await runDueDigests({ now })).disabled).toBeGreaterThanOrEqual(1);
      expect(await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: hook.id } })).toMatchObject({ active: false, disabledReason: 'owner_lost_access' });
      expect(await digestsOf(hook.id)).toHaveLength(0);
      expect(await prisma.notification.count({ where: { userId: users.admin, body: { contains: 'turned off' } } })).toBe(1);
    } finally {
      await prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId: users.admin } }, data: { role: 'admin' } });
    }
  });
});
