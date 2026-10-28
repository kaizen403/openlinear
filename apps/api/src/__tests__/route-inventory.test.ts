/**
 * W02a route inventory: parity with the routes `createApp()` registers, and
 * HTTP probes proving each row's declared auth mode, PAT scopes, tenant
 * resource checks and PAT workspace binding. W02b: the middleware enforces
 * the registry (binding stances probed for every row).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { encryptToken, prisma } from '@openlinear/db';
import { PAT_SCOPES, hasRequiredScopes } from '@openlinear/api-core';
import { createApp } from '../app';
import {
  ROUTE_REGISTRY,
  assertRegistryComplete,
  routeKey,
  type ResourceParam,
  type RouteDeclaration,
} from '../registry';
import { generatePersonalAccessToken, hashPersonalAccessToken } from '../services/pats';
import { collectRegisteredRoutes } from './route-collector';
import { closeServer, listen } from './auth-helpers';
import type { Server } from 'node:http';
import { testJwtSecret } from './test-env';

const suffix = randomUUID().slice(0, 8);

function sign(userId: string, username: string): string {
  return jwt.sign({ userId, username }, testJwtSecret(), { expiresIn: '1h' });
}

async function createPat(
  userId: string,
  scopes: string[],
  extra: { workspaceId?: string; revokedAt?: Date; expiresAt?: Date } = {},
): Promise<{ token: string; id: string }> {
  const token = generatePersonalAccessToken();
  const row = await prisma.personalAccessToken.create({
    data: {
      userId,
      name: `inventory-${suffix}`,
      tokenHash: hashPersonalAccessToken(token),
      tokenPrefix: token.slice(0, 15),
      scopes,
      workspaceId: extra.workspaceId ?? null,
      revokedAt: extra.revokedAt ?? null,
      expiresAt: extra.expiresAt ?? null,
    },
  });
  return { token, id: row.id };
}

type Lower = 'get' | 'post' | 'patch' | 'put' | 'delete';

/**
 * Probes go to one server bound to 127.0.0.1 for the whole file, not to
 * supertest's per-request `app.listen(0)`. That listener binds the wildcard
 * address and supertest then connects to 127.0.0.1:<port>; on a shared
 * machine the kernel handed it ports another process already held on
 * 127.0.0.1 (other developers' PostgreSQL clusters on 127.0.0.1:556xx), the
 * more specific listener won, and the probe failed with `socket hang up`
 * without ever reaching the app. A 127.0.0.1 bind cannot share such a port.
 * (`app.listen(0)` once per file would still bind the wildcard.)
 */
type Target = string;

function send(target: Target, entry: RouteDeclaration, path: string, token?: string) {
  const method = entry.method.toLowerCase() as Lower;
  let req = request(target)[method](path);
  if (token) req = req.set('Authorization', `Bearer ${token}`);
  if (entry.method !== 'GET' && entry.method !== 'DELETE') req = req.send({});
  return req;
}

function fillPath(path: string, value: (param: string) => string): string {
  return path.replace(/:([A-Za-z]+)/g, (_match, param: string) => value(param));
}

function placeholder(param: string): string {
  if (param === 'filename') return `missing-${suffix}.txt`;
  if (param === 'owner' || param === 'repo') return 'x';
  return randomUUID();
}

function code(body: unknown): string | undefined {
  return typeof body === 'object' && body !== null && typeof (body as { code?: unknown }).code === 'string'
    ? (body as { code: string }).code
    : undefined;
}

/** Every closed-enum scope that does not by itself satisfy `required`. */
function nearMissScopes(required: string[]): string[] {
  const nearMiss = PAT_SCOPES.filter((scope) => !hasRequiredScopes([scope], required));
  return nearMiss.length > 0 && !hasRequiredScopes(nearMiss, required) ? [...nearMiss] : ['__none__'];
}

const patCallable = (entry: RouteDeclaration) => entry.auth === 'session_or_pat' || entry.auth === 'optional';

