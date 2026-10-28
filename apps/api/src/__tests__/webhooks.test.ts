/**
 * FE-14 outbound webhooks against real PostgreSQL and a local HTTP receiver
 * on 127.0.0.1 (allowed through the explicit loopback test hook; nothing
 * leaves the machine): endpoint management and permissions, the secret
 * shown once and encrypted at rest (also in idempotency records), fan-out
 * from the event stream with tenancy and exactly-once recording, signed
 * deliveries, retries with backoff, turning off after 20 failures (owner
 * notified), concurrent workers, timeouts / capped reads / redirects /
 * refused addresses, pings, redelivery with the same id, rotation with a
 * grace signature, keyset paging, and the event mapping.
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
import { generatePersonalAccessToken, hashPersonalAccessToken } from '../services/pats';
import { WEBHOOK_DISABLE_AFTER_FAILURES, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY_DELAYS_MS, postWebhook, runWebhookDeliveries } from '../services/webhook-delivery';
import { fanOutWebhookEvents, toWebhookEvents, WEBHOOK_EVENT_TYPES, type SourceEvent } from '../services/webhook-events';
import { allowLoopbackWebhooksForTests } from '../services/webhook-network';
import { MAX_WEBHOOKS_PER_SCOPE, pruneWebhookDeliveries, runWebhookCycle } from '../services/webhooks';
import { testJwtSecret } from './test-env';
import { useTestServer } from './http';

const RUN = randomUUID().slice(0, 8);
const http_ = useTestServer(() => createApp());
const ids = { users: [] as string[], workspaces: [] as string[], projects: [] as string[] };
const users = { owner: '', admin: '', member: '', viewer: '', stranger: '', other: '' };
const tokens = { owner: '', admin: '', member: '', viewer: '', stranger: '', other: '' };
let workspaceId = '';
let otherWorkspaceId = '';
let projectId = '';
let siblingProjectId = '';
let quotaProjectId = '';
let otherProjectId = '';
let patRead = '';
let patWrite = '';
let patAdmin = '';

type Body = Record<string, unknown>;
const as = (token: string) => ({ Authorization: `Bearer ${token}` });

// ── Local receiver ─────────────────────────────────────────────────────────

interface Received { path: string; headers: IncomingHttpHeaders; body: string }
interface Reply { status: number; body?: string; headers?: Record<string, string>; delayMs?: number }
const received: Received[] = [];
const replies = new Map<string, (count: number) => Reply>();
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

async function createPat(userId: string, scopes: string[]): Promise<string> {
  const token = generatePersonalAccessToken();
  await prisma.personalAccessToken.create({
    data: { userId, name: `wh-${RUN}`, tokenHash: hashPersonalAccessToken(token), tokenPrefix: token.slice(0, 15), scopes },
  });
  return token;
}

async function createEndpoint(body: Body, options: { token?: string; project?: string; key?: string; workspace?: string } = {}) {
  const path = options.workspace ? `/api/workspaces/${options.workspace}/webhooks` : `/api/projects/${options.project ?? projectId}/webhooks`;
  return http_().post(path).set({ ...as(options.token ?? tokens.owner), ...(options.key ? { 'Idempotency-Key': options.key } : {}) }).send(body);
}

async function endpoint(path: string, eventTypes: string[], options: { token?: string; project?: string; workspace?: string } = {}): Promise<{ id: string; secret: string }> {
  const res = await createEndpoint({ url: `${base}${path}`, eventTypes }, options);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { id: res.body.id as string, secret: res.body.secret as string };
}

/** Sequence committed outbox rows into the stream, then fan out. */
async function pump() {
  for (let round = 0; round < 10; round += 1) {
    await sequencePendingEvents();
    if ((await prisma.domainEventOutbox.count()) === 0) break;
  }
  return fanOutWebhookEvents();
}

