/**
 * W02a realtime policy: live delivery and Last-Event-ID replay authorize each
 * subscriber against the event's resource binding with its current
 * principal; membership/grant revocation re-authorizes open streams.
 */
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { prisma } from '@openlinear/db';
import { createApp } from '../app';
import {
  MAX_HELD_EVENTS_PER_CLIENT,
  applyClientPrincipal,
  clients,
  deliverToLocalClients,
  refreshClientScope,
  registerClient,
  revalidateClientPrincipal,
  setPrincipalResolver,
  unregisterClient,
  type SSEClient,
} from '../events/hub';
import { persistAndDeliver, replaySince } from '../events/outbox';
import { broadcastToChatSession, broadcastToProject, broadcastToTask, broadcastToTeam, broadcastToWorkspace } from '../sse';
import { resolveTenancyContext } from '../tenancy/context';
import type { TenancyContext } from '../tenancy/types';
import { testJwtSecret } from './test-env';
import { useTestServer } from './http';

const suffix = randomUUID().slice(0, 8);

function sign(userId: string, username: string): string {
  return jwt.sign({ userId, username }, testJwtSecret(), { expiresIn: '1h' });
}

async function principalOf(userId: string): Promise<TenancyContext> {
  return resolveTenancyContext({ userId, authSource: 'jwt', scopes: [] }, { bypassCache: true });
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface FakeStream {
  client: SSEClient;
  frames: string[];
  ended: () => boolean;
  has: (marker: string) => boolean;
}

const streams: FakeStream[] = [];

async function connect(userId: string): Promise<FakeStream> {
  const frames: string[] = [];
  let ended = false;
  const res = {
    get writableEnded() { return ended; },
    write(chunk: string) { frames.push(chunk); return true; },
    end() { ended = true; },
  };
  const client: SSEClient = {
    id: `policy-${randomUUID()}`,
    res: res as unknown as SSEClient['res'],
    userId,
    teamIds: [],
    workspaceIds: [],
    connectedAt: Date.now(),
  };
  applyClientPrincipal(client, await principalOf(userId));
  registerClient(client);
  const stream = { client, frames, ended: () => ended, has: (marker: string) => frames.some((f) => f.includes(marker)) };
  streams.push(stream);
  return stream;
}

describe('W02a realtime delivery and replay policy', () => {
  const app = createApp();
  const http = useTestServer(() => app);
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  const users: Record<string, { id: string; username: string }> = {};
  const ids = { workspace: '', projectP: '', teamX: '', taskT: '', runT: '', chatOwner: '' };

  beforeAll(async () => {
    for (const label of ['owner', 'denied', 'viewer', 'member', 'drifter', 'outsider']) {
      const user = await prisma.user.create({
        data: { githubId: `ep-${label}-${suffix}`, username: `ep-${label}-${suffix}`, email: `ep-${label}-${suffix}@example.com` },
      });
      userIds.push(user.id);
      users[label] = user;
    }
    const workspace = await prisma.workspace.create({ data: { name: `EP ${suffix}`, slug: `ep-${suffix}` } });
    const outsiderWs = await prisma.workspace.create({ data: { name: `EP out ${suffix}`, slug: `ep-out-${suffix}` } });
    workspaceIds.push(workspace.id, outsiderWs.id);
    ids.workspace = workspace.id;
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId: workspace.id, userId: users.owner.id, role: 'owner' },
        { workspaceId: workspace.id, userId: users.denied.id, role: 'member' },
        { workspaceId: workspace.id, userId: users.viewer.id, role: 'member' },
        { workspaceId: workspace.id, userId: users.member.id, role: 'member' },
        { workspaceId: workspace.id, userId: users.drifter.id, role: 'member' },
        { workspaceId: outsiderWs.id, userId: users.outsider.id, role: 'owner' },
      ],
    });
    const project = await prisma.project.create({ data: { name: 'EP P', workspaceId: workspace.id, key: 'EPP' } });
    ids.projectP = project.id;
    await prisma.projectAccess.createMany({
      data: [
        { projectId: project.id, userId: users.denied.id, permission: 'deny' },
        { projectId: project.id, userId: users.viewer.id, permission: 'view' },
      ],
    });
    const team = await prisma.team.create({ data: { name: 'EP X', key: 'EPX', projectId: project.id } });
    ids.teamX = team.id;
    await prisma.teamMember.createMany({
      data: ['owner', 'denied', 'viewer', 'member', 'drifter'].map((label) => ({
        teamId: team.id, userId: users[label].id, role: label === 'owner' ? 'owner' as const : 'member' as const,
      })),
    });
    const task = await prisma.task.create({
      data: { title: `ep-task-${suffix}`, projectId: project.id, teamId: team.id, creatorId: users.denied.id },
    });
    ids.taskT = task.id;
    ids.runT = (await prisma.agentRun.create({ data: { taskId: task.id, userId: users.owner.id, agent: 'opencode', model: 'm' } })).id;
    ids.chatOwner = (await prisma.chatSession.create({ data: { userId: users.owner.id, workspaceId: workspace.id } })).id;
  });

  afterEach(() => {
    for (const stream of streams.splice(0)) unregisterClient(stream.client.id);
    setPrincipalResolver(null);
  });

  afterAll(async () => {
    clients.clear();
    await prisma.task.deleteMany({ where: { projectId: ids.projectP } });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.domainEvent.deleteMany({
      where: { OR: [{ userIds: { hasSome: userIds } }, { workspaceIds: { hasSome: workspaceIds } }, { projectId: ids.projectP }] },
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  it('delivers project events only to users who can view the project', async () => {
    const owner = await connect(users.owner.id);
    const viewer = await connect(users.viewer.id);
    const denied = await connect(users.denied.id);
    const outsider = await connect(users.outsider.id);
    const marker = `label-${randomUUID()}`;
    await broadcastToProject(ids.projectP, 'label:created', { marker });
    await waitFor(() => owner.has(marker) && viewer.has(marker));
    expect(denied.has(marker)).toBe(false);
    expect(outsider.has(marker)).toBe(false);
  });

  it('delivers task and team events to team members minus the denied ones', async () => {
    const owner = await connect(users.owner.id);
    const denied = await connect(users.denied.id);
    const taskMarker = `task-${randomUUID()}`;
    broadcastToTask('task:updated', { id: ids.taskT, projectId: ids.projectP, teamId: ids.teamX, creatorId: users.denied.id }, { taskMarker });
    const teamMarker = `team-${randomUUID()}`;
    broadcastToTeam(ids.teamX, 'comment:created', { teamMarker });
    await waitFor(() => owner.has(taskMarker) && owner.has(teamMarker));
    expect(denied.has(taskMarker)).toBe(false);
    expect(denied.has(teamMarker)).toBe(false);
  });

  it('sends chat session events to the session owner only', async () => {
    const owner = await connect(users.owner.id);
    const member = await connect(users.member.id);
    const marker = `chat-${randomUUID()}`;
    await broadcastToChatSession(ids.chatOwner, 'chat:session:updated', { marker });
    await waitFor(() => owner.has(marker));
    expect(member.has(marker)).toBe(false);
  });

  it('authorizes execution progress against the task, not the routing audience', async () => {
    const owner = await connect(users.owner.id);
    const denied = await connect(users.denied.id);
    const marker = `progress-${randomUUID()}`;
    const res = await http()
      .post('/api/agent-runs/progress')
      .set('Authorization', `Bearer ${sign(users.owner.id, users.owner.username)}`)
      .send({ runId: ids.runT, events: [{ seq: 1, type: 'message', payload: { marker } }] });
    expect(res.status).toBe(200);
    // The denied user is the task creator and a workspace member: addressed
    // by the audience, refused by the binding.
    await waitFor(() => owner.frames.filter((f) => f.includes(marker)).length >= 2);
    expect(denied.has(marker)).toBe(false);
  });

  it('replays only events the principal may receive, and fails closed on legacy rows', async () => {
    const before = await prisma.domainEvent.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
    const lastId = before?.id ?? 0n;
    const marker = `replay-${randomUUID()}`;
    const owner = await connect(users.owner.id);
    await broadcastToProject(ids.projectP, 'label:updated', { marker });
    await waitFor(() => owner.has(marker)); // persisted and published
    await prisma.domainEvent.create({
      data: { type: 'legacy:workspace', payload: { marker }, workspaceIds: [ids.workspace], publishedAt: new Date() },
    });
    await prisma.domainEvent.create({
      data: { type: 'legacy:direct', payload: { marker }, userIds: [users.owner.id], publishedAt: new Date() },
    });

    const replayFor = async (userId: string) => {
      const principal = await principalOf(userId);
      const rows = await replaySince(lastId, {
        userId, teamIds: [...principal.teams], workspaceIds: [...principal.workspaces.keys()], principal,
      });
      return rows.filter((row) => JSON.stringify(row.payload).includes(marker)).map((row) => row.type);
    };
    const ownerTypes = await replayFor(users.owner.id);
    expect(ownerTypes).toContain('label:updated');
    expect(ownerTypes).toContain('legacy:direct');
    expect(ownerTypes).not.toContain('legacy:workspace');
    expect(await replayFor(users.denied.id)).toEqual([]);
    expect(await replayFor(users.outsider.id)).toEqual([]);
    expect(await replayFor(users.viewer.id)).toEqual(['label:updated']);
  });

  /** Hold principal refreshes until released, to observe the paused window. */
  function gateRefreshes() {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    setPrincipalResolver(async (userId) => {
      await gate;
      return principalOf(userId);
    });
    return release;
  }

  it('re-authorizes an open stream as soon as a project grant is revoked', async () => {
    const viewer = await connect(users.viewer.id);
    const owner = await connect(users.owner.id);
    const release = gateRefreshes();
    const revoke = await http()
      .delete(`/api/projects/${ids.projectP}/access/${users.viewer.id}`)
      .set('Authorization', `Bearer ${sign(users.owner.id, users.owner.username)}`);
    expect(revoke.status).toBe(204);
    // Emitted right after the revocation committed, before any refresh could
    // finish: the stream must hold it rather than use the old snapshot.
    const marker = `after-revoke-${randomUUID()}`;
    await broadcastToProject(ids.projectP, 'label:updated', { marker });
    await waitFor(() => owner.has(marker));
    expect(viewer.has(marker)).toBe(false);
    expect(viewer.client.held?.length ?? 0).toBeGreaterThan(0);
    release();
    await waitFor(() => !viewer.client.held);
    expect(viewer.has(marker)).toBe(false);
    expect(viewer.client.principal?.projectGrants.get(ids.projectP)).toBe('deny');
  });

  it('re-authorizes an open stream when the user is removed from the workspace', async () => {
    const member = await connect(users.member.id);
    const owner = await connect(users.owner.id);
    const release = gateRefreshes();
    const removed = await http()
      .delete(`/api/workspaces/${ids.workspace}/members/${users.member.id}`)
      .set('Authorization', `Bearer ${sign(users.owner.id, users.owner.username)}`);
    expect(removed.status).toBe(204);
    const wsMarker = `ws-${randomUUID()}`;
    const projectMarker = `pj-${randomUUID()}`;
    broadcastToWorkspace(ids.workspace, 'workspace:updated', { wsMarker });
    await broadcastToProject(ids.projectP, 'project:updated', { projectMarker });
    await waitFor(() => owner.has(wsMarker) && owner.has(projectMarker));
    expect(member.has(wsMarker)).toBe(false);
    expect(member.has(projectMarker)).toBe(false);
    release();
    await waitFor(() => !member.client.held);
    expect(member.has(wsMarker)).toBe(false);
    expect(member.has(projectMarker)).toBe(false);
    expect(member.client.workspaceIds).toEqual([]);
  });

  it('periodic revalidation applies a grant change that emitted no event', async () => {
    const drifter = await connect(users.drifter.id);
    const owner = await connect(users.owner.id);
    await prisma.projectAccess.create({ data: { projectId: ids.projectP, userId: users.drifter.id, permission: 'deny' } });
    expect(await revalidateClientPrincipal(drifter.client.id)).toBe(true);
    const marker = `drift-${randomUUID()}`;
    await broadcastToProject(ids.projectP, 'label:updated', { marker });
    await waitFor(() => owner.has(marker));
    expect(drifter.has(marker)).toBe(false);
  });

  it('closes a stream whose principal cannot be refreshed, or whose held buffer overflows', async () => {
    const failing = await connect(users.owner.id);
    setPrincipalResolver(async () => { throw new Error('db down'); });
    await refreshClientScope(users.owner.id);
    expect(failing.ended()).toBe(true);
    expect(clients.has(failing.client.id)).toBe(false);

    const stuck = await connect(users.viewer.id);
    setPrincipalResolver(() => new Promise<TenancyContext>(() => undefined));
    void refreshClientScope(users.viewer.id);
    expect(stuck.client.held).toEqual([]);
    for (let i = 0; i <= MAX_HELD_EVENTS_PER_CLIENT; i += 1) {
      deliverToLocalClients({
        id: String(i), type: 'noise', occurredAt: new Date().toISOString(), actorId: null, workspaceId: null,
        payload: {}, userIds: [users.viewer.id], teamIds: [], workspaceIds: [], resourceType: 'user', projectId: null,
      });
    }
    expect(stuck.ended()).toBe(true);
    expect(stuck.frames.some((f) => f.includes('event: noise'))).toBe(false);
  });

  it('keeps unbound events limited to explicitly addressed users', async () => {
    const owner = await connect(users.owner.id);
    const member = await connect(users.viewer.id);
    const marker = `unbound-${randomUUID()}`;
    await persistAndDeliver({ type: 'legacy:live', payload: { marker }, audience: { workspaceIds: [ids.workspace], userIds: [users.owner.id] } });
    await waitFor(() => owner.has(marker));
    expect(member.has(marker)).toBe(false);
  });
});

describe('W02a realtime policy over a real SSE connection', () => {
  const app = createApp();
  const http = useTestServer(() => app);
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  let server: Server | undefined;
  let baseUrl = '';
  const tokens: Record<string, string> = {};
  const ids = { project: '', task: '' };

  beforeAll(async () => {
    const created: Record<string, string> = {};
    for (const label of ['owner', 'denied']) {
      const user = await prisma.user.create({
        data: { githubId: `eh-${label}-${suffix}`, username: `eh-${label}-${suffix}`, email: `eh-${label}-${suffix}@example.com` },
      });
      userIds.push(user.id);
      created[label] = user.id;
      tokens[label] = sign(user.id, user.username);
    }
    const workspace = await prisma.workspace.create({ data: { name: `EH ${suffix}`, slug: `eh-${suffix}` } });
    workspaceIds.push(workspace.id);
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId: workspace.id, userId: created.owner, role: 'owner' },
        { workspaceId: workspace.id, userId: created.denied, role: 'member' },
      ],
    });
    const project = await prisma.project.create({ data: { name: 'EH P', workspaceId: workspace.id, key: 'EHP' } });
    ids.project = project.id;
    await prisma.projectAccess.create({ data: { projectId: project.id, userId: created.denied, permission: 'deny' } });
    const team = await prisma.team.create({ data: { name: 'EH X', key: 'EHX', projectId: project.id } });
    await prisma.teamMember.createMany({
      data: [
        { teamId: team.id, userId: created.owner, role: 'owner' },
        { teamId: team.id, userId: created.denied, role: 'member' },
      ],
    });
    ids.task = (await prisma.task.create({ data: { title: `eh-task-${suffix}`, projectId: project.id, teamId: team.id, creatorId: created.owner } })).id;

    server = await new Promise<Server>((resolve, reject) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
      listening.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server) {
      const closing = new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
      server.closeAllConnections();
      await closing;
    }
    clients.clear();
    await prisma.task.deleteMany({ where: { projectId: ids.project } });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.domainEvent.deleteMany({ where: { OR: [{ userIds: { hasSome: userIds } }, { workspaceIds: { hasSome: workspaceIds } }, { projectId: ids.project }] } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  async function openStream(token: string, lastEventId?: string) {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/events`, {
      headers: { Authorization: `Bearer ${token}`, ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}) },
      signal: controller.signal,
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let body = '';
    let done = false;
    const pump = (async () => {
      try {
        while (!done) {
          const chunk = await reader.read();
          if (chunk.done) break;
          body += decoder.decode(chunk.value, { stream: true });
        }
      } catch {
        // aborted
      }
    })();
    await waitFor(() => body.includes('event: connected'));
    return {
      text: () => body,
      close: async () => {
        done = true;
        controller.abort();
        await pump;
      },
    };
  }

  it('streams a task update to the owner but not to a denied team member, live and on replay', async () => {
    const before = await prisma.domainEvent.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
    const owner = await openStream(tokens.owner);
    const denied = await openStream(tokens.denied);
    const marker = `eh-${randomUUID()}`;
    const patch = await http().patch(`/api/tasks/${ids.task}`).set('Authorization', `Bearer ${tokens.owner}`).send({ description: marker });
    expect(patch.status).toBe(200);
    await waitFor(() => owner.text().includes(marker));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(denied.text()).not.toContain(marker);
    await owner.close();
    await denied.close();

    const cursor = (before?.id ?? 0n).toString();
    const ownerReplay = await openStream(tokens.owner, cursor);
    const deniedReplay = await openStream(tokens.denied, cursor);
    await waitFor(() => ownerReplay.text().includes(marker));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(deniedReplay.text()).not.toContain(marker);
    await ownerReplay.close();
    await deniedReplay.close();
  });
});
