/**
 * W19b / FE-13 project knowledge: people write (active at once), agents
 * (PATs) only propose; approving, retracting, restoring and editing active
 * entries need a person; every change is a revision with optimistic
 * concurrency; sources are provenance (the task must be in the project and
 * not sealed); quota; what a run is given (active, unexpired, conventions
 * first, bounded) and that it is sealed into the execution snapshot.
 *
 * Real PostgreSQL (TEST_DATABASE_URL); fixtures delete only what they create.
 */
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@openlinear/db';
import { createApp } from '../app';
import { isSealedTask, MAX_KNOWLEDGE_PER_PROJECT, MAX_OPEN_PROPOSALS, PROMPT_CHARS, promptKnowledge } from '../services/knowledge';
import { createPat } from './auth-helpers';
import { testJwtSecret } from './test-env';
import { useTestServer } from './http';

const RUN = randomUUID().slice(0, 8);
const http = useTestServer(() => createApp());
const ids = { users: [] as string[], workspaces: [] as string[], projects: [] as string[] };
const tokens = { owner: '', viewer: '', stranger: '', agent: '' };
let projectId = '';
let otherProjectId = '';
let taskId = '';
let sealedTaskId = '';
let otherTaskId = '';

type Body = Record<string, unknown>;
const as = (token: string) => ({ Authorization: `Bearer ${token}` });

async function create(body: Body, token = tokens.owner, project = projectId) {
  return http().post(`/api/projects/${project}/knowledge`).set(as(token)).send(body);
}

beforeAll(async () => {
  const owner = await prisma.user.create({ data: { username: `w19b-${RUN}`, email: `w19b-${RUN}@example.com` } });
  const viewer = await prisma.user.create({ data: { username: `w19b-v-${RUN}`, email: `w19b-v-${RUN}@example.com` } });
  const stranger = await prisma.user.create({ data: { username: `w19b-x-${RUN}`, email: `w19b-x-${RUN}@example.com` } });
  ids.users.push(owner.id, viewer.id, stranger.id);
  for (const [key, user] of [['owner', owner], ['viewer', viewer], ['stranger', stranger]] as const) {
    tokens[key] = jwt.sign({ userId: user.id, username: user.username }, testJwtSecret(), { expiresIn: '1h' });
  }
  tokens.agent = (await createPat(owner.id, ['tasks:read', 'tasks:write'], { name: 'w19b-agent' })).token;
  const workspace = await prisma.workspace.create({ data: { name: `W19b ${RUN}`, slug: `w19b-${RUN}` } });
  ids.workspaces.push(workspace.id);
  await prisma.workspaceMember.createMany({ data: [
    { workspaceId: workspace.id, userId: owner.id, role: 'owner' },
    { workspaceId: workspace.id, userId: viewer.id, role: 'member' },
  ] });
  const project = await prisma.project.create({ data: { name: `Knowledge ${RUN}`, workspaceId: workspace.id, key: `KN${RUN.slice(0, 3).toUpperCase()}` } });
  const other = await prisma.project.create({ data: { name: `Other ${RUN}`, workspaceId: workspace.id, key: `KO${RUN.slice(0, 3).toUpperCase()}` } });
  projectId = project.id;
  otherProjectId = other.id;
  ids.projects.push(project.id, other.id);
  await prisma.projectAccess.create({ data: { projectId, userId: viewer.id, permission: 'view' } });
  const team = await prisma.team.create({ data: { name: `W19b ${RUN}`, key: `KT${RUN.slice(0, 2).toUpperCase()}`, projectId } });
  await prisma.teamMember.create({ data: { teamId: team.id, userId: owner.id, role: 'owner' } });
  taskId = (await prisma.task.create({ data: { title: 'Source task', projectId, teamId: team.id, creatorId: owner.id } })).id;
  const sealedLabel = await prisma.label.create({ data: { name: 'eval:sealed', color: '#000000', projectId } });
  sealedTaskId = (await prisma.task.create({ data: { title: 'Holdout', projectId, teamId: team.id, creatorId: owner.id, labels: { create: { labelId: sealedLabel.id } } } })).id;
  otherTaskId = (await prisma.task.create({ data: { title: 'Elsewhere', projectId: otherProjectId, creatorId: owner.id } })).id;
});

