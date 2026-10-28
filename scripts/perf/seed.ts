/**
 * Deterministic performance fixture (performance plan, Phase 0).
 *
 *   PERF_DATABASE_URL=postgresql://openlinear@127.0.0.1:5432/openlinear_perf_test pnpm perf:seed
 *   PERF_DATABASE_URL=... pnpm perf:seed --tokens-only     # re-mint bench credentials only
 *
 * Refuses any database that is not loopback and named *_test, then TRUNCATEs
 * every table in `public` (except `_prisma_migrations`) and inserts a
 * realistic multi-tenant dataset:
 *
 *   - 80 users; 3 workspaces (the bench principal's large primary workspace, a
 *     secondary one it is a member of, and a foreign tenant it cannot see);
 *   - 100 projects with Zipf-skewed sizes, 120 teams, labels, explicit
 *     project grants and denies;
 *   - PERF_TASKS tasks (default 50,000) with realistic status/priority/
 *     assignee/due-date/archive/inbox distributions, sub-tasks, team-only
 *     legacy tasks, persisted execution logs on some finished tasks;
 *   - about 2 comments, 8 activity rows, 0.7 agent runs per task; 13k
 *     notifications; about 10k chat messages; 20k MCP tool calls; audit rows.
 *
 * Same PERF_SEED + PERF_ANCHOR => byte-identical rows. PERF_ANCHOR (ISO date,
 * default: today 00:00 UTC) is "now" for the dataset, so 30-day usage windows
 * stay populated when the fixture is rebuilt later.
 *
 * Writes the fixture manifest (ids + freshly minted bench credentials) to
 * PERF_OUT_DIR (default $TMPDIR/openlinear-perf), never into the repository.
 */
import { performance } from 'node:perf_hooks';
import { prisma, type Prisma } from '../../packages/db/src/index.ts';
import { bindPerfDatabase } from './lib/safety.ts';
import {
  apportion,
  COMMON_SEARCH_TERM,
  paragraph,
  RARE_SEARCH_TERM,
  Rng,
  sentence,
  stableUuid,
  taskTitle,
  zipfWeights,
} from './lib/random.ts';
import { type BenchUser, type FixtureManifest, readManifest, writeManifest } from './lib/manifest.ts';
import { generateBenchSecret, generatePat, mintAccessToken, sha256Hex } from './lib/tokens.ts';

// The Prisma client is built lazily on first use, so binding here is in time.
const database = bindPerfDatabase();
// Seeding issues large multi-row INSERTs; keep the slow-query sink quiet.
process.env.OPENLINEAR_SLOW_QUERY_MS ??= 'off';

type TaskRow = Prisma.TaskCreateManyInput;

// ─── Configuration ───────────────────────────────────────────────────────────

const args = new Set(process.argv.slice(2));
const TOKENS_ONLY = args.has('--tokens-only');
const TASKS = Number.parseInt(process.env.PERF_TASKS ?? '50000', 10);
const SEED = Number.parseInt(process.env.PERF_SEED ?? '20261026', 10);
const ANCHOR = process.env.PERF_ANCHOR
  ? new Date(process.env.PERF_ANCHOR)
  : new Date(new Date().toISOString().slice(0, 10));
const TOKEN_TTL_SECONDS = Number.parseInt(process.env.PERF_TOKEN_TTL_SECONDS ?? String(12 * 3600), 10);
const BENCH_USERS = 16;

if (!Number.isInteger(TASKS) || TASKS < 5_000 || TASKS > 2_000_000) {
  throw new Error('PERF_TASKS must be an integer between 5,000 and 2,000,000');
}
if (Number.isNaN(ANCHOR.getTime())) throw new Error('PERF_ANCHOR is not a valid date');

const SCALE = TASKS / 50_000;
const DAY = 86_400_000;
const anchorMs = ANCHOR.getTime();
const rng = new Rng(SEED);
const at = (msBeforeAnchor: number) => new Date(anchorMs - Math.max(0, msBeforeAnchor));

function log(message: string): void {
  process.stdout.write(`[perf:seed] ${message}\n`);
}

// ─── Credentials ─────────────────────────────────────────────────────────────