async function createTask(title: string, project = projectId, token = tokens.owner): Promise<string> {
  const res = await http_().post('/api/tasks').set(as(token)).send({ title, projectId: project, description: `private notes ${RUN}` });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

async function deliveriesOf(endpointId: string) {
  return prisma.webhookDelivery.findMany({ where: { endpointId }, orderBy: [{ createdAt: 'asc' }, { eventType: 'asc' }] });
}

async function cursorToHead(): Promise<void> {
  await pump();
}

/** Each fan-out/delivery test starts with no endpoints in the test projects (the per-project cap is 10). */
async function clearEndpoints(): Promise<void> {
  await prisma.webhookEndpoint.deleteMany({ where: { OR: [{ projectId: { in: ids.projects } }, { workspaceId: { in: ids.workspaces } }] } });
}

beforeAll(async () => {
  allowLoopbackWebhooksForTests(true);
  receiver = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      received.push({ path, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      const respond: (count: number) => Reply = replies.get(path) ?? (() => ({ status: 200, body: 'ok' }));
      const reply = respond(hits(path).length);
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(reply.status, reply.headers ?? { 'Content-Type': 'text/plain' });
        res.end(reply.body ?? '');
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

  for (const key of Object.keys(users) as Array<keyof typeof users>) {
    const user = await prisma.user.create({ data: { username: `wh-${key}-${RUN}`, email: `wh-${key}-${RUN}@example.com` } });
    ids.users.push(user.id);
    users[key] = user.id;
    tokens[key] = jwt.sign({ userId: user.id, username: user.username }, testJwtSecret(), { expiresIn: '1h' });
  }
  const workspace = await prisma.workspace.create({ data: { name: `WH ${RUN}`, slug: `wh-${RUN}` } });
  workspaceId = workspace.id;
  const other = await prisma.workspace.create({ data: { name: `WH other ${RUN}`, slug: `wh-other-${RUN}` } });
  otherWorkspaceId = other.id;
  ids.workspaces.push(workspaceId, otherWorkspaceId);
  await prisma.workspaceMember.createMany({ data: [
    { workspaceId, userId: users.owner, role: 'owner' },
    { workspaceId, userId: users.admin, role: 'admin' },
    { workspaceId, userId: users.member, role: 'member' },
    { workspaceId, userId: users.viewer, role: 'member' },
    { workspaceId: otherWorkspaceId, userId: users.other, role: 'owner' },
  ] });
  const key = RUN.slice(0, 3).toUpperCase();
  const makeProject = async (name: string, prefix: string, ws: string, members: Array<{ userId: string; role: 'owner' | 'admin' | 'member' }>) => {
    const project = await prisma.project.create({ data: { name: `${name} ${RUN}`, workspaceId: ws, key: `${prefix}${key}` } });
    ids.projects.push(project.id);
    const team = await prisma.team.create({ data: { name: `${name} ${RUN}`, key: `${prefix}${key}`, projectId: project.id } });
    await prisma.teamMember.createMany({ data: members.map((member) => ({ teamId: team.id, ...member })) });
    return project.id;
  };
  const team = [{ userId: users.owner, role: 'owner' as const }, { userId: users.admin, role: 'admin' as const }, { userId: users.member, role: 'member' as const }];
  projectId = await makeProject('Hooks', 'H', workspaceId, team);
  siblingProjectId = await makeProject('Sibling', 'S', workspaceId, team);
  quotaProjectId = await makeProject('Quota', 'Q', workspaceId, team);
  otherProjectId = await makeProject('Other', 'O', otherWorkspaceId, [{ userId: users.other, role: 'owner' }]);
  await prisma.projectAccess.createMany({ data: [
    { projectId, userId: users.member, permission: 'full' },
    { projectId, userId: users.viewer, permission: 'view' },
  ] });
  patRead = await createPat(users.owner, ['projects:read']);
  patWrite = await createPat(users.owner, ['projects:write']);
  patAdmin = await createPat(users.owner, ['admin']);
  await cursorToHead();
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
  await prisma.personalAccessToken.deleteMany({ where: { userId: { in: ids.users } } });
  await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
});

beforeEach(() => {
  replies.clear();
});

// ── Endpoint management ────────────────────────────────────────────────────

describe('FE-14 webhook endpoints', () => {
  it('creates an endpoint, shows the secret once, keeps it encrypted (also in the idempotency record) and replays the same secret', async () => {
    const key = `wh-create-${RUN}`;
    const body = { url: `${base}/hooks/create`, eventTypes: ['issue.created', 'issue.created', 'run.failed'], description: 'CI bridge' };
    const first = await createEndpoint(body, { key });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.headers['cache-control']).toBe('no-store');
    const secret = first.body.secret as string;
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(first.body).toMatchObject({
      scope: 'project', projectId, workspaceId: null, url: `${base}/hooks/create`, description: 'CI bridge',
      eventTypes: ['issue.created', 'run.failed'], secretPrefix: secret.slice(0, 10), active: true, ownerId: users.owner,
    });
    expect(first.body).not.toHaveProperty('sealedSecret');

    const replay = await createEndpoint(body, { key });
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.body).toMatchObject({ id: first.body.id, secret });
    expect(await prisma.webhookEndpoint.count({ where: { projectId, url: `${base}/hooks/create` } })).toBe(1);

    const row = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: first.body.id as string } });
    expect(row.secretEncrypted.startsWith('enc:v1:')).toBe(true);
    expect(JSON.stringify(row)).not.toContain(secret);
    const record = await prisma.idempotencyRecord.findFirstOrThrow({ where: { key, operation: 'webhooks.create' } });
    expect(record.responseBody).not.toContain(secret);
    expect(record.responseBody).toContain('sealedSecret');

    const list = await http_().get(`/api/projects/${projectId}/webhooks`).set(as(tokens.owner));
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ canManage: true, limits: { endpoints: MAX_WEBHOOKS_PER_SCOPE, maxAttempts: WEBHOOK_MAX_ATTEMPTS } });
    expect(list.body.eventTypes).toEqual([...WEBHOOK_EVENT_TYPES]);
    expect(JSON.stringify(list.body)).not.toContain(secret);
    const audit = await prisma.auditLog.findFirst({ where: { workspaceId, action: 'webhook.created', resourceId: first.body.id as string } });
    expect(audit?.metadata).toMatchObject({ origin: `${base}/…` });
  });

  it('lets viewers read with the URL reduced to its origin; only admins with full access manage; PATs cannot create', async () => {
    const viewer = await http_().get(`/api/projects/${projectId}/webhooks`).set(as(tokens.viewer));
    expect(viewer.status).toBe(200);
    expect(viewer.body.canManage).toBe(false);
    expect(viewer.body.items.length).toBeGreaterThan(0);
    for (const item of viewer.body.items as Body[]) {
      expect(item.url).toBeNull();
      expect(item.urlDisplay).toBe(`${base}/…`);
    }
    const url = `${base}/hooks/denied`;
    expect((await createEndpoint({ url, eventTypes: ['issue.created'] }, { token: tokens.viewer })).status).toBe(403);
    // Full project access is not enough: managing webhooks needs a workspace owner/admin.
    expect((await createEndpoint({ url, eventTypes: ['issue.created'] }, { token: tokens.member })).status).toBe(403);
    expect((await createEndpoint({ url, eventTypes: ['issue.created'] }, { token: tokens.stranger })).status).toBe(403);
    const pat = await createEndpoint({ url, eventTypes: ['issue.created'] }, { token: patAdmin });
    expect(pat.status).toBe(403);
    expect(pat.body.code).toBe('SESSION_REQUIRED');
    expect((await http_().get(`/api/projects/${projectId}/webhooks`).set(as(patRead))).status).toBe(200);
    expect((await http_().get(`/api/projects/${projectId}/webhooks`).set(as(tokens.stranger))).status).toBe(403);
    expect((await createEndpoint({ url, eventTypes: ['issue.created'] }, { token: tokens.admin })).status).toBe(201);
  });

  it('refuses unsafe URLs and unknown events', async () => {
    for (const [url, reason] of [
      ['http://example.com/hook', 'https_required'],
      ['https://169.254.169.254/latest/meta-data', 'forbidden_address'],
      ['https://[::ffff:10.0.0.1]/hook', 'forbidden_address'],
      ['https://localhost/hook', 'internal_host'],
      ['https://user:pw@example.com/hook', 'credentials'],
    ] as const) {
      const res = await createEndpoint({ url, eventTypes: ['issue.created'] });
      expect(res.status, url).toBe(400);
      expect(res.body).toMatchObject({ code: 'WEBHOOK_URL_INVALID', details: { field: 'url', reason } });
    }
    const unknown = await createEndpoint({ url: 'https://example.com/hook', eventTypes: ['issue.exploded'] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe('VALIDATION_ERROR');
    expect((await createEndpoint({ url: 'https://example.com/hook', eventTypes: [] })).status).toBe(400);
  });

  it('caps endpoints per project', async () => {
    for (let index = 0; index < MAX_WEBHOOKS_PER_SCOPE; index += 1) {
      expect((await createEndpoint({ url: `https://hooks.example.com/${index}`, eventTypes: ['issue.created'] }, { project: quotaProjectId })).status).toBe(201);
    }
    const over = await createEndpoint({ url: 'https://hooks.example.com/over', eventTypes: ['issue.created'] }, { project: quotaProjectId });
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({ code: 'WEBHOOK_LIMIT_EXCEEDED', details: { limit: MAX_WEBHOOKS_PER_SCOPE } });
  });

  it('manages workspace endpoints for workspace owners/admins only', async () => {
    const created = await createEndpoint({ url: 'https://hooks.example.com/ws', eventTypes: ['plan.approved'] }, { workspace: workspaceId, token: tokens.admin });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ scope: 'workspace', workspaceId, projectId: null });
    expect((await createEndpoint({ url: 'https://hooks.example.com/ws2', eventTypes: ['plan.approved'] }, { workspace: workspaceId, token: tokens.member })).status).toBe(403);
    const memberList = await http_().get(`/api/workspaces/${workspaceId}/webhooks`).set(as(tokens.member));
    expect(memberList.status).toBe(200);
    expect(memberList.body.canManage).toBe(false);
    expect([403, 404]).toContain((await http_().get(`/api/workspaces/${workspaceId}/webhooks`).set(as(tokens.stranger))).status);
    await http_().delete(`/api/webhooks/${created.body.id as string}`).set(as(tokens.admin)).expect(204);
  });

  it('workspace endpoints need the workspace PAT family (workspaces:read to read, admin to act); PATs never get the full URL', async () => {
    const created = await createEndpoint({ url: 'https://hooks.example.com/ws-pat/receiver-token', eventTypes: ['plan.approved'] }, { workspace: workspaceId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as string;
    // projects:* is the project family; a workspace endpoint is workspace configuration.
    for (const res of [
      await http_().get(`/api/webhooks/${id}`).set(as(patRead)),
      await http_().get(`/api/webhooks/${id}/deliveries`).set(as(patRead)),
      await http_().delete(`/api/webhooks/${id}`).set(as(patWrite)),
      await http_().post(`/api/webhooks/${id}/ping`).set(as(patWrite)),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_SCOPE');
    }
    const patWorkspaceRead = await createPat(users.owner, ['projects:read', 'workspaces:read']);
    const read = await http_().get(`/api/webhooks/${id}`).set(as(patWorkspaceRead));
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ canManage: true, url: null, urlDisplay: 'https://hooks.example.com/…' });
    expect((await http_().get(`/api/workspaces/${workspaceId}/webhooks`).set(as(patWorkspaceRead))).body.items[0].url).toBeNull();
    expect((await http_().delete(`/api/webhooks/${id}`).set(as(patWorkspaceRead))).status).toBe(403);
    expect((await http_().get(`/api/webhooks/${id}`).set(as(tokens.owner))).body.url).toBe('https://hooks.example.com/ws-pat/receiver-token');

    // Project endpoints: a manager's PAT reads and acts, but the URL (a Slack/Discord URL is a credential) stays with sessions.
    const project = await endpoint('/hooks/pat-url', ['issue.created']);
    expect((await http_().get(`/api/webhooks/${project.id}`).set(as(tokens.owner))).body.url).toBe(`${base}/hooks/pat-url`);
    expect((await http_().get(`/api/webhooks/${project.id}`).set(as(patWrite))).body).toMatchObject({ canManage: true, url: null });
    const listed = await http_().get(`/api/projects/${projectId}/webhooks`).set(as(patRead));
    expect(listed.body.items.every((item: { url: string | null }) => item.url === null)).toBe(true);

    await http_().delete(`/api/webhooks/${id}`).set(as(patAdmin)).expect(204);
    await http_().delete(`/api/webhooks/${project.id}`).set(as(patWrite)).expect(204);
  });

  it('changes an endpoint with a session only; turning it off abandons pending deliveries, back on resets the failures; the editor becomes owner', async () => {
    const { id } = await endpoint('/hooks/patch', ['issue.created']);
    const pending = await prisma.webhookDelivery.create({ data: { endpointId: id, eventId: `evt_manual_${RUN}`, eventType: 'issue.created', payload: '{}', nextAttemptAt: new Date(Date.now() + 3_600_000) } });
    expect((await http_().patch(`/api/webhooks/${id}`).set(as(tokens.viewer)).send({ description: 'x' })).status).toBe(403);
    expect((await http_().patch(`/api/webhooks/${id}`).set(as(patAdmin)).send({ description: 'x' })).body.code).toBe('SESSION_REQUIRED');
    const bad = await http_().patch(`/api/webhooks/${id}`).set(as(tokens.owner)).send({ url: 'http://example.com/x' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('WEBHOOK_URL_INVALID');

    const off = await http_().patch(`/api/webhooks/${id}`).set(as(tokens.admin)).send({ active: false, description: 'paused' });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body).toMatchObject({ active: false, disabledReason: 'manual', description: 'paused', ownerId: users.admin });
    expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({ status: 'abandoned', nextAttemptAt: null });

    await prisma.webhookEndpoint.update({ where: { id }, data: { consecutiveFailures: 7 } });
    const on = await http_().patch(`/api/webhooks/${id}`).set(as(tokens.owner)).send({ active: true, eventTypes: ['issue.updated'] });
    expect(on.body).toMatchObject({ active: true, disabledAt: null, disabledReason: null, consecutiveFailures: 0, eventTypes: ['issue.updated'], ownerId: users.owner });
  });

  it('deletes endpoints (PATs with projects:write may), taking their history; project deletion removes them', async () => {
    const { id } = await endpoint('/hooks/delete', ['issue.created']);
    await http_().post(`/api/webhooks/${id}/ping`).set(as(tokens.owner)).expect(201);
    expect((await http_().delete(`/api/webhooks/${id}`).set(as(tokens.viewer))).status).toBe(403);
    expect((await http_().delete(`/api/webhooks/${id}`).set(as(patRead))).status).toBe(403);
    await http_().delete(`/api/webhooks/${id}`).set(as(patWrite)).expect(204);
    expect(await prisma.webhookDelivery.count({ where: { endpointId: id } })).toBe(0);
    const gone = await http_().get(`/api/webhooks/${id}`).set(as(tokens.owner));
    expect(gone.status).toBe(404);
    expect(gone.body.code).toBe('WEBHOOK_NOT_FOUND');

    const doomed = await prisma.project.create({ data: { name: `Doomed ${RUN}`, workspaceId, key: `D${RUN.slice(0, 3).toUpperCase()}` } });
    const hook = await createEndpoint({ url: 'https://hooks.example.com/doomed', eventTypes: ['issue.created'] }, { project: doomed.id });
    expect(hook.status).toBe(201);
    await prisma.project.delete({ where: { id: doomed.id } });
    expect(await prisma.webhookEndpoint.count({ where: { id: hook.body.id as string } })).toBe(0);
  });
});

