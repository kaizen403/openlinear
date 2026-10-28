import { prisma, type Prisma } from '@openlinear/db';
import { HttpError } from '../errors';
import { transactionWithEvents } from '../events/outbox';
import { appendToTarget, taskTarget } from '../events/targets';
import { PRISMA_TX_OPTIONS } from '../lib/constants';
import { logActivity } from './activity';
import { logger } from '../logger';
import { createNotification } from '../routes/notifications';
import { assertProjectAccess, assertTaskAccess, assertTaskOwned, type OwnedTask } from './ownership';

/**
 * W17a: "blocked by" relations between tasks — the first edge of the plan
 * graph (see docs/reports/revamp-2026-10-26/deps.md).
 *
 * A task is blocked by another until that task is done. Cancelled does not
 * count: a failed agent run also ends as cancelled, and work built on a
 * failed blocker is wasted — remove the edge, or run anyway, instead. Both
 * tasks share a project (or, when project-less, a team), so anyone who can
 * see one can see the other. The graph stays acyclic: an edge is checked and
 * written under a transaction-scoped advisory lock per project/team, so two
 * concurrent opposite edges cannot both pass. Edges disappear with either
 * task (FK cascade) and when a task moves to another project.
 *
 * Runs honour it: execution refuses a task with open blockers unless the
 * caller explicitly runs it anyway (TASK_BLOCKED, `allowBlocked`), and v2
 * batches start a member only after its in-batch blockers succeeded.
 */

export const MAX_BLOCKERS_PER_TASK = 50;
export const MAX_DEPENDENCY_QUERY_TASKS = 100;
/** Closure answers stop here (a batch takes 20 tasks; the UI says when more exist). */
export const MAX_CLOSURE_TASKS = 100;

/** Blockers stop blocking once done (not cancelled: a failed run ends as cancelled). */
export function isResolvedTaskStatus(status: string): boolean {
  return status === 'done';
}

export interface DependencyTaskRef {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  archived: boolean;
  /** Done: no longer blocks. */
  resolved: boolean;
}

const refSelect = { id: true, identifier: true, title: true, status: true, archived: true } as const;

function toRef(task: { id: string; identifier: string | null; title: string; status: string; archived: boolean }): DependencyTaskRef {
  return { ...task, resolved: isResolvedTaskStatus(task.status) };
}

function scopeKey(task: Pick<OwnedTask, 'projectId' | 'teamId'>): string | null {
  if (task.projectId) return `project:${task.projectId}`;
  if (task.teamId) return `team:${task.teamId}`;
  return null;
}

function label(task: { identifier: string | null; title: string }): string {
  return task.identifier ?? `"${task.title.slice(0, 60)}"`;
}

/** Both directions for one task, blockers first by creation. */
export async function listTaskDependencies(input: { taskId: string; userId: string }): Promise<{ blockedBy: DependencyTaskRef[]; blocking: DependencyTaskRef[] }> {
  await assertTaskAccess(input.taskId, input.userId, 'view');
  return readTaskDependencies(prisma, input.taskId);
}

interface DependencyRow {
  direction: 'blockedBy' | 'blocking';
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  archived: boolean;
}

/**
 * Both directions in one statement (GET /api/tasks/:id has a statement
 * budget), oldest edge first, without an access check (the caller made one).
 */
export async function readTaskDependencies(db: Prisma.TransactionClient | typeof prisma, taskId: string): Promise<{ blockedBy: DependencyTaskRef[]; blocking: DependencyTaskRef[] }> {
  const rows = await db.$queryRaw<DependencyRow[]>`
    SELECT 'blockedBy' AS direction, t.id, t.identifier, t.title, t.status::text AS status, t.archived, d."createdAt" AS "edgeCreatedAt", d.id AS "edgeId"
      FROM "task_dependencies" d JOIN "tasks" t ON t.id = d."dependsOnTaskId"
     WHERE d."taskId" = ${taskId}
    UNION ALL
    SELECT 'blocking', t.id, t.identifier, t.title, t.status::text, t.archived, d."createdAt", d.id
      FROM "task_dependencies" d JOIN "tasks" t ON t.id = d."taskId"
     WHERE d."dependsOnTaskId" = ${taskId}
    ORDER BY "edgeCreatedAt", "edgeId"`;
  const pick = (direction: DependencyRow['direction']) => rows
    .filter((row) => row.direction === direction)
    .map((row) => toRef({ id: row.id, identifier: row.identifier, title: row.title, status: row.status, archived: row.archived }));
  return { blockedBy: pick('blockedBy'), blocking: pick('blocking') };
}