afterAll(async () => {
  await prisma.executionAttempt.deleteMany({ where: { taskId: { in: [taskId, sealedTaskId, otherTaskId] } } });
  await prisma.activityLog.deleteMany({ where: { userId: { in: ids.users } } });
  await prisma.domainEventOutbox.deleteMany({ where: { OR: [{ userIds: { hasSome: ids.users } }, { workspaceIds: { hasSome: ids.workspaces } }] } });
  await prisma.domainEvent.deleteMany({ where: { OR: [{ userIds: { hasSome: ids.users } }, { workspaceIds: { hasSome: ids.workspaces } }] } });
  await prisma.idempotencyRecord.deleteMany({ where: { workspaceId: { in: ids.workspaces } } });
  await prisma.task.deleteMany({ where: { projectId: { in: ids.projects } } });
  await prisma.project.deleteMany({ where: { id: { in: ids.projects } } });
  await prisma.workspace.deleteMany({ where: { id: { in: ids.workspaces } } });
  await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
});

describe('W19b project knowledge', () => {
  it('a person\'s entry is active at once; an agent\'s is a proposal only a person can approve', async () => {
    const mine = await create({ kind: 'convention', title: 'Use pnpm', body: 'Never npm or yarn.' });
    expect(mine.status).toBe(201);
    expect(mine.body).toMatchObject({ status: 'active', source: 'user', version: 1, kind: 'convention', expired: false });
    expect(mine.body.approvedById).toBe(ids.users[0]);

    const proposal = await create({ title: 'Tests live next to code', body: 'Put foo.test.ts beside foo.ts.' }, tokens.agent);
    expect(proposal.status).toBe(201);
    expect(proposal.body).toMatchObject({ status: 'proposed', source: 'agent', approvedById: null });
    const id = proposal.body.id as string;

    // The agent may refine its own proposal, but not approve, retract or restore.
    const refined = await http().patch(`/api/knowledge/${id}`).set(as(tokens.agent)).send({ baseVersion: 1, body: 'Put foo.test.ts next to foo.ts.' });
    expect(refined.body).toMatchObject({ status: 'proposed', version: 2 });
    expect((await http().post(`/api/knowledge/${id}/approve`).set(as(tokens.agent)).send({ version: 2 })).body.code).toBe('KNOWLEDGE_PEOPLE_ONLY');
    expect((await http().post(`/api/knowledge/${id}/retract`).set(as(tokens.agent)).send({ reason: 'nope' })).body.code).toBe('KNOWLEDGE_PEOPLE_ONLY');

    // Approval is of the latest revision only.
    expect((await http().post(`/api/knowledge/${id}/approve`).set(as(tokens.owner)).send({ version: 1 })).body).toMatchObject({ code: 'KNOWLEDGE_VERSION_CONFLICT', details: { latest: 2 } });
    const approved = await http().post(`/api/knowledge/${id}/approve`).set(as(tokens.owner)).send({ version: 2 });
    expect(approved.body).toMatchObject({ status: 'active', version: 3, approvedById: ids.users[0] });
    expect((await http().post(`/api/knowledge/${id}/approve`).set(as(tokens.owner)).send({ version: 3 })).body.code).toBe('KNOWLEDGE_NOT_PROPOSED');
    // Now active: the agent can no longer change it.
    expect((await http().patch(`/api/knowledge/${id}`).set(as(tokens.agent)).send({ baseVersion: 3, title: 'Changed' })).body.code).toBe('KNOWLEDGE_PEOPLE_ONLY');
  });

  it('edits are revisions based on the latest; retract keeps the history; restore brings it back', async () => {
    const created = await create({ title: 'Deploy on Fridays', body: 'Never.' });
    const id = created.body.id as string;
    const edited = await http().patch(`/api/knowledge/${id}`).set(as(tokens.owner)).send({ baseVersion: 1, title: 'No deploys on Fridays', kind: 'procedure' });
    expect(edited.body).toMatchObject({ version: 2, title: 'No deploys on Fridays', kind: 'procedure', status: 'active' });
    expect((await http().patch(`/api/knowledge/${id}`).set(as(tokens.owner)).send({ baseVersion: 1, body: 'stale' })).body).toMatchObject({ code: 'KNOWLEDGE_VERSION_CONFLICT', details: { latest: 2 } });

    const retracted = await http().post(`/api/knowledge/${id}/retract`).set(as(tokens.owner)).send({ reason: 'We deploy continuously now' });
    expect(retracted.body).toMatchObject({ status: 'retracted', version: 3, retractReason: 'We deploy continuously now' });
    expect((await http().patch(`/api/knowledge/${id}`).set(as(tokens.owner)).send({ baseVersion: 3, body: 'x' })).body.code).toBe('KNOWLEDGE_RETRACTED');
    const restored = await http().post(`/api/knowledge/${id}/restore`).set(as(tokens.owner));
    expect(restored.body).toMatchObject({ status: 'active', version: 4, retractedAt: null, retractReason: null });

    const detail = await http().get(`/api/knowledge/${id}`).set(as(tokens.viewer));
    expect(detail.status).toBe(200);
    expect((detail.body.versions as Array<{ version: number; change: string; title: string; note: string | null }>).map((version) => [version.version, version.change, version.title, version.note])).toEqual([
      [4, 'restored', 'No deploys on Fridays', null],
      [3, 'retracted', 'No deploys on Fridays', 'We deploy continuously now'],
      [2, 'edited', 'No deploys on Fridays', null],
      [1, 'created', 'Deploy on Fridays', null],
    ]);
  });

  it('access: viewers read, cannot write; strangers see nothing', async () => {
    expect((await http().get(`/api/projects/${projectId}/knowledge`).set(as(tokens.viewer))).status).toBe(200);
    expect((await create({ title: 'x', body: 'y' }, tokens.viewer)).status).toBe(403);
    const stranger = await http().get(`/api/projects/${projectId}/knowledge`).set(as(tokens.stranger));
    expect([403, 404]).toContain(stranger.status);
    const list = await http().get(`/api/projects/${projectId}/knowledge?status=proposed`).set(as(tokens.owner));
    expect((list.body.entries as Array<{ status: string }>).every((entry) => entry.status === 'proposed')).toBe(true);
  });

  it('provenance: the source task must be in the project and must not be sealed', async () => {
    expect(isSealedTask(['bug', 'Eval:Sealed'])).toBe(true);
    expect(isSealedTask(['bug'])).toBe(false);
    const fromFinding = await create({ title: 'Guard division', body: 'Check b !== 0 before dividing.', sourceRef: { taskId, reviewId: 'rev-1', findingId: 'f1', commit: 'abcdef1' } });
    expect(fromFinding.body).toMatchObject({ status: 'active', source: 'review_finding', sourceRef: { taskId, reviewId: 'rev-1', findingId: 'f1', commit: 'abcdef1' } });
    expect((await create({ title: 'x', body: 'y', sourceRef: { taskId: sealedTaskId } })).body.code).toBe('KNOWLEDGE_SEALED_SOURCE');
    expect((await create({ title: 'x', body: 'y', sourceRef: { taskId: otherTaskId } })).body.code).toBe('KNOWLEDGE_SOURCE_INVALID');
    expect((await create({ title: 'x', body: 'y', sourceRef: { taskId, secret: 'no' } })).status).toBe(400);
  });

  it('what a run is given: active and unexpired, conventions then procedures then notes, within the budget', async () => {
    const project = await prisma.project.create({ data: { name: `Prompt ${RUN}`, workspaceId: ids.workspaces[0], key: `KP${RUN.slice(0, 3).toUpperCase()}` } });
    ids.projects.push(project.id);
    const base = { projectId: project.id, source: 'user', createdById: ids.users[0], updatedById: ids.users[0] };
    await prisma.knowledgeEntry.createMany({ data: [
      { ...base, kind: 'note', title: 'A note', body: 'n', status: 'active' },
      { ...base, kind: 'procedure', title: 'A procedure', body: 'p', status: 'active' },
      { ...base, kind: 'convention', title: 'A convention', body: 'c', status: 'active' },
      { ...base, kind: 'convention', title: 'Proposed', body: 'x', status: 'proposed' },
      { ...base, kind: 'convention', title: 'Retracted', body: 'x', status: 'retracted', retractedAt: new Date(), retractedById: ids.users[0] },
      { ...base, kind: 'convention', title: 'Expired', body: 'x', status: 'active', expiresAt: new Date(Date.now() - 1_000) },
      { ...base, kind: 'note', title: 'Big 1', body: 'b'.repeat(PROMPT_CHARS / 2 - 10), status: 'active' },
      { ...base, kind: 'note', title: 'Big 2', body: 'b'.repeat(PROMPT_CHARS / 2 - 10), status: 'active' },
      { ...base, kind: 'note', title: 'Big 3', body: 'b'.repeat(PROMPT_CHARS / 2 - 10), status: 'active' },
    ] });
    const given = await promptKnowledge(project.id);
    const titles = given.map((entry) => entry.title);
    // Kinds first; then notes until the character budget: only one big note fits.
    expect(titles.slice(0, 2)).toEqual(['A convention', 'A procedure']);
    expect(titles).toHaveLength(4);
    expect(titles).toContain('A note');
    expect(titles.filter((title) => title.startsWith('Big'))).toHaveLength(1);
    expect(given.reduce((sum, entry) => sum + entry.title.length + entry.body.length, 0)).toBeLessThanOrEqual(PROMPT_CHARS);
    expect(await promptKnowledge(null)).toEqual([]);
  });

  it('is sealed into the execution snapshot when a run starts', async () => {
    const started = await http().post('/api/executions/attempts').set(as(tokens.owner)).send({ taskId });
    expect(started.status).toBe(201);
    const knowledge = started.body.snapshot.knowledge as Array<{ title: string; version: number; kind: string }>;
    expect(knowledge.map((entry) => entry.title)).toEqual(expect.arrayContaining(['Use pnpm', 'Tests live next to code', 'No deploys on Fridays', 'Guard division']));
    expect(knowledge[0]?.kind).toBe('convention');
  });

  it('review fixes: agents edit only their own user\'s agent proposals; a restored rejection is a proposal again; open proposals are capped', async () => {
    const otherToken = (await createPat(ids.users[1] ?? '', ['tasks:read', 'tasks:write'], { name: 'w19b-other-agent' })).token;
    await prisma.projectAccess.update({ where: { projectId_userId: { projectId, userId: ids.users[1] ?? '' } }, data: { permission: 'full' } });
    const mine = await create({ title: 'Agent idea', body: 'Something' }, tokens.agent);
    expect((await http().patch(`/api/knowledge/${mine.body.id as string}`).set(as(otherToken)).send({ baseVersion: 1, body: 'Hijacked' })).body.code).toBe('KNOWLEDGE_PEOPLE_ONLY');
    await prisma.projectAccess.update({ where: { projectId_userId: { projectId, userId: ids.users[1] ?? '' } }, data: { permission: 'view' } });

    const rejected = await http().post(`/api/knowledge/${mine.body.id as string}/retract`).set(as(tokens.owner)).send({ reason: 'Not a rule' });
    expect(rejected.body.status).toBe('retracted');
    const restored = await http().post(`/api/knowledge/${mine.body.id as string}/restore`).set(as(tokens.owner));
    expect(restored.body).toMatchObject({ status: 'proposed', approvedById: null });

    const project = await prisma.project.create({ data: { name: `Proposals ${RUN}`, workspaceId: ids.workspaces[0], key: `KR${RUN.slice(0, 3).toUpperCase()}` } });
    ids.projects.push(project.id);
    await prisma.knowledgeEntry.createMany({ data: Array.from({ length: MAX_OPEN_PROPOSALS }, (_, index) => ({
      projectId: project.id, title: `Proposal ${index}`, body: 'x', status: 'proposed', source: 'agent', createdById: ids.users[0], updatedById: ids.users[0],
    })) });
    expect((await create({ title: 'One more idea', body: 'x' }, tokens.agent, project.id)).body.code).toBe('KNOWLEDGE_PROPOSALS_FULL');
    expect((await create({ title: 'A person still can', body: 'x' }, tokens.owner, project.id)).status).toBe(201);
  });

  it('quota: at most MAX_KNOWLEDGE_PER_PROJECT entries that are not retracted', async () => {
    const project = await prisma.project.create({ data: { name: `Quota ${RUN}`, workspaceId: ids.workspaces[0], key: `KQ${RUN.slice(0, 3).toUpperCase()}` } });
    ids.projects.push(project.id);
    await prisma.knowledgeEntry.createMany({ data: Array.from({ length: MAX_KNOWLEDGE_PER_PROJECT }, (_, index) => ({
      projectId: project.id, title: `Entry ${index}`, body: 'x', status: 'active', source: 'user', createdById: ids.users[0], updatedById: ids.users[0],
    })) });
    const over = await create({ title: 'One more', body: 'x' }, tokens.owner, project.id);
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({ code: 'KNOWLEDGE_QUOTA_EXCEEDED', details: { limit: MAX_KNOWLEDGE_PER_PROJECT } });
  });
});