async function mintCredentials(manifest: FixtureManifest): Promise<FixtureManifest> {
  const jwtSecret = generateBenchSecret();
  const tokenEncryptionKey = generateBenchSecret();
  const users = await prisma.user.findMany({
    where: { id: { in: manifest.benchUserIds } },
    select: { id: true, username: true, workspaceMemberships: { select: { workspaceId: true, role: true } } },
  });
  const byId = new Map(users.map((user) => [user.id, user]));
  const benchUsers: BenchUser[] = [];
  const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000);

  // Old bench sessions/PATs are dead once the secret changes; drop them.
  await prisma.session.deleteMany({ where: { userId: { in: manifest.benchUserIds } } });
  await prisma.personalAccessToken.deleteMany({ where: { userId: { in: manifest.benchUserIds } } });

  for (const id of manifest.benchUserIds) {
    const user = byId.get(id);
    if (!user) throw new Error(`bench user ${id} missing; re-run the full seed`);
    const accessToken = mintAccessToken({ secret: jwtSecret, userId: user.id, username: user.username, ttlSeconds: TOKEN_TTL_SECONDS });
    await prisma.session.create({
      data: { userId: user.id, tokenHash: sha256Hex(accessToken), deviceInfo: 'perf-bench', ipAddress: '127.0.0.1', expiresAt },
    });
    const role = user.workspaceMemberships.find((m) => m.workspaceId === manifest.workspaces.primary)?.role ?? 'member';
    benchUsers.push({ id: user.id, username: user.username, workspaceRole: role, accessToken });
  }

  const owner = manifest.benchUserIds[0];
  const pat = generatePat();
  await prisma.personalAccessToken.create({
    data: {
      userId: owner,
      name: 'perf-bench',
      tokenHash: sha256Hex(pat.token),
      tokenPrefix: pat.prefix,
      scopes: ['read', 'write'],
      expiresAt,
    },
  });

  return {
    ...manifest,
    credentials: {
      mintedAt: new Date().toISOString(),
      jwtSecret,
      tokenEncryptionKey,
      users: benchUsers,
      pat: { userId: owner, token: pat.token },
    },
  };
}

if (TOKENS_ONLY) {
  const manifest = readManifest(database.database);
  const path = writeManifest(database.database, await mintCredentials(manifest));
  log(`re-minted ${manifest.benchUserIds.length} bench sessions + 1 PAT; manifest ${path}`);
  await prisma.$disconnect();
  process.exit(0);
}

// ─── Wipe ────────────────────────────────────────────────────────────────────

const startedAt = performance.now();
log(`database ${database.label}; tasks=${TASKS} seed=${SEED} anchor=${ANCHOR.toISOString()}`);

const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
  SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