/** Open (not done) blockers of a task, for the execution gate. */
export async function openBlockersOf(taskId: string, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<DependencyTaskRef[]> {
  const rows = await db.taskDependency.findMany({
    where: { taskId, dependsOnTask: { status: { not: 'done' } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { dependsOnTask: { select: refSelect } },
  });
  return rows.map((row) => toRef(row.dependsOnTask));
}

/** TASK_BLOCKED unless the caller chose to run it anyway. */
export async function assertNotBlocked(taskId: string, allowBlocked: boolean): Promise<void> {
  if (allowBlocked) return;
  const open = await openBlockersOf(taskId);
  if (open.length === 0) return;
  const names = open.slice(0, 3).map(label).join(', ');
  const more = open.length > 3 ? ` and ${open.length - 3} more` : '';
  throw new HttpError(409, 'TASK_BLOCKED', `This task is blocked by ${names}${more}. Finish ${open.length === 1 ? 'it' : 'them'} first, or run it anyway.`, {
    blockers: open.map(({ id, identifier, title, status }) => ({ id, identifier, title, status })),
  });
}

/**
 * Mark `taskId` as blocked by `dependsOnTaskId`. Idempotent (an existing edge
 * answers `created: false`). Needs write access to the blocked task and view
 * access to the blocker.
 */
export async function addTaskDependency(input: { taskId: string; dependsOnTaskId: string; userId: string }) {
  if (input.taskId === input.dependsOnTaskId) {
    throw new HttpError(400, 'DEPENDENCY_SELF', 'A task cannot block itself');
  }
  const task = await assertTaskOwned(input.taskId, input.userId);
  const blocker = await assertTaskAccess(input.dependsOnTaskId, input.userId, 'view');
  const scope = scopeKey(task);
  if (!scope) {
    throw new HttpError(400, 'DEPENDENCY_SCOPE', 'Only tasks in a project or team can have blockers');
  }
  if (scope !== scopeKey(blocker)) {
    throw new HttpError(400, 'DEPENDENCY_SCOPE', 'A task can only be blocked by a task in the same project');
  }

  const result = await transactionWithEvents(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`openlinear-task-deps:${scope}`}, 0))`;
    // Re-read both inside the lock: a concurrent move would change the scope.
    const pair = await tx.task.findMany({ where: { id: { in: [input.taskId, input.dependsOnTaskId] } }, select: { id: true, projectId: true, teamId: true, identifier: true, title: true } });
    const current = pair.find((row) => row.id === input.taskId);
    const other = pair.find((row) => row.id === input.dependsOnTaskId);
    if (!current || !other || scopeKey(current) !== scope || scopeKey(other) !== scope) {
      throw new HttpError(409, 'DEPENDENCY_SCOPE_CHANGED', 'One of the tasks moved while the dependency was added; try again');
    }
    const existing = await tx.taskDependency.findUnique({
      where: { taskId_dependsOnTaskId: { taskId: input.taskId, dependsOnTaskId: input.dependsOnTaskId } },
      select: { id: true },
    });
    if (existing) return { created: false };
    const count = await tx.taskDependency.count({ where: { taskId: input.taskId } });
    if (count >= MAX_BLOCKERS_PER_TASK) {
      throw new HttpError(409, 'DEPENDENCY_LIMIT', `A task can have at most ${MAX_BLOCKERS_PER_TASK} blockers`);
    }
    if (await wouldCreateCycle(tx, input.taskId, input.dependsOnTaskId)) {
      throw new HttpError(409, 'DEPENDENCY_CYCLE', `${label(other)} already waits on ${label(current)}, so ${label(current)} cannot also wait on it`);
    }
    await tx.taskDependency.create({ data: { taskId: input.taskId, dependsOnTaskId: input.dependsOnTaskId, createdById: input.userId } });
    await appendToTarget(tx, await taskTarget(tx, task), 'task:dependencies', { taskId: input.taskId, dependsOnTaskId: input.dependsOnTaskId, change: 'added' }, input.userId);
    return { created: true };
  }, PRISMA_TX_OPTIONS);

  if (result.created) {
    await logActivity({
      taskId: input.taskId, projectId: task.projectId, teamId: task.teamId, userId: input.userId,
      action: 'task_updated', payload: { fields: ['blockedBy'], added: input.dependsOnTaskId },
    });
  }
  return { created: result.created, ...(await readTaskDependencies(prisma, input.taskId)) };
}

/**
 * Whether `taskId` → `dependsOnTaskId` would close a loop: the blocker
 * already waits on the task, directly or transitively. Call under the
 * scope's advisory lock (`dependencyLockKey`).
 */
export async function wouldCreateCycle(tx: Prisma.TransactionClient, taskId: string, dependsOnTaskId: string): Promise<boolean> {
  const found = await tx.$queryRaw<Array<{ found: number }>>`
    WITH RECURSIVE upstream(id) AS (
      SELECT "dependsOnTaskId" FROM "task_dependencies" WHERE "taskId" = ${dependsOnTaskId}
      UNION
      SELECT d."dependsOnTaskId" FROM "task_dependencies" d JOIN upstream u ON d."taskId" = u.id
    )
    SELECT 1 AS found FROM upstream WHERE id = ${taskId} LIMIT 1`;
  return found.length > 0;
}

/** The advisory lock every dependency write in a project takes (serializes cycle checks). */
export async function lockProjectDependencies(tx: Prisma.TransactionClient, projectId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`openlinear-task-deps:project:${projectId}`}, 0))`;
}

/**
 * The same lock for a task's current scope (project, else team). A task
 * moving out of its scope takes it before dropping its edges, so a
 * concurrent add either lands first (and is dropped) or sees the new scope
 * and is refused.
 */
export async function lockTaskDependencyScope(tx: Prisma.TransactionClient, task: Pick<OwnedTask, 'projectId' | 'teamId'>): Promise<void> {
  const scope = scopeKey(task);
  if (scope) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`openlinear-task-deps:${scope}`}, 0))`;
}

/**
 * Drop a task's "blocked by" edges when it leaves its project (or, when
 * project-less, its team) — edges never cross scopes, so nobody in the new
 * scope sees the old one's tasks through them. Call inside the move
 * transaction; takes the old scope's lock first.
 */
export async function dropDependenciesOnScopeChange(
  tx: Prisma.TransactionClient,
  taskId: string,
  before: Pick<OwnedTask, 'projectId' | 'teamId'>,
  after: Pick<OwnedTask, 'projectId' | 'teamId'>,
): Promise<void> {
  if (scopeKey(before) === scopeKey(after)) return;
  await lockTaskDependencyScope(tx, before);
  await tx.taskDependency.deleteMany({ where: { OR: [{ taskId }, { dependsOnTaskId: taskId }] } });
}

/** Remove the edge if it exists (idempotent). */
export async function removeTaskDependency(input: { taskId: string; dependsOnTaskId: string; userId: string }) {
  const task = await assertTaskOwned(input.taskId, input.userId);
  const removed = await transactionWithEvents(async (tx) => {
    const deleted = await tx.taskDependency.deleteMany({ where: { taskId: input.taskId, dependsOnTaskId: input.dependsOnTaskId } });
    if (deleted.count > 0) {
      await appendToTarget(tx, await taskTarget(tx, task), 'task:dependencies', { taskId: input.taskId, dependsOnTaskId: input.dependsOnTaskId, change: 'removed' }, input.userId);
    }
    return deleted.count > 0;
  }, PRISMA_TX_OPTIONS);
  if (removed) {
    await logActivity({
      taskId: input.taskId, projectId: task.projectId, teamId: task.teamId, userId: input.userId,
      action: 'task_updated', payload: { fields: ['blockedBy'], removed: input.dependsOnTaskId },
    });
  }
  return { removed };
}

/**
 * Edges among a set of tasks the caller can view (the sidecar orders a batch
 * with this). Tasks the caller cannot view are refused, not silently dropped.
 */
export async function dependencyEdgesAmong(input: { taskIds: string[]; userId: string }): Promise<Array<{ taskId: string; dependsOnTaskId: string }>> {
  const ids = [...new Set(input.taskIds)];
  if (ids.length === 0) return [];
  if (ids.length > MAX_DEPENDENCY_QUERY_TASKS) {
    throw new HttpError(400, 'VALIDATION_ERROR', `At most ${MAX_DEPENDENCY_QUERY_TASKS} tasks per query`);
  }
  for (const id of ids) await assertTaskAccess(id, input.userId, 'view');
  return prisma.taskDependency.findMany({
    where: { taskId: { in: ids }, dependsOnTaskId: { in: ids } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { taskId: true, dependsOnTaskId: true },
  });
}

/**
 * FE-10: every unfinished task this one waits on, transitively — what "run
 * with blockers" has to run first. Done blockers end their branch (their own
 * blockers no longer matter). Oldest first; at most MAX_CLOSURE_TASKS, with
 * `truncated` when more exist. The walk stays in the task's project because
 * every edge does.
 */
export async function openBlockerClosure(input: { taskId: string; userId: string }): Promise<{ tasks: DependencyTaskRef[]; truncated: boolean }> {
  await assertTaskAccess(input.taskId, input.userId, 'view');
  const rows = await prisma.$queryRaw<Array<{ id: string; identifier: string | null; title: string; status: string; archived: boolean }>>`
    WITH RECURSIVE closure(id) AS (
      SELECT d."dependsOnTaskId" FROM "task_dependencies" d JOIN "tasks" t ON t.id = d."dependsOnTaskId"
       WHERE d."taskId" = ${input.taskId} AND t.status <> 'done'
      UNION
      SELECT d."dependsOnTaskId" FROM "task_dependencies" d
        JOIN closure c ON d."taskId" = c.id
        JOIN "tasks" t ON t.id = d."dependsOnTaskId"
       WHERE t.status <> 'done'
    )
    SELECT t.id, t.identifier, t.title, t.status::text AS status, t.archived
      FROM closure c JOIN "tasks" t ON t.id = c.id
     WHERE t.id <> ${input.taskId}
     ORDER BY t."createdAt", t.id
     LIMIT ${MAX_CLOSURE_TASKS + 1}`;
  return { tasks: rows.slice(0, MAX_CLOSURE_TASKS).map(toRef), truncated: rows.length > MAX_CLOSURE_TASKS };
}

/**
 * FE-11: open issues in a project whose title resembles `title` (pg_trgm
 * similarity on the `tasks_title_trgm_idx` index) — a duplicate hint while
 * creating an issue. Read-only; never merges or writes anything.
 */
export async function similarTasks(input: { projectId: string; title: string; userId: string; limit: number; excludeTaskId?: string }) {
  await assertProjectAccess(input.projectId, input.userId, 'view');
  const title = input.title.trim();
  if (title.length < 4) return { items: [] };
  const rows = await prisma.$queryRaw<Array<{ id: string; identifier: string | null; title: string; status: string; score: number }>>`
    SELECT t.id, t.identifier, t.title, t.status::text AS status, similarity(t.title, ${title})::float8 AS score
      FROM "tasks" t
     WHERE t."projectId" = ${input.projectId}
       AND t.archived = false
       AND t.status <> 'cancelled'
       AND t.title % ${title}
       AND t.id <> ${input.excludeTaskId ?? ''}
     ORDER BY score DESC, t."createdAt" DESC
     LIMIT ${input.limit}`;
  return { items: rows.map((row) => ({ ...row, score: Math.round(row.score * 100) / 100 })) };
}

/**
 * W17a: after `taskId` became done, tell whoever owns each task it was
 * blocking that has no open blocker left (its assignee, else its creator):
 * "ENG-5 is unblocked". Best-effort, after the status change committed;
 * honours notification preferences (as a status change) and task access.
 */
export async function notifyUnblockedDependents(input: { taskIds: readonly string[]; actorUserId: string | null }): Promise<void> {
  if (input.taskIds.length === 0) return;
  try {
    // One pass for every task that just became done: a dependent waiting on
    // two of them is told once.
    const dependents = await prisma.taskDependency.findMany({
      where: { dependsOnTaskId: { in: [...input.taskIds] }, task: { archived: false, status: { notIn: ['done', 'cancelled'] } } },
      distinct: ['taskId'],
      select: {
        task: {
          select: {
            id: true, identifier: true, title: true, assigneeId: true, creatorId: true,
            blockedBy: { where: { dependsOnTask: { status: { not: 'done' } } }, select: { id: true }, take: 1 },
          },
        },
      },
      take: 200,
    });
    for (const { task } of dependents) {
      const recipient = task.assigneeId ?? task.creatorId;
      if (!recipient || task.blockedBy.length > 0) continue;
      await createNotification({
        recipientUserId: recipient,
        actorUserId: input.actorUserId,
        type: 'status_change',
        taskId: task.id,
        body: `${label(task)} is unblocked: everything it waited on is done`,
      });
    }
  } catch (error) {
    logger.warn({ err: error, taskIds: input.taskIds }, '[TaskDependencies] unblocked notifications failed');
  }
}