describe('W02a route inventory', () => {
  it('lists exactly the routes createApp() registers (inventory parity)', () => {
    const registered = collectRegisteredRoutes(createApp).map((entry) => `${entry.method} ${entry.path}`).sort();
    const inventory = ROUTE_REGISTRY.map(routeKey).sort();
    const missingFromInventory = registered.filter((key) => !inventory.includes(key));
    const staleInInventory = inventory.filter((key) => !registered.includes(key));
    expect({ missingFromInventory, staleInInventory }).toEqual({ missingFromInventory: [], staleInInventory: [] });
    expect(registered.length).toBe(ROUTE_REGISTRY.length);
  });

  it('is internally consistent', () => {
    expect(() => assertRegistryComplete(ROUTE_REGISTRY)).not.toThrow();
  });

  it('every non-public route names an enforcement point and a PAT workspace stance', () => {
    const undeclared = ROUTE_REGISTRY.filter((entry) => entry.auth !== 'public' && entry.enforcement === 'none');
    expect(undeclared.map(routeKey)).toEqual([]);
    const patWithoutStance = ROUTE_REGISTRY.filter((entry) => patCallable(entry) && entry.workspaceBinding === 'not-applicable');
    expect(patWithoutStance.map(routeKey)).toEqual([]);
  });

  it('W02b: every PAT route needs scopes some mintable PAT can hold, and account data is denied to bound PATs by default', () => {
    const unsatisfiable = ROUTE_REGISTRY.filter((entry) => patCallable(entry)
      && !PAT_SCOPES.some((scope) => hasRequiredScopes([scope], entry.patScopes)));
    expect(unsatisfiable.map(routeKey)).toEqual([]);
    const genericWithoutReason = ROUTE_REGISTRY.filter((entry) => entry.patScopes.some((scope) => scope === 'read' || scope === 'write') && !entry.scopeJustification);
    expect(genericWithoutReason.map(routeKey)).toEqual([]);
    const accountReads = ROUTE_REGISTRY.filter((entry) => entry.workspaceBinding === 'account-read');
    expect(accountReads.every((entry) => entry.method === 'GET' && Boolean(entry.bindingJustification))).toBe(true);
    // Account-level routes are refused unless explicitly justified.
    const accountLevel = ROUTE_REGISTRY.filter((entry) => patCallable(entry) && entry.patScopes.some((scope) => scope.startsWith('account:')));
    expect(accountLevel.filter((entry) => entry.workspaceBinding === 'enforced').map(routeKey)).toEqual([]);
  });
});