// ── Fan-out and delivery ───────────────────────────────────────────────────

describe('FE-14 fan-out and signed delivery', () => {
  beforeEach(clearEndpoints);
  it('records one delivery per event and endpoint from committed events, and POSTs it signed', async () => {
    await cursorToHead();
    const { id, secret } = await endpoint('/hooks/e2e', ['issue.created', 'issue.updated', 'issue.done']);
    const cursorBefore = (await prisma.webhookFanoutCursor.findUniqueOrThrow({ where: { id: 1 } })).lastEventId;
    const taskId = await createTask('Ship webhooks');
    await http_().patch(`/api/tasks/${taskId}`).set(as(tokens.owner)).send({ status: 'done' }).expect(200);
    const fan = await pump();
    expect(fan.busy).toBe(false);

    const rows = await deliveriesOf(id);
    expect(rows.map((row) => row.eventType).sort()).toEqual(['issue.created', 'issue.done', 'issue.updated']);
    const result = await runWebhookDeliveries();
    expect(result.succeeded).toBeGreaterThanOrEqual(3);

    const got = hits('/hooks/e2e');
    expect(got).toHaveLength(3);
    for (const entry of got) {
      const body = JSON.parse(entry.body) as Body;
      expect(Object.keys(body)).toEqual(['id', 'type', 'createdAt', 'projectId', 'workspaceId', 'data']);
      expect(entry.headers['openlinear-delivery']).toBe(body.id);
      expect(rows.some((row) => row.id === body.id)).toBe(true);
      expect(entry.headers['openlinear-event']).toBe(body.type);
      expect(entry.headers['content-type']).toBe('application/json');
      expect(Math.abs(Number(entry.headers['openlinear-timestamp']) - Date.now() / 1000)).toBeLessThan(60);
      expect(verifySignature(entry, secret)).toBe(true);
      expect(verifySignature(entry, 'whsec_wrong')).toBe(false);
      expect(body).toMatchObject({ projectId, workspaceId, data: { issue: { id: taskId, title: 'Ship webhooks', projectId } } });
      // No free text beyond the title, no logs.
      expect(entry.body).not.toContain(`private notes ${RUN}`);
      expect((body.data as { issue: Body }).issue).not.toHaveProperty('description');
      expect((body.data as { issue: Body }).issue).not.toHaveProperty('executionLogs');
    }
    const done = JSON.parse(got.find((entry) => entry.headers['openlinear-event'] === 'issue.done')?.body ?? '{}') as { data: Body };
    expect(done.data).toMatchObject({ from: 'todo', actorId: users.owner, source: 'person', issue: { status: 'done' } });
    for (const row of await deliveriesOf(id)) {
      expect(row).toMatchObject({ status: 'succeeded', attempts: 1, lastStatusCode: 200, lastResponseExcerpt: 'ok', nextAttemptAt: null, leaseToken: null });
    }
    expect(await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id } })).toMatchObject({ consecutiveFailures: 0, lastSuccessAt: expect.any(Date) });

    // A replayed stream (cursor moved back, e.g. a crash before commit) records nothing twice.
    await prisma.webhookFanoutCursor.update({ where: { id: 1 }, data: { lastEventId: cursorBefore } });
    expect((await pump()).recorded).toBe(0);
    expect(await prisma.webhookDelivery.count({ where: { endpointId: id } })).toBe(3);
  });

  it('delivers only to endpoints of the event project or its workspace, for subscribed types, after they were created', async () => {
    await cursorToHead();
    const project = await endpoint('/hooks/t-project', ['issue.created']);
    const sibling = await endpoint('/hooks/t-sibling', ['issue.created'], { project: siblingProjectId, token: tokens.admin });
    const workspace = await endpoint('/hooks/t-workspace', ['issue.created'], { workspace: workspaceId });
    const foreign = await endpoint('/hooks/t-foreign', ['issue.created'], { workspace: otherWorkspaceId, token: tokens.other });
    const otherTypes = await endpoint('/hooks/t-types', ['issue.done']);
    await createTask('Tenancy check');
    const late = await endpoint('/hooks/t-late', ['issue.created']);
    await pump();
    expect(await deliveriesOf(project.id)).toHaveLength(1);
    expect(await deliveriesOf(workspace.id)).toHaveLength(1);
    expect(await deliveriesOf(sibling.id)).toHaveLength(0);
    expect(await deliveriesOf(foreign.id)).toHaveLength(0);
    expect(await deliveriesOf(otherTypes.id)).toHaveLength(0);
    // The task was created before this endpoint existed.
    expect(await deliveriesOf(late.id)).toHaveLength(0);

    // A workspace endpoint never carries a project its owner is denied (the
    // sibling endpoint belongs to another admin and still gets it).
    await prisma.projectAccess.create({ data: { projectId: siblingProjectId, userId: users.owner, permission: 'deny' } });
    try {
      await createTask('Denied project', siblingProjectId, tokens.admin);
      await pump();
      expect(await deliveriesOf(workspace.id)).toHaveLength(1);
      expect(await deliveriesOf(sibling.id)).toHaveLength(1);
    } finally {
      await prisma.projectAccess.deleteMany({ where: { projectId: siblingProjectId, userId: users.owner } });
    }
    for (const hook of [project, sibling, workspace, otherTypes, late]) await http_().delete(`/api/webhooks/${hook.id}`).set(as(tokens.owner)).expect(204);
    await http_().delete(`/api/webhooks/${foreign.id}`).set(as(tokens.other)).expect(204);
  });

  it('turns an endpoint off when its owner can no longer manage webhooks', async () => {
    await cursorToHead();
    const { id } = await endpoint('/hooks/owner', ['issue.created'], { token: tokens.admin });
    await prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId: users.admin } }, data: { role: 'member' } });
    try {
      await createTask('Owner demoted');
      await pump();
      expect(await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id } })).toMatchObject({ active: false, disabledReason: 'owner_lost_access' });
      expect(await deliveriesOf(id)).toHaveLength(0);
      expect(await prisma.notification.count({ where: { userId: users.admin, body: { contains: 'turned off' } } })).toBe(1);
    } finally {
      await prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId: users.admin } }, data: { role: 'admin' } });
    }
  });

  it('retries on failure with backoff (1 m, 5 m, 30 m, 2 h, 12 h), then fails; redelivery reuses the delivery id', async () => {
    await cursorToHead();
    replies.set('/hooks/flaky', () => ({ status: 500, body: 'boom' }));
    const { id } = await endpoint('/hooks/flaky', ['issue.created']);
    await createTask('Flaky receiver');
    await pump();
    const [delivery] = await deliveriesOf(id);
    if (!delivery) throw new Error('no delivery recorded');
    for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
      const before = Date.now();
      await runWebhookDeliveries();
      const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
      expect(row.attempts).toBe(attempt);
      expect(row).toMatchObject({ lastStatusCode: 500, lastResponseExcerpt: 'boom', lastError: 'HTTP 500' });
      if (attempt < WEBHOOK_MAX_ATTEMPTS) {
        expect(row.status).toBe('pending');
        const delay = (row.nextAttemptAt?.getTime() ?? 0) - before;
        const expected = WEBHOOK_RETRY_DELAYS_MS[attempt - 1] ?? 0;
        expect(delay).toBeGreaterThanOrEqual(expected - 1_000);
        expect(delay).toBeLessThanOrEqual(expected + 10_000);
        // Not due yet: another pass leaves it alone.
        expect((await runWebhookDeliveries()).claimed).toBe(0);
        await prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { nextAttemptAt: new Date(Date.now() - 1_000) } });
      } else {
        expect(row).toMatchObject({ status: 'failed', nextAttemptAt: null });
      }
    }
    expect(hits('/hooks/flaky')).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
    expect(new Set(hits('/hooks/flaky').map((entry) => entry.headers['openlinear-delivery']))).toEqual(new Set([delivery.id]));
    expect((await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id } })).consecutiveFailures).toBe(WEBHOOK_MAX_ATTEMPTS);

    replies.set('/hooks/flaky', () => ({ status: 204 }));
    expect((await http_().post(`/api/webhooks/${id}/deliveries/${delivery.id}/redeliver`).set(as(tokens.viewer))).status).toBe(403);
    const again = await http_().post(`/api/webhooks/${id}/deliveries/${delivery.id}/redeliver`).set(as(tokens.owner));
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ id: delivery.id, status: 'succeeded', attempts: 1, redeliveries: 1, lastStatusCode: 204 });
    const last = hits('/hooks/flaky').at(-1);
    expect(last?.headers['openlinear-delivery']).toBe(delivery.id);
    expect(last?.body).toBe(delivery.payload);
    expect((await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id } })).consecutiveFailures).toBe(0);
  });

  it(`turns the endpoint off after ${WEBHOOK_DISABLE_AFTER_FAILURES} failures in a row and notifies its owner`, async () => {
    await cursorToHead();
    replies.set('/hooks/down', () => ({ status: 503 }));
    const { id } = await endpoint('/hooks/down', ['issue.created']);
    await prisma.webhookEndpoint.update({ where: { id }, data: { consecutiveFailures: WEBHOOK_DISABLE_AFTER_FAILURES - 1 } });
    await createTask('Down 1');
    await createTask('Down 2');
    await pump();
    expect(await deliveriesOf(id)).toHaveLength(2);
    await runWebhookDeliveries({ limit: 1 });
    const hook = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id } });
    expect(hook).toMatchObject({ active: false, disabledReason: 'consecutive_failures', consecutiveFailures: WEBHOOK_DISABLE_AFTER_FAILURES });
    const statuses = (await deliveriesOf(id)).map((row) => row.status).sort();
    expect(statuses).toEqual(['abandoned', 'abandoned']);
    expect(await prisma.notification.count({ where: { userId: users.owner, body: { contains: `${WEBHOOK_DISABLE_AFTER_FAILURES} failed deliveries` } } })).toBe(1);

    // Off: no new deliveries, no redelivery; a test ping still works and counts nothing.
    await createTask('Down 3');
    await pump();
    expect(await deliveriesOf(id)).toHaveLength(2);
    const [first] = await deliveriesOf(id);
    const refused = await http_().post(`/api/webhooks/${id}/deliveries/${first?.id}/redeliver`).set(as(tokens.owner));
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('WEBHOOK_DISABLED');
    const ping = await http_().post(`/api/webhooks/${id}/ping`).set(as(tokens.owner));
    expect(ping.status).toBe(201);
    expect(ping.body).toMatchObject({ eventType: 'ping', status: 'failed', attempts: 1, maxAttempts: 1, lastStatusCode: 503 });
    expect((await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id } })).consecutiveFailures).toBe(WEBHOOK_DISABLE_AFTER_FAILURES);
  });

  it('runs fan-out and delivery as one job pass, never two passes at once in a process', async () => {
    await cursorToHead();
    const { id } = await endpoint('/hooks/cycle', ['issue.created']);
    await createTask('Cycle');
    for (let round = 0; round < 10 && (await prisma.domainEventOutbox.count()) > 0; round += 1) await sequencePendingEvents();
    const [first, second] = await Promise.all([runWebhookCycle(), runWebhookCycle()]);
    expect(second).toBeNull();
    expect(first?.fanOut.recorded).toBe(1);
    expect(first?.deliveries.succeeded).toBe(1);
    expect(hits('/hooks/cycle')).toHaveLength(1);
    expect((await deliveriesOf(id)).map((row) => row.status)).toEqual(['succeeded']);
  });

  it('prunes finished deliveries after 30 days and keeps pending ones', async () => {
    const { id } = await endpoint('/hooks/prune', ['issue.created']);
    const old = new Date(Date.now() - 31 * 24 * 3_600_000);
    await prisma.webhookDelivery.createMany({ data: [
      { endpointId: id, eventId: `old-done-${RUN}`, eventType: 'issue.created', payload: '{}', status: 'succeeded', deliveredAt: old, createdAt: old },
      { endpointId: id, eventId: `old-pending-${RUN}`, eventType: 'issue.created', payload: '{}', status: 'pending', nextAttemptAt: new Date(), createdAt: old },
      { endpointId: id, eventId: `new-done-${RUN}`, eventType: 'issue.created', payload: '{}', status: 'failed' },
    ] });
    expect(await pruneWebhookDeliveries()).toBeGreaterThanOrEqual(1);
    expect((await deliveriesOf(id)).map((row) => row.eventId).sort()).toEqual([`new-done-${RUN}`, `old-pending-${RUN}`]);
  });

  it('never sends a delivery twice when workers race', async () => {
    await cursorToHead();
    replies.set('/hooks/race', () => ({ status: 200, delayMs: 50 }));
    const { id } = await endpoint('/hooks/race', ['issue.created']);
    const bulk = await http_().post('/api/tasks/bulk').set(as(tokens.owner)).send({ projectId, tasks: [1, 2, 3, 4, 5, 6].map((n) => ({ title: `Race ${n}` })) });
    expect(bulk.status, JSON.stringify(bulk.body)).toBe(201);
    await pump();
    const rows = await deliveriesOf(id);
    expect(rows).toHaveLength(6);
    // Bulk creation: one issue.created per issue, keyed by issue.
    expect(new Set(rows.map((row) => row.eventId)).size).toBe(6);
    const [a, b, c] = await Promise.all([runWebhookDeliveries({ limit: 10 }), runWebhookDeliveries({ limit: 10 }), runWebhookDeliveries({ limit: 10 })]);
    expect(a.claimed + b.claimed + c.claimed).toBe(6);
    const got = hits('/hooks/race');
    expect(got).toHaveLength(6);
    expect(new Set(got.map((entry) => entry.headers['openlinear-delivery'])).size).toBe(6);
    expect((await deliveriesOf(id)).every((row) => row.status === 'succeeded' && row.attempts === 1)).toBe(true);
  });
});