if (tables.length > 0) {
  const list = tables.map((t) => `"public"."${t.tablename.replace(/"/g, '""')}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}
log(`truncated ${tables.length} tables`);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const counts: Record<string, number> = {};

/** Rows per INSERT so one statement stays below Postgres' 65,535 bind parameters. */
function chunkSize(columns: number): number {
  return Math.max(100, Math.floor(30_000 / columns));
}

async function insertAll<T>(label: string, rows: T[], columns: number, insert: (chunk: T[]) => Promise<unknown>): Promise<void> {
  const size = chunkSize(columns);
  for (let i = 0; i < rows.length; i += size) {
    await insert(rows.slice(i, i + size));
  }
  counts[label] = (counts[label] ?? 0) + rows.length;
}

interface Flushable {
  flush(): Promise<void>;
}

/**
 * Buffered writer for the high-volume tables. A sink whose rows reference a
 * parent table flushes the parent's sink first, so foreign keys always hold.
 */
class Sink<T> implements Flushable {
  private buffer: T[] = [];
  private readonly size: number;
  constructor(
    private readonly label: string,
    columns: number,
    private readonly insert: (chunk: T[]) => Promise<unknown>,
    private readonly parent: Flushable | null = null,
  ) {
    this.size = chunkSize(columns);
  }

  async push(row: T): Promise<void> {
    this.buffer.push(row);
    if (this.buffer.length >= this.size) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    await this.parent?.flush();
    const chunk = this.buffer;
    this.buffer = [];
    await this.insert(chunk);
    counts[this.label] = (counts[this.label] ?? 0) + chunk.length;
  }
}

function between(rngLocal: Rng, from: Date, to: Date): Date {
  const a = from.getTime();
  const b = Math.max(a, to.getTime());
  return new Date(a + Math.floor(rngLocal.next() * (b - a)));
}

// ─── Users and workspaces ────────────────────────────────────────────────────

const USERS = 80;
const users = Array.from({ length: USERS }, (_, i) => {
  const username = i === 0 ? 'perf-owner' : i < BENCH_USERS ? `perf-bench-${i}` : `perf-user-${i}`;
  return {
    id: stableUuid('user', SEED, i),
    username,
    displayName: username.replace(/-/g, ' '),
    email: `${username}@perf.invalid`,
    createdAt: at(500 * DAY - i * 3_600_000),
    backupCodes: [] as string[],
  };
});
await insertAll('users', users, 6, (chunk) => prisma.user.createMany({ data: chunk }));

const benchUsers = users.slice(0, BENCH_USERS);
const benchUserIds = benchUsers.map((u) => u.id);
const owner = users[0];

type WsKey = 'A' | 'B' | 'C';
const workspaceIds: Record<WsKey, string> = {
  A: stableUuid('workspace', SEED, 'A'),
  B: stableUuid('workspace', SEED, 'B'),
  C: stableUuid('workspace', SEED, 'C'),
};
await prisma.workspace.createMany({
  data: [
    { id: workspaceIds.A, name: 'Acme (perf primary)', slug: `perf-acme-${SEED}`, plan: 'team', createdAt: at(480 * DAY) },
    { id: workspaceIds.B, name: 'Beta (perf secondary)', slug: `perf-beta-${SEED}`, createdAt: at(470 * DAY) },
    { id: workspaceIds.C, name: 'Gamma (perf foreign tenant)', slug: `perf-gamma-${SEED}`, createdAt: at(460 * DAY) },
  ],
});
counts.workspaces = 3;

const wsMembers: Record<WsKey, string[]> = {
  A: users.slice(0, 60).map((u) => u.id),
  B: [...users.slice(60, 70).map((u) => u.id), ...benchUserIds],
  C: users.slice(70, 80).map((u) => u.id),
};
const memberRows: Array<{ workspaceId: string; userId: string; role: 'owner' | 'admin' | 'member' | 'viewer'; joinedAt: Date }> = [];
users.slice(0, 60).forEach((u, i) => {
  memberRows.push({
    workspaceId: workspaceIds.A,
    userId: u.id,
    role: i === 0 ? 'owner' : i < BENCH_USERS ? 'admin' : i >= 56 ? 'viewer' : 'member',
    joinedAt: at(470 * DAY),
  });
});
users.slice(60, 70).forEach((u, i) => {
  memberRows.push({ workspaceId: workspaceIds.B, userId: u.id, role: i === 0 ? 'owner' : 'member', joinedAt: at(460 * DAY) });
});
for (const id of benchUserIds) memberRows.push({ workspaceId: workspaceIds.B, userId: id, role: 'member', joinedAt: at(400 * DAY) });
users.slice(70, 80).forEach((u, i) => {
  memberRows.push({ workspaceId: workspaceIds.C, userId: u.id, role: i === 0 ? 'owner' : 'member', joinedAt: at(450 * DAY) });
});
await insertAll('workspace_members', memberRows, 4, (chunk) => prisma.workspaceMember.createMany({ data: chunk }));

// ─── Projects, teams, labels ─────────────────────────────────────────────────

interface ProjectPlan {
  id: string;
  ws: WsKey;
  index: number;
  key: string;
  tasks: number;
  teams: Array<{ id: string; key: string; members: string[]; next: number }>;
  labelIds: string[];
}

const PROJECT_COUNTS: Record<WsKey, number> = { A: 80, B: 12, C: 8 };
const TEAM_ONLY_TASKS = Math.round(TASKS * 0.01);
const projectTasks = TASKS - TEAM_ONLY_TASKS;
const wsTaskTotals: Record<WsKey, number> = {
  A: Math.round(projectTasks * 0.8),
  B: Math.round(projectTasks * 0.1),
  C: 0,
};
wsTaskTotals.C = projectTasks - wsTaskTotals.A - wsTaskTotals.B;

const PROJECT_WORDS = ['Payments', 'Platform', 'Mobile', 'Search', 'Growth', 'Billing', 'Infra', 'Design', 'Data', 'Security', 'Onboarding', 'Insights'];
const projects: ProjectPlan[] = [];
let globalTeamIndex = 0;
for (const ws of ['A', 'B', 'C'] as const) {
  const sizes = apportion(wsTaskTotals[ws], zipfWeights(PROJECT_COUNTS[ws], 1.0));
  for (let j = 0; j < PROJECT_COUNTS[ws]; j += 1) {
    const id = stableUuid('project', SEED, ws, j);
    const teamCount = ws === 'A' && j < 20 ? 2 : 1;
    const teams = Array.from({ length: teamCount }, (_, k) => {
      const key = `K${globalTeamIndex}`;
      globalTeamIndex += 1;
      return { id: stableUuid('team', SEED, id, k), key, members: [] as string[], next: 1 };
    });
    projects.push({ id, ws, index: j, key: `${ws}${j}`, tasks: sizes[j], teams, labelIds: [] });
  }
}

await insertAll(
  'projects',
  projects.map((p) => ({
    id: p.id,
    workspaceId: workspaceIds[p.ws],
    key: p.key,
    name: `${rng.pick(PROJECT_WORDS)} ${rng.pick(PROJECT_WORDS).toLowerCase()} ${p.key}`,
    description: rng.chance(0.7) ? paragraph(rng, 60, 400) : null,
    status: rng.weighted([
      ['planned', 2],
      ['in_progress', 5],
      ['paused', 1],
      ['completed', 2],
      ['cancelled', 0.5],
    ] as const),
    leadId: rng.chance(0.8) ? rng.pick(wsMembers[p.ws]) : null,
    targetDate: rng.chance(0.5) ? new Date(anchorMs + rng.int(-60, 180) * DAY) : null,
    createdAt: at((420 + rng.int(0, 40)) * DAY),
    updatedAt: at(rng.int(0, 30) * DAY),
  })),
  12,
  (chunk) => prisma.project.createMany({ data: chunk }),
);

const HOT_PROJECTS = 10; // bench users belong to every team of A0..A9
const teamRows: Array<{ id: string; name: string; key: string; projectId: string; nextIssueNumber: number; createdAt: Date }> = [];
const teamMemberRows: Array<{ teamId: string; userId: string; role: 'owner' | 'admin' | 'member'; sortOrder: number }> = [];
for (const p of projects) {
  for (const team of p.teams) {
    const pool = wsMembers[p.ws].filter((id) => !benchUserIds.includes(id));
    const extra = rng.sample(pool, rng.int(4, 12));
    const benchJoins = p.ws === 'A' ? p.index < HOT_PROJECTS || rng.chance(0.6) : p.ws === 'B' ? rng.chance(0.5) : false;
    team.members = [...(benchJoins ? benchUserIds : []), ...extra];
    team.members.forEach((userId, sortOrder) => {
      const role = userId === owner.id ? 'owner' : benchUserIds.includes(userId) ? 'admin' : 'member';
      teamMemberRows.push({ teamId: team.id, userId, role, sortOrder });
    });
    teamRows.push({ id: team.id, name: `${p.key} ${team.key}`, key: team.key, projectId: p.id, nextIssueNumber: 1, createdAt: at(420 * DAY) });
  }
}
await insertAll('teams', teamRows, 6, (chunk) => prisma.team.createMany({ data: chunk }));
await insertAll('team_members', teamMemberRows, 4, (chunk) => prisma.teamMember.createMany({ data: chunk }));

const LABELS: Array<[string, string]> = [
  ['bug', '#ef4444'],
  ['feature', '#6366f1'],
  ['chore', '#64748b'],
  ['performance', '#f59e0b'],
  ['documentation', '#10b981'],
  ['security', '#dc2626'],
];
const labelRows: Array<{ id: string; projectId: string; name: string; color: string; priority: number }> = [];
for (const p of projects) {
  const names = [...LABELS];
  if (rng.chance(0.3)) names.push(['phase:1 — Discovery', '#0ea5e9'], ['phase:2 — Build', '#8b5cf6']);
  names.forEach(([name, color], priority) => {
    const id = stableUuid('label', p.id, name);
    p.labelIds.push(id);
    labelRows.push({ id, projectId: p.id, name, color, priority });
  });
}
await insertAll('labels', labelRows, 5, (chunk) => prisma.label.createMany({ data: chunk }));

// Explicit grants: a few denies and a view-only grant inside the primary workspace.
const accessRows: Array<{ projectId: string; userId: string; permission: 'full' | 'view' | 'deny' }> = [];
const primaryProjects = projects.filter((p) => p.ws === 'A');
for (const userId of wsMembers.A.slice(16, 21)) accessRows.push({ projectId: primaryProjects[5].id, userId, permission: 'deny' });
accessRows.push({ projectId: primaryProjects[3].id, userId: wsMembers.A[21], permission: 'view' });
accessRows.push({ projectId: primaryProjects[12].id, userId: wsMembers.A[22], permission: 'full' });
await insertAll('project_access', accessRows, 3, (chunk) => prisma.projectAccess.createMany({ data: chunk }));

// ─── Tasks and per-task children ─────────────────────────────────────────────

const STATUS_WEIGHTS = [
  ['todo', 30],
  ['in_progress', 12],
  ['done', 45],
  ['cancelled', 13],
] as const;
const PRIORITY_WEIGHTS = [
  ['low', 30],
  ['medium', 50],
  ['high', 20],
] as const;
const AGENTS = ['opencode', 'claude-code', 'codex'] as const;
const MODELS = ['anthropic/claude-sonnet-4-5', 'openai/gpt-5-codex', 'fireworks/kimi-k2'] as const;
const LOG_TYPES = ['info', 'agent', 'tool', 'tool', 'agent', 'success'] as const;

const taskSink = new Sink<TaskRow>('tasks', 30, (chunk) => prisma.task.createMany({ data: chunk }));
const taskLabelSink = new Sink<{ taskId: string; labelId: string }>('task_labels', 2, (chunk) => prisma.taskLabel.createMany({ data: chunk }), taskSink);
const taskAssigneeSink = new Sink<{ taskId: string; userId: string; role: 'assignee' | 'watcher'; createdAt: Date }>(
  'task_assignees',
  4,
  (chunk) => prisma.taskAssignee.createMany({ data: chunk }),
  taskSink,
);
const commentSink = new Sink<{ id: string; taskId: string; userId: string; body: string; createdAt: Date; updatedAt: Date }>(
  'comments',
  6,
  (chunk) => prisma.comment.createMany({ data: chunk }),
  taskSink,
);
type ActivityAction = 'task_created' | 'task_updated' | 'task_status_changed' | 'task_assigned' | 'comment_created';
const activitySink = new Sink<{
  taskId: string;
  projectId: string | null;
  teamId: string | null;
  userId: string;
  action: ActivityAction;
  payload: Prisma.InputJsonValue;
  createdAt: Date;
}>('activity_logs', 8, (chunk) => prisma.activityLog.createMany({ data: chunk }), taskSink);
const agentRunSink = new Sink<{
  taskId: string;
  userId: string;
  agent: string;
  runner: string;
  model: string;
  startedAt: Date;
  endedAt: Date;
  costUsd: string;
  costBasis: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  status: 'succeeded' | 'failed' | 'cancelled';
}>('agent_runs', 15, (chunk) => prisma.agentRun.createMany({ data: chunk }), taskSink);

interface TaskRef {
  id: string;
  projectIndex: number;
  ws: WsKey;
  status: string;
  archived: boolean;
  teamId: string;
}
const primaryTaskRefs: TaskRef[] = [];
const rarePlantEvery = Math.max(1, Math.floor(TASKS / 12));
let taskIndex = 0;
let identifierExample = '';

async function emitTask(p: ProjectPlan | null, team: ProjectPlan['teams'][number], ws: WsKey, recentInProject: string[]): Promise<void> {
  const i = taskIndex;
  taskIndex += 1;
  const id = stableUuid('task', SEED, i);
  const ageDays = 400 * rng.next() ** 1.7;
  const createdAt = at(ageDays * DAY);
  const status = rng.weighted(STATUS_WEIGHTS);
  const finished = status === 'done' || status === 'cancelled';
  const archived = rng.chance(finished ? 0.18 : 0.02);
  const updatedAt = between(rng, createdAt, new Date(Math.min(anchorMs, createdAt.getTime() + 30 * DAY)));
  const number = team.next;
  team.next += 1;
  const identifier = `${team.key}-${number}`;
  if (!identifierExample && p && p.ws === 'A' && p.index === 2 && number === 17) identifierExample = identifier;

  let title = taskTitle(rng);
  if (rng.chance(0.04)) title = `${title} ${COMMON_SEARCH_TERM}`;
  if (i % rarePlantEvery === 7) title = `${title} ${RARE_SEARCH_TERM}`;
  let description: string | null = rng.chance(0.7) ? paragraph(rng, 40, rng.chance(0.15) ? 4_000 : 800) : null;
  if (description && rng.chance(0.03)) description = `${description} ${COMMON_SEARCH_TERM} regression.`;

  const assigneeId = rng.chance(0.75) ? rng.pick(team.members) : null;
  const creatorId = rng.pick(team.members);
  const parentId = p && recentInProject.length > 0 && rng.chance(0.05) ? rng.pick(recentInProject) : null;

  const hasRuns = (status === 'done' || status === 'in_progress') && rng.chance(0.6);
  let executionLogs: Prisma.InputJsonValue | undefined;
  if (hasRuns && status === 'done' && rng.chance(0.25)) {
    const entries = rng.int(10, 40);
    executionLogs = Array.from({ length: entries }, (_, k) => ({
      timestamp: new Date(updatedAt.getTime() - (entries - k) * 4_000).toISOString(),
      type: rng.pick(LOG_TYPES),
      message: sentence(rng, 6, 30),
    }));
  }

  const row: TaskRow = {
    id,
    title,
    description,
    priority: rng.weighted(PRIORITY_WEIGHTS),
    status,
    createdAt,
    updatedAt,
    archived,
    inboxRead: finished ? rng.chance(0.75) : false,
    teamId: team.id,
    projectId: p?.id ?? null,
    workspaceId: p ? workspaceIds[ws] : null,
    number,
    identifier,
    dueDate: rng.chance(0.25) ? new Date(createdAt.getTime() + rng.int(1, 90) * DAY) : null,
    assigneeId,
    creatorId,
    parentId,
    ...(hasRuns && status === 'done'
      ? {
          prUrl: `https://github.com/perf-org/repo-${p?.index ?? 0}/pull/${number}`,
          outcome: paragraph(rng, 80, 300),
          executionElapsedMs: rng.int(30_000, 1_800_000),
        }
      : {}),
    ...(executionLogs !== undefined ? { executionLogs } : {}),
  };
  await taskSink.push(row);
  if (p) {
    recentInProject.push(id);
    if (recentInProject.length > 50) recentInProject.shift();
  }
  if (ws === 'A' && p) {
    primaryTaskRefs.push({ id, projectIndex: p.index, ws, status, archived, teamId: team.id });
  }

  // Labels.
  if (p) {
    const labelCount = rng.weighted([
      [0, 30],
      [1, 40],
      [2, 20],
      [3, 10],
    ] as const);
    for (const labelId of rng.sample(p.labelIds, labelCount)) await taskLabelSink.push({ taskId: id, labelId });
  }

  // Watchers / multi-assignees.
  if (rng.chance(0.15)) {
    for (const userId of rng.sample(team.members, rng.int(1, 2))) {
      await taskAssigneeSink.push({ taskId: id, userId, role: rng.chance(0.5) ? 'assignee' : 'watcher', createdAt });
    }
  }

  // Activity: created, status changes, updates, assignment.
  const activity = async (action: ActivityAction, payload: Prisma.InputJsonValue, when: Date) =>
    activitySink.push({ taskId: id, projectId: p?.id ?? null, teamId: team.id, userId: rng.pick(team.members), action, payload, createdAt: when });
  await activity('task_created', { title }, createdAt);
  const statusChanges = finished ? rng.int(1, 3) : status === 'in_progress' ? 1 : rng.int(0, 1);
  for (let k = 0; k < statusChanges; k += 1) {
    await activity('task_status_changed', { from: 'todo', to: status }, between(rng, createdAt, updatedAt));
  }
  const updates = rng.int(0, 3);
  for (let k = 0; k < updates; k += 1) await activity('task_updated', { fields: ['description'] }, between(rng, createdAt, updatedAt));
  if (assigneeId) await activity('task_assigned', { assigneeId }, between(rng, createdAt, updatedAt));

  // Comments (each also logs activity).
  const comments = rng.weighted([
    [0, 35],
    [1, 20],
    [2, 15],
    [3, 10],
    [4, 8],
    [6, 7],
    [10, 5],
  ] as const);
  for (let k = 0; k < comments; k += 1) {
    const when = between(rng, createdAt, new Date(Math.min(anchorMs, updatedAt.getTime() + 5 * DAY)));
    const author = rng.pick(team.members);
    await commentSink.push({ id: stableUuid('comment', SEED, i, k), taskId: id, userId: author, body: paragraph(rng, 20, 600), createdAt: when, updatedAt: when });
    await activity('comment_created', { commentId: stableUuid('comment', SEED, i, k) }, when);
  }

  // Agent runs (usage, analytics).
  if (hasRuns) {
    const runs = rng.int(1, 3);
    const windowStart = new Date(Math.max(createdAt.getTime(), anchorMs - 120 * DAY));
    for (let k = 0; k < runs; k += 1) {
      const startedAt = between(rng, windowStart, ANCHOR);
      const inputTokens = rng.int(2_000, 400_000);
      await agentRunSink.push({
        taskId: id,
        userId: assigneeId ?? creatorId,
        agent: rng.pick(AGENTS),
        runner: 'local',
        model: rng.pick(MODELS),
        startedAt,
        endedAt: new Date(startedAt.getTime() + rng.int(60, 1_200) * 1_000),
        costUsd: (inputTokens / 160_000 + rng.next() * 0.3).toFixed(6),
        costBasis: 'list_price',
        inputTokens,
        outputTokens: rng.int(500, 40_000),
        cachedInputTokens: rng.int(0, inputTokens),
        reasoningTokens: rng.int(0, 8_000),
        status: rng.weighted([
          ['succeeded', 80],
          ['failed', 15],
          ['cancelled', 5],
        ] as const),
      });
    }
  }
}

