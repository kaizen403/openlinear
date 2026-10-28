/**
 * W14 `GET /api/tasks`: filters (status[], labelId, q, identifier, parentId,
 * assignee=none), keyset pagination with a stable order (incl. concurrent
 * inserts and timestamp ties), the unchanged default response shape, and
 * the id-set visibility rule.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, type Status } from '@openlinear/db';
import { createApp } from '../app';
import { createPat, createTestSession, makeUser, type TestUser } from './auth-helpers';
import { useTestServer } from './http';

const RUN = randomUUID().slice(0, 8);
const http = useTestServer(() => createApp());

interface ListItem {
  id: string;
  title: string;
  createdAt: string;
  status: Status;
  executionLogs?: unknown;
}

const fx = {
  workspace: '', otherWorkspace: '', project: '', project2: '', otherProject: '', deniedProject: '',
  team: '', team2: '', otherTeam: '', deniedTeam: '',
  labelA: '', labelB: '', parent: '',
};
let owner: TestUser;
let member: TestUser;
let stranger: TestUser;
let ownerJwt = '';
const ids: Record<string, string> = {};
let numberSeq = 1;

const BASE = Date.UTC(2026, 0, 1);
const at = (minutes: number) => new Date(BASE + minutes * 60_000);

async function task(input: {
  title: string;
  minutes: number;
  projectId?: string | null;
  teamId?: string | null;
  status?: Status;
  description?: string;
  assigneeId?: string | null;
  parentId?: string | null;
  creatorId?: string;
  archived?: boolean;
  labelIds?: string[];
  identifier?: string;
}): Promise<string> {
  const number = 10_000 + numberSeq++;
  const row = await prisma.task.create({
    data: {
      title: input.title,
      description: input.description,
      status: input.status ?? 'todo',
      projectId: input.projectId === undefined ? fx.project : input.projectId,
      teamId: input.teamId === undefined ? fx.team : input.teamId,
      number,
      identifier: input.identifier ?? `LST${RUN.slice(0, 3).toUpperCase()}-${number}`,
      assigneeId: input.assigneeId ?? null,
      parentId: input.parentId ?? null,
      creatorId: input.creatorId ?? owner.id,
      archived: input.archived ?? false,
      createdAt: at(input.minutes),
      labels: input.labelIds?.length ? { create: input.labelIds.map((labelId) => ({ labelId })) } : undefined,
    },
    select: { id: true },
  });
  ids[input.title] = row.id;
  return row.id;
}

const list = (query: string, token = ownerJwt) =>
  http().get(`/api/tasks${query ? `?${query}` : ''}`).set('Authorization', `Bearer ${token}`);

function titles(items: ListItem[]): string[] {
  return items.map((item) => item.title);
}

beforeAll(async () => {
  owner = await makeUser('lst-owner', RUN);
  member = await makeUser('lst-member', RUN);
  stranger = await makeUser('lst-stranger', RUN);
  ownerJwt = (await createTestSession(owner)).accessToken;

  const workspace = await prisma.workspace.create({ data: { name: `List ${RUN}`, slug: `lst-${RUN}` } });
  const other = await prisma.workspace.create({ data: { name: `List other ${RUN}`, slug: `lst-o-${RUN}` } });
  fx.workspace = workspace.id;
  fx.otherWorkspace = other.id;
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: workspace.id, userId: owner.id, role: 'owner' },
      { workspaceId: workspace.id, userId: member.id, role: 'member' },
      { workspaceId: other.id, userId: stranger.id, role: 'owner' },
    ],
  });
  const mkProject = async (key: string, workspaceId: string, memberIds: string[]) => {
    const project = await prisma.project.create({ data: { name: `${key} ${RUN}`, key, workspaceId } });
    const team = await prisma.team.create({
      data: { name: `${key} team`, key, projectId: project.id, members: { create: memberIds.map((userId, index) => ({ userId, role: index === 0 ? 'owner' as const : 'member' as const })) } },
    });
    return { project: project.id, team: team.id };
  };
  ({ project: fx.project, team: fx.team } = await mkProject('LSTA', workspace.id, [owner.id, member.id]));
  ({ project: fx.project2, team: fx.team2 } = await mkProject('LSTB', workspace.id, [owner.id]));
  ({ project: fx.deniedProject, team: fx.deniedTeam } = await mkProject('LSTD', workspace.id, [owner.id]));
  ({ project: fx.otherProject, team: fx.otherTeam } = await mkProject('LSTO', other.id, [stranger.id]));
  await prisma.projectAccess.create({ data: { projectId: fx.deniedProject, userId: owner.id, permission: 'deny' } });

  fx.labelA = (await prisma.label.create({ data: { name: 'alpha', color: '#111111', projectId: fx.project } })).id;
  fx.labelB = (await prisma.label.create({ data: { name: 'beta', color: '#222222', projectId: fx.project } })).id;

  fx.parent = await task({ title: 'parent', minutes: 1, status: 'in_progress', assigneeId: owner.id, labelIds: [fx.labelA] });
  await task({ title: 'child-1', minutes: 2, parentId: fx.parent, assigneeId: member.id });
  await task({ title: 'child-2', minutes: 3, parentId: fx.parent, status: 'done', labelIds: [fx.labelB] });
  await task({ title: 'Billing webhook', minutes: 4, description: 'Stripe retries', status: 'done' });
  await task({ title: 'percent', minutes: 5, description: 'discount 100% off' });
  await task({ title: 'cancelled one', minutes: 6, status: 'cancelled', labelIds: [fx.labelA, fx.labelB] });
  await task({ title: 'archived one', minutes: 7, archived: true });
  // Three tasks with the same createdAt: order falls back to id DESC.
  await task({ title: 'tie-a', minutes: 8 });
  await task({ title: 'tie-b', minutes: 8 });
  await task({ title: 'tie-c', minutes: 8 });
  await task({ title: 'p2 task', minutes: 9, projectId: fx.project2, teamId: fx.team2 });
  await task({ title: 'team-only', minutes: 10, projectId: null, teamId: fx.team });
  await task({ title: 'my orphan', minutes: 11, projectId: null, teamId: null });
  await task({ title: 'denied task', minutes: 12, projectId: fx.deniedProject, teamId: fx.deniedTeam });
  await task({ title: 'other tenant', minutes: 13, projectId: fx.otherProject, teamId: fx.otherTeam, creatorId: stranger.id });
  await task({ title: "stranger's orphan", minutes: 14, projectId: null, teamId: null, creatorId: stranger.id });
});

afterAll(async () => {
  const userIds = [owner.id, member.id, stranger.id];
  await prisma.task.deleteMany({ where: { OR: [{ project: { workspaceId: { in: [fx.workspace, fx.otherWorkspace] } } }, { creatorId: { in: userIds } }] } });
  await prisma.project.deleteMany({ where: { workspaceId: { in: [fx.workspace, fx.otherWorkspace] } } });
  await prisma.workspace.deleteMany({ where: { id: { in: [fx.workspace, fx.otherWorkspace] } } });
  await prisma.personalAccessToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

describe('GET /api/tasks default (offset) mode', () => {
  it('keeps the original response shape, adds nextCursor, orders by createdAt DESC then id DESC', async () => {
    const res = await list(`projectId=${fx.project}&pageSize=200`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['hasMore', 'items', 'nextCursor', 'page', 'pageSize', 'total']);
    expect(res.body).toMatchObject({ page: 1, pageSize: 200, hasMore: false, nextCursor: null });
    const items: ListItem[] = res.body.items;
    expect(res.body.total).toBe(items.length);
    const ties = [ids['tie-a'], ids['tie-b'], ids['tie-c']].sort().reverse();
    expect(items.slice(0, 3).map((item) => item.id)).toEqual(ties);
    expect(titles(items)).not.toContain('archived one');
    for (let i = 1; i < items.length; i += 1) {
      const prev = items[i - 1];
      const cur = items[i];
      const ordered = prev.createdAt > cur.createdAt || (prev.createdAt === cur.createdAt && prev.id > cur.id);
      expect(ordered, `${prev.title} before ${cur.title}`).toBe(true);
    }
    expect(items[0]).toHaveProperty('executionLogs');
  });

  it('returns a nextCursor on a partial offset page that continues in keyset mode', async () => {
    const all: ListItem[] = (await list(`projectId=${fx.project}&pageSize=200`)).body.items;
    const first = await list(`projectId=${fx.project}&pageSize=4`);
    expect(first.body.hasMore).toBe(true);
    expect(typeof first.body.nextCursor).toBe('string');
    const next = await list(`projectId=${fx.project}&pageSize=4&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(next.status).toBe(200);
    expect(titles(next.body.items)).toEqual(titles(all.slice(4, 8)));
  });
});

describe('GET /api/tasks filters', () => {
  it('status accepts repeated and comma-separated values', async () => {
    const comma = await list(`projectId=${fx.project}&status=done,cancelled`);
    const repeated = await list(`projectId=${fx.project}&status=done&status=cancelled`);
    expect(comma.status).toBe(200);
    expect(titles(comma.body.items).sort()).toEqual(['Billing webhook', 'cancelled one', 'child-2']);
    expect(titles(repeated.body.items).sort()).toEqual(titles(comma.body.items).sort());
    expect((await list(`projectId=${fx.project}&status=bogus`)).status).toBe(400);
  });

  it('labelId matches tasks having any of the labels', async () => {
    const one = await list(`projectId=${fx.project}&labelId=${fx.labelB}`);
    expect(titles(one.body.items).sort()).toEqual(['cancelled one', 'child-2']);
    const any = await list(`labelId=${fx.labelA},${fx.labelB}`);
    expect(titles(any.body.items).sort()).toEqual(['cancelled one', 'child-2', 'parent']);
  });

  it('q matches title, description or identifier, case-insensitively, with literal % and _', async () => {
    expect(titles((await list('q=BILLING')).body.items)).toEqual(['Billing webhook']);
    expect(titles((await list('q=stripe')).body.items)).toEqual(['Billing webhook']);
    const identifier = (await prisma.task.findUniqueOrThrow({ where: { id: ids.percent } })).identifier ?? '';
    expect(titles((await list(`q=${encodeURIComponent(identifier.toLowerCase())}`)).body.items)).toContain('percent');
    expect(titles((await list(`q=${encodeURIComponent('100%')}`)).body.items)).toEqual(['percent']);
    expect(titles((await list(`q=${encodeURIComponent('1_0')}`)).body.items)).toEqual([]);
  });

  it('identifier is an exact, case-insensitive match (never ENG-120) within the caller visibility', async () => {
    // Identifiers are unique per team only: the same one in a denied project
    // and in another tenant must not leak. Created here (and removed) so the
    // other tests' fixtures stay as they are.
    const prefix = `IDX${RUN.slice(0, 4).toUpperCase()}`;
    const exact = `${prefix}-12`;
    const created = [
      await task({ title: 'ident exact', minutes: 20, identifier: exact }),
      await task({ title: 'ident longer', minutes: 21, identifier: `${prefix}-120` }),
      await task({ title: 'ident denied', minutes: 22, identifier: exact, projectId: fx.deniedProject, teamId: fx.deniedTeam }),
      await task({ title: 'ident other tenant', minutes: 23, identifier: exact, projectId: fx.otherProject, teamId: fx.otherTeam, creatorId: stranger.id }),
    ];
    try {
      expect(titles((await list(`q=${exact}`)).body.items).sort()).toEqual(['ident exact', 'ident longer']);
      expect(titles((await list(`identifier=${exact}`)).body.items)).toEqual(['ident exact']);
      expect(titles((await list(`identifier=${exact.toLowerCase()}`)).body.items)).toEqual(['ident exact']);
      // The CLI's lookup request.
      const cli = await list(`q=${exact}&identifier=${exact}&view=compact&pagination=cursor&pageSize=100`);
      expect(cli.status).toBe(200);
      expect(titles(cli.body.items)).toEqual(['ident exact']);
      expect(cli.body.nextCursor).toBeNull();
      expect(titles((await list(`identifier=${prefix}-1`)).body.items)).toEqual([]);
      const strangerJwt = (await createTestSession(stranger)).accessToken;
      expect(titles((await list(`identifier=${exact}`, strangerJwt)).body.items)).toEqual(['ident other tenant']);
      for (const bad of ['ENG_12', '%25-12', 'ENG-', '-12', 'ENG-12x']) {
        expect((await list(`identifier=${bad}`)).status, bad).toBe(400);
      }
    } finally {
      await prisma.task.deleteMany({ where: { id: { in: created } } });
    }
  });

  it('parentId lists sub-issues; parentId=none lists top-level issues only', async () => {
    expect(titles((await list(`parentId=${fx.parent}`)).body.items).sort()).toEqual(['child-1', 'child-2']);
    const top = titles((await list(`projectId=${fx.project}&parentId=none&pageSize=200`)).body.items);
    expect(top).toContain('parent');
    expect(top).not.toContain('child-1');
  });

  it('assignee=none lists unassigned issues; assignee=me and a member id still work', async () => {
    const none = titles((await list(`projectId=${fx.project}&assignee=none&pageSize=200`)).body.items);
    expect(none).not.toContain('parent');
    expect(none).not.toContain('child-1');
    expect(none).toContain('Billing webhook');
    expect(titles((await list(`projectId=${fx.project}&assignee=me`)).body.items)).toEqual(['parent']);
    expect(titles((await list(`assignee=${member.id}`)).body.items)).toEqual(['child-1']);
  });

  it('combines filters as AND', async () => {
    const res = await list(`projectId=${fx.project}&status=done&labelId=${fx.labelB}&parentId=${fx.parent}`);
    expect(titles(res.body.items)).toEqual(['child-2']);
  });

  it('view=compact omits executionLogs', async () => {
    const res = await list(`projectId=${fx.project}&view=compact&pageSize=2`);
    expect(res.status).toBe(200);
    for (const item of res.body.items as ListItem[]) expect(item).not.toHaveProperty('executionLogs');
  });
});

describe('GET /api/tasks keyset pagination', () => {
  async function walk(query: string, pageSize: number): Promise<{ items: ListItem[]; pages: number }> {
    const items: ListItem[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await list(`${query}&pageSize=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : '&pagination=cursor'}`);
      expect(res.status, res.text).toBe(200);
      expect(res.body).not.toHaveProperty('total');
      expect(res.body).not.toHaveProperty('page');
      items.push(...res.body.items);
      cursor = res.body.nextCursor;
      expect(res.body.hasMore).toBe(cursor !== null);
      pages += 1;
    } while (cursor && pages < 50);
    return { items, pages };
  }

  it('walks every row exactly once in the offset order, splitting timestamp ties across pages', async () => {
    const all: ListItem[] = (await list(`projectId=${fx.project}&pageSize=200`)).body.items;
    // pageSize 2 puts a page boundary inside the three-way createdAt tie.
    const walked = await walk(`projectId=${fx.project}`, 2);
    expect(walked.items.map((item) => item.id)).toEqual(all.map((item) => item.id));
    expect(new Set(walked.items.map((item) => item.id)).size).toBe(walked.items.length);
  });

  it('includeTotal=true adds the total', async () => {
    const res = await list(`projectId=${fx.project}&pagination=cursor&pageSize=2&includeTotal=true`);
    expect(res.body.total).toBe((await list(`projectId=${fx.project}`)).body.total);
  });

  it('is stable under concurrent inserts: rows that existed are returned once, in order', async () => {
    const before: ListItem[] = (await list(`projectId=${fx.project}&pageSize=200`)).body.items;
    const seen: ListItem[] = [];
    let cursor: string | null = null;
    let round = 0;
    const inserted: string[] = [];
    do {
      const res = await list(`projectId=${fx.project}&pageSize=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : '&pagination=cursor'}`);
      seen.push(...res.body.items);
      cursor = res.body.nextCursor;
      // Other clients create issues between (and during) page requests.
      const writes = Array.from({ length: 3 }, (_, i) =>
        prisma.task.create({
          data: { title: `concurrent-${round}-${i}`, projectId: fx.project, teamId: fx.team, creatorId: owner.id },
          select: { id: true },
        }).then((row) => { inserted.push(row.id); }),
      );
      await Promise.all(writes);
      round += 1;
    } while (cursor && round < 50);

    const seenIds = seen.map((item) => item.id);
    expect(new Set(seenIds).size).toBe(seenIds.length);
    expect(seenIds.filter((id) => !inserted.includes(id))).toEqual(before.map((item) => item.id));
    await prisma.task.deleteMany({ where: { id: { in: inserted } } });
  });

  it('rejects malformed cursors and mixed pagination modes', async () => {
    const bad = await list(`projectId=${fx.project}&cursor=not-a-cursor`);
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INVALID_CURSOR');
    const forged = Buffer.from(JSON.stringify({ v: 1, c: 'yesterday', i: 'x' })).toString('base64url');
    expect((await list(`cursor=${forged}`)).body.code).toBe('INVALID_CURSOR');
    const first = await list(`projectId=${fx.project}&pageSize=2`);
    const withPage = await list(`projectId=${fx.project}&cursor=${encodeURIComponent(first.body.nextCursor)}&page=2`);
    expect(withPage.status).toBe(400);
    expect(withPage.body.code).toBe('PAGINATION_CONFLICT');
    expect((await list(`cursor=${encodeURIComponent(first.body.nextCursor)}&pagination=offset`)).body.code).toBe('PAGINATION_CONFLICT');
  });
});

describe('GET /api/tasks visibility (id-set form)', () => {
  it('lists visible projects, own team-only tasks and own orphans; never denied projects or other tenants', async () => {
    const visible = titles((await list('pageSize=200')).body.items);
    expect(visible).toEqual(expect.arrayContaining(['parent', 'p2 task', 'team-only', 'my orphan']));
    expect(visible).not.toContain('denied task');
    expect(visible).not.toContain('other tenant');
    expect(visible).not.toContain("stranger's orphan");
    expect(visible).not.toContain('archived one');
  });

  it('a workspace member without team membership sees workspace projects but not team-only tasks of other teams', async () => {
    const memberJwt = (await createTestSession(member)).accessToken;
    const visible = titles((await list('pageSize=200', memberJwt)).body.items);
    expect(visible).toEqual(expect.arrayContaining(['parent', 'p2 task']));
    expect(visible).toContain('team-only'); // member of fx.team
    expect(visible).not.toContain('my orphan');
  });

  it('a workspace-bound PAT sees only its workspace and no orphans', async () => {
    const pat = await createPat(owner.id, ['read'], { workspaceId: fx.workspace });
    const visible = titles((await list('pageSize=200', pat.token)).body.items);
    expect(visible).toContain('parent');
    expect(visible).not.toContain('my orphan');
    const strangerPat = await createPat(stranger.id, ['read'], { workspaceId: fx.otherWorkspace });
    const theirs = titles((await list('pageSize=200', strangerPat.token)).body.items);
    expect(theirs).toEqual(['other tenant']);
  });

  it('a denied project stays denied even when filtered explicitly', async () => {
    const res = await list(`projectId=${fx.deniedProject}`);
    expect(res.status).toBe(403);
  });
});