// ── Network behaviour ──────────────────────────────────────────────────────

describe('FE-14 delivery network rules', () => {
  it('times out, caps the response read and never follows redirects', async () => {
    replies.set('/hooks/hang', () => ({ status: 200, delayMs: 2_000 }));
    const started = Date.now();
    const hang = await postWebhook(`${base}/hooks/hang`, {}, '{}', { timeoutMs: 300 });
    expect(hang).toMatchObject({ statusCode: null, error: 'No response within 0.3 s' });
    expect(Date.now() - started).toBeLessThan(1_500);

    replies.set('/hooks/big', () => ({ status: 200, body: 'x'.repeat(1024 * 1024) }));
    const big = await postWebhook(`${base}/hooks/big`, {}, '{}');
    expect(big.statusCode).toBe(200);
    expect(big.error).toBeNull();
    expect(big.excerpt?.length).toBe(1024);

    replies.set('/hooks/redirect', () => ({ status: 302, headers: { Location: `${base}/hooks/target` } }));
    const redirected = await postWebhook(`${base}/hooks/redirect`, {}, '{}');
    expect(redirected.statusCode).toBe(302);
    expect(redirected.error).toMatch(/not followed/);
    expect(hits('/hooks/target')).toHaveLength(0);
  });

  it('refuses private, loopback and metadata addresses without connecting', async () => {
    expect((await postWebhook('https://169.254.169.254/latest/meta-data', {}, '{}')).error).toMatch(/does not contact/);
    expect((await postWebhook('https://[::ffff:127.0.0.1]:1/', {}, '{}')).error).toMatch(/does not contact/);
    expect((await postWebhook('http://10.0.0.1/', {}, '{}')).error).toBe('Only https:// URLs are delivered');
    allowLoopbackWebhooksForTests(false);
    try {
      // `localhost` resolves locally; the guarded lookup refuses the loopback answer.
      expect((await postWebhook('https://localhost:9/', {}, '{}')).error).toMatch(/does not contact/);
      expect((await postWebhook(`${base}/hooks/plain`, {}, '{}')).error).toBe('Only https:// URLs are delivered');
    } finally {
      allowLoopbackWebhooksForTests(true);
    }
    expect(hits('/hooks/plain')).toHaveLength(0);
  });
});