for (const p of projects) {
  const recent: string[] = [];
  for (let k = 0; k < p.tasks; k += 1) {
    await emitTask(p, p.teams[k % p.teams.length], p.ws, recent);
  }
}
// Legacy team-only tasks (no project) on primary-workspace teams.
const primaryTeams = projects.filter((p) => p.ws === 'A').flatMap((p) => p.teams);
for (let k = 0; k < TEAM_ONLY_TASKS; k += 1) {
  await emitTask(null, primaryTeams[k % primaryTeams.length], 'A', []);
}
for (const sink of [taskSink, taskLabelSink, taskAssigneeSink, commentSink, activitySink, agentRunSink]) {
  await sink.flush();
}
for (const p of projects) {
  for (const team of p.teams) {
    await prisma.team.update({ where: { id: team.id }, data: { nextIssueNumber: team.next } });
  }
}
log(`tasks and children done in ${((performance.now() - startedAt) / 1000).toFixed(1)}s`);

// ─── Notifications, chat, MCP, audit ─────────────────────────────────────────

const visiblePrimary = primaryTaskRefs.filter((t) => t.projectIndex !== 5);
const notificationSink = new Sink<{
  userId: string;
  type: 'mention' | 'assignment' | 'status_change' | 'comment';
  taskId: string;
  actorUserId: string;
  body: string;
  readAt: Date | null;
  createdAt: Date;
}>('notifications', 7, (chunk) => prisma.notification.createMany({ data: chunk }));
const notificationPlan: Array<[string, number]> = [
  [owner.id, Math.round(4_000 * SCALE)],
  ...benchUserIds.slice(1).map((id) => [id, Math.round(300 * SCALE)] as [string, number]),
  ...wsMembers.A.slice(BENCH_USERS).map((id) => [id, Math.round(100 * SCALE)] as [string, number]),
];
for (const [userId, n] of notificationPlan) {
  for (let k = 0; k < n; k += 1) {
    const createdAt = at(90 * DAY * rng.next() ** 1.5);
    await notificationSink.push({
      userId,
      type: rng.weighted([
        ['mention', 15],
        ['assignment', 30],
        ['status_change', 35],
        ['comment', 20],
      ] as const),
      taskId: rng.pick(visiblePrimary).id,
      actorUserId: rng.pick(wsMembers.A),
      body: sentence(rng, 5, 14),
      readAt: rng.chance(0.6) ? new Date(createdAt.getTime() + rng.int(1, 72) * 3_600_000) : null,
      createdAt,
    });
  }
}
await notificationSink.flush();