describe('W02a route inventory HTTP probes', () => {
  const app = createApp();
  let server: Server | undefined;
  let target = '';
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  let probeUserId = '';
  let probeJwt = '';
  const exactPats = new Map<string, string>();
  let nonePat = '';
  let allScopePat = '';
  let revokedPat = '';
  let expiredPat = '';

  const fixture = {
    outsiderJwt: '',
    dualJwt: '',
    boundPat: '',
    boundPatId: '',
    ownerB: '',
    dual: '',
    workspaceB: '',
    projectB: '',
    teamB: '',
    taskB: '',
    commentB: '',
    labelB: '',
    chatSessionB: '',
    agentRunB: '',
    planB: '',
    scheduleB: '',
    knowledgeB: '',
    webhookB: '',
    webhookDeliveryB: '',
    notificationB: '',
    invitationB: '',
    sessionDual: '',
    repositoryDual: '',
  };

  async function makeUser(label: string) {
    const user = await prisma.user.create({
      data: {
        githubId: `inv-${label}-${suffix}`,
        username: `inv-${label}-${suffix}`,
        email: `inv-${label}-${suffix}@example.com`,
      },
    });
    userIds.push(user.id);
    return user;
  }

  beforeAll(async () => {
    // No probe may reach the network: GitHub, models.dev, OIDC discovery.
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network disabled in route inventory probes');
    }));

    ({ server, baseUrl: target } = await listen(app));

    const probe = await makeUser('probe');
    probeUserId = probe.id;
    probeJwt = sign(probe.id, probe.username);
    for (const scopes of new Set(ROUTE_REGISTRY.map((entry) => entry.patScopes.join(',')))) {
      if (!scopes) continue;
      exactPats.set(scopes, (await createPat(probe.id, scopes.split(','))).token);
    }
    nonePat = (await createPat(probe.id, ['__none__'])).token;
    allScopePat = (await createPat(probe.id, ['admin'])).token;
    revokedPat = (await createPat(probe.id, ['admin'], { revokedAt: new Date() })).token;
    expiredPat = (await createPat(probe.id, ['admin'], { expiresAt: new Date(Date.now() - 60_000) })).token;

    // Tenant B, plus a "dual" user who belongs to A and B and holds a PAT bound to A.
    const outsider = await makeUser('outsider');
    const ownerB = await makeUser('owner-b');
    const dual = await makeUser('dual');
    fixture.outsiderJwt = sign(outsider.id, outsider.username);
    fixture.dualJwt = sign(dual.id, dual.username);
    fixture.ownerB = ownerB.id;
    fixture.dual = dual.id;

    const workspaceA = await prisma.workspace.create({ data: { name: `Inv A ${suffix}`, slug: `inv-a-${suffix}` } });
    const workspaceB = await prisma.workspace.create({ data: { name: `Inv B ${suffix}`, slug: `inv-b-${suffix}` } });
    const outsiderWs = await prisma.workspace.create({ data: { name: `Inv O ${suffix}`, slug: `inv-o-${suffix}` } });
    workspaceIds.push(workspaceA.id, workspaceB.id, outsiderWs.id);
    fixture.workspaceB = workspaceB.id;
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId: workspaceA.id, userId: dual.id, role: 'owner' },
        { workspaceId: workspaceB.id, userId: ownerB.id, role: 'owner' },
        { workspaceId: workspaceB.id, userId: dual.id, role: 'admin' },
        { workspaceId: outsiderWs.id, userId: outsider.id, role: 'owner' },
      ],
    });
    const bound = await createPat(dual.id, ['admin'], { workspaceId: workspaceA.id });
    fixture.boundPat = bound.token;
    fixture.boundPatId = bound.id;

    const projectB = await prisma.project.create({ data: { name: 'Inv project B', workspaceId: workspaceB.id, key: 'INVB' } });
    fixture.projectB = projectB.id;
    const teamB = await prisma.team.create({ data: { name: 'Inv team B', key: 'IVB', projectId: projectB.id } });
    fixture.teamB = teamB.id;
    await prisma.teamMember.createMany({
      data: [
        { teamId: teamB.id, userId: ownerB.id, role: 'owner' },
        { teamId: teamB.id, userId: dual.id, role: 'owner' },
      ],
    });
    const taskB = await prisma.task.create({
      data: { title: `inv-task-${suffix}`, projectId: projectB.id, teamId: teamB.id, creatorId: dual.id, archived: true },
    });
    fixture.taskB = taskB.id;
    fixture.commentB = (await prisma.comment.create({ data: { taskId: taskB.id, userId: dual.id, body: 'inv comment' } })).id;
    fixture.labelB = (await prisma.label.create({ data: { projectId: projectB.id, name: `inv-${suffix}`, color: '#000000' } })).id;
    await prisma.taskLabel.create({ data: { taskId: taskB.id, labelId: fixture.labelB } });
    fixture.chatSessionB = (await prisma.chatSession.create({ data: { userId: dual.id, workspaceId: workspaceB.id, projectId: projectB.id } })).id;
    fixture.agentRunB = (await prisma.agentRun.create({ data: { taskId: taskB.id, userId: dual.id, agent: 'opencode', model: 'test/model' } })).id;
    fixture.planB = (await prisma.plan.create({
      data: { projectId: projectB.id, title: 'inv plan', createdById: dual.id, revisions: { create: { number: 1, spec: { tasks: [{ key: 'a', title: 'A' }] }, specHash: 'a'.repeat(64) } } },
    })).id;
    fixture.scheduleB = (await prisma.issueSchedule.create({
      data: {
        projectId: projectB.id, title: 'inv schedule', cadence: 'daily', hour: 9, minute: 0, timezone: 'UTC',
        nextRunAt: new Date(Date.now() + 86_400_000), ownerId: dual.id, createdById: dual.id,
      },
    })).id;
    fixture.knowledgeB = (await prisma.knowledgeEntry.create({
      data: { projectId: projectB.id, title: 'inv knowledge', body: 'inv', status: 'active', source: 'user', createdById: dual.id, updatedById: dual.id },
    })).id;
    // FE-14: a project webhook (secret ciphertext only; never delivered here) and one delivery.
    fixture.webhookB = (await prisma.webhookEndpoint.create({
      data: {
        scope: 'project', projectId: projectB.id, url: 'https://hooks.example.com/inv', eventTypes: ['issue.created'],
        secretEncrypted: encryptToken('whsec_inventory'), secretPrefix: 'whsec_inve', ownerId: dual.id, createdById: dual.id,
      },
    })).id;
    fixture.webhookDeliveryB = (await prisma.webhookDelivery.create({
      data: { endpointId: fixture.webhookB, eventId: `ping_${suffix}`, eventType: 'ping', payload: '{}', status: 'failed', attempts: 1 },
    })).id;
    fixture.notificationB = (await prisma.notification.create({ data: { userId: dual.id, type: 'mention', taskId: taskB.id, body: 'inv' } })).id;
    fixture.invitationB = (await prisma.invitation.create({
      data: { email: `inv-invitee-${suffix}@example.com`, workspaceId: workspaceB.id, invitedById: ownerB.id, expiresAt: new Date(Date.now() + 86_400_000) },
    })).id;
    fixture.sessionDual = (await prisma.session.create({ data: { userId: dual.id, tokenHash: `inv-session-${suffix}` } })).id;
    fixture.repositoryDual = (await prisma.repository.create({
      data: { githubRepoId: 990_000 + Math.floor(Math.random() * 9_000), name: 'inv', fullName: `inv/${suffix}`, cloneUrl: 'https://example.invalid/inv.git', userId: dual.id },
    })).id;
    await prisma.chatAttachment.create({
      data: { userId: dual.id, filename: 'inv.txt', mimeType: 'text/plain', url: `/uploads/inv-${suffix}.txt`, size: 1 },
    });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await closeServer(server);
    await prisma.workspace.deleteMany({ where: { members: { some: { userId: { in: userIds } } } } });
    await prisma.task.deleteMany({ where: { id: fixture.taskB } });
    await prisma.project.deleteMany({ where: { id: fixture.projectB } });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.domainEvent.deleteMany({ where: { OR: [{ userIds: { hasSome: userIds } }, { workspaceIds: { hasSome: workspaceIds } }] } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  const resourceIds = (param: ResourceParam): string => {
    switch (param) {
      case 'task': return fixture.taskB;
      case 'project': return fixture.projectB;
      case 'team': return fixture.teamB;
      case 'workspace': return fixture.workspaceB;
      case 'comment': return fixture.commentB;
      case 'label': return fixture.labelB;
      case 'chatSession': return fixture.chatSessionB;
      case 'agentRun': return fixture.agentRunB;
      case 'repository': return fixture.repositoryDual;
      case 'notification': return fixture.notificationB;
      case 'invitation': return fixture.invitationB;
      case 'session': return fixture.sessionDual;
      case 'pat': return fixture.boundPatId;
      case 'user': return fixture.ownerB;
      case 'upload': return `inv-${suffix}.txt`;
      case 'plan': return fixture.planB;
      case 'schedule': return fixture.scheduleB;
      case 'knowledge': return fixture.knowledgeB;
      case 'webhook': return fixture.webhookB;
      case 'webhookDelivery': return fixture.webhookDeliveryB;
      default: {
        const exhaustive: never = param;
        throw new Error(`unmapped resource ${String(exhaustive)}`);
      }
    }
  };

  const foreignPath = (entry: RouteDeclaration) =>
    fillPath(entry.path, (param) => {
      const kind = entry.params?.[param];
      return kind ? resourceIds(kind) : placeholder(param);
    });

  it('requires authentication on every non-public route', async () => {
    const failures: string[] = [];
    for (const entry of ROUTE_REGISTRY) {
      if (entry.auth === 'public') continue;
      const res = await send(target, entry, fillPath(entry.path, placeholder));
      const ok = entry.auth === 'optional' ? res.status !== 401 : res.status === 401;
      if (!ok) failures.push(`${routeKey(entry)} -> ${res.status}`);
    }
    expect(failures).toEqual([]);
  });

  it('refuses PATs on session-only and stream routes', async () => {
    const failures: string[] = [];
    for (const entry of ROUTE_REGISTRY) {
      if (entry.auth !== 'session' && entry.auth !== 'stream') continue;
      const res = await send(target, entry, fillPath(entry.path, placeholder), allScopePat);
      const ok = entry.auth === 'session'
        ? res.status === 403 && code(res.body) === 'SESSION_REQUIRED'
        : res.status === 401;
      if (!ok) failures.push(`${routeKey(entry)} -> ${res.status} ${code(res.body) ?? ''}`);
    }
    expect(failures).toEqual([]);
  });

  it('rejects scope-less, near-miss, revoked and expired PATs on every PAT route', async () => {
    const failures: string[] = [];
    for (const entry of ROUTE_REGISTRY) {
      if (!patCallable(entry)) continue;
      const path = fillPath(entry.path, placeholder);
      const none = await send(target, entry, path, nonePat);
      if (none.status !== 403 || code(none.body) !== 'INSUFFICIENT_SCOPE') {
        failures.push(`${routeKey(entry)} scope-less -> ${none.status} ${code(none.body) ?? ''}`);
      }
      const nearMiss = nearMissScopes(entry.patScopes);
      const nearMissPat = (await createPat(probeUserId, nearMiss)).token;
      const near = await send(target, entry, path, nearMissPat);
      if (near.status !== 403 || code(near.body) !== 'INSUFFICIENT_SCOPE') {
        failures.push(`${routeKey(entry)} near-miss [${nearMiss.join(',')}] -> ${near.status} ${code(near.body) ?? ''}`);
      }
      const revoked = await send(target, entry, path, revokedPat);
      if (revoked.status !== 401) failures.push(`${routeKey(entry)} revoked -> ${revoked.status}`);
      const expired = await send(target, entry, path, expiredPat);
      if (expired.status !== 401) failures.push(`${routeKey(entry)} expired -> ${expired.status}`);
    }
    expect(failures).toEqual([]);
  });

  it('accepts a PAT holding exactly the declared scopes (declared scopes are sufficient)', async () => {
    const failures: string[] = [];
    for (const entry of ROUTE_REGISTRY) {
      if (!patCallable(entry)) continue;
      const token = exactPats.get(entry.patScopes.join(','));
      if (!token) {
        failures.push(`${routeKey(entry)} has no exact-scope PAT`);
        continue;
      }
      const res = await send(target, entry, fillPath(entry.path, placeholder), token);
      const rejected = res.status === 401 || ['INSUFFICIENT_SCOPE', 'SESSION_REQUIRED'].includes(code(res.body) ?? '');
      if (rejected) failures.push(`${routeKey(entry)} -> ${res.status} ${code(res.body) ?? ''}`);
    }
    expect(failures).toEqual([]);
    // The same probe identity also works with a session.
    expect((await request(target).get('/api/users/me').set('Authorization', `Bearer ${probeJwt}`)).status).toBe(200);
  });

  it('W02b: refuses workspace-bound PATs on account-level routes before the handler runs', async () => {
    const failures: string[] = [];
    const refused = ROUTE_REGISTRY.filter((entry) => patCallable(entry) && entry.workspaceBinding === 'refused');
    expect(refused.length).toBeGreaterThan(15);
    for (const entry of refused) {
      const res = await send(target, entry, foreignPath(entry), fixture.boundPat);
      if (res.status !== 403 || code(res.body) !== 'PAT_WORKSPACE_RESTRICTED') {
        failures.push(`${routeKey(entry)} -> ${res.status} ${code(res.body) ?? ''}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('W02b: lets workspace-bound PATs through on justified account reads and workspace-scoped routes', async () => {
    const failures: string[] = [];
    for (const entry of ROUTE_REGISTRY) {
      if (!patCallable(entry) || entry.workspaceBinding === 'refused') continue;
      const res = await send(target, entry, fillPath(entry.path, placeholder), fixture.boundPat);
      if (res.status === 401 || ['PAT_WORKSPACE_RESTRICTED', 'INSUFFICIENT_SCOPE', 'SESSION_REQUIRED', 'PAT_ROUTE_UNDECLARED'].includes(code(res.body) ?? '')) {
        failures.push(`${routeKey(entry)} -> ${res.status} ${code(res.body) ?? ''}`);
      }
    }
    expect(failures).toEqual([]);
  });

  const resourceRoutes = () =>
    ROUTE_REGISTRY.filter((entry) => entry.params && (entry.method === 'GET' || entry.method === 'DELETE'));

  it('denies every GET/DELETE resource route to a caller from another tenant', async () => {
    const failures: string[] = [];
    for (const entry of resourceRoutes()) {
      const res = await send(target, entry, foreignPath(entry), fixture.outsiderJwt);
      if (![403, 404].includes(res.status)) failures.push(`${routeKey(entry)} -> ${res.status}`);
    }
    expect(failures).toEqual([]);
  });

  it('denies every workspace-bound GET/DELETE resource route to a PAT bound to another workspace', async () => {
    const failures: string[] = [];
    const bound = resourceRoutes().filter((entry) => entry.workspaceBinding === 'enforced');
    expect(bound.length).toBeGreaterThan(20);
    for (const entry of bound) {
      const res = await send(target, entry, foreignPath(entry), fixture.boundPat);
      if (![403, 404].includes(res.status)) failures.push(`${routeKey(entry)} -> ${res.status} ${code(res.body) ?? ''}`);
    }
    expect(failures).toEqual([]);
  });

  it('serves the same GET resources to the same user without the workspace binding (control)', async () => {
    const failures: string[] = [];
    const reads = resourceRoutes().filter((entry) => entry.workspaceBinding === 'enforced' && entry.method === 'GET');
    for (const entry of reads) {
      const res = await send(target, entry, foreignPath(entry), fixture.dualJwt);
      if (res.status < 200 || res.status >= 300) failures.push(`${routeKey(entry)} -> ${res.status} ${code(res.body) ?? ''}`);
    }
    expect(failures).toEqual([]);
  });

  it('left every probed tenant-B resource in place', async () => {
    expect(await prisma.task.count({ where: { id: fixture.taskB } })).toBe(1);
    expect(await prisma.comment.count({ where: { id: fixture.commentB } })).toBe(1);
    expect(await prisma.label.count({ where: { id: fixture.labelB } })).toBe(1);
    expect(await prisma.taskLabel.count({ where: { taskId: fixture.taskB, labelId: fixture.labelB } })).toBe(1);
    expect(await prisma.team.count({ where: { id: fixture.teamB } })).toBe(1);
    expect(await prisma.teamMember.count({ where: { teamId: fixture.teamB } })).toBe(2);
    expect(await prisma.project.count({ where: { id: fixture.projectB } })).toBe(1);
    expect(await prisma.workspaceMember.count({ where: { workspaceId: fixture.workspaceB } })).toBe(2);
    expect(await prisma.chatSession.count({ where: { id: fixture.chatSessionB, archivedAt: null } })).toBe(1);
    expect(await prisma.issueSchedule.count({ where: { id: fixture.scheduleB } })).toBe(1);
    expect(await prisma.webhookEndpoint.count({ where: { id: fixture.webhookB } })).toBe(1);
    expect(await prisma.session.count({ where: { id: fixture.sessionDual, revokedAt: null } })).toBe(1);
    expect(await prisma.personalAccessToken.count({ where: { id: fixture.boundPatId, revokedAt: null } })).toBe(1);
  });
});