// ── Pings, rotation, history ───────────────────────────────────────────────

describe('FE-14 pings, rotation and delivery history', () => {
  beforeEach(clearEndpoints);
  it('sends a signed test ping (PATs with projects:write may; viewers may not)', async () => {
    const { id, secret } = await endpoint('/hooks/ping', ['issue.created']);
    const res = await http_().post(`/api/webhooks/${id}/ping`).set(as(tokens.owner));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ eventType: 'ping', status: 'succeeded', attempts: 1, lastStatusCode: 200, redeliveries: 0 });
    const entry = hits('/hooks/ping').at(-1);
    if (!entry) throw new Error('ping not received');
    expect(verifySignature(entry, secret)).toBe(true);
    expect(JSON.parse(entry.body)).toMatchObject({ id: res.body.id, type: 'ping', projectId, workspaceId, data: { webhookId: id } });
    expect(JSON.parse(res.body.payload as string)).toEqual(JSON.parse(entry.body));
    expect((await http_().post(`/api/webhooks/${id}/ping`).set(as(tokens.viewer))).status).toBe(403);
    expect((await http_().post(`/api/webhooks/${id}/ping`).set(as(patWrite))).status).toBe(201);
    expect((await http_().post(`/api/webhooks/${id}/ping`).set(as(patRead))).status).toBe(403);
  });

  it('rotates the secret with a session; the previous one keeps signing for 24 h', async () => {
    const { id, secret } = await endpoint('/hooks/rotate', ['issue.created']);
    expect((await http_().post(`/api/webhooks/${id}/rotate-secret`).set(as(patAdmin))).body.code).toBe('SESSION_REQUIRED');
    expect((await http_().post(`/api/webhooks/${id}/rotate-secret`).set(as(tokens.viewer))).status).toBe(403);
    const rotated = await http_().post(`/api/webhooks/${id}/rotate-secret`).set(as(tokens.admin));
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);
    const next = rotated.body.secret as string;
    expect(next).toMatch(/^whsec_/);
    expect(next).not.toBe(secret);
    expect(rotated.body.ownerId).toBe(users.admin);
    const grace = new Date(rotated.body.previousSecretExpiresAt as string).getTime() - Date.now();
    expect(grace).toBeGreaterThan(23 * 3_600_000);
    await http_().post(`/api/webhooks/${id}/ping`).set(as(tokens.owner)).expect(201);
    const entry = hits('/hooks/rotate').at(-1);
    if (!entry) throw new Error('ping not received');
    expect(String(entry.headers['openlinear-signature']).split(',')).toHaveLength(2);
    expect(verifySignature(entry, next)).toBe(true);
    expect(verifySignature(entry, secret)).toBe(true);
    // Review fix: a second rotation inside the grace period would drop the original secret.
    const again = await http_().post(`/api/webhooks/${id}/rotate-secret`).set(as(tokens.admin));
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('WEBHOOK_ROTATION_IN_PROGRESS');
    // After the grace period only the new secret signs.
    await prisma.webhookEndpoint.update({ where: { id }, data: { previousSecretExpiresAt: new Date(Date.now() - 1_000) } });
    await http_().post(`/api/webhooks/${id}/ping`).set(as(tokens.owner)).expect(201);
    const after = hits('/hooks/rotate').at(-1);
    if (!after) throw new Error('ping not received');
    expect(verifySignature(after, next)).toBe(true);
    expect(verifySignature(after, secret)).toBe(false);
  });

  it('pages delivery history newest first and shows one delivery with its body', async () => {
    const { id } = await endpoint('/hooks/history', ['issue.created']);
    const sent: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      sent.push((await http_().post(`/api/webhooks/${id}/ping`).set(as(tokens.owner))).body.id as string);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4; page += 1) {
      const res = await http_().get(`/api/webhooks/${id}/deliveries`).query({ limit: 2, ...(cursor ? { cursor } : {}) }).set(as(tokens.viewer));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      seen.push(...(res.body.items as Body[]).map((item) => item.id as string));
      cursor = res.body.nextCursor as string | null;
      if (!cursor) break;
    }
    expect(seen).toEqual([...sent].reverse());
    expect((await http_().get(`/api/webhooks/${id}/deliveries`).query({ status: 'failed' }).set(as(tokens.owner))).body.items).toEqual([]);
    const bad = await http_().get(`/api/webhooks/${id}/deliveries`).query({ cursor: 'not-a-cursor' }).set(as(tokens.owner));
    expect(bad.status).toBe(400);
    expect((await http_().get(`/api/webhooks/${id}/deliveries`).set(as(tokens.stranger))).status).toBe(403);

    const one = await http_().get(`/api/webhooks/${id}/deliveries/${sent[0]}`).set(as(tokens.viewer));
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ id: sent[0], eventType: 'ping', lastResponseExcerpt: 'ok' });
    expect(JSON.parse(one.body.payload as string)).toMatchObject({ id: sent[0], type: 'ping' });
    const other = await endpoint('/hooks/history-2', ['issue.created']);
    const cross = await http_().get(`/api/webhooks/${other.id}/deliveries/${sent[0]}`).set(as(tokens.owner));
    expect(cross.status).toBe(404);
    expect(cross.body.code).toBe('WEBHOOK_DELIVERY_NOT_FOUND');
  });
});