const chatSessionRows: Array<{ id: string; userId: string; workspaceId: string; projectId: string | null; title: string; createdAt: Date; updatedAt: Date }> = [];
const chatMessageSink = new Sink<{ id: string; sessionId: string; userId: string | null; role: 'user' | 'assistant'; content: string; createdAt: Date }>(
  'chat_messages',
  6,
  (chunk) => prisma.chatMessage.createMany({ data: chunk }),
);

const benchChatSessions: Record<string, string> = {};
const chatPlan: Array<[string, number, number, number]> = [
  // userId, sessions, min messages, max messages
  [owner.id, Math.max(5, Math.round(100 * SCALE)), 20, 120],
  ...benchUserIds.slice(1).map((id) => [id, Math.max(1, Math.round(5 * SCALE)), 10, 40] as [string, number, number, number]),
];
const pendingMessages: Array<{ sessionId: string; userId: string; count: number; start: Date }> = [];
for (const [userId, sessions, minMessages, maxMessages] of chatPlan) {
  for (let s = 0; s <= sessions; s += 1) {
    const id = stableUuid('chat-session', SEED, userId, s);
    const isBench = s === 0;
    const createdAt = at(rng.int(1, 120) * DAY);
    chatSessionRows.push({
      id,
      userId,
      workspaceId: workspaceIds.A,
      projectId: isBench ? null : rng.chance(0.5) ? rng.pick(primaryProjects.slice(0, HOT_PROJECTS)).id : null,
      title: isBench ? 'perf bench session' : sentence(rng, 2, 6),
      createdAt,
      updatedAt: new Date(createdAt.getTime() + DAY),
    });
    if (isBench) benchChatSessions[userId] = id;
    pendingMessages.push({ sessionId: id, userId, count: isBench ? 40 : rng.int(minMessages, maxMessages), start: createdAt });
  }
}
await insertAll('chat_sessions', chatSessionRows, 7, (chunk) => prisma.chatSession.createMany({ data: chunk }));
for (const { sessionId, userId, count, start } of pendingMessages) {
  for (let k = 0; k < count; k += 1) {
    const isUser = k % 2 === 0;
    await chatMessageSink.push({
      id: stableUuid('chat-message', sessionId, k),
      sessionId,
      userId: isUser ? userId : null,
      role: isUser ? 'user' : 'assistant',
      content: isUser ? sentence(rng, 5, 30) : paragraph(rng, 80, 1_200),
      createdAt: new Date(start.getTime() + k * 30_000),
    });
  }
}
await chatMessageSink.flush();

const TOOLS = ['openlinear_list_projects', 'openlinear_get_project', 'openlinear_create_issue', 'openlinear_update_issue', 'openlinear_bulk_create_plan'];
const mcpSink = new Sink<{ toolName: string; userId: string; success: boolean; error: string | null; createdAt: Date }>(
  'mcp_tool_calls',
  5,
  (chunk) => prisma.mcpToolCall.createMany({ data: chunk }),
);
for (let k = 0; k < Math.round(20_000 * SCALE); k += 1) {
  const success = rng.chance(0.95);
  await mcpSink.push({ toolName: rng.pick(TOOLS), userId: owner.id, success, error: success ? null : 'upstream timeout', createdAt: at(60 * DAY * rng.next()) });
}
await mcpSink.flush();

const auditSink = new Sink<{ workspaceId: string; actorId: string; action: string; resourceType: string; resourceId: string; createdAt: Date }>(
  'audit_logs',
  6,
  (chunk) => prisma.auditLog.createMany({ data: chunk }),
);
for (let k = 0; k < Math.round(5_000 * SCALE); k += 1) {
  const resource = rng.pick(primaryProjects);
  await auditSink.push({
    workspaceId: workspaceIds.A,
    actorId: rng.pick(benchUserIds),
    action: rng.pick(['project.updated', 'member.invited', 'member.role_changed', 'pat.created']),
    resourceType: 'project',
    resourceId: resource.id,
    createdAt: at(180 * DAY * rng.next()),
  });
}
await auditSink.flush();