// ── Event mapping ──────────────────────────────────────────────────────────

describe('FE-14 event mapping', () => {
  const ALL = new Set(WEBHOOK_EVENT_TYPES);
  let taskId = '';
  let foreignTaskId = '';

  beforeAll(async () => {
    taskId = (await prisma.task.create({ data: { title: 'Mapped', projectId, creatorId: users.owner, description: 'secret plans' } })).id;
    foreignTaskId = (await prisma.task.create({ data: { title: 'Elsewhere', projectId: otherProjectId, creatorId: users.other } })).id;
  });

  function source(type: string, payload: unknown, id = 42n): SourceEvent {
    return { id, type, occurredAt: new Date('2026-10-27T10:00:00.000Z'), projectId, workspaceId, payload };
  }

  it('maps agent runs to run.* (and a succeeded run to issue.done too)', async () => {
    const run = await prisma.agentRun.create({ data: { taskId, userId: users.owner, agent: 'claude-code', model: 'anthropic/test', status: 'succeeded', endedAt: new Date() } });
    const activity = (status: string) => source('activity:created', { action: 'agent_run_completed', taskId, userId: users.owner, payload: { agentRunId: run.id, status, errorMessage: 'stack trace with /secret/path' } });
    const succeeded = await toWebhookEvents(prisma, activity('succeeded'), ALL);
    expect(succeeded.map((event) => [event.type, event.eventId])).toEqual([['run.succeeded', 'evt_42:run.succeeded'], ['issue.done', 'evt_42:issue.done']]);
    expect(succeeded[0]?.data).toMatchObject({ run: { id: run.id, agent: 'claude-code', model: 'anthropic/test', status: 'succeeded' }, issue: { id: taskId, title: 'Mapped' } });
    expect(JSON.stringify(succeeded)).not.toContain('secret');
    expect((await toWebhookEvents(prisma, activity('failed'), ALL)).map((event) => event.type)).toEqual(['run.failed']);
    expect((await toWebhookEvents(prisma, activity('cancelled'), ALL)).map((event) => event.type)).toEqual(['run.cancelled']);
    expect(await toWebhookEvents(prisma, activity('succeeded'), new Set(['run.failed'] as const))).toEqual([]);
  });

  it('ignores payloads that name another project (the binding decides)', async () => {
    expect(await toWebhookEvents(prisma, source('activity:created', { action: 'task_status_changed', taskId: foreignTaskId, payload: { from: 'todo', to: 'done' } }), ALL)).toEqual([]);
    expect(await toWebhookEvents(prisma, source('task:created', { id: foreignTaskId, title: 'Elsewhere', projectId: otherProjectId }), ALL)).toEqual([]);
    expect(await toWebhookEvents(prisma, source('tasks:bulk-created', { taskIds: [foreignTaskId] }), ALL)).toEqual([]);
  });

  it('maps schedule-created issues, plan approvals, deletions and bulk creation', async () => {
    const schedule = await prisma.issueSchedule.create({
      data: { projectId, title: 'Weekly triage', cadence: 'weekly', weekday: 1, hour: 9, minute: 0, timezone: 'UTC', nextRunAt: new Date(Date.now() + 86_400_000), ownerId: users.owner, createdById: users.owner },
    });
    const fired = await toWebhookEvents(prisma, source('activity:created', { action: 'task_created', taskId, payload: { source: 'schedule', scheduleId: schedule.id } }), ALL);
    expect(fired).toMatchObject([{ type: 'schedule.fired', data: { schedule: { id: schedule.id, title: 'Weekly triage', cadence: 'weekly' }, issue: { id: taskId } } }]);
    expect(await toWebhookEvents(prisma, source('activity:created', { action: 'task_created', taskId, payload: { source: 'chat_bulk' } }), ALL)).toEqual([]);

    const plan = await prisma.plan.create({ data: { projectId, title: 'Launch plan', createdById: users.owner } });
    expect(await toWebhookEvents(prisma, source('plan:approved', { planId: plan.id, projectId, revision: 3 }), ALL))
      .toMatchObject([{ type: 'plan.approved', data: { plan: { id: plan.id, title: 'Launch plan', revision: 3 } } }]);
    expect(await toWebhookEvents(prisma, source('task:deleted', { id: taskId }), ALL)).toMatchObject([{ type: 'issue.deleted', data: { issue: { id: taskId } } }]);
    const bulk = await toWebhookEvents(prisma, source('tasks:bulk-created', { taskIds: [taskId, randomUUID()] }), ALL);
    expect(bulk.map((event) => event.eventId)).toEqual([`evt_42:issue.created:${taskId}`]);
    expect(bulk[0]?.data.issue).not.toHaveProperty('description');
  });

  it('projects task DTOs without description, outcome or logs', async () => {
    const [event] = await toWebhookEvents(prisma, source('task:updated', {
      id: taskId, title: 'Mapped', projectId, status: 'in_progress', description: 'secret plans', outcome: 'secret outcome',
      executionLogs: [{ token: 'ghs_secret' }], sessionId: 's', labels: [{ id: 'l1', name: 'bug', color: '#f00' }],
    }), ALL);
    expect(event?.type).toBe('issue.updated');
    expect(JSON.stringify(event)).not.toMatch(/secret|ghs_|sessionId|color/);
    expect(event?.data).toMatchObject({ issue: { id: taskId, status: 'in_progress', labels: [{ id: 'l1', name: 'bug' }] } });
  });
});