// ─── Statistics ──────────────────────────────────────────────────────────────

log('VACUUM ANALYZE');
await prisma.$executeRawUnsafe('VACUUM ANALYZE');

// ─── Manifest ────────────────────────────────────────────────────────────────

function projectRef(p: ProjectPlan): FixtureManifest['projects']['large'] {
  return { id: p.id, key: p.key, teamIds: p.teams.map((t) => t.id), tasks: p.tasks };
}

const large = primaryProjects[0];
const largeTodo = primaryTaskRefs.filter((t) => t.projectIndex === 0 && t.status === 'todo' && !t.archived);
if (largeTodo.length < 200) throw new Error('not enough todo tasks in the large project for bulk fixtures; raise PERF_TASKS');
const detailPool = primaryTaskRefs.filter((t) => t.projectIndex < HOT_PROJECTS && !t.archived);

const manifest: FixtureManifest = {
  version: 1,
  seededAt: new Date().toISOString(),
  anchor: ANCHOR.toISOString(),
  seed: SEED,
  database: database.label,
  counts,
  seedSeconds: Math.round((performance.now() - startedAt) / 100) / 10,
  workspaces: { primary: workspaceIds.A, secondary: workspaceIds.B, foreign: workspaceIds.C },
  projects: { large: projectRef(large), medium: projectRef(primaryProjects[9]), small: projectRef(primaryProjects[60]) },
  teamId: large.teams[0].id,
  benchUserIds,
  bulkMoveTaskIds: largeTodo.slice(0, 100).map((t) => t.id),
  fanoutMoveTaskIds: largeTodo.slice(100, 200).map((t) => t.id),
  detailTaskIds: rng.sample(detailPool, 50).map((t) => t.id),
  chatSessions: benchChatSessions,
  search: { common: COMMON_SEARCH_TERM, rare: RARE_SEARCH_TERM, identifier: identifierExample || 'K4-17', none: 'qqxjzvnomatch' },
};

const path = writeManifest(database.database, await mintCredentials(manifest));
log(`counts ${JSON.stringify(counts)}`);
log(`done in ${manifest.seedSeconds}s; manifest ${path}`);
await prisma.$disconnect();
